package app.independo.inderun.capacitor

import app.independo.inderun.contracts.CancelSemantics
import app.independo.inderun.contracts.ProviderCapabilitySnapshot
import app.independo.inderun.contracts.ProviderDescriptor
import app.independo.inderun.contracts.ProviderDynamicCapabilities
import app.independo.inderun.contracts.ProviderLimits
import app.independo.inderun.contracts.ProviderPrivacy
import app.independo.inderun.contracts.ProviderReadiness
import app.independo.inderun.contracts.ProviderSupports
import app.independo.inderun.contracts.ProviderTaskAvailability
import app.independo.inderun.contracts.ProviderTransport
import app.independo.inderun.contracts.ProviderType
import app.independo.inderun.contracts.StreamingStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IndeRunSerializerCapabilitiesTest {

    private fun snapshot(
        providerId: String,
        type: ProviderType,
        transport: ProviderTransport,
        streamingStyle: StreamingStyle? = null,
        streaming: Boolean,
        cancel: CancelSemantics,
        limits: ProviderLimits? = null,
        privacy: ProviderPrivacy? = null,
        capabilities: ProviderDynamicCapabilities
    ): ProviderCapabilitySnapshot = ProviderCapabilitySnapshot(
        providerId = providerId,
        descriptor = ProviderDescriptor(
            id = providerId,
            type = type,
            transport = transport,
            streamingStyle = streamingStyle,
            supports = ProviderSupports(
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
                    type = ProviderType.Cloud,
                    transport = ProviderTransport.HTTP,
                    streamingStyle = StreamingStyle.Tokens,
                    streaming = true,
                    cancel = CancelSemantics.Hard,
                    limits = ProviderLimits(
                        maxInputTokens = 128_000L,
                        maxOutputTokens = 4_096L
                    ),
                    privacy = ProviderPrivacy(
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
                    type = ProviderType.Local,
                    transport = ProviderTransport.InProcess,
                    streaming = false,
                    cancel = CancelSemantics.Soft,
                    capabilities = ProviderDynamicCapabilities(
                        available = false,
                        reason = "No model package configured."
                    )
                ),
                snapshot(
                    providerId = "android.mlkit.genai",
                    type = ProviderType.Local,
                    transport = ProviderTransport.SystemService,
                    streamingStyle = StreamingStyle.Chunks,
                    streaming = true,
                    cancel = CancelSemantics.Soft,
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
                    type = ProviderType.Local,
                    transport = ProviderTransport.SystemService,
                    streaming = true,
                    cancel = CancelSemantics.Soft,
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
                    type = ProviderType.Cloud,
                    transport = ProviderTransport.HTTP,
                    streamingStyle = StreamingStyle.Tokens,
                    streaming = true,
                    cancel = CancelSemantics.Hard,
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
            setOf("local", "edge", "cloud"),
            ProviderType.entries.map { it.rawValue }.toSet()
        )
        assertEquals(
            setOf("in_process", "system_service", "http", "sse", "realtime"),
            ProviderTransport.entries.map { it.rawValue }.toSet()
        )
        assertEquals(
            setOf("tokens", "chunks", "snapshots"),
            StreamingStyle.entries.map { it.rawValue }.toSet()
        )
        assertEquals(
            setOf("hard", "soft", "none"),
            CancelSemantics.entries.map { it.rawValue }.toSet()
        )
    }

    @Test
    fun `encodeCapabilitySnapshots carries per task readiness`() {
        val encoded = IndeRunSerializer.encodeCapabilitySnapshots(
            listOf(
                snapshot(
                    providerId = "local.onnx.genai.android",
                    type = ProviderType.Local,
                    transport = ProviderTransport.InProcess,
                    streaming = false,
                    cancel = CancelSemantics.Soft,
                    capabilities = ProviderDynamicCapabilities(
                        available = true,
                        taskCapabilities = listOf(
                            ProviderTaskAvailability(
                                kind = "text_to_text",
                                readiness = ProviderReadiness.NotPrepared
                            )
                        )
                    )
                )
            )
        )

        val task = encoded.getJSONArray("providers")
            .getJSONObject(0)
            .getJSONObject("capabilities")
            .getJSONArray("taskCapabilities")
            .getJSONObject(0)
        assertEquals("text_to_text", task.getString("kind"))
        assertEquals("not_prepared", task.getString("readiness"))
    }
}
