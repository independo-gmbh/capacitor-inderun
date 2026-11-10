package app.independo.inderun.capacitor

import app.independo.inderun.contracts.ArtifactLifetime
import app.independo.inderun.contracts.ArtifactOwner
import app.independo.inderun.contracts.ArtifactReadRequest
import app.independo.inderun.contracts.AssetLicense
import app.independo.inderun.contracts.Cloud
import app.independo.inderun.contracts.ExecutionProvenance
import app.independo.inderun.contracts.Files
import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.Format
import app.independo.inderun.contracts.FrontendKind
import app.independo.inderun.contracts.Generation
import app.independo.inderun.contracts.IndeRunError
import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.Integrity
import app.independo.inderun.contracts.License
import app.independo.inderun.contracts.Limits
import app.independo.inderun.contracts.LocaleMatch
import app.independo.inderun.contracts.MediaArtifact
import app.independo.inderun.contracts.Message
import app.independo.inderun.contracts.MessageRole
import app.independo.inderun.contracts.ModelPackage
import app.independo.inderun.contracts.OptimizeFor
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.OutputDelivery
import app.independo.inderun.contracts.OutputDeliveryRequest
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PayloadError
import app.independo.inderun.contracts.PayloadTelemetry
import app.independo.inderun.contracts.PayloadUsage
import app.independo.inderun.contracts.Phase
import app.independo.inderun.contracts.PlaybackOutput
import app.independo.inderun.contracts.PreparationItem
import app.independo.inderun.contracts.PrepareRequest
import app.independo.inderun.contracts.PrepareVoice
import app.independo.inderun.contracts.Privacy
import app.independo.inderun.contracts.ProviderCapabilitySnapshot
import app.independo.inderun.contracts.ProviderDescriptor
import app.independo.inderun.contracts.ProviderDynamicCapabilities
import app.independo.inderun.contracts.ProviderPrivacy
import app.independo.inderun.contracts.ProviderTaskAvailability
import app.independo.inderun.contracts.ProviderTaskCapability
import app.independo.inderun.contracts.ProviderVoice
import app.independo.inderun.contracts.RequirementLevel
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.Source
import app.independo.inderun.contracts.SourceType
import app.independo.inderun.contracts.SpeechFrontend
import app.independo.inderun.contracts.SpeechInput
import app.independo.inderun.contracts.SpeechModelPackage
import app.independo.inderun.contracts.SpeechModelVoice
import app.independo.inderun.contracts.SpeechOutput
import app.independo.inderun.contracts.SpeechVoice
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.StreamRunHandle
import app.independo.inderun.contracts.TaskKind
import app.independo.inderun.contracts.TaskOutput
import app.independo.inderun.contracts.TaskRequest
import app.independo.inderun.contracts.TaskRequestConstraints
import app.independo.inderun.contracts.TaskRequestPreferences
import app.independo.inderun.contracts.TaskRequestTask
import app.independo.inderun.contracts.TaskRequestTelemetry
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.contracts.TaskResultTelemetry
import app.independo.inderun.contracts.TelemetryLevel
import app.independo.inderun.contracts.VoiceGender
import app.independo.inderun.contracts.Runtime as ModelPackageRuntime
import app.independo.inderun.core.ArtifactChunk
import app.independo.inderun.core.createInternal
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * One OpenAI-compatible target is registered per entry in [models], with id `openai:<model>` --
 * the id scheme the web SDK and the upstream factories use, so a model profile names the same
 * targets on every platform.
 */
data class OpenAIProviderBootstrapOptions(
    val models: List<String>,
    val endpointUrl: String? = null,
    val auth: String? = null,
    val authContextRef: String? = null,
    val timeoutMs: Long? = null
)

/** `systemSpeech` arrives as `true` or as an options object; see `SystemSpeechBootstrapOptions` in src/definitions.ts. */
data class SystemSpeechBootstrapOptions(
    val id: String? = null
)

/**
 * One neural speech provider; see `NeuralSpeechBootstrapOptions` in src/definitions.ts. There is
 * no `runtime` here: ONNX is the only one Android has, and parsing refuses any other.
 */
data class NeuralSpeechBootstrapOptions(
    val modelPackage: ModelPackage,
    val id: String? = null,
    val timeoutMs: Long? = null,
    val autoDownload: Boolean? = null
)

data class RunOptions(
    val openAI: OpenAIProviderBootstrapOptions? = null,
    /** Profile name to ordered target ids, as `ModelProfiles` takes it. */
    val modelProfiles: Map<String, List<String>>? = null,
    /** Null when not asked for: system speech is opt-in (ADR 018). */
    val systemSpeech: SystemSpeechBootstrapOptions? = null,
    val neuralSpeech: List<NeuralSpeechBootstrapOptions>? = null
)

