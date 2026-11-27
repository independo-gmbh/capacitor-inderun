package app.independo.inderun.capacitor

import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.Format
import app.independo.inderun.contracts.FrontendKind
import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.LocaleMatch
import app.independo.inderun.contracts.OutputDelivery
import app.independo.inderun.contracts.PlaybackOutput
import app.independo.inderun.contracts.PlaybackTiming
import app.independo.inderun.contracts.RequirementLevel
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.SourceType
import app.independo.inderun.contracts.SpeechOutput
import app.independo.inderun.contracts.SpeechOutputVoice
import app.independo.inderun.contracts.TaskKind
import app.independo.inderun.contracts.TaskOutput
import app.independo.inderun.contracts.TaskOutputType
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.contracts.TaskResultTelemetry
import app.independo.inderun.contracts.VoiceGender
import app.independo.inderun.core.IndeRunException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The speech half of the wire format: `text_to_speech` requests, the playback and artifact
 * results they produce, and the `systemSpeech` / `neuralSpeech` configure options.
 */
class IndeRunSerializerSpeechTest {

    /**
     * The cross-SDK facade vectors (`contracts/fixtures/facade/speech.json` at inderun
     * 99ce979, contract 1.1): the `expected` request of each case is what `speak()` /
     * `generateSpeech()` hand the bridge, so it must parse into the contract without losing a
     * field. They follow the facade split (ADR 025): `speak` carries `delivery.playback`,
     * `generateSpeech` never does.
     */
    private fun speechVectors(): List<JSONObject> {
        val text = checkNotNull(javaClass.getResource("/fixtures/facade-speech.json")).readText()
        val cases = JSONObject(text).getJSONArray("cases")
        return List(cases.length()) { cases.getJSONObject(it) }
    }

    @Test
    fun `every cross-SDK speech vector parses and round-trips without losing a field`() {
        val vectors = speechVectors()
        assertTrue(vectors.isNotEmpty())
        // The 1.1 vectors that put controls on both calls and a volume on speak.
        assertTrue(vectors.any { it.getJSONObject("expected").getJSONObject("delivery").has("playback") })
        assertTrue(vectors.any { it.getString("call") == "generateSpeech" && it.getJSONObject("expected").getJSONObject("speech").has("controls") })

        for (vector in vectors) {
            val expected = vector.getJSONObject("expected")
            val request = IndeRunSerializer.parseTaskRequest(JSONObject(expected.toString()))

            assertEquals(vector.getString("id"), TaskKind.TEXT_TO_SPEECH, request.task.kind)
            val mode = if (vector.getString("call") == "speak") OutputDelivery.Playback else OutputDelivery.Artifact
            assertEquals(vector.getString("id"), mode, request.delivery?.mode)
            assertSameJson(vector.getString("id"), expected, encodeRequestForTest(request))
            if (mode == OutputDelivery.Artifact) assertNull(vector.getString("id"), request.delivery?.playback)
        }
    }

    @Test
    fun `a required catalog voice keeps every field with its wire spelling`() {
        val request = IndeRunSerializer.parseTaskRequest(
            JSONObject(
                """
                {
                  "schemaVersion": "1.1",
                  "task": { "kind": "text_to_speech" },
                  "speech": {
                    "text": "Servus", "locale": "de-AT", "localeMatch": "exact",
                    "voice": { "providerId": "android_system_speech", "id": "de-at-x-sfs", "gender": "female", "requirement": "required" }
                  },
                  "delivery": { "mode": "artifact", "mediaTypes": ["audio/wav"], "destinationRef": "dest_1" }
                }
                """.trimIndent()
            )
        )

        val speech = checkNotNull(request.speech)
        assertEquals("Servus", speech.text)
        assertEquals(LocaleMatch.Exact, speech.localeMatch)
        assertEquals("android_system_speech", speech.voice?.providerId)
        assertEquals("de-at-x-sfs", speech.voice?.id)
        assertEquals(VoiceGender.Female, speech.voice?.gender)
        assertEquals(RequirementLevel.Required, speech.voice?.requirement)
        assertEquals(listOf("audio/wav"), request.delivery?.mediaTypes)
        assertEquals("dest_1", request.delivery?.destinationRef)
    }

