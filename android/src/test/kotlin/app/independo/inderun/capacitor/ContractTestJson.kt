package app.independo.inderun.capacitor

import app.independo.inderun.contracts.ArtifactLifetime
import app.independo.inderun.contracts.ArtifactOwner
import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.MediaArtifact
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PlaybackOutput
import app.independo.inderun.contracts.PlaybackTiming
import app.independo.inderun.contracts.RequestedNumber
import app.independo.inderun.contracts.RequestedUnitNumber
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.SpeechControlId
import app.independo.inderun.contracts.SpeechControlMethod
import app.independo.inderun.contracts.SpeechControlOutcome
import app.independo.inderun.contracts.SpeechControlOutcomeReason
import app.independo.inderun.contracts.SpeechControlStatus
import app.independo.inderun.contracts.SpeechOutput
import app.independo.inderun.contracts.SpeechOutputVoice
import app.independo.inderun.contracts.TaskOutput
import app.independo.inderun.contracts.TaskOutputType
import app.independo.inderun.contracts.TaskRequest
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.contracts.TaskResultTelemetry
import app.independo.inderun.contracts.VoiceGender
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import java.io.File

/**
 * Test-side JSON helpers shared by the serializer suites: structural comparison, an encoder for
 * the request fields the bridge parses, and decoders for the result and terminal shapes the
 * engine hands the bridge. The production serializer only parses requests and only encodes
 * results, so the tests need the opposite directions to round-trip either one.
 */

/**
 * Structural JSON equality. The unit tests compile against android.jar's `org.json`, which has
 * no `similar`, so both sides become plain maps, lists and doubles first.
 */
internal fun plainJson(value: Any?): Any? = when (value) {
    is JSONObject -> value.keys().asSequence().associateWith { plainJson(value.get(it)) }
    is JSONArray -> List(value.length()) { plainJson(value.get(it)) }
    is Number -> value.toDouble()
    else -> value
}

internal fun assertSameJson(message: String, expected: JSONObject, actual: JSONObject) {
    assertEquals(message, plainJson(expected), plainJson(actual))
}

/**
 * The vendored task-contract fixture (`test-fixtures/task-contracts/`, provenance in its README),
 * read from the repository root, which is one level above this Gradle project: it is the one copy
 * the JS and both native suites share, so it is never copied into the test resources.
 */
internal fun taskContractFixture(name: String): JSONObject {
    val file = File(System.getProperty("user.dir"), "../test-fixtures/task-contracts/$name").canonicalFile
    check(file.isFile) { "Vendored task-contract fixture not found at $file" }
    return JSONObject(file.readText())
}

internal fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }

/** Every request field the bridge parses, each only when set, with its wire spelling. */
internal fun encodeRequestForTest(request: TaskRequest): JSONObject = JSONObject().apply {
    put("schemaVersion", request.schemaVersion.rawValue)
    put("task", JSONObject().put("kind", request.task.kind.rawValue))
    request.prompt?.let { put("prompt", it) }
    request.speech?.let { speech ->
        put(
            "speech",
            JSONObject().apply {
                put("text", speech.text)
                put("locale", speech.locale)
                speech.localeMatch?.let { put("localeMatch", it.rawValue) }
                speech.voice?.let { voice ->
                    put(
                        "voice",
                        JSONObject().apply {
                            voice.providerId?.let { put("providerId", it) }
                            voice.id?.let { put("id", it) }
                            voice.gender?.let { put("gender", it.rawValue) }
                            voice.requirement?.let { put("requirement", it.rawValue) }
                        }
                    )
                }
                speech.controls?.let { controls ->
                    put(
                        "controls",
                        JSONObject().apply {
                            controls.speakingRate?.let { put("speakingRate", encodeRequestedNumber(it)) }
                            controls.pitch?.let { put("pitch", encodeRequestedNumber(it)) }
                        }
                    )
                }
            }
        )
    }
    request.delivery?.let { delivery ->
        put(
            "delivery",
            JSONObject().apply {
                put("mode", delivery.mode.rawValue)
                delivery.mediaTypes?.let { put("mediaTypes", JSONArray(it)) }
                delivery.destinationRef?.let { put("destinationRef", it) }
                delivery.playback?.let { playback ->
                    put(
                        "playback",
                        JSONObject().apply { playback.volume?.let { put("volume", encodeRequestedUnitNumber(it)) } }
                    )
                }
            }
        )
    }
    request.modelProfile?.let { put("modelProfile", it) }
    request.authContextRef?.let { put("authContextRef", it) }
    request.requestId?.let { put("requestId", it) }
    request.constraints?.let { constraints ->
        put(
            "constraints",
            JSONObject().apply {
                constraints.cloud?.let { put("cloud", it.rawValue) }
                constraints.privacy?.let { put("privacy", it.rawValue) }
                constraints.timeoutMs?.let { put("timeoutMs", it) }
            }
        )
    }
    request.preferences?.let { preferences ->
        put("preferences", JSONObject().apply { preferences.optimizeFor?.let { put("optimizeFor", it.rawValue) } })
    }
}