object IndeRunSerializer {
    fun parseConfigureOptions(json: JSONObject): RunOptions {
        return RunOptions(
            openAI = json.optJSONObject("openAI")?.let(::parseOpenAIOptions),
            modelProfiles = json.optJSONObject("modelProfiles")?.let(::parseModelProfiles),
            systemSpeech = parseSystemSpeechOptions(json),
            neuralSpeech = json.optJSONArray("neuralSpeech")?.let { entries ->
                List(entries.length()) { index -> parseNeuralSpeechOptions(entries.getJSONObject(index)) }
            }
        )
    }

    /** `true` or `{ id? }`; `false` reads as not asking for it, like leaving it out. */
    private fun parseSystemSpeechOptions(json: JSONObject): SystemSpeechBootstrapOptions? {
        if (!json.has("systemSpeech") || json.isNull("systemSpeech")) return null
        return when (val value = json.get("systemSpeech")) {
            true -> SystemSpeechBootstrapOptions()
            false -> null
            is JSONObject -> SystemSpeechBootstrapOptions(id = value.optStringOrNull("id"))
            else -> throw IllegalArgumentException("systemSpeech must be true or an options object.")
        }
    }

    private fun parseNeuralSpeechOptions(json: JSONObject): NeuralSpeechBootstrapOptions {
        val runtime = json.optStringOrNull("runtime")
        if (runtime != null && runtime != "onnx") {
            throw createInternal("$runtime runtime is not available on Android")
        }
        return NeuralSpeechBootstrapOptions(
            modelPackage = parseModelPackage(json.getJSONObject("modelPackage")),
            id = json.optStringOrNull("id"),
            timeoutMs = json.optLongOrNull("timeoutMs"),
            autoDownload = json.optBooleanOrNull("autoDownload")
        )
    }

    /**
     * Every field of the `ModelPackage` contract, each only when set, so a package reaches the
     * provider exactly as the app declared it: the provider and its runtime, not the bridge,
     * decide what a package needs.
     */
    fun parseModelPackage(json: JSONObject): ModelPackage {
        return ModelPackage(
            files = json.optJSONObject("files")?.let { files ->
                Files(
                    config = files.optStringOrNull("config"),
                    external = files.optJSONArray("external")?.toStringList(),
                    required = files.optJSONArray("required")?.toStringList(),
                    tokenizer = files.optStringOrNull("tokenizer")
                )
            },
            format = parseEnum(json.getString("format"), "model package format", Format::fromRawValue),
            id = json.getString("id"),
            integrity = json.optJSONObject("integrity")?.let { integrity ->
                Integrity(checksums = integrity.optJSONObject("checksums")?.toStringMap())
            },
            license = json.optJSONObject("license")?.let { license ->
                License(spdx = license.optStringOrNull("spdx"), url = license.optStringOrNull("url"))
            },
            limits = json.optJSONObject("limits")?.let { limits ->
                Limits(diskBytes = limits.optLongOrNull("diskBytes"), memBytes = limits.optLongOrNull("memBytes"))
            },
            runtime = json.optJSONObject("runtime")?.let { runtime ->
                ModelPackageRuntime(
                    minOpset = runtime.optLongOrNull("minOpset"),
                    minOsVersion = runtime.optStringOrNull("minOsVersion"),
                    minRuntimeVersion = runtime.optStringOrNull("minRuntimeVersion"),
                    platforms = runtime.optJSONArray("platforms")?.toStringList()
                )
            },
            source = json.optJSONObject("source")?.let { source ->
                Source(
                    ref = source.optStringOrNull("ref"),
                    sourceType = parseEnum(source.getString("sourceType"), "model source type", SourceType::fromRawValue)
                )
            },
            speech = json.optJSONObject("speech")?.let(::parseSpeechModelPackage),
            tasks = json.optJSONArray("tasks")?.toStringList(),
            variant = json.optStringOrNull("variant"),
            version = json.optStringOrNull("version")
        )
    }

    private fun parseSpeechModelPackage(json: JSONObject): SpeechModelPackage {
        val voices = json.getJSONArray("voices")
        return SpeechModelPackage(
            channels = json.optLongOrNull("channels"),
            frontend = json.optJSONObject("frontend")?.let { frontend ->
                SpeechFrontend(
                    assets = frontend.optJSONObject("assets")?.toStringMap(),
                    kind = parseEnum(frontend.getString("kind"), "speech frontend kind", FrontendKind::fromRawValue),
                    license = frontend.optJSONObject("license")?.let(::parseAssetLicense)
                )
            },
            graphs = json.getJSONObject("graphs").toStringMap(),
            pipeline = json.getString("pipeline"),
            sampleRate = json.getLong("sampleRate"),
            voices = List(voices.length()) { index ->
                val voice = voices.getJSONObject(index)
                SpeechModelVoice(
                    file = voice.optStringOrNull("file"),
                    gender = voice.optStringOrNull("gender")?.let { parseEnum(it, "voice gender", VoiceGender::fromRawValue) },
                    id = voice.getString("id"),
                    license = voice.optJSONObject("license")?.let(::parseAssetLicense),
                    locales = voice.getJSONArray("locales").toStringList(),
                    name = voice.getString("name")
                )
            }
        )
    }

