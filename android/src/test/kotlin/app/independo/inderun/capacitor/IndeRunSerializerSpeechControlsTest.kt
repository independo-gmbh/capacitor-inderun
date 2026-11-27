package app.independo.inderun.capacitor

import app.independo.inderun.contracts.CancelSemantics
import app.independo.inderun.contracts.Code
import app.independo.inderun.contracts.ControlDelivery
import app.independo.inderun.contracts.ExecutionProvenance
import app.independo.inderun.contracts.ExecutionProvenanceRouteRejection
import app.independo.inderun.contracts.FinishReason
import app.independo.inderun.contracts.IndeRunError
import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.Locality
import app.independo.inderun.contracts.Outcome
import app.independo.inderun.contracts.OutputDelivery
import app.independo.inderun.contracts.Payload
import app.independo.inderun.contracts.PayloadError
import app.independo.inderun.contracts.PlaybackOutput
import app.independo.inderun.contracts.ProviderCapabilitySnapshot
import app.independo.inderun.contracts.ProviderDescriptor
import app.independo.inderun.contracts.ProviderDynamicCapabilities
import app.independo.inderun.contracts.ProviderSupports
import app.independo.inderun.contracts.ProviderTaskAvailability
import app.independo.inderun.contracts.ProviderTaskCapability
import app.independo.inderun.contracts.ProviderTaskInteraction
import app.independo.inderun.contracts.ProviderTaskOutput
import app.independo.inderun.contracts.ProviderTransport
import app.independo.inderun.contracts.ProviderType
import app.independo.inderun.contracts.ProviderVoice
import app.independo.inderun.contracts.RequirementLevel
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.SpeechControlDeclaration
import app.independo.inderun.contracts.SpeechControlId
import app.independo.inderun.contracts.SpeechControlLifetime
import app.independo.inderun.contracts.SpeechControlMethod
import app.independo.inderun.contracts.SpeechControlOutcome
import app.independo.inderun.contracts.SpeechControlOutcomeReason
import app.independo.inderun.contracts.SpeechControlPhase
import app.independo.inderun.contracts.SpeechControlRange
import app.independo.inderun.contracts.SpeechControlState
import app.independo.inderun.contracts.SpeechControlStatus
import app.independo.inderun.contracts.SpeechControlValueKind
import app.independo.inderun.contracts.SpeechOutput
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.TaskInputKind
import app.independo.inderun.contracts.TaskOutput
import app.independo.inderun.contracts.TaskOutputType
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.contracts.TaskResultTelemetry
import app.independo.inderun.core.IndeRunException
import app.independo.inderun.core.rawTaskRequestIssues
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Speech controls (ADR 025, contract 1.1) across the bridge hop. The Kotlin contracts have no
 * JSON codec, so every field below is mapped by hand in [IndeRunSerializer] and a field it does
 * not name is lost; each group is pinned here, with absent kept distinct from `false`.
 */
class IndeRunSerializerSpeechControlsTest {

    // --- request: speech.controls and delivery.playback ---

    private fun ttsRequest(speech: String = "", delivery: String = """{ "mode": "playback" }""") = JSONObject(
        """
        {
          "schemaVersion": "1.1",
          "task": { "kind": "text_to_speech" },
          "speech": { "text": "Guten Morgen!", "locale": "de-AT"$speech },
          "delivery": $delivery
        }
        """.trimIndent()
    )

    @Test
    fun `speech controls and playback volume parse with their requirement`() {
        val json = ttsRequest(
            speech = """, "controls": { "speakingRate": { "value": 0.85, "requirement": "required" }, "pitch": { "value": 1.05 } }""",
            delivery = """{ "mode": "playback", "playback": { "volume": { "value": 0.7, "requirement": "preferred" } } }"""
        )
        val request = IndeRunSerializer.parseTaskRequest(JSONObject(json.toString()))

        val controls = checkNotNull(request.speech?.controls)
        assertEquals(0.85, checkNotNull(controls.speakingRate).value, 0.0)
        assertEquals(RequirementLevel.Required, controls.speakingRate?.requirement)
        assertEquals(1.05, checkNotNull(controls.pitch).value, 0.0)
        // Absent stays absent: the engine reads it as 'preferred', the bridge does not decide.
        assertNull(controls.pitch?.requirement)
        val volume = checkNotNull(request.delivery?.playback?.volume)
        assertEquals(0.7, volume.value, 0.0)
        assertEquals(RequirementLevel.Preferred, volume.requirement)

        assertSameJson("round trip", json, encodeRequestForTest(request))
    }

    @Test
    fun `a control value crosses without rounding`() {
        val value = 1.1400000000000001
        val request = IndeRunSerializer.parseTaskRequest(ttsRequest(speech = """, "controls": { "speakingRate": { "value": $value } }"""))
        assertEquals(value.toRawBits(), checkNotNull(request.speech?.controls?.speakingRate).value.toRawBits())
    }