    @Test
    fun `an unknown delivery mode or task kind is refused rather than guessed`() {
        val base = """{ "schemaVersion": "1.1", "speech": { "text": "Hallo", "locale": "de-DE" }"""
        assertThrows(IllegalArgumentException::class.java) {
            IndeRunSerializer.parseTaskRequest(
                JSONObject("""$base, "task": { "kind": "text_to_speech" }, "delivery": { "mode": "broadcast" } }""")
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            IndeRunSerializer.parseTaskRequest(JSONObject("""$base, "task": { "kind": "speech_to_text" } }"""))
        }
    }

    @Test
    fun `a playback completion result encodes its timing and the voice used`() {
        val encoded = IndeRunSerializer.encodeTaskResult(
            TaskResult(
                finishReason = FinishReason.STOP,
                output = TaskOutput(
                    playback = PlaybackOutput(timing = PlaybackTiming(durationMs = 900.0, firstAudioMs = 120.0)),
                    speech = SpeechOutput(locale = "de-AT", voice = SpeechOutputVoice(id = "lena", name = "Lena")),
                    type = TaskOutputType.PLAYBACK
                ),
                runId = "run_speak",
                schemaVersion = SchemaVersion.V1_1,
                telemetry = TaskResultTelemetry(providerUsed = "android_system_speech", totalMs = 950.0)
            )
        )

        val output = encoded.getJSONObject("output")
        assertSameJson(
            "playback output",
            JSONObject(
                """
                {
                  "type": "playback",
                  "playback": { "timing": { "durationMs": 900.0, "firstAudioMs": 120.0 } },
                  "speech": { "locale": "de-AT", "voice": { "id": "lena", "name": "Lena" } }
                }
                """.trimIndent()
            ),
            output
        )
        assertFalse(output.has("text"))
        assertFalse(output.has("artifact"))
    }

    // configure options

    private val speechPackage = """
        {
          "id": "articulino",
          "format": "onnx",
          "version": "1.0.0",
          "variant": "int8",
          "tasks": ["text_to_speech"],
          "source": { "sourceType": "filesystem", "ref": "/data/models/articulino" },
          "files": { "required": ["text.onnx"], "external": ["text.onnx.data"], "config": "config.json", "tokenizer": "tokenizer.json" },
          "integrity": { "checksums": { "text.onnx": "sha256:abc" } },
          "license": { "spdx": "MIT", "url": "https://example.test/license" },
          "limits": { "diskBytes": 1000, "memBytes": 2000 },
          "runtime": { "platforms": ["android"], "minOpset": 17, "minOsVersion": "26", "minRuntimeVersion": "1.20" },
          "speech": {
            "pipeline": "articulino",
            "sampleRate": 44100,
            "channels": 1,
            "graphs": { "text": "text.onnx", "vocoder": "vocoder.onnx" },
            "frontend": { "kind": "phoneme", "assets": { "lexicon": "lexicon.txt" }, "license": { "spdx": "CC-BY-4.0" } },
            "voices": [
              { "id": "lena", "name": "Lena", "locales": ["de-AT", "de-DE"], "gender": "female", "file": "voices/lena.safetensors", "license": { "url": "https://example.test/lena" } }
            ]
          }
        }
    """.trimIndent()

    @Test
    fun `systemSpeech reads true or an options object, and is off unless asked for`() {
        assertEquals(SystemSpeechBootstrapOptions(), IndeRunSerializer.parseConfigureOptions(JSONObject("""{ "systemSpeech": true }""")).systemSpeech)
        assertEquals(
            SystemSpeechBootstrapOptions(id = "speech.android"),
            IndeRunSerializer.parseConfigureOptions(JSONObject("""{ "systemSpeech": { "id": "speech.android" } }""")).systemSpeech
        )
        assertNull(IndeRunSerializer.parseConfigureOptions(JSONObject("""{ "systemSpeech": false }""")).systemSpeech)
        assertNull(IndeRunSerializer.parseConfigureOptions(JSONObject("{}")).systemSpeech)
        assertNull(IndeRunSerializer.parseConfigureOptions(JSONObject("{}")).neuralSpeech)
    }

    @Test
    fun `a neuralSpeech entry carries every model package field to the provider`() {
        val options = IndeRunSerializer.parseConfigureOptions(
            JSONObject(
                """
                { "neuralSpeech": [
                  { "modelPackage": $speechPackage },
                  { "modelPackage": $speechPackage, "runtime": "onnx", "id": "speech.neural", "timeoutMs": 8000, "autoDownload": true }
                ] }
                """.trimIndent()
            )
        )

        val (plain, tuned) = checkNotNull(options.neuralSpeech)
        assertNull(plain.id)
        assertNull(plain.timeoutMs)
        assertNull(plain.autoDownload)
        assertEquals("speech.neural", tuned.id)
        assertEquals(8000L, tuned.timeoutMs)
        assertEquals(true, tuned.autoDownload)

        val pkg = plain.modelPackage
        assertEquals("articulino", pkg.id)
        assertEquals(Format.Onnx, pkg.format)
        assertEquals("1.0.0", pkg.version)
        assertEquals("int8", pkg.variant)
        assertEquals(listOf("text_to_speech"), pkg.tasks)
        assertEquals(SourceType.Filesystem, pkg.source?.sourceType)
        assertEquals("/data/models/articulino", pkg.source?.ref)
        assertEquals(listOf("text.onnx"), pkg.files?.required)
        assertEquals(listOf("text.onnx.data"), pkg.files?.external)
        assertEquals("config.json", pkg.files?.config)
        assertEquals("tokenizer.json", pkg.files?.tokenizer)
        assertEquals(mapOf("text.onnx" to "sha256:abc"), pkg.integrity?.checksums)
        assertEquals("MIT", pkg.license?.spdx)
        assertEquals(2000L, pkg.limits?.memBytes)
        assertEquals(1000L, pkg.limits?.diskBytes)
        assertEquals(listOf("android"), pkg.runtime?.platforms)
        assertEquals(17L, pkg.runtime?.minOpset)

        val speech = checkNotNull(pkg.speech)
        assertEquals("articulino", speech.pipeline)
        assertEquals(44100L, speech.sampleRate)
        assertEquals(1L, speech.channels)
        assertEquals(mapOf("text" to "text.onnx", "vocoder" to "vocoder.onnx"), speech.graphs)
        assertEquals(FrontendKind.Phoneme, speech.frontend?.kind)
        assertEquals(mapOf("lexicon" to "lexicon.txt"), speech.frontend?.assets)
        assertEquals("CC-BY-4.0", speech.frontend?.license?.spdx)
        val voice = speech.voices.single()
        assertEquals("lena", voice.id)
        assertEquals("Lena", voice.name)
        assertEquals(listOf("de-AT", "de-DE"), voice.locales)
        assertEquals(VoiceGender.Female, voice.gender)
        assertEquals("voices/lena.safetensors", voice.file)
        assertEquals("https://example.test/lena", voice.license?.url)
    }

    @Test
    fun `the coreai runtime is refused at configure`() {
        val error = assertThrows(IndeRunException::class.java) {
            IndeRunSerializer.parseConfigureOptions(
                JSONObject("""{ "neuralSpeech": [{ "modelPackage": $speechPackage, "runtime": "coreai" }] }""")
            )
        }

        val contractError = error.toContractError()
        assertEquals(IndeRunErrorClass.Internal, contractError.errorClass)
        assertEquals("coreai neural speech runtime is not available on this platform", contractError.message)
    }
}