    private fun parseAssetLicense(json: JSONObject): AssetLicense {
        return AssetLicense(spdx = json.optStringOrNull("spdx"), url = json.optStringOrNull("url"))
    }

    fun parseTaskRequest(json: JSONObject): TaskRequest {
        return TaskRequest(
            authContextRef = json.optStringOrNull("authContextRef"),
            constraints = json.optJSONObject("constraints")?.let(::parseConstraints),
            delivery = json.optJSONObject("delivery")?.let(::parseDelivery),
            generation = json.optJSONObject("generation")?.let(::parseGeneration),
            messages = json.optJSONArray("messages")?.let(::parseMessages),
            modelProfile = json.optStringOrNull("modelProfile"),
            preferences = json.optJSONObject("preferences")?.let(::parsePreferences),
            prompt = json.optStringOrNull("prompt"),
            requestId = json.optStringOrNull("requestId"),
            schemaVersion = parseSchemaVersion(json.getString("schemaVersion")),
            speech = json.optJSONObject("speech")?.let(::parseSpeechInput),
            task = parseTask(json.getJSONObject("task")),
            telemetry = json.optJSONObject("telemetry")?.let(::parseTelemetry)
        )
    }

    private fun parseSpeechInput(json: JSONObject): SpeechInput {
        return SpeechInput(
            locale = json.getString("locale"),
            localeMatch = json.optStringOrNull("localeMatch")?.let(::parseLocaleMatch),
            text = json.getString("text"),
            voice = json.optJSONObject("voice")?.let { voice ->
                SpeechVoice(
                    gender = voice.optStringOrNull("gender")?.let { parseEnum(it, "voice gender", VoiceGender::fromRawValue) },
                    id = voice.optStringOrNull("id"),
                    providerId = voice.optStringOrNull("providerId"),
                    requirement = voice.optStringOrNull("requirement")?.let {
                        parseEnum(it, "voice requirement", RequirementLevel::fromRawValue)
                    }
                )
            }
        )
    }

    private fun parseDelivery(json: JSONObject): OutputDeliveryRequest {
        return OutputDeliveryRequest(
            destinationRef = json.optStringOrNull("destinationRef"),
            mediaTypes = json.optJSONArray("mediaTypes")?.toStringList(),
            mode = parseEnum(json.getString("mode"), "delivery mode", OutputDelivery::fromRawValue)
        )
    }

    fun parsePrepareRequest(json: JSONObject): PrepareRequest {
        return PrepareRequest(
            allowDownload = json.optBooleanOrNull("allowDownload"),
            locale = json.optStringOrNull("locale"),
            localeMatch = json.optStringOrNull("localeMatch")?.let(::parseLocaleMatch),
            privacy = json.optStringOrNull("privacy")?.let(::parsePrivacy),
            requestId = json.optStringOrNull("requestId"),
            tasks = json.optJSONArray("tasks")?.toStringList(),
            voice = json.optJSONObject("voice")?.let(::parsePrepareVoice)
        )
    }

    /** Like `run(request)`, the request arrives at the options root. */
    fun parseArtifactReadRequest(json: JSONObject): ArtifactReadRequest {
        return ArtifactReadRequest(
            artifactId = json.getString("artifactId"),
            maxBytes = json.optLongOrNull("maxBytes"),
            offset = json.optLongOrNull("offset")
        )
    }

    fun parseMediaArtifact(json: JSONObject): MediaArtifact {
        return MediaArtifact(
            byteLength = json.optLongOrNull("byteLength"),
            destinationRef = json.optStringOrNull("destinationRef"),
            durationMs = json.optDoubleOrNull("durationMs"),
            id = json.getString("id"),
            lifetime = parseEnum(json.getString("lifetime"), "artifact lifetime", ArtifactLifetime::fromRawValue),
            mediaType = json.getString("mediaType"),
            owner = parseEnum(json.getString("owner"), "artifact owner", ArtifactOwner::fromRawValue)
        )
    }

    /**
     * `bytes` crosses as base64: a Capacitor call resolves JSON, which has no byte type, and the
     * JS side decodes it back. `java.util.Base64` rather than `android.util.Base64`, so the JVM
     * unit tests run it. Transport only — results still carry artifact handles, never bytes.
     */
    fun encodeArtifactChunk(chunk: ArtifactChunk): JSObject {
        return JSObject().apply {
            put("artifactId", chunk.artifactId)
            put("offset", chunk.offset)
            put("bytes", Base64.getEncoder().encodeToString(chunk.bytes))
            put("totalBytes", chunk.totalBytes)
            put("done", chunk.done)
        }
    }