    @Test
    fun `requests without controls leave them null`() {
        val request = IndeRunSerializer.parseTaskRequest(ttsRequest(speech = """, "controls": {}"""))
        assertNull(request.speech?.controls?.speakingRate)
        assertNull(request.speech?.controls?.pitch)
        assertNull(IndeRunSerializer.parseTaskRequest(ttsRequest()).speech?.controls)
        assertNull(IndeRunSerializer.parseTaskRequest(ttsRequest()).delivery?.playback)
    }

    /**
     * `generateSpeech` has no volume option, so a playback control on an artifact call can only
     * come from a caller that bypassed the facade's types. It must reach the engine's validation,
     * which refuses it, rather than vanish in parsing and leave an artifact run that looks fine.
     */
    @Test
    fun `a playback control on an artifact request is kept, never dropped`() {
        val request = IndeRunSerializer.parseTaskRequest(
            ttsRequest(delivery = """{ "mode": "artifact", "mediaTypes": ["audio/wav"], "playback": { "volume": { "value": 0.5 } } }""")
        )
        assertEquals(OutputDelivery.Artifact, request.delivery?.mode)
        assertEquals(0.5, checkNotNull(request.delivery?.playback?.volume).value, 0.0)
    }

    // --- raw validation before parsing ---

    private fun refusal(json: JSONObject): IndeRunError {
        val error = assertThrows(IndeRunException::class.java) { IndeRunSerializer.parseTaskRequest(json) }
        return error.toContractError()
    }

    @Test
    fun `a request the raw check rejects is refused with the normalized validation error`() {
        val json = ttsRequest(
            speech = """, "controls": { "speakingrate": { "value": 0.9, "requirement": "required" }, "pitch": { "value": "high" } }""",
            delivery = """{ "mode": "playback", "playback": { "gain": { "value": 0.5 } } }"""
        )
        val expected = rawTaskRequestIssues(JSONObject(json.toString()))
        assertEquals(3, expected.size)

        val error = refusal(json)
        assertEquals(IndeRunErrorClass.Internal, error.errorClass)
        assertEquals("Validation failed for TaskRequest: ${expected.joinToString("; ")}", error.message)
        assertEquals(mapOf("validationIssues" to expected), error.details)

        val encoded = IndeRunSerializer.encodeError(error)
        assertEquals("Internal", encoded.getString("errorClass"))
        val issues = encoded.getJSONObject("details").getJSONArray("validationIssues")
        assertEquals(expected, List(issues.length()) { issues.getString(it) })
    }

    @Test
    fun `a schema version other than 1_1 is refused by the raw check`() {
        for (version in listOf("\"1.0\"", "\"9.9\"", "1.1")) {
            val error = refusal(JSONObject("""{ "schemaVersion": $version, "task": { "kind": "text_to_text" }, "prompt": "Hi" }"""))
            assertEquals(version, mapOf("validationIssues" to listOf("schemaVersion must be '1.1'.")), error.details)
        }
    }

    // --- capabilities: declarations and control states ---

    private val rateRange = SpeechControlRange(default = 1.0, max = 2.0, min = 0.5, step = 0.05)

    private fun speechSnapshot(
        controls: List<SpeechControlDeclaration>?,
        task: ProviderTaskAvailability
    ) = ProviderCapabilitySnapshot(
        providerId = "android_system_speech",
        descriptor = ProviderDescriptor(
            id = "android_system_speech",
            type = ProviderType.Local,
            transport = ProviderTransport.SystemService,
            supports = ProviderSupports(
                run = true,
                streaming = true,
                realtime = false,
                tools = false,
                reasoningEvents = false,
                structuredOutput = false,
                multimodal = false
            ),
            cancel = CancelSemantics.Hard,
            tasks = listOf("text_to_speech"),
            taskCapabilities = listOf(
                ProviderTaskCapability(
                    cancel = CancelSemantics.Hard,
                    controls = controls,
                    inputs = listOf(TaskInputKind.Text),
                    interaction = ProviderTaskInteraction(run = true, stream = true),
                    kind = "text_to_speech",
                    outputs = listOf(ProviderTaskOutput(delivery = OutputDelivery.Playback))
                )
            )
        ),
        capabilities = ProviderDynamicCapabilities(available = true, taskCapabilities = listOf(task))
    )

    private fun encodedProvider(snapshot: ProviderCapabilitySnapshot): JSONObject =
        IndeRunSerializer.encodeCapabilitySnapshots(listOf(snapshot)).getJSONArray("providers").getJSONObject(0)

