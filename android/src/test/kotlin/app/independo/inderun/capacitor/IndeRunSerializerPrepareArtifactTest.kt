package app.independo.inderun.capacitor

import app.independo.inderun.contracts.ArtifactLifetime
import app.independo.inderun.contracts.ArtifactOwner
import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.LocaleMatch
import app.independo.inderun.contracts.MediaArtifact
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PreparationItem
import app.independo.inderun.contracts.PreparationStatus
import app.independo.inderun.contracts.Privacy
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.TaskOutput
import app.independo.inderun.contracts.TaskOutputType
import app.independo.inderun.contracts.VoiceGender
import app.independo.inderun.core.ArtifactChunk
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/**
 * The prepare and artifact halves of the wire format: what `startPrepare`, `readArtifact` and
 * `disposeArtifact` parse, and what their results and events encode to.
 */
class IndeRunSerializerPrepareArtifactTest {

    private fun keysOf(json: JSONObject): Set<String> = json.keys().asSequence().toSet()

    @Test
    fun `parsePrepareRequest reads every field with its wire spelling`() {
        val request = IndeRunSerializer.parsePrepareRequest(
            JSONObject(
                """
                {
                  "allowDownload": true,
                  "locale": "de-AT",
                  "localeMatch": "language",
                  "privacy": "local_required",
                  "requestId": "prepare_1",
                  "tasks": ["text_to_speech"],
                  "voice": { "gender": "female", "id": "voice_1", "providerId": "local.speech" }
                }
                """.trimIndent()
            )
        )

        assertEquals(true, request.allowDownload)
        assertEquals("de-AT", request.locale)
        assertEquals(LocaleMatch.Language, request.localeMatch)
        assertEquals(Privacy.LocalRequired, request.privacy)
        assertEquals("prepare_1", request.requestId)
        assertEquals(listOf("text_to_speech"), request.tasks)
        assertEquals(VoiceGender.Female, request.voice?.gender)
        assertEquals("voice_1", request.voice?.id)
        assertEquals("local.speech", request.voice?.providerId)
    }