    /**
     * Every branch of `TaskOutput`, each field only when set: a run's text, a managed-playback
     * completion, a media artifact reference, or a prepare run's items. Shared by results and
     * terminal stream events, which carry the same output.
     */
    fun encodeTaskOutput(output: TaskOutput): JSObject {
        return JSObject().apply {
            put("type", output.type.rawValue)
            output.text?.let { put("text", it) }
            output.artifact?.let { put("artifact", encodeMediaArtifact(it)) }
            output.playback?.let { put("playback", encodePlaybackOutput(it)) }
            output.speech?.let { put("speech", encodeSpeechOutput(it)) }
            output.preparation?.let { items ->
                put("preparation", JSArray().apply { items.forEach { put(encodePreparationItem(it)) } })
            }
        }
    }

    private fun encodeMediaArtifact(artifact: MediaArtifact): JSObject {
        return JSObject().apply {
            put("id", artifact.id)
            put("owner", artifact.owner.rawValue)
            put("lifetime", artifact.lifetime.rawValue)
            put("mediaType", artifact.mediaType)
            artifact.byteLength?.let { put("byteLength", it) }
            artifact.durationMs?.let { put("durationMs", it) }
            artifact.destinationRef?.let { put("destinationRef", it) }
        }
    }

    private fun encodePlaybackOutput(playback: PlaybackOutput): JSObject {
        return JSObject().apply {
            playback.timing?.let { timing ->
                put(
                    "timing",
                    JSObject().apply {
                        timing.durationMs?.let { put("durationMs", it) }
                        timing.firstAudioMs?.let { put("firstAudioMs", it) }
                        timing.firstChunkMs?.let { put("firstChunkMs", it) }
                    }
                )
            }
        }
    }

    private fun encodeSpeechOutput(speech: SpeechOutput): JSObject {
        return JSObject().apply {
            put("locale", speech.locale)
            speech.voice?.let { voice ->
                put(
                    "voice",
                    JSObject().apply {
                        voice.gender?.let { put("gender", it.rawValue) }
                        voice.id?.let { put("id", it) }
                        voice.name?.let { put("name", it) }
                    }
                )
            }
        }
    }

    private fun encodePreparationItem(item: PreparationItem): JSObject {
        return JSObject().apply {
            put("providerId", item.providerId)
            put("task", item.task)
            put("status", item.status.rawValue)
            item.voiceId?.let { put("voiceId", it) }
            item.reason?.let { put("reason", it) }
        }
    }

    fun encodeTaskResult(result: TaskResult): JSObject {
        return JSObject().apply {
            put("schemaVersion", result.schemaVersion.rawValue)
            put("runId", result.runId)
            put("finishReason", result.finishReason.rawValue)
            put("output", encodeTaskOutput(result.output))
            put(
                "telemetry",
                JSObject()
                    .put("providerUsed", result.telemetry.providerUsed)
                    .put("totalMs", result.telemetry.totalMs)
                    .apply {
                        result.telemetry.errorClass?.let { put("errorClass", it.rawValue) }
                    }
            )
            result.usage?.let { usage ->
                put(
                    "usage",
                    JSObject().apply {
                        usage.inputTokens?.let { put("inputTokens", it) }
                        usage.outputTokens?.let { put("outputTokens", it) }
                        usage.totalTokens?.let { put("totalTokens", it) }
                    }
                )
            }
            result.provenance?.let { put("provenance", encodeProvenance(it)) }
        }
    }

    fun encodeError(error: IndeRunError): JSObject {
        return JSObject().apply {
            put("schemaVersion", error.schemaVersion.rawValue)
            put("errorClass", error.errorClass.rawValue)
            put("message", error.message)
            error.providerId?.let { put("providerId", it) }
            error.retryable?.let { put("retryable", it) }
            error.retryAfterMs?.let { put("retryAfterMs", it) }
            error.runId?.let { put("runId", it) }
            error.details?.let { put("details", JSONObject(it)) }
            error.provenance?.let { put("provenance", encodeProvenance(it)) }
        }
    }