private fun encodeRequestedNumber(number: RequestedNumber): JSONObject = JSONObject().apply {
    put("value", number.value)
    number.requirement?.let { put("requirement", it.rawValue) }
}

private fun encodeRequestedUnitNumber(number: RequestedUnitNumber): JSONObject = JSONObject().apply {
    put("value", number.value)
    number.requirement?.let { put("requirement", it.rawValue) }
}

/** The fixture's result shape, decoded into the contract type the engine returns. */
internal fun decodeResultForTest(json: JSONObject): TaskResult {
    val telemetry = json.getJSONObject("telemetry")
    return TaskResult(
        finishReason = checkNotNull(FinishReason.fromRawValue(json.getString("finishReason"))),
        output = decodeOutputForTest(json.getJSONObject("output")),
        runId = json.getString("runId"),
        schemaVersion = checkNotNull(SchemaVersion.fromRawValue(json.getString("schemaVersion"))),
        telemetry = TaskResultTelemetry(providerUsed = telemetry.getString("providerUsed"), totalMs = telemetry.getDouble("totalMs"))
    )
}

/** The fixture's terminal payload shape (`outcome`, `runId`, `output`, `reason`). */
internal fun decodeTerminalPayloadForTest(json: JSONObject): Payload = Payload(
    outcome = when (json.getString("outcome")) {
        "completed" -> Outcome.Completed
        "error" -> Outcome.Error
        "cancelled" -> Outcome.Cancelled
        else -> error("Unknown outcome ${json.getString("outcome")}")
    },
    output = json.optJSONObject("output")?.let(::decodeOutputForTest),
    reason = json.optString("reason").takeIf { json.has("reason") },
    runId = json.getString("runId"),
    schemaVersion = checkNotNull(SchemaVersion.fromRawValue(json.getString("schemaVersion")))
)

internal fun decodeOutputForTest(json: JSONObject): TaskOutput = TaskOutput(
    type = checkNotNull(TaskOutputType.fromRawValue(json.getString("type"))),
    text = if (json.has("text")) json.getString("text") else null,
    artifact = json.optJSONObject("artifact")?.let { artifact ->
        MediaArtifact(
            byteLength = if (artifact.has("byteLength")) artifact.getLong("byteLength") else null,
            durationMs = if (artifact.has("durationMs")) artifact.getDouble("durationMs") else null,
            id = artifact.getString("id"),
            lifetime = checkNotNull(ArtifactLifetime.fromRawValue(artifact.getString("lifetime"))),
            mediaType = artifact.getString("mediaType"),
            owner = checkNotNull(ArtifactOwner.fromRawValue(artifact.getString("owner")))
        )
    },
    playback = json.optJSONObject("playback")?.let { playback ->
        PlaybackOutput(
            timing = playback.optJSONObject("timing")?.let { timing ->
                PlaybackTiming(
                    durationMs = if (timing.has("durationMs")) timing.getDouble("durationMs") else null,
                    firstAudioMs = if (timing.has("firstAudioMs")) timing.getDouble("firstAudioMs") else null,
                    firstChunkMs = if (timing.has("firstChunkMs")) timing.getDouble("firstChunkMs") else null
                )
            }
        )
    },
    speech = json.optJSONObject("speech")?.let { speech ->
        SpeechOutput(
            locale = speech.getString("locale"),
            voice = speech.optJSONObject("voice")?.let { voice ->
                SpeechOutputVoice(
                    gender = if (voice.has("gender")) checkNotNull(VoiceGender.fromRawValue(voice.getString("gender"))) else null,
                    id = if (voice.has("id")) voice.getString("id") else null,
                    name = if (voice.has("name")) voice.getString("name") else null
                )
            },
            controls = speech.optJSONArray("controls")?.objects()?.map { control ->
                SpeechControlOutcome(
                    effective = if (control.has("effective")) control.getDouble("effective") else null,
                    id = checkNotNull(SpeechControlId.fromRawValue(control.getString("id"))),
                    method = if (control.has("method")) checkNotNull(SpeechControlMethod.fromRawValue(control.getString("method"))) else null,
                    reason = if (control.has("reason")) checkNotNull(SpeechControlOutcomeReason.fromRawValue(control.getString("reason"))) else null,
                    requested = control.getDouble("requested"),
                    status = checkNotNull(SpeechControlStatus.fromRawValue(control.getString("status")))
                )
            }
        )
    }
)
