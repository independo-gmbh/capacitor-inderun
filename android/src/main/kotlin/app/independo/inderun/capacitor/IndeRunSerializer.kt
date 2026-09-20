package app.independo.inderun.capacitor

import app.independo.inderun.contracts.Cloud
import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.Generation
import app.independo.inderun.contracts.IndeRunError
import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.Message
import app.independo.inderun.contracts.MessageRole
import app.independo.inderun.contracts.OptimizeFor
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.OutputType
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PayloadError
import app.independo.inderun.contracts.PayloadTelemetry
import app.independo.inderun.contracts.PayloadUsage
import app.independo.inderun.contracts.Phase
import app.independo.inderun.contracts.PrivacyEnum
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.StreamRunHandle
import app.independo.inderun.contracts.TaskKind
import app.independo.inderun.contracts.TaskRequest
import app.independo.inderun.contracts.TaskRequestConstraints
import app.independo.inderun.contracts.TaskRequestPreferences
import app.independo.inderun.contracts.TaskRequestTask
import app.independo.inderun.contracts.TaskRequestTelemetry
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.contracts.TaskResultTelemetry
import app.independo.inderun.contracts.TelemetryLevel
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject

data class OpenAIProviderBootstrapOptions(
    val model: String,
    val endpointUrl: String? = null,
    val auth: String? = null,
    val authContextRef: String? = null,
    val timeoutMs: Long? = null
)

data class RunOptions(
    val openAI: OpenAIProviderBootstrapOptions? = null
)

object IndeRunSerializer {
    fun parseConfigureOptions(json: JSONObject): RunOptions {
        return RunOptions(
            openAI = json.optJSONObject("openAI")?.let(::parseOpenAIOptions)
        )
    }

    fun parseTaskRequest(json: JSONObject): TaskRequest {
        return TaskRequest(
            authContextRef = json.optStringOrNull("authContextRef"),
            constraints = json.optJSONObject("constraints")?.let(::parseConstraints),
            generation = json.optJSONObject("generation")?.let(::parseGeneration),
            messages = json.optJSONArray("messages")?.let(::parseMessages),
            preferences = json.optJSONObject("preferences")?.let(::parsePreferences),
            prompt = json.optStringOrNull("prompt"),
            requestId = json.optStringOrNull("requestId"),
            schemaVersion = parseSchemaVersion(json.getString("schemaVersion")),
            task = parseTask(json.getJSONObject("task")),
            telemetry = json.optJSONObject("telemetry")?.let(::parseTelemetry)
        )
    }

    fun encodeTaskResult(result: TaskResult): JSObject {
        return JSObject().apply {
            put("schemaVersion", result.schemaVersion.rawValue)
            put("runId", result.runId)
            put("finishReason", result.finishReason.rawValue)
            put(
                "output",
                JSObject()
                    .put("type", result.output.type.rawValue)
                    .put("text", result.output.text)
            )
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
            model = json.getString("model"),
            endpointUrl = json.optStringOrNull("endpointUrl"),
            auth = json.optStringOrNull("auth"),
            authContextRef = json.optStringOrNull("authContextRef"),
            timeoutMs = json.optLongOrNull("timeoutMs")
        )
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

    private fun parsePrivacy(value: String): PrivacyEnum {
        return when (value) {
            "local_required" -> PrivacyEnum.LocalRequired
            "local_preferred" -> PrivacyEnum.LocalPreferred
            "cloud_allowed" -> PrivacyEnum.CloudAllowed
            "cloud_required" -> PrivacyEnum.CloudRequired
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

    private fun parseTaskKind(value: String): TaskKind {
        return when (value) {
            "text_to_text" -> TaskKind.TEXT_TO_TEXT
            else -> throw IllegalArgumentException("Unsupported task kind '$value'.")
        }
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