    /**
     * Wire encoding for the `ExecutionProvenance` carried on results, errors and terminal
     * stream events. Optional fields are omitted rather than written as null: an absent
     * `providerId` means no provider was attributed, and an absent `reportedModel` means the
     * backend named none -- a null would be a third state the schema does not have.
     */
    private fun encodeProvenance(provenance: ExecutionProvenance): JSObject {
        return JSObject().apply {
            put("schemaVersion", provenance.schemaVersion.rawValue)
            put("modelProfile", provenance.modelProfile)
            provenance.providerId?.let { put("providerId", it) }
            put("locality", provenance.locality.rawValue)
            provenance.configuredModel?.let { put("configuredModel", it) }
            provenance.reportedModel?.let { put("reportedModel", it) }
            put("fallbackOccurred", provenance.fallbackOccurred)
            put("attemptCount", provenance.attemptCount)
            put(
                "attempts",
                JSArray().apply {
                    provenance.attempts.forEach { attempt ->
                        put(
                            JSObject().apply {
                                put("providerId", attempt.providerId)
                                put("outcome", attempt.outcome.rawValue)
                                attempt.errorClass?.let { put("errorClass", it.rawValue) }
                            }
                        )
                    }
                }
            )
            put(
                "routeRejections",
                JSArray().apply {
                    provenance.routeRejections.forEach { rejection ->
                        put(
                            JSObject().apply {
                                put("providerId", rejection.providerId)
                                put("codes", JSArray().apply { rejection.codes.forEach { put(it.rawValue) } })
                            }
                        )
                    }
                }
            )
        }
    }

    /**
     * Wire encoding for `checkCapabilities()`.
     *
     * Note the enums are written with `.name`, which is the opposite of what
     * [encodeOutcome] and [encodePhase] below have to do. Those contract enums are
     * generated without raw values, so their Kotlin constant names are camelCase and the
     * snake_case wire spelling has to be written by hand. `ProviderDescriptor`'s enums are
     * declared with the wire spelling *as* the constant name (`in_process`,
     * `system_service`), so `.name` already is the wire value — and writing them by hand
     * here would be the thing that eventually drifts.
     *
     * The array is wrapped in a `providers` object because a Capacitor `PluginCall` cannot
     * resolve a top-level array. `IndeRunCapacitor` unwraps it on the JS side.
     */
    fun encodeCapabilitySnapshots(snapshots: List<ProviderCapabilitySnapshot>): JSObject {
        return JSObject().apply {
            put(
                "providers",
                JSArray().apply {
                    snapshots.forEach { snapshot ->
                        put(
                            JSObject().apply {
                                put("providerId", snapshot.providerId)
                                put("descriptor", encodeProviderDescriptor(snapshot.descriptor))
                                put("capabilities", encodeProviderDynamicCapabilities(snapshot.capabilities))
                            }
                        )
                    }
                }
            )
        }
    }

    private fun encodeProviderDescriptor(descriptor: ProviderDescriptor): JSObject {
        return JSObject().apply {
            put("id", descriptor.id)
            descriptor.model?.let { put("model", it) }
            put("type", descriptor.type.rawValue)
            put("transport", descriptor.transport.rawValue)
            descriptor.streamingStyle?.let { put("streamingStyle", it.rawValue) }
            put(
                "supports",
                JSObject().apply {
                    put("run", descriptor.supports.run)
                    put("streaming", descriptor.supports.streaming)
                    put("realtime", descriptor.supports.realtime)
                    put("tools", descriptor.supports.tools)
                    put("reasoningEvents", descriptor.supports.reasoningEvents)
                    put("structuredOutput", descriptor.supports.structuredOutput)
                    put("multimodal", descriptor.supports.multimodal)
                }
            )
            put("cancel", descriptor.cancel.rawValue)
            put("tasks", JSArray().apply { descriptor.tasks.forEach { put(it) } })
            descriptor.taskCapabilities?.let { put("taskCapabilities", encodeTaskCapabilities(it)) }
            descriptor.limits?.let { limits ->
                put(
                    "limits",
                    JSObject().apply {
                        limits.maxInputTokens?.let { put("maxInputTokens", it) }
                        limits.maxOutputTokens?.let { put("maxOutputTokens", it) }
                        limits.maxImageBytes?.let { put("maxImageBytes", it) }
                        limits.maxAudioSeconds?.let { put("maxAudioSeconds", it) }
                    }
                )
            }
            descriptor.privacy?.let { put("privacy", encodeProviderPrivacy(it)) }
        }
    }

    private fun encodeProviderPrivacy(privacy: ProviderPrivacy): JSObject {
        return JSObject().apply {
            put("dataLeavesDevice", privacy.dataLeavesDevice)
            privacy.regions?.let { regions -> put("regions", JSArray().apply { regions.forEach { put(it) } }) }
        }
    }

