package app.independo.inderun.capacitor

import app.independo.inderun.contracts.AttemptOutcome
import app.independo.inderun.contracts.Code
import app.independo.inderun.contracts.ExecutionProvenance
import app.independo.inderun.contracts.ExecutionProvenanceAttempt
import app.independo.inderun.contracts.ExecutionProvenanceRouteRejection
import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.IndeRunError
import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.Locality
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.Output
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PayloadError
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.contracts.TaskResultTelemetry
import app.independo.inderun.core.ProviderCapabilitySnapshot
import app.independo.inderun.core.ProviderDescriptor
import app.independo.inderun.core.ProviderDynamicCapabilities
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The Android serializer maps every field by hand, so a field it does not name is dropped at the
 * bridge hop. These pin the 0.4.0 additions: `modelProfile` in, `provenance` and
 * `descriptor.model` out.
 */
class IndeRunSerializerProvenanceTest {

    /** A local attempt that failed, then a cloud fallback that succeeded. */
    private val provenance = ExecutionProvenance(
        attemptCount = 2,
        attempts = listOf(
            ExecutionProvenanceAttempt(
                errorClass = IndeRunErrorClass.Unavailable,
                outcome = AttemptOutcome.Failed,
                providerId = "mlkit.genai"
            ),
            ExecutionProvenanceAttempt(outcome = AttemptOutcome.Succeeded, providerId = "openai:gpt-5.2")
        ),
        configuredModel = "gpt-5.2",
        fallbackOccurred = true,
        locality = Locality.Cloud,
        modelProfile = "smart",
        providerId = "openai:gpt-5.2",
        reportedModel = "gpt-5.2-2026-08-01",
        routeRejections = listOf(
            ExecutionProvenanceRouteRejection(codes = listOf(Code.NotInModelProfile), providerId = "openai:gpt-5-mini")
        )
    )

    private fun assertProvenance(encoded: JSONObject) {
        assertEquals("1.0", encoded.getString("schemaVersion"))
        assertEquals("smart", encoded.getString("modelProfile"))
        assertEquals("openai:gpt-5.2", encoded.getString("providerId"))
        assertEquals("cloud", encoded.getString("locality"))
        assertEquals("gpt-5.2", encoded.getString("configuredModel"))
        assertEquals("gpt-5.2-2026-08-01", encoded.getString("reportedModel"))
        assertEquals(true, encoded.getBoolean("fallbackOccurred"))
        assertEquals(2L, encoded.getLong("attemptCount"))

        val attempts = encoded.getJSONArray("attempts")
        assertEquals(2, attempts.length())
        assertEquals("mlkit.genai", attempts.getJSONObject(0).getString("providerId"))
        assertEquals("failed", attempts.getJSONObject(0).getString("outcome"))
        assertEquals("Unavailable", attempts.getJSONObject(0).getString("errorClass"))
        assertEquals("succeeded", attempts.getJSONObject(1).getString("outcome"))
        assertFalse(attempts.getJSONObject(1).has("errorClass"))

        val rejection = encoded.getJSONArray("routeRejections").getJSONObject(0)
        assertEquals("openai:gpt-5-mini", rejection.getString("providerId"))
        assertEquals("not_in_model_profile", rejection.getJSONArray("codes").getString(0))
    }

    @Test
    fun `parseTaskRequest reads modelProfile`() {
        val request = IndeRunSerializer.parseTaskRequest(
            JSONObject("""{ "schemaVersion": "1.0", "task": { "kind": "text_to_text" }, "prompt": "Hi", "modelProfile": "smart" }""")
        )
        assertEquals("smart", request.modelProfile)
    }

    @Test
    fun `parseTaskRequest leaves an absent modelProfile null`() {
        val request = IndeRunSerializer.parseTaskRequest(
            JSONObject("""{ "schemaVersion": "1.0", "task": { "kind": "text_to_text" }, "prompt": "Hi" }""")
        )
        assertNull(request.modelProfile)
    }

