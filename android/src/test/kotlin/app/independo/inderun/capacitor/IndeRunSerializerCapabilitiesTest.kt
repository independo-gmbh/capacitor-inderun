package app.independo.inderun.capacitor

import app.independo.inderun.core.ProviderCapabilitySnapshot
import app.independo.inderun.core.ProviderDescriptor
import app.independo.inderun.core.ProviderDynamicCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IndeRunSerializerCapabilitiesTest {

    private fun snapshot(
        providerId: String,
        type: ProviderDescriptor.ProviderType,
        transport: ProviderDescriptor.TransportType,
        streamingStyle: ProviderDescriptor.StreamingStyle? = null,
        streaming: Boolean,
        cancel: ProviderDescriptor.CancelSemantics,
        limits: ProviderDescriptor.ResourceLimits? = null,
        privacy: ProviderDescriptor.PrivacyDescriptor? = null,
        capabilities: ProviderDynamicCapabilities
    ): ProviderCapabilitySnapshot = ProviderCapabilitySnapshot(
        providerId = providerId,
        descriptor = ProviderDescriptor(
            id = providerId,
            type = type,
            transport = transport,
            streamingStyle = streamingStyle,
            supports = ProviderDescriptor.SupportsCapabilities(
                run = true,
                streaming = streaming,
                realtime = false,
                tools = false,
                reasoningEvents = false,
                structuredOutput = false,
                multimodal = false
            ),
            cancel = cancel,
            tasks = listOf("text_to_text"),
            limits = limits,
            privacy = privacy
        ),
        capabilities = capabilities
    )

    @Test
    fun `encodeCapabilitySnapshots wraps the snapshots in a providers array`() {
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(
            listOf(
                snapshot(
                    providerId = "openai",
                    type = ProviderDescriptor.ProviderType.cloud,
                    transport = ProviderDescriptor.TransportType.http,
                    streamingStyle = ProviderDescriptor.StreamingStyle.tokens,
                    streaming = true,
                    cancel = ProviderDescriptor.CancelSemantics.hard,
                    limits = ProviderDescriptor.ResourceLimits(
                        maxInputTokens = 128_000,
                        maxOutputTokens = 4_096
                    ),
                    privacy = ProviderDescriptor.PrivacyDescriptor(
                        dataLeavesDevice = true,
                        regions = listOf("us")
                    ),
                    capabilities = ProviderDynamicCapabilities(available = true)
                )
            )
        )

        val providers = encoded.getJSONArray("providers")
        assertEquals(1, providers.length())

        val provider = providers.getJSONObject(0)
        assertEquals("openai", provider.getString("providerId"))

        val descriptor = provider.getJSONObject("descriptor")
        assertEquals("openai", descriptor.getString("id"))
        assertEquals("cloud", descriptor.getString("type"))
        assertEquals("http", descriptor.getString("transport"))
        assertEquals("tokens", descriptor.getString("streamingStyle"))
        assertEquals("hard", descriptor.getString("cancel"))
        assertEquals(1, descriptor.getJSONArray("tasks").length())
        assertEquals("text_to_text", descriptor.getJSONArray("tasks").getString(0))

        val supports = descriptor.getJSONObject("supports")
        assertTrue(supports.getBoolean("run"))
        assertTrue(supports.getBoolean("streaming"))
        assertFalse(supports.getBoolean("realtime"))
        assertFalse(supports.getBoolean("tools"))
        assertFalse(supports.getBoolean("reasoningEvents"))
        assertFalse(supports.getBoolean("structuredOutput"))
        assertFalse(supports.getBoolean("multimodal"))

        val limits = descriptor.getJSONObject("limits")
        assertEquals(128_000, limits.getInt("maxInputTokens"))
        assertEquals(4_096, limits.getInt("maxOutputTokens"))
        assertFalse(limits.has("maxImageBytes"))
        assertFalse(limits.has("maxAudioSeconds"))

        val privacy = descriptor.getJSONObject("privacy")
        assertTrue(privacy.getBoolean("dataLeavesDevice"))
        assertEquals("us", privacy.getJSONArray("regions").getString(0))

        assertTrue(provider.getJSONObject("capabilities").getBoolean("available"))
    }

    /**
     * `in_process` and `system_service` are the two descriptor constants a future upstream
     * rename to camelCase would silently corrupt on the wire, because the TypeScript union
     * in src/definitions.ts spells them out. Asserting the literals is the guard.
     */
    @Test
    fun `encodeCapabilitySnapshots writes snake case transport constants verbatim`() {
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(
            listOf(
                snapshot(
                    providerId = "local.onnx.genai.android",
                    type = ProviderDescriptor.ProviderType.local,
                    transport = ProviderDescriptor.TransportType.in_process,
                    streaming = false,
                    cancel = ProviderDescriptor.CancelSemantics.soft,
                    capabilities = ProviderDynamicCapabilities(
                        available = false,
                        reason = "No model package configured."
                    )
                ),
                snapshot(
                    providerId = "android.mlkit.genai",
                    type = ProviderDescriptor.ProviderType.local,
                    transport = ProviderDescriptor.TransportType.system_service,
                    streamingStyle = ProviderDescriptor.StreamingStyle.chunks,
                    streaming = true,
                    cancel = ProviderDescriptor.CancelSemantics.soft,
                    capabilities = ProviderDynamicCapabilities(available = true)
                )
            )
        )

        val providers = encoded.getJSONArray("providers")
        assertEquals(
            "in_process",
            providers.getJSONObject(0).getJSONObject("descriptor").getString("transport")
        )
        assertEquals(
            "system_service",
            providers.getJSONObject(1).getJSONObject("descriptor").getString("transport")
        )
        assertEquals(
            "chunks",
            providers.getJSONObject(1).getJSONObject("descriptor").getString("streamingStyle")
        )
    }

    /**
     * Absence is the contract's "inherit the static declaration" state, so the nullable
     * flags must not reach the wire as nulls — a null would be a third state no consumer
     * has. Same for the optional descriptor sub-objects.
     */
    @Test
    fun `encodeCapabilitySnapshots omits unset optional fields instead of writing null`() {
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(
            listOf(
                snapshot(
                    providerId = "android.mlkit.genai",
                    type = ProviderDescriptor.ProviderType.local,
                    transport = ProviderDescriptor.TransportType.system_service,
                    streaming = true,
                    cancel = ProviderDescriptor.CancelSemantics.soft,
                    capabilities = ProviderDynamicCapabilities(available = true)
                )
            )
        )

        val provider = encoded.getJSONArray("providers").getJSONObject(0)
        val descriptor = provider.getJSONObject("descriptor")
        assertFalse(descriptor.has("streamingStyle"))
        assertFalse(descriptor.has("limits"))
        assertFalse(descriptor.has("privacy"))

        val capabilities = provider.getJSONObject("capabilities")
        assertFalse(capabilities.has("reason"))
        assertFalse(capabilities.has("streamingAvailable"))
        assertFalse(capabilities.has("streamingUnavailableReason"))
        assertFalse(capabilities.has("cancellationAvailable"))
    }

    @Test
    fun `encodeCapabilitySnapshots encodes streaming taken away at runtime`() {
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(
            listOf(
                snapshot(
                    providerId = "openai",
                    type = ProviderDescriptor.ProviderType.cloud,
                    transport = ProviderDescriptor.TransportType.http,
                    streamingStyle = ProviderDescriptor.StreamingStyle.tokens,
                    streaming = true,
                    cancel = ProviderDescriptor.CancelSemantics.hard,
                    capabilities = ProviderDynamicCapabilities(
                        available = true,
                        streamingAvailable = false,
                        streamingUnavailableReason = "Host has no streaming HTTP client.",
                        cancellationAvailable = true
                    )
                )
            )
        )

        val capabilities = encoded.getJSONArray("providers")
            .getJSONObject(0)
            .getJSONObject("capabilities")
        assertTrue(capabilities.getBoolean("available"))
        assertFalse(capabilities.getBoolean("streamingAvailable"))
        assertEquals(
            "Host has no streaming HTTP client.",
            capabilities.getString("streamingUnavailableReason")
        )
        assertTrue(capabilities.getBoolean("cancellationAvailable"))
    }

    @Test
    fun `encodeCapabilitySnapshots encodes an empty registry as an empty array`() {
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(emptyList())

        assertTrue(encoded.has("providers"))
        assertEquals(0, encoded.getJSONArray("providers").length())
    }

    /**
     * Every enum constant of every descriptor enum maps to the wire spelling the
     * TypeScript unions declare. Exhaustive by construction: `values()` grows when
     * upstream adds a constant, and a renamed one fails here rather than in a demo.
     */
    @Test
    fun `every descriptor enum constant maps to its declared wire value`() {
        assertEquals(
            listOf("local", "edge", "cloud"),
            ProviderDescriptor.ProviderType.values().map { it.name }
        )
        assertEquals(
            listOf("in_process", "system_service", "http", "sse", "realtime"),
            ProviderDescriptor.TransportType.values().map { it.name }
        )
        assertEquals(
            listOf("tokens", "chunks", "snapshots"),
            ProviderDescriptor.StreamingStyle.values().map { it.name }
        )
        assertEquals(
            listOf("hard", "soft", "none"),
            ProviderDescriptor.CancelSemantics.values().map { it.name }
        )
    }
}