    private fun encodeTaskCapabilities(capabilities: List<ProviderTaskCapability>): JSArray {
        return JSArray().apply {
            capabilities.forEach { capability ->
                put(
                    JSObject().apply {
                        put("kind", capability.kind)
                        put("inputs", JSArray().apply { capability.inputs.forEach { put(it.rawValue) } })
                        put(
                            "interaction",
                            JSObject().apply {
                                put("run", capability.interaction.run)
                                put("stream", capability.interaction.stream)
                                capability.interaction.prepare?.let { put("prepare", it) }
                            }
                        )
                        put("cancel", capability.cancel.rawValue)
                        put(
                            "outputs",
                            JSArray().apply {
                                capability.outputs.forEach { output ->
                                    put(
                                        JSObject().apply {
                                            put("delivery", output.delivery.rawValue)
                                            output.mediaTypes?.let { types ->
                                                put("mediaTypes", JSArray().apply { types.forEach { put(it) } })
                                            }
                                        }
                                    )
                                }
                            }
                        )
                        capability.locales?.let { locales -> put("locales", JSArray().apply { locales.forEach { put(it) } }) }
                        capability.privacy?.let { put("privacy", encodeProviderPrivacy(it)) }
                    }
                )
            }
        }
    }

    private fun encodeTaskAvailability(availability: List<ProviderTaskAvailability>): JSArray {
        return JSArray().apply {
            availability.forEach { task ->
                put(
                    JSObject().apply {
                        put("kind", task.kind)
                        task.available?.let { put("available", it) }
                        task.cancellationAvailable?.let { put("cancellationAvailable", it) }
                        task.locales?.let { locales -> put("locales", JSArray().apply { locales.forEach { put(it) } }) }
                        task.readiness?.let { put("readiness", it.rawValue) }
                        task.reason?.let { put("reason", it) }
                        task.streamingAvailable?.let { put("streamingAvailable", it) }
                        task.streamingUnavailableReason?.let { put("streamingUnavailableReason", it) }
                        task.voices?.let { voices -> put("voices", encodeVoices(voices)) }
                    }
                )
            }
        }
    }

    private fun encodeVoices(voices: List<ProviderVoice>): JSArray {
        return JSArray().apply {
            voices.forEach { voice ->
                put(
                    JSObject().apply {
                        put("locale", voice.locale)
                        voice.gender?.let { put("gender", it.rawValue) }
                        voice.id?.let { put("id", it) }
                        voice.locales?.let { locales -> put("locales", JSArray().apply { locales.forEach { put(it) } }) }
                        voice.name?.let { put("name", it) }
                        voice.networkRequired?.let { put("networkRequired", it) }
                        voice.readiness?.let { put("readiness", it.rawValue) }
                    }
                )
            }
        }
    }

    /**
     * The three nullable flags are **omitted** rather than written as null. Absence is the
     * contract's "inherit the static declaration" state — `descriptor.supports.streaming`
     * for streaming, `descriptor.cancel != none` for cancellation — and a null would be a
     * third state no consumer has.
     */
    private fun encodeProviderDynamicCapabilities(capabilities: ProviderDynamicCapabilities): JSObject {
        return JSObject().apply {
            put("available", capabilities.available)
            capabilities.reason?.let { put("reason", it) }
            capabilities.streamingAvailable?.let { put("streamingAvailable", it) }
            capabilities.streamingUnavailableReason?.let { put("streamingUnavailableReason", it) }
            capabilities.cancellationAvailable?.let { put("cancellationAvailable", it) }
            capabilities.taskCapabilities?.let { put("taskCapabilities", encodeTaskAvailability(it)) }
        }
    }

    fun encodeStreamRunHandle(handle: StreamRunHandle): JSObject {
        return JSObject().apply {
            put("schemaVersion", handle.schemaVersion.rawValue)
            put("runId", handle.runId)
            put("startedAt", handle.startedAt)
            handle.providerId?.let { put("providerId", it) }
        }
    }

    /**
     * Note what is deliberately *not* here: a `when` over [StreamEvent.type].
     *
     * The inbound parsers in this file throw on an unrecognized enum value, and that is
     * right for them — those are closed contract enums on a request, where an unknown
     * value really is an invalid request. `type` is the opposite: stream-event.schema.json
     * closes its union with an explicit catch-all branch, and contracts/README.md requires
     * SDKs to treat an unrecognized type as ignore-or-pass-through rather than an error, so
     * that an additive minor revision does not break older consumers. Copying the
     * throw-on-unknown pattern here would turn the one mechanism protecting forward
     * compatibility into a guaranteed hard failure at the bridge hop. The type crosses as
     * the string it is.
     */
    fun encodeStreamEvent(event: StreamEvent): JSObject {
        return JSObject().apply {
            put("schemaVersion", event.schemaVersion.rawValue)
            put("runId", event.runId)
            put("sequence", event.sequence)
            put("timestamp", event.timestamp)
            put("type", event.type)
            event.payload?.let { put("payload", encodeStreamPayload(it)) }
        }
    }

