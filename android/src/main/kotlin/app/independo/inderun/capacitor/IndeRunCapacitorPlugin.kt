package app.independo.inderun.capacitor

import app.independo.inderun.contracts.IndeRunError
import app.independo.inderun.core.IndeRunException
import app.independo.inderun.core.ModelProfiles
import app.independo.inderun.core.ProviderRegistrationOptions
import app.independo.inderun.core.ProviderRegistry
import app.independo.inderun.core.StreamRun
import app.independo.inderun.core.toIndeRunException
import app.independo.inderun.providers.mlkit.AndroidProviderRegistryFactory
import app.independo.inderun.providers.neuralspeech.NeuralSpeechProvider
import app.independo.inderun.providers.onnx.AndroidOnnxRuntimeProvider
import app.independo.inderun.providers.onnx.OnnxNeuralSpeechRuntime
import app.independo.inderun.providers.openai.DEFAULT_OPENAI_RESPONSES_ENDPOINT
import app.independo.inderun.providers.openai.OpenAIAuthMode
import app.independo.inderun.providers.openai.OpenAIFactoryOptions
import app.independo.inderun.providers.openai.OpenAIProvider
import app.independo.inderun.providers.systemspeech.AndroidSystemSpeechProvider
import app.independo.inderun.sdk.IndeRun
import android.content.Context
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