    @Test
    fun `task control declarations encode every field`() {
        val provider = encodedProvider(
            speechSnapshot(
                controls = listOf(
                    SpeechControlDeclaration(
                        deliveries = listOf(ControlDelivery.Playback, ControlDelivery.Artifact),
                        id = SpeechControlId.SpeechSpeakingRate,
                        lifetime = SpeechControlLifetime.Utterance,
                        phase = SpeechControlPhase.Synthesis,
                        valueKind = SpeechControlValueKind.Number
                    ),
                    SpeechControlDeclaration(
                        deliveries = listOf(ControlDelivery.Playback),
                        id = SpeechControlId.PlaybackVolume,
                        lifetime = SpeechControlLifetime.ProviderInstance,
                        phase = SpeechControlPhase.Playback,
                        valueKind = SpeechControlValueKind.Number
                    )
                ),
                task = ProviderTaskAvailability(kind = "text_to_speech")
            )
        )

        val controls = provider.getJSONObject("descriptor").getJSONArray("taskCapabilities").getJSONObject(0).getJSONArray("controls")
        assertSameJson(
            "controls",
            JSONObject(
                """
                { "controls": [
                  { "id": "speech.speakingRate", "valueKind": "number", "phase": "synthesis", "lifetime": "utterance", "deliveries": ["playback", "artifact"] },
                  { "id": "playback.volume", "valueKind": "number", "phase": "playback", "lifetime": "provider_instance", "deliveries": ["playback"] }
                ] }
                """.trimIndent()
            ),
            JSONObject().put("controls", controls)
        )
    }

    @Test
    fun `a task without control declarations writes no controls key`() {
        val provider = encodedProvider(speechSnapshot(controls = null, task = ProviderTaskAvailability(kind = "text_to_speech")))
        val task = provider.getJSONObject("descriptor").getJSONArray("taskCapabilities").getJSONObject(0)
        assertFalse(task.has("controls"))
        assertFalse(provider.getJSONObject("capabilities").getJSONArray("taskCapabilities").getJSONObject(0).has("controlStates"))
    }

    @Test
    fun `control states on tasks and voices encode, keeping absent available distinct from false`() {
        val provider = encodedProvider(
            speechSnapshot(
                controls = null,
                task = ProviderTaskAvailability(
                    kind = "text_to_speech",
                    controlStates = listOf(
                        SpeechControlState(available = true, delivery = ControlDelivery.Playback, id = SpeechControlId.SpeechSpeakingRate, range = rateRange),
                        SpeechControlState(delivery = ControlDelivery.Artifact, id = SpeechControlId.SpeechSpeakingRate),
                        SpeechControlState(
                            available = false,
                            delivery = ControlDelivery.Playback,
                            id = SpeechControlId.SpeechPitch,
                            reason = "The engine has no pitch control."
                        )
                    ),
                    voices = listOf(
                        ProviderVoice(
                            controlStates = listOf(
                                SpeechControlState(
                                    delivery = ControlDelivery.Playback,
                                    id = SpeechControlId.SpeechSpeakingRate,
                                    range = SpeechControlRange(max = 1.5, min = 0.75)
                                ),
                                SpeechControlState(available = false, delivery = ControlDelivery.Playback, id = SpeechControlId.PlaybackVolume)
                            ),
                            id = "de-at-x-local",
                            locale = "de-AT"
                        ),
                        ProviderVoice(locale = "de-DE")
                    )
                )
            )
        )

        val task = provider.getJSONObject("capabilities").getJSONArray("taskCapabilities").getJSONObject(0)
        assertSameJson(
            "task control states",
            JSONObject(
                """
                { "controlStates": [
                  { "id": "speech.speakingRate", "delivery": "playback", "available": true, "range": { "min": 0.5, "max": 2.0, "default": 1.0, "step": 0.05 } },
                  { "id": "speech.speakingRate", "delivery": "artifact" },
                  { "id": "speech.pitch", "delivery": "playback", "available": false, "reason": "The engine has no pitch control." }
                ] }
                """.trimIndent()
            ),
            JSONObject().put("controlStates", task.getJSONArray("controlStates"))
        )

        val voices = task.getJSONArray("voices")
        assertSameJson(
            "voice control states",
            JSONObject(
                """
                { "controlStates": [
                  { "id": "speech.speakingRate", "delivery": "playback", "range": { "min": 0.75, "max": 1.5 } },
                  { "id": "playback.volume", "delivery": "playback", "available": false }
                ] }
                """.trimIndent()
            ),
            JSONObject().put("controlStates", voices.getJSONObject(0).getJSONArray("controlStates"))
        )
        assertFalse(voices.getJSONObject(1).has("controlStates"))

        // Absent is "unknown", and unknown is never support: it must not become false (or null).
        val unknown = task.getJSONArray("controlStates").getJSONObject(1)
        assertFalse(unknown.has("available"))
        assertFalse(task.getJSONArray("controlStates").getJSONObject(2).getBoolean("available"))
    }