    /**
     * quicktype flattens the event union, so [Payload] carries every branch's fields as
     * optionals. Emitting only the non-null ones is what reconstitutes the correct branch
     * on the JS side: each branch's `outcome` discriminator plus its required peer field
     * (finalText / error / partialText) is exactly the set that is populated.
     */
    private fun encodeStreamPayload(payload: Payload): JSObject {
        return JSObject().apply {
            payload.text?.let { put("text", it) }
            payload.phase?.let { put("phase", phaseValue(it)) }
            payload.providerId?.let { put("providerId", it) }
            payload.task?.let { put("task", it) }
            payload.fractionCompleted?.let { put("fractionCompleted", it) }
            payload.output?.let { put("output", encodeTaskOutput(it)) }
            payload.finalText?.let { put("finalText", it) }
            payload.finishReason?.let { put("finishReason", it.rawValue) }
            payload.outcome?.let { put("outcome", outcomeValue(it)) }
            payload.runId?.let { put("runId", it) }
            payload.schemaVersion?.let { put("schemaVersion", it.rawValue) }
            payload.telemetry?.let { put("telemetry", encodeStreamPayloadTelemetry(it)) }
            payload.usage?.let { put("usage", encodeStreamPayloadUsage(it)) }
            payload.error?.let { put("error", encodeStreamPayloadError(it)) }
            payload.partialText?.let { put("partialText", it) }
            payload.reason?.let { put("reason", it) }
            payload.provenance?.let { put("provenance", encodeProvenance(it)) }
        }
    }

    private fun encodeStreamPayloadError(error: PayloadError): JSObject {
        return JSObject().apply {
            put("schemaVersion", error.schemaVersion.rawValue)
            put("errorClass", error.errorClass.rawValue)
            put("message", error.message)
            error.providerId?.let { put("providerId", it) }
            error.retryable?.let { put("retryable", it) }
            error.retryAfterMs?.let { put("retryAfterMs", it) }
            error.details?.let { put("details", JSONObject(it)) }
            error.provenance?.let { put("provenance", encodeProvenance(it)) }
        }
    }

    private fun encodeStreamPayloadTelemetry(telemetry: PayloadTelemetry): JSObject {
        return JSObject().apply {
            put("providerUsed", telemetry.providerUsed)
            put("totalMs", telemetry.totalMs)
        }
    }

    private fun encodeStreamPayloadUsage(usage: PayloadUsage): JSObject {
        return JSObject().apply {
            usage.inputTokens?.let { put("inputTokens", it) }
            usage.outputTokens?.let { put("outputTokens", it) }
            usage.totalTokens?.let { put("totalTokens", it) }
        }
    }

    // Outcome and Phase are generated without a rawValue, unlike every other contract enum
    // here, so the wire strings have to be written out. Both `when`s are exhaustive with no
    // `else`: if a regeneration ever adds a constant, this must fail to compile rather than
    // silently serialize the wrong discriminator.
    private fun outcomeValue(outcome: Outcome): String = when (outcome) {
        Outcome.Completed -> "completed"
        Outcome.Error -> "error"
        Outcome.Cancelled -> "cancelled"
    }

    private fun phaseValue(phase: Phase): String = when (phase) {
        Phase.ProviderSelected -> "provider_selected"
        Phase.Started -> "started"
    }

    private fun parseOpenAIOptions(json: JSONObject): OpenAIProviderBootstrapOptions {
        return OpenAIProviderBootstrapOptions(
            models = json.getJSONArray("models").toStringList(),
            endpointUrl = json.optStringOrNull("endpointUrl"),
            auth = json.optStringOrNull("auth"),
            authContextRef = json.optStringOrNull("authContextRef"),
            timeoutMs = json.optLongOrNull("timeoutMs")
        )
    }

    private fun parseModelProfiles(json: JSONObject): Map<String, List<String>> {
        return buildMap {
            json.keys().forEach { name -> put(name, json.getJSONArray(name).toStringList()) }
        }
    }

    private fun parseConstraints(json: JSONObject): TaskRequestConstraints {
        return TaskRequestConstraints(
            cloud = json.optStringOrNull("cloud")?.let(::parseCloud),
            privacy = json.optStringOrNull("privacy")?.let(::parsePrivacy),
            timeoutMs = json.optLongOrNull("timeoutMs")
        )
    }

    private fun parseGeneration(json: JSONObject): Generation {
        return Generation(
            maxOutputTokens = json.optLongOrNull("maxOutputTokens"),
            seed = json.optLongOrNull("seed"),
            stop = json.optJSONArray("stop")?.toStringList(),
            temperature = json.optDoubleOrNull("temperature"),
            topP = json.optDoubleOrNull("topP")
        )
    }

