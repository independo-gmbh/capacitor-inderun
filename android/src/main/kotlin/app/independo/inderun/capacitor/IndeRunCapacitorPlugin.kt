package app.independo.inderun.capacitor

import app.independo.inderun.contracts.IndeRunError
import app.independo.inderun.core.IndeRunException
import app.independo.inderun.core.ProviderRegistry
import app.independo.inderun.core.toIndeRunException
import app.independo.inderun.providers.mlkit.AndroidProviderRegistryFactory
import app.independo.inderun.providers.openai.DEFAULT_OPENAI_RESPONSES_ENDPOINT
import app.independo.inderun.providers.openai.OpenAIAuthMode
import app.independo.inderun.providers.openai.OpenAIProvider
import app.independo.inderun.providers.openai.OpenAIProviderOptions
import app.independo.inderun.sdk.IndeRun
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "IndeRunCapacitor")
class IndeRunCapacitorPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var configuredRegistry: ProviderRegistry? = null
    private val streams = IndeRunStreamRegistry()

    @PluginMethod
    fun configure(call: PluginCall) {
        try {
            val options = IndeRunSerializer.parseConfigureOptions(call.data)
            configuredRegistry = createRegistry(options.openAI)
            call.resolve()
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
                val registry = configuredRegistry
                    ?: throw toIndeRunException(IllegalStateException("Capacitor IndeRun has not been configured. Configure providers before calling run(request)."))
                val request = IndeRunSerializer.parseTaskRequest(requestJson)
                // IndeRun is stateless; new per call is intentional — registry is cached after configure().
                val result = IndeRun.initialize(context.applicationContext, registry).run(request)
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
                val registry = configuredRegistry
                    ?: throw toIndeRunException(IllegalStateException("Capacitor IndeRun has not been configured. Configure providers before calling checkCapabilities()."))
                // IndeRun is stateless; new per call is intentional — registry is cached after configure().
                val snapshots = IndeRun.initialize(context.applicationContext, registry).checkCapabilities()
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
        val streamId = call.getString("streamId")
        if (streamId == null) {
            rejectContractError(call, IllegalArgumentException("startStream requires a streamId."))
            return
        }
        // Unlike run(request), which takes the request at the options root, startStream
        // nests it under `request` so the envelope can also carry the bridge-local streamId.
        val requestJson = call.getObject("request")
        if (requestJson == null) {
            rejectContractError(call, IllegalArgumentException("startStream requires a request."))
            return
        }

        // Reserved before the engine is reached, so a cancel arriving during route
        // selection is recorded rather than dropped as an unknown id.
        streams.open(streamId)

        val job = scope.launch {
            var resolved = false
            try {
                val registry = configuredRegistry
                    ?: throw toIndeRunException(IllegalStateException("Capacitor IndeRun has not been configured. Configure providers before calling stream(request)."))
                val request = IndeRunSerializer.parseTaskRequest(requestJson)
                // IndeRun is stateless; new per call is intentional — registry is cached after configure().
                val streamRun = IndeRun.initialize(context.applicationContext, registry).stream(request)

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

    override fun handleOnDestroy() {
        // Runs first, so providers unwind before the scope that collects them goes away.
        streams.cancelAll("Capacitor plugin destroyed.")
        scope.cancel()
        super.handleOnDestroy()
    }

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

    private fun createRegistry(openAI: OpenAIProviderBootstrapOptions?): ProviderRegistry {
        val registry = AndroidProviderRegistryFactory.makeDefaultRegistry(context.applicationContext)

        if (openAI != null) {
            registry.register(
                OpenAIProvider(
                    OpenAIProviderOptions(
                        id = "openai",
                        model = openAI.model,
                        endpointUrl = openAI.endpointUrl ?: DEFAULT_OPENAI_RESPONSES_ENDPOINT,
                        auth = if (openAI.auth == "none") OpenAIAuthMode.none else OpenAIAuthMode.authContextRef,
                        authContextRef = openAI.authContextRef,
                        timeoutMs = openAI.timeoutMs
                    )
                )
            )
        }

        return registry
    }
}