    @Test
    fun `parseConfigureOptions reads modelProfiles in order`() {
        val options = IndeRunSerializer.parseConfigureOptions(
            JSONObject(
                """
                {
                  "openAI": { "models": ["gpt-5.2", "gpt-5-mini"] },
                  "modelProfiles": { "smart": ["openai:gpt-5.2", "mlkit.genai"], "fast": ["openai:gpt-5-mini"] }
                }
                """.trimIndent()
            )
        )
        assertEquals(
            mapOf("smart" to listOf("openai:gpt-5.2", "mlkit.genai"), "fast" to listOf("openai:gpt-5-mini")),
            options.modelProfiles
        )
    }

    @Test
    fun `parseConfigureOptions leaves absent modelProfiles null`() {
        assertNull(IndeRunSerializer.parseConfigureOptions(JSONObject("{}")).modelProfiles)
    }

    @Test
    fun `encodeTaskResult carries provenance`() {
        val encoded = IndeRunSerializer.encodeTaskResult(
            TaskResult(
                finishReason = FinishReason.STOP,
                output = Output(text = "Hi"),
                provenance = provenance,
                runId = "run_1",
                schemaVersion = SchemaVersion.V1_0,
                telemetry = TaskResultTelemetry(providerUsed = "openai:gpt-5.2", totalMs = 12.0)
            )
        )
        assertProvenance(encoded.getJSONObject("provenance"))
    }

    @Test
    fun `encodeTaskResult omits absent provenance`() {
        val encoded = IndeRunSerializer.encodeTaskResult(
            TaskResult(
                finishReason = FinishReason.STOP,
                output = Output(text = "Hi"),
                runId = "run_1",
                schemaVersion = SchemaVersion.V1_0,
                telemetry = TaskResultTelemetry(providerUsed = "openai:gpt-5.2", totalMs = 12.0)
            )
        )
        assertFalse(encoded.has("provenance"))
    }

    @Test
    fun `encodeError carries provenance`() {
        val encoded = IndeRunSerializer.encodeError(
            IndeRunError(errorClass = IndeRunErrorClass.Unavailable, message = "No provider.", provenance = provenance)
        )
        assertProvenance(encoded.getJSONObject("provenance"))
    }

    @Test
    fun `encodeStreamEvent carries provenance on the terminal payload and its error`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            StreamEvent(
                payload = Payload(
                    outcome = Outcome.Error,
                    runId = "run_1",
                    schemaVersion = SchemaVersion.V1_0,
                    partialText = "half ",
                    provenance = provenance,
                    error = PayloadError(
                        errorClass = IndeRunErrorClass.RateLimited,
                        message = "Too many requests.",
                        provenance = provenance
                    )
                ),
                runId = "run_1",
                schemaVersion = SchemaVersion.V1_0,
                sequence = 3,
                timestamp = 1_700_000_000_000.0,
                type = "terminal"
            )
        )
        val payload = encoded.getJSONObject("payload")
        assertProvenance(payload.getJSONObject("provenance"))
        assertProvenance(payload.getJSONObject("error").getJSONObject("provenance"))
    }

    @Test
    fun `encodeCapabilitySnapshots writes descriptor model only when declared`() {
        fun descriptor(id: String, model: String?) = ProviderDescriptor(
            id = id,
            model = model,
            type = ProviderDescriptor.ProviderType.cloud,
            transport = ProviderDescriptor.TransportType.http,
            supports = ProviderDescriptor.SupportsCapabilities(
                run = true,
                streaming = true,
                realtime = false,
                tools = false,
                reasoningEvents = false,
                structuredOutput = false,
                multimodal = false
            ),
            cancel = ProviderDescriptor.CancelSemantics.hard,
            tasks = listOf("text_to_text")
        )
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(
            listOf(
                ProviderCapabilitySnapshot(
                    providerId = "openai:gpt-5.2",
                    descriptor = descriptor("openai:gpt-5.2", "gpt-5.2"),
                    capabilities = ProviderDynamicCapabilities(available = true)
                ),
                ProviderCapabilitySnapshot(
                    providerId = "mlkit.genai",
                    descriptor = descriptor("mlkit.genai", null),
                    capabilities = ProviderDynamicCapabilities(available = true)
                )
            )
        )
        val providers = encoded.getJSONArray("providers")
        assertEquals("gpt-5.2", providers.getJSONObject(0).getJSONObject("descriptor").getString("model"))
        assertFalse(providers.getJSONObject(1).getJSONObject("descriptor").has("model"))
    }
}