    @Test
    fun `parsePrepareRequest accepts the empty request that covers every provider`() {
        val request = IndeRunSerializer.parsePrepareRequest(JSONObject("{}"))

        assertNull(request.allowDownload)
        assertNull(request.tasks)
        assertNull(request.voice)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `parsePrepareRequest throws on an unknown localeMatch`() {
        IndeRunSerializer.parsePrepareRequest(JSONObject("""{ "localeMatch": "fuzzy" }"""))
    }

    @Test
    fun `parseArtifactReadRequest reads the range`() {
        val request = IndeRunSerializer.parseArtifactReadRequest(
            JSONObject("""{ "artifactId": "artifact_1", "offset": 1024, "maxBytes": 4096 }""")
        )

        assertEquals("artifact_1", request.artifactId)
        assertEquals(1024L, request.offset)
        assertEquals(4096L, request.maxBytes)
    }

    @Test
    fun `parseMediaArtifact reads an engine-owned artifact`() {
        val artifact = IndeRunSerializer.parseMediaArtifact(
            JSONObject(
                """
                {
                  "id": "artifact_1",
                  "owner": "engine",
                  "lifetime": "until_disposed",
                  "mediaType": "audio/wav",
                  "byteLength": 4,
                  "durationMs": 125.5
                }
                """.trimIndent()
            )
        )

        assertEquals(
            MediaArtifact(
                byteLength = 4,
                durationMs = 125.5,
                id = "artifact_1",
                lifetime = ArtifactLifetime.UntilDisposed,
                mediaType = "audio/wav",
                owner = ArtifactOwner.Engine
            ),
            artifact
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `parseMediaArtifact throws on an unknown owner`() {
        IndeRunSerializer.parseMediaArtifact(
            JSONObject("""{ "id": "a", "owner": "nobody", "lifetime": "until_disposed", "mediaType": "audio/wav" }""")
        )
    }

    @Test
    fun `encodeArtifactChunk sends the bytes as base64`() {
        val bytes = byteArrayOf(0, 1, 2, -1)
        val encoded = IndeRunSerializer.encodeArtifactChunk(
            ArtifactChunk(artifactId = "artifact_1", offset = 0, bytes = bytes, totalBytes = 4, done = true)
        )

        assertEquals(setOf("artifactId", "offset", "bytes", "totalBytes", "done"), keysOf(encoded))
        assertEquals("AAEC/w==", encoded.getString("bytes"))
        assertArrayEquals(bytes, Base64.getDecoder().decode(encoded.getString("bytes")))
        assertEquals(0L, encoded.getLong("offset"))
        assertEquals(4L, encoded.getLong("totalBytes"))
        assertEquals(true, encoded.getBoolean("done"))
    }

    @Test
    fun `encodeArtifactChunk sends an empty range at the end as an empty string`() {
        val encoded = IndeRunSerializer.encodeArtifactChunk(
            ArtifactChunk(artifactId = "artifact_1", offset = 4, bytes = ByteArray(0), totalBytes = 4, done = true)
        )

        assertEquals("", encoded.getString("bytes"))
    }

    @Test
    fun `encodeTaskOutput writes an artifact reference with only its set fields`() {
        val encoded = IndeRunSerializer.encodeTaskOutput(
            TaskOutput(
                artifact = MediaArtifact(
                    id = "artifact_1",
                    lifetime = ArtifactLifetime.UntilDisposed,
                    mediaType = "audio/wav",
                    owner = ArtifactOwner.Engine
                ),
                type = TaskOutputType.ARTIFACT
            )
        )

        assertEquals(setOf("type", "artifact"), keysOf(encoded))
        assertEquals("artifact", encoded.getString("type"))
        val artifact = encoded.getJSONObject("artifact")
        assertEquals(setOf("id", "owner", "lifetime", "mediaType"), keysOf(artifact))
        assertEquals("engine", artifact.getString("owner"))
        assertEquals("until_disposed", artifact.getString("lifetime"))
    }

    @Test
    fun `encodes a preparation progress event with its provider, task and fraction`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            StreamEvent(
                payload = Payload(providerId = "local.speech", task = "text_to_speech", fractionCompleted = 0.5),
                runId = "prepare_1",
                schemaVersion = SchemaVersion.V1_0,
                sequence = 0,
                timestamp = 1_700_000_000_000.0,
                type = "preparation_progress"
            )
        )

        val payload = encoded.getJSONObject("payload")
        assertEquals(setOf("providerId", "task", "fractionCompleted"), keysOf(payload))
        assertEquals("local.speech", payload.getString("providerId"))
        assertEquals("text_to_speech", payload.getString("task"))
        assertEquals(0.5, payload.getDouble("fractionCompleted"), 0.0)
    }

    @Test
    fun `encodes a prepare terminal with its preparation items`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            StreamEvent(
                payload = Payload(
                    finishReason = FinishReason.STOP,
                    outcome = Outcome.Completed,
                    output = TaskOutput(
                        preparation = listOf(
                            PreparationItem(
                                providerId = "local.speech",
                                status = PreparationStatus.AlreadyReady,
                                task = "text_to_speech"
                            ),
                            PreparationItem(
                                providerId = "cloud.speech",
                                reason = "download not allowed",
                                status = PreparationStatus.Skipped,
                                task = "text_to_speech",
                                voiceId = "voice_1"
                            )
                        ),
                        type = TaskOutputType.PREPARED
                    ),
                    runId = "prepare_1",
                    schemaVersion = SchemaVersion.V1_0
                ),
                runId = "prepare_1",
                schemaVersion = SchemaVersion.V1_0,
                sequence = 1,
                timestamp = 1_700_000_000_001.0,
                type = "terminal"
            )
        )

        val payload = encoded.getJSONObject("payload")
        assertEquals("completed", payload.getString("outcome"))
        val output = payload.getJSONObject("output")
        assertEquals(setOf("type", "preparation"), keysOf(output))
        assertEquals("prepared", output.getString("type"))
        val items = output.getJSONArray("preparation")
        assertEquals(2, items.length())
        assertEquals(setOf("providerId", "task", "status"), keysOf(items.getJSONObject(0)))
        assertEquals("already_ready", items.getJSONObject(0).getString("status"))
        assertEquals("skipped", items.getJSONObject(1).getString("status"))
        assertEquals("voice_1", items.getJSONObject(1).getString("voiceId"))
        assertEquals("download not allowed", items.getJSONObject(1).getString("reason"))
    }
}
