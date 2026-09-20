package app.independo.inderun.capacitor

import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PayloadError
import app.independo.inderun.contracts.PayloadTelemetry
import app.independo.inderun.contracts.PayloadUsage
import app.independo.inderun.contracts.Phase
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.StreamRunHandle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Encoding is what the JS side actually consumes, so these assert exact key sets: a
 * field that encodes as null instead of being absent changes which union branch the
 * consumer reconstitutes.
 */
class IndeRunSerializerStreamTest {

    private fun event(
        type: String,
        payload: Payload?,
        sequence: Long = 0,
        runId: String = "run_1"
    ): StreamEvent = StreamEvent(
        payload = payload,
        runId = runId,
        schemaVersion = SchemaVersion.V1_0,
        sequence = sequence,
        timestamp = 1_700_000_000_000.0,
        type = type
    )

    private fun keysOf(json: org.json.JSONObject): Set<String> =
        json.keys().asSequence().toSet()

    @Test
    fun `encodes a content delta with only the text field`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            event(type = "content_delta", payload = Payload(text = "hello"))
        )

        assertEquals("1.0", encoded.getString("schemaVersion"))
        assertEquals("run_1", encoded.getString("runId"))
        assertEquals(0L, encoded.getLong("sequence"))
        assertEquals("content_delta", encoded.getString("type"))
        assertEquals(setOf("text"), keysOf(encoded.getJSONObject("payload")))
        assertEquals("hello", encoded.getJSONObject("payload").getString("text"))
    }

    @Test
    fun `encodes a completed terminal outcome`() {
        val payload = Payload(
            finalText = "all done",
            finishReason = FinishReason.STOP,
            outcome = Outcome.Completed,
            runId = "run_1",
            schemaVersion = SchemaVersion.V1_0,
            telemetry = PayloadTelemetry(providerUsed = "openai", totalMs = 42.0),
            usage = PayloadUsage(inputTokens = 3, outputTokens = 5, totalTokens = 8)
        )

        val encoded = IndeRunSerializer.encodeStreamEvent(
            event(type = "terminal", payload = payload, sequence = 4)
        ).getJSONObject("payload")

        assertEquals("completed", encoded.getString("outcome"))
        assertEquals("all done", encoded.getString("finalText"))
        assertEquals("stop", encoded.getString("finishReason"))
        assertEquals(8L, encoded.getJSONObject("usage").getLong("totalTokens"))
        assertEquals("openai", encoded.getJSONObject("telemetry").getString("providerUsed"))
        // The other branches' fields must not leak into a completion.
        assertFalse(encoded.has("error"))
        assertFalse(encoded.has("partialText"))
        assertFalse(encoded.has("reason"))
    }

    @Test
    fun `encodes an error terminal outcome with its nested error`() {
        val payload = Payload(
            outcome = Outcome.Error,
            runId = "run_1",
            schemaVersion = SchemaVersion.V1_0,
            error = PayloadError(
                details = mapOf("endpoint" to "https://example.test"),
                errorClass = IndeRunErrorClass.RateLimited,
                message = "Too many requests.",
                providerId = "openai",
                retryable = true,
                retryAfterMs = 2_000
            ),
            partialText = "half "
        )

        val encoded = IndeRunSerializer.encodeStreamEvent(
            event(type = "terminal", payload = payload, sequence = 7)
        ).getJSONObject("payload")

        assertEquals("error", encoded.getString("outcome"))
        assertEquals("half ", encoded.getString("partialText"))

        val error = encoded.getJSONObject("error")
        assertEquals("RateLimited", error.getString("errorClass"))
        assertEquals(2_000L, error.getLong("retryAfterMs"))
        assertTrue(error.getBoolean("retryable"))
        assertEquals(
            "https://example.test",
            error.getJSONObject("details").getString("endpoint")
        )
    }

    @Test
    fun `omits the cancellation reason entirely when there is none`() {
        val withReason = IndeRunSerializer.encodeStreamEvent(
            event(
                type = "terminal",
                payload = Payload(
                    outcome = Outcome.Cancelled,
                    partialText = "part",
                    reason = "user left"
                )
            )
        ).getJSONObject("payload")
        assertEquals("user left", withReason.getString("reason"))

        val withoutReason = IndeRunSerializer.encodeStreamEvent(
            event(
                type = "terminal",
                payload = Payload(outcome = Outcome.Cancelled, partialText = "part")
            )
        ).getJSONObject("payload")

        assertEquals("cancelled", withoutReason.getString("outcome"))
        assertEquals("part", withoutReason.getString("partialText"))
        // Absent, not null: a null would decode as a present-but-empty reason.
        assertFalse(withoutReason.has("reason"))
    }

    @Test
    fun `encodes a lifecycle phase using its snake case wire value`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            event(type = "lifecycle", payload = Payload(phase = Phase.ProviderSelected))
        ).getJSONObject("payload")

        assertEquals("provider_selected", encoded.getString("phase"))
    }

    /**
     * The schema closes its union with an open catch-all branch, so an unrecognized
     * type must cross the bridge untouched rather than be rejected — unlike the
     * inbound request enums, which throw.
     */
    @Test
    fun `passes an unknown event type through verbatim without a payload`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            event(type = "some_future_type", payload = null, sequence = 2)
        )

        assertEquals("some_future_type", encoded.getString("type"))
        assertFalse(encoded.has("payload"))
    }

    @Test
    fun `encodes a diagnostic event with an empty payload object`() {
        val encoded = IndeRunSerializer.encodeStreamEvent(
            event(type = "diagnostic", payload = Payload())
        )

        assertTrue(encoded.has("payload"))
        assertEquals(emptySet<String>(), keysOf(encoded.getJSONObject("payload")))
    }

    @Test
    fun `encodes a stream run handle with and without a provider id`() {
        val withProvider = IndeRunSerializer.encodeStreamRunHandle(
            StreamRunHandle(
                providerId = "openai",
                runId = "run_1",
                schemaVersion = SchemaVersion.V1_0,
                startedAt = 1_700_000_000_000.0
            )
        )
        assertEquals("openai", withProvider.getString("providerId"))
        assertEquals("run_1", withProvider.getString("runId"))
        assertEquals(1_700_000_000_000.0, withProvider.getDouble("startedAt"), 0.0)

        val withoutProvider = IndeRunSerializer.encodeStreamRunHandle(
            StreamRunHandle(
                runId = "run_1",
                schemaVersion = SchemaVersion.V1_0,
                startedAt = 1_700_000_000_000.0
            )
        )
        assertFalse(withoutProvider.has("providerId"))
    }

    /**
     * Outcome and Phase are generated without a rawValue, so their wire strings are
     * hand-written. If a regeneration adds a constant, the `when` stops compiling —
     * and if one is ever mapped to the wrong casing, this catches it.
     */
    @Test
    fun `every outcome and phase constant maps to a snake case wire value`() {
        val outcomes = Outcome.entries.map { outcome ->
            IndeRunSerializer.encodeStreamEvent(
                event(type = "terminal", payload = Payload(outcome = outcome))
            ).getJSONObject("payload").getString("outcome")
        }
        assertEquals(listOf("cancelled", "completed", "error"), outcomes)

        val phases = Phase.entries.map { phase ->
            IndeRunSerializer.encodeStreamEvent(
                event(type = "lifecycle", payload = Payload(phase = phase))
            ).getJSONObject("payload").getString("phase")
        }
        assertEquals(listOf("provider_selected", "started"), phases)

        assertTrue((outcomes + phases).all { it.isNotEmpty() && it == it.lowercase() })
    }
}