    private fun parseMessages(json: JSONArray): List<Message> {
        return buildList {
            for (index in 0 until json.length()) {
                val message = json.getJSONObject(index)
                add(
                    Message(
                        role = parseRole(message.getString("role")),
                        content = message.getString("content")
                    )
                )
            }
        }
    }

    private fun parsePreferences(json: JSONObject): TaskRequestPreferences {
        return TaskRequestPreferences(
            optimizeFor = json.optStringOrNull("optimizeFor")?.let(::parseOptimizeFor)
        )
    }

    private fun parseTask(json: JSONObject): TaskRequestTask {
        return TaskRequestTask(kind = parseTaskKind(json.getString("kind")))
    }

    private fun parseTelemetry(json: JSONObject): TaskRequestTelemetry {
        return TaskRequestTelemetry(
            consent = json.optBooleanOrNull("consent"),
            level = json.optStringOrNull("level")?.let(::parseTelemetryLevel),
            tags = json.optJSONObject("tags")?.toStringMap()
        )
    }

    private fun parseSchemaVersion(value: String): SchemaVersion {
        return when (value) {
            "1.0" -> SchemaVersion.V1_0
            else -> throw IllegalArgumentException("Unsupported schemaVersion '$value'.")
        }
    }

    private fun parseCloud(value: String): Cloud {
        return when (value) {
            "allowed" -> Cloud.Allowed
            "forbidden" -> Cloud.Forbidden
            "required" -> Cloud.Required
            else -> throw IllegalArgumentException("Unsupported cloud constraint '$value'.")
        }
    }

    private fun parsePrivacy(value: String): Privacy {
        return when (value) {
            "local_required" -> Privacy.LocalRequired
            "local_preferred" -> Privacy.LocalPreferred
            "cloud_allowed" -> Privacy.CloudAllowed
            "cloud_required" -> Privacy.CloudRequired
            else -> throw IllegalArgumentException("Unsupported privacy constraint '$value'.")
        }
    }

    private fun parseRole(value: String): MessageRole {
        return when (value) {
            "assistant" -> MessageRole.ASSISTANT
            "system" -> MessageRole.SYSTEM
            "user" -> MessageRole.USER
            else -> throw IllegalArgumentException("Unsupported message role '$value'.")
        }
    }

    private fun parseOptimizeFor(value: String): OptimizeFor {
        return when (value) {
            "balanced" -> OptimizeFor.Balanced
            "cost" -> OptimizeFor.Cost
            "latency" -> OptimizeFor.Latency
            "privacy" -> OptimizeFor.Privacy
            else -> throw IllegalArgumentException("Unsupported optimizeFor '$value'.")
        }
    }

    private fun parseTaskKind(value: String): TaskKind = parseEnum(value, "task kind", TaskKind::fromRawValue)

    private fun parsePrepareVoice(json: JSONObject): PrepareVoice {
        return PrepareVoice(
            gender = json.optStringOrNull("gender")?.let { parseEnum(it, "voice gender", VoiceGender::fromRawValue) },
            id = json.optStringOrNull("id"),
            providerId = json.optStringOrNull("providerId")
        )
    }

    private fun parseLocaleMatch(value: String): LocaleMatch = parseEnum(value, "localeMatch", LocaleMatch::fromRawValue)

    /** Reads a wire string through the generated enum's own `fromRawValue`, never a hand-kept table. */
    private fun <T> parseEnum(value: String, name: String, fromRawValue: (String) -> T?): T {
        return fromRawValue(value) ?: throw IllegalArgumentException("Unsupported $name '$value'.")
    }

    private fun parseTelemetryLevel(value: String): TelemetryLevel {
        return when (value) {
            "debug" -> TelemetryLevel.DEBUG
            "minimal" -> TelemetryLevel.MINIMAL
            "off" -> TelemetryLevel.OFF
            else -> throw IllegalArgumentException("Unsupported telemetry level '$value'.")
        }
    }
}

private fun JSONObject.optStringOrNull(key: String): String? {
    return if (has(key) && !isNull(key)) getString(key) else null
}

private fun JSONObject.optLongOrNull(key: String): Long? {
    return if (has(key) && !isNull(key)) getLong(key) else null
}

private fun JSONObject.optDoubleOrNull(key: String): Double? {
    return if (has(key) && !isNull(key)) getDouble(key) else null
}

private fun JSONObject.optBooleanOrNull(key: String): Boolean? {
    return if (has(key) && !isNull(key)) getBoolean(key) else null
}

private fun JSONObject.toStringMap(): Map<String, String> {
    val result = linkedMapOf<String, String>()
    val keys = keys()
    while (keys.hasNext()) {
        val key = keys.next()
        result[key] = getString(key)
    }
    return result
}

private fun JSONArray.toStringList(): List<String> {
    return buildList {
        for (index in 0 until length()) {
            add(getString(index))
        }
    }
}