@CapacitorPlugin(name = "IndeRunCapacitor")
class IndeRunCapacitorPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /**
     * The one engine every call uses, built by [configure] and kept until the next one, with the
     * providers and runtimes the bridge built for it, which close after it.
     * Long-lived on purpose: artifacts are engine-owned and die with the engine, and a provider
     * that loads a model keeps it loaded only as long as its engine is in use. Atomic, because
     * Capacitor calls plugin methods on its own thread while the calls run on [scope].
     */
    private val configuration = AtomicReference<BridgedConfiguration<IndeRun>?>(null)
    private val streams = IndeRunStreamRegistry()

    /**
     * Resolves once the engine this configuration replaces has closed — its streams and prepares
     * have reached their cancelled terminal and its in-flight runs have finished — and the
     * providers the bridge built for it are released. New calls reach the new engine at once.
     */
    @PluginMethod
    fun configure(call: PluginCall) {
        try {
            val options = IndeRunSerializer.parseConfigureOptions(call.data)
            // Validated and built before anything is replaced, so a refused configuration leaves
            // the previous engine in place rather than half of each.
            val modelProfiles = options.modelProfiles?.let(::ModelProfiles) ?: ModelProfiles()
            val built = createRegistry(options)
            val installed = try {
                BridgedConfiguration(
                    IndeRun.initialize(context.applicationContext, built.registry, modelProfiles),
                    built.owned
                ) { it.close() }
            } catch (error: Throwable) {
                closeQuietly(built.owned)
                throw error
            }
            val previous = configuration.getAndSet(installed)
            scope.launch {
                try {
                    previous?.close()
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    // The new engine is already installed, so the configuration took effect:
                    // a failure to close the old one is reported, not turned into a rejection.
                    Log.w(LOG_TAG, "Closing the replaced IndeRun engine failed.", error)
                }
                call.resolve()
            }
        } catch (error: IndeRunException) {
            val contractError = error.toContractError()
            call.reject(
                contractError.message,
                contractError.errorClass.rawValue,
                null,
                runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
            )
        } catch (error: Throwable) {
            val normalized = toIndeRunException(error)
            val contractError = normalized.toContractError()
            call.reject(
                contractError.message,
                contractError.errorClass.rawValue,
                null,
                runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
            )
        }
    }

    @PluginMethod
    fun run(call: PluginCall) {
        val requestJson = call.data

        scope.launch {
            try {
                val engine = requireEngine("run(request)")
                val request = IndeRunSerializer.parseTaskRequest(requestJson)
                val result = engine.run(request)
                call.resolve(IndeRunSerializer.encodeTaskResult(result))
            } catch (error: IndeRunException) {
                val contractError = error.toContractError()
                call.reject(
                    contractError.message,
                    contractError.errorClass.rawValue,
                    null,
                    runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
                )
            } catch (error: Throwable) {
                val normalized = toIndeRunException(error)
                val contractError = normalized.toContractError()
                call.reject(
                    contractError.message,
                    contractError.errorClass.rawValue,
                    null,
                    runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
                )
            }
        }
    }

    /**
     * Reports every registered provider's static declaration and live availability without
     * executing a task. Availability changes between calls — a local model can unload,
     * cloud credentials can expire — so callers must not cache it across a run.
     */
    @PluginMethod
    fun checkCapabilities(call: PluginCall) {
        scope.launch {
            try {
                val snapshots = requireEngine("checkCapabilities()").checkCapabilities()
                call.resolve(IndeRunSerializer.encodeCapabilitySnapshots(snapshots))
            } catch (error: IndeRunException) {
                val contractError = error.toContractError()
                call.reject(
                    contractError.message,
                    contractError.errorClass.rawValue,
                    null,
                    runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
                )
            } catch (error: Throwable) {
                val normalized = toIndeRunException(error)
                val contractError = normalized.toContractError()
                call.reject(
                    contractError.message,
                    contractError.errorClass.rawValue,
                    null,
                    runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
                )
            }
        }
    }

    /**
     * Resolves with the run handle. Only validation and route-selection failures reject;
     * a provider failure, a cancellation, or completion all arrive as the single terminal
     * event on `indeRunStreamEvent` — which is why [resolved] is tracked: a PluginCall
     * must settle exactly once, and a failure after the handle has gone back is an event,
     * not a rejection.
     *
     * `retainUntilConsumed` closes the listener-registration race from the native side: an
     * event emitted before the JS listener attaches is retained and replayed, not lost.
     */
    @PluginMethod
    fun startStream(call: PluginCall) {
        startBridgedRun(call, "startStream", "stream(request)") { engine, requestJson ->
            engine.stream(IndeRunSerializer.parseTaskRequest(requestJson))
        }
    }

    /**
     * Delivered exactly like [startStream] — same notifications, same [cancelStream] — because
     * upstream's `prepare` returns the same `StreamRun`.
     */
    @PluginMethod
    fun startPrepare(call: PluginCall) {
        startBridgedRun(call, "startPrepare", "prepare(request)") { engine, requestJson ->
            engine.prepare(IndeRunSerializer.parsePrepareRequest(requestJson))
        }
    }

    private fun startBridgedRun(
        call: PluginCall,
        method: String,
        engineCall: String,
        start: suspend (IndeRun, JSONObject) -> StreamRun
    ) {
        val streamId = call.getString("streamId")
        if (streamId == null) {
            rejectContractError(call, IllegalArgumentException("$method requires a streamId."))
            return
        }
        // Unlike run(request), which takes the request at the options root, startStream and
        // startPrepare nest it under `request` so the envelope can also carry the bridge-local
        // streamId.
        val requestJson = call.getObject("request")
        if (requestJson == null) {
            rejectContractError(call, IllegalArgumentException("$method requires a request."))
            return
        }

        // Reserved before the engine is reached, so a cancel arriving during route
        // selection is recorded rather than dropped as an unknown id.
        streams.open(streamId)

        val job = scope.launch {
            var resolved = false
            try {
                val streamRun = start(requireEngine(engineCall), requestJson)

                val outcome = streams.attach(streamId, streamRun)
                if (outcome is AttachOutcome.CancelRequested) {
                    streamRun.cancel(outcome.reason)
                }

                call.resolve(IndeRunSerializer.encodeStreamRunHandle(streamRun.handle))
                resolved = true

                // The Flow is cold and single-use; collecting it exactly once here is what
                // drives the run.
                streamRun.events.collect { event ->
                    val payload = JSObject()
                    payload.put("streamId", streamId)
                    payload.put("event", IndeRunSerializer.encodeStreamEvent(event))
                    notifyListeners("indeRunStreamEvent", payload, true)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val contractError = contractErrorFor(error)
                if (resolved) {
                    val payload = JSObject()
                    payload.put("streamId", streamId)
                    payload.put(
                        "error",
                        runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
                    )
                    notifyListeners("indeRunStreamError", payload, true)
                } else {
                    call.reject(
                        contractError.message,
                        contractError.errorClass.rawValue,
                        null,
                        runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
                    )
                }
            } finally {
                streams.close(streamId)
            }
        }

        streams.attachJob(streamId, job)
    }

    /**
     * Resolves for an unknown or already-finished run: cancelling after the terminal is a
     * no-op by contract, not an error.
     */
    @PluginMethod
    fun cancelStream(call: PluginCall) {
        val streamId = call.getString("streamId")
        if (streamId == null) {
            rejectContractError(call, IllegalArgumentException("cancelStream requires a streamId."))
            return
        }

        streams.requestCancel(streamId, call.getString("reason"))
        call.resolve()
    }

    /** Like `run(request)`, the request arrives at the options root. Resolves `bytes` as base64. */
    @PluginMethod
    fun readArtifact(call: PluginCall) {
        val requestJson = call.data
        // Read on the plugin call, like configure's swap, so a later configure cannot redirect it.
        val target = configuration.get()?.engine
        scope.launch {
            try {
                val engine = requireEngine(target, "readArtifact(request)")
                val chunk = engine.readArtifact(IndeRunSerializer.parseArtifactReadRequest(requestJson))
                call.resolve(IndeRunSerializer.encodeArtifactChunk(chunk))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                rejectContractError(call, error)
            }
        }
    }

    @PluginMethod
    fun disposeArtifact(call: PluginCall) {
        val artifactJson = call.data
        val target = configuration.get()?.engine
        scope.launch {
            try {
                val engine = requireEngine(target, "disposeArtifact(artifact)")
                engine.disposeArtifact(IndeRunSerializer.parseMediaArtifact(artifactJson))
                call.resolve()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                rejectContractError(call, error)
            }
        }
    }

    /**
     * Closes the configured engine, then the providers the bridge built for it, and keeps the
     * engine, so every later call fails the way the closed engine fails it (`engine_closed`) until
     * [configure] installs a new one. Nothing configured is nothing to close.
     */
    @PluginMethod
    fun close(call: PluginCall) {
        // Read on the plugin call: a configure that follows must not have its new engine closed.
        val target = configuration.get()
        scope.launch {
            try {
                target?.close()
                call.resolve()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                rejectContractError(call, error)
            }
        }
    }

    override fun handleOnDestroy() {
        // Runs first, so providers unwind before the scope that collects them goes away.
        streams.cancelAll("Capacitor plugin destroyed.")
        scope.cancel()
        // Closed outside the cancelled scope, without waiting: nobody is left to wait, and
        // the main thread must not block on in-flight runs.
        configuration.get()?.let { closing ->
            CoroutineScope(Dispatchers.Default).launch {
                runCatching { closing.close() }.onFailure { error ->
                    Log.w(LOG_TAG, "Closing the IndeRun engine at teardown failed.", error)
                }
            }
        }
        super.handleOnDestroy()
    }

    /** The configured engine, closed or not: a closed one answers each call the way upstream defines. */
    private fun requireEngine(call: String): IndeRun = requireEngine(configuration.get()?.engine, call)

    private fun requireEngine(target: IndeRun?, call: String): IndeRun = target
        ?: throw toIndeRunException(IllegalStateException("Capacitor IndeRun has not been configured. Configure providers before calling $call."))

    private fun contractErrorFor(error: Throwable): IndeRunError = when (error) {
        is IndeRunException -> error.toContractError()
        else -> toIndeRunException(error).toContractError()
    }

    private fun rejectContractError(call: PluginCall, error: Throwable) {
        val contractError = contractErrorFor(error)
        call.reject(
            contractError.message,
            contractError.errorClass.rawValue,
            null,
            runCatching { IndeRunSerializer.encodeError(contractError) }.getOrNull()
        )
    }

    /**
     * The default on-device registry plus what [options] asks for. Every provider or runtime built
     * here that holds something to release is returned in `owned`, for [BridgedConfiguration] to
     * close after the engine; if building fails part way, the ones already built are closed here.
     */
    private fun createRegistry(options: RunOptions): BridgedRegistry {
        val appContext = context.applicationContext
        val registry = AndroidProviderRegistryFactory.makeDefaultRegistry(appContext)
        val owned = mutableListOf<AutoCloseable>()
        try {
            registerProviders(registry, options, appContext, owned)
        } catch (error: Throwable) {
            closeQuietly(owned)
            throw error
        }
        return BridgedRegistry(registry, owned)
    }

    private fun registerProviders(
        registry: ProviderRegistry,
        options: RunOptions,
        appContext: Context,
        owned: MutableList<AutoCloseable>
    ) {
        val openAI = options.openAI
        if (openAI != null) {
            // Upstream's makeOpenAIRegistry builds a registry of its own, while this one also
            // carries the on-device provider; providerOptions(model) is the shared half, so the
            // target ids cannot drift from the factory's.
            require(openAI.models.isNotEmpty()) {
                "Capacitor openAI bootstrap requires models to list at least one model."
            }
            val factory = OpenAIFactoryOptions(
                models = openAI.models,
                endpointUrl = openAI.endpointUrl ?: DEFAULT_OPENAI_RESPONSES_ENDPOINT,
                auth = if (openAI.auth == "none") OpenAIAuthMode.none else OpenAIAuthMode.authContextRef,
                authContextRef = openAI.authContextRef,
                timeoutMs = openAI.timeoutMs
            )
            openAI.models.forEach { model -> registry.register(OpenAIProvider(factory.providerOptions(model))) }
        }

        options.onnx?.let { onnx ->
            // The convenience constructor builds the default runtime, which loads lazily and has
            // no close, so there is nothing here for the bridge to own.
            registry.register(
                AndroidOnnxRuntimeProvider(
                    appContext,
                    onnx.modelPackage,
                    onnx.id ?: AndroidOnnxRuntimeProvider.DEFAULT_ID,
                    onnx.timeoutMs
                )
            )
        }

        // Opt-in (ADR 018): the router probes every registered provider on every request, so an
        // app that does not speak should not bind a TTS service.
        options.systemSpeech?.let { systemSpeech ->
            val provider = AndroidSystemSpeechProvider(appContext, systemSpeech.id ?: AndroidSystemSpeechProvider.DEFAULT_ID)
            owned += provider
            registry.register(provider)
        }

        options.neuralSpeech?.forEach { entry ->
            // One runtime per entry, closed with the configuration: the provider has no close of
            // its own, and the runtime is what holds the loaded model.
            val runtime = OnnxNeuralSpeechRuntime(appContext)
            owned += runtime
            registry.register(
                NeuralSpeechProvider(entry.modelPackage, runtime, entry.id, entry.timeoutMs),
                ProviderRegistrationOptions(autoDownload = entry.autoDownload ?: false)
            )
        }
    }
}

private const val LOG_TAG = "IndeRunCapacitor"