    // --- output.speech.controls on results, terminals and error terminals ---

    private val outcomes = listOf(
        SpeechControlOutcome(
            effective = 0.85,
            id = SpeechControlId.SpeechSpeakingRate,
            method = SpeechControlMethod.PlatformSynthesis,
            requested = 0.85,
            status = SpeechControlStatus.Applied
        ),
        SpeechControlOutcome(
            id = SpeechControlId.SpeechPitch,
            reason = SpeechControlOutcomeReason.Unsupported,
            requested = 1.05,
            status = SpeechControlStatus.NotApplied
        ),
        SpeechControlOutcome(
            effective = 0.7,
            id = SpeechControlId.PlaybackVolume,
            method = SpeechControlMethod.PlaybackAttenuation,
            requested = 0.7,
            status = SpeechControlStatus.Applied
        )
    )

    private val expectedOutcomes = JSONObject(
        """
        { "locale": "de-AT", "controls": [
          { "id": "speech.speakingRate", "requested": 0.85, "effective": 0.85, "status": "applied", "method": "platform_synthesis" },
          { "id": "speech.pitch", "requested": 1.05, "status": "not_applied", "reason": "unsupported" },
          { "id": "playback.volume", "requested": 0.7, "effective": 0.7, "status": "applied", "method": "playback_attenuation" }
        ] }
        """.trimIndent()
    )

    private val playbackOutput = TaskOutput(
        playback = PlaybackOutput(),
        speech = SpeechOutput(controls = outcomes, locale = "de-AT"),
        type = TaskOutputType.PLAYBACK
    )

    @Test
    fun `a result carries every control outcome field`() {
        val encoded = IndeRunSerializer.encodeTaskResult(
            TaskResult(
                finishReason = FinishReason.STOP,
                output = playbackOutput,
                runId = "run_controls",
                schemaVersion = SchemaVersion.V1_1,
                telemetry = TaskResultTelemetry(providerUsed = "android_system_speech", totalMs = 10.0)
            )
        )
        assertSameJson("speech", expectedOutcomes, encoded.getJSONObject("output").getJSONObject("speech"))
    }

    @Test
    fun `cancelled and error terminals pass control outcomes through unchanged`() {
        for (outcome in listOf(Outcome.Cancelled, Outcome.Error)) {
            val payload = Payload(
                outcome = outcome,
                output = playbackOutput,
                runId = "run_controls",
                schemaVersion = SchemaVersion.V1_1,
                error = if (outcome == Outcome.Error) PayloadError(errorClass = IndeRunErrorClass.Unavailable, message = "Lost the engine.") else null
            )
            val encoded = IndeRunSerializer.encodeStreamEvent(
                StreamEvent(
                    payload = payload,
                    runId = "run_controls",
                    schemaVersion = SchemaVersion.V1_1,
                    sequence = 2,
                    timestamp = 1_700_000_000_000.0,
                    type = "terminal"
                )
            )
            assertSameJson(outcome.name, expectedOutcomes, encoded.getJSONObject("payload").getJSONObject("output").getJSONObject("speech"))
        }
    }

    @Test
    fun `speech output without controls writes no controls key`() {
        val encoded = IndeRunSerializer.encodeTaskOutput(
            TaskOutput(speech = SpeechOutput(locale = "de-AT"), playback = PlaybackOutput(), type = TaskOutputType.PLAYBACK)
        )
        assertFalse(encoded.getJSONObject("speech").has("controls"))
    }

    // --- provenance: the two speech-control rejection codes ---

    @Test
    fun `route rejections carry the speech control codes`() {
        val provenance = ExecutionProvenance(
            attemptCount = 0,
            attempts = emptyList(),
            fallbackOccurred = false,
            locality = Locality.Unknown,
            modelProfile = "auto",
            routeRejections = listOf(
                ExecutionProvenanceRouteRejection(codes = listOf(Code.SpeechControlUnsupported), providerId = "android_system_speech"),
                ExecutionProvenanceRouteRejection(codes = listOf(Code.SpeechControlOutOfRange, Code.NotReady), providerId = "local.onnx.speech.articulino")
            )
        )
        val encoded = IndeRunSerializer.encodeError(
            IndeRunError(errorClass = IndeRunErrorClass.CapabilityMismatch, message = "No provider.", provenance = provenance)
        )

        val rejections = encoded.getJSONObject("provenance").getJSONArray("routeRejections")
        assertEquals("speech_control_unsupported", rejections.getJSONObject(0).getJSONArray("codes").getString(0))
        val second = rejections.getJSONObject(1).getJSONArray("codes")
        assertEquals(listOf("speech_control_out_of_range", "not_ready"), List(second.length()) { second.getString(it) })
        assertTrue(Code.entries.map { it.rawValue }.containsAll(listOf("speech_control_unsupported", "speech_control_out_of_range")))
    }
}
