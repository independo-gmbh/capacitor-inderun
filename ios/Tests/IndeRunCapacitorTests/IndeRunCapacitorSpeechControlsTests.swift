import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
import IndeRunSwift
@testable import IndeRunCapacitorPlugin

/// Speech controls (ADR 025) across the iOS bridge's JSON path. The bridge builds no control JSON
/// by hand: requests decode and capabilities and outcomes encode through the generated Codable
/// types, so these tests pin that every control field survives that path and that an absent
/// `available` (unknown) stays absent rather than becoming `false` or `null`.
final class IndeRunCapacitorSpeechControlsTests: XCTestCase {

    // MARK: - Requests

    /// The facade split (`SpeakOptions` adds `playback`, `GenerateSpeechOptions` adds `mediaTypes`
    /// and `destinationRef`) happens in the Web facade on the JS side; native receives the request
    /// each call produces. `speak_controls_and_volume` and `generate_with_controls` from inderun
    /// 99ce979 `contracts/fixtures/facade/speech.json`, expected requests.
    func testTheRequestsSpeakAndGenerateSpeechProduceDecodeWithEveryControl() throws {
        let speak: JSObject = [
            "schemaVersion": "1.1",
            "task": ["kind": "text_to_speech"],
            "speech": [
                "text": "Guten Morgen!",
                "locale": "de-AT",
                "controls": ["speakingRate": ["value": 0.85, "requirement": "required"], "pitch": ["value": 1.05]]
            ],
            "delivery": ["mode": "playback", "playback": ["volume": ["value": 0.7]]]
        ]
        let speakRequest = try IndeRunCapacitorBridge.decodeTaskRequest(speak)
        XCTAssertEqual(speakRequest.speech?.controls?.speakingRate?.value, 0.85)
        XCTAssertEqual(speakRequest.speech?.controls?.speakingRate?.requirement, .requirementLevelRequired)
        XCTAssertEqual(speakRequest.speech?.controls?.pitch?.value, 1.05)
        // Absent stays absent: the engine reads it as `preferred`, the bridge does not fill it in.
        XCTAssertNil(speakRequest.speech?.controls?.pitch?.requirement)
        XCTAssertEqual(speakRequest.delivery?.playback?.volume?.value, 0.7)
        assertSameJSON(try jsonObject(speakRequest), speak, "speak request")

        let generate: JSObject = [
            "schemaVersion": "1.1",
            "task": ["kind": "text_to_speech"],
            "speech": ["text": "Guten Morgen!", "locale": "de-AT", "controls": ["speakingRate": ["value": 0.9]]],
            "delivery": ["mode": "artifact", "mediaTypes": ["audio/wav"]]
        ]
        let generateRequest = try IndeRunCapacitorBridge.decodeTaskRequest(generate)
        XCTAssertEqual(generateRequest.speech?.controls?.speakingRate?.value, 0.9)
        XCTAssertNil(generateRequest.delivery?.playback)
        assertSameJSON(try jsonObject(generateRequest), generate, "generateSpeech request")
    }

    /// A playback control on an artifact call is never dropped: it reaches the engine's validation,
    /// which refuses it.
    func testAPlaybackControlOnAnArtifactRequestReachesValidationAndIsRefused() async throws {
        let request: JSObject = [
            "schemaVersion": "1.1",
            "task": ["kind": "text_to_speech"],
            "speech": ["text": "Guten Morgen!", "locale": "de-AT"],
            "delivery": ["mode": "artifact", "mediaTypes": ["audio/wav"], "playback": ["volume": ["value": 0.5]]]
        ]
        XCTAssertEqual(try IndeRunCapacitorBridge.decodeTaskRequest(request).delivery?.playback?.volume?.value, 0.5)

        let bridge = IndeRunCapacitorBridge()
        await bridge.install(engine: IndeRun(registry: ProviderRegistry(), hostServices: DefaultHostServices.make()))
        let error = await refusal("run") { _ = try await bridge.run(requestObject: request) }
        XCTAssertEqual(error?.errorClass, .Internal)
        XCTAssertTrue(error?.message.contains("delivery.playback") ?? false, String(describing: error?.message))
    }

    func testARawCheckRefusalCarriesTheIssuesAsAnArray() async throws {
        let request: JSObject = [
            "schemaVersion": "1.1",
            "task": ["kind": "text_to_speech"],
            "speech": ["text": "Hallo", "locale": "de-AT", "controls": ["speakingrate": ["value": 0.9]]],
            "delivery": ["mode": "playback"]
        ]
        let bridge = IndeRunCapacitorBridge()
        await bridge.install(engine: IndeRun(registry: ProviderRegistry(), hostServices: DefaultHostServices.make()))

        let refused = await refusal("run") { _ = try await bridge.run(requestObject: request) }
        let error = try XCTUnwrap(refused)
        XCTAssertEqual(error.errorClass, .Internal)
        XCTAssertEqual(error.message, "Validation failed for TaskRequest: speech.controls.speakingrate is not a known control.")
        let details = try XCTUnwrap(try bridge.encode(error: error)["details"] as? [String: Any])
        XCTAssertEqual(details["validationIssues"] as? [String], ["speech.controls.speakingrate is not a known control."])
    }

    func testAStartStreamEnvelopeWithoutARequestObjectIsAValidationError() async throws {
        let bridge = IndeRunCapacitorBridge()
        await bridge.install(engine: IndeRun(registry: ProviderRegistry(), hostServices: DefaultHostServices.make()))
        let error = await refusal("stream") {
            _ = try await bridge.startStream(options: ["streamId": "s1", "request": "speak"], onEvent: { _, _ in }, onError: { _, _ in })
        }
        XCTAssertEqual(error?.errorClass, .Internal)
        XCTAssertEqual(error?.message, "Validation failed for TaskRequest: request must be a JSON object.")
    }

    // MARK: - Capabilities

    private let snapshot: [String: Any] = [
        "providerId": "speech.test",
        "descriptor": [
            "id": "speech.test",
            "type": "local",
            "transport": "in_process",
            "cancel": "hard",
            "tasks": ["text_to_speech"],
            "supports": [
                "run": true, "streaming": true, "realtime": false, "tools": false,
                "structuredOutput": false, "multimodal": false, "reasoningEvents": false
            ],
            "taskCapabilities": [[
                "kind": "text_to_speech",
                "cancel": "hard",
                "inputs": ["text"],
                "interaction": ["run": true, "stream": true],
                "outputs": [["delivery": "playback"], ["delivery": "artifact", "mediaTypes": ["audio/wav"]]],
                "locales": ["de-AT"],
                "controls": [
                    ["id": "speech.speakingRate", "valueKind": "number", "phase": "synthesis", "lifetime": "utterance", "deliveries": ["playback", "artifact"]],
                    ["id": "speech.pitch", "valueKind": "number", "phase": "synthesis", "lifetime": "utterance", "deliveries": ["playback"]],
                    ["id": "playback.volume", "valueKind": "number", "phase": "playback", "lifetime": "utterance", "deliveries": ["playback"]]
                ]
            ]]
        ],
        "capabilities": [
            "available": true,
            "taskCapabilities": [[
                "kind": "text_to_speech",
                "controlStates": [
                    ["id": "speech.speakingRate", "delivery": "playback", "available": true, "range": ["min": 0.5, "max": 2, "default": 1, "step": 0.1]],
                    ["id": "speech.speakingRate", "delivery": "artifact", "available": false, "reason": "artifact_path_fixed_rate"],
                    // `available` absent: unknown, which is not `false`.
                    ["id": "playback.volume", "delivery": "playback", "range": ["min": 0, "max": 1]]
                ],
                "voices": [[
                    "id": "anna",
                    "locale": "de-AT",
                    "controlStates": [
                        ["id": "speech.pitch", "delivery": "playback", "available": false, "reason": "voice_unsupported"],
                        ["id": "speech.speakingRate", "delivery": "playback"]
                    ]
                ]]
            ]]
        ]
    ]

    func testControlDeclarationsAndStatesSurviveTheCapabilitiesPath() throws {
        let decoded = try decodeJSON(ProviderCapabilitySnapshot.self, snapshot)
        let encoded = try IndeRunCapacitorBridge().encode(capabilities: [decoded])
        let providers = try XCTUnwrap(encoded["providers"] as? [Any])
        XCTAssertEqual(providers.count, 1)
        assertSameJSON(providers.first, snapshot, "capability snapshot")
    }

    func testAnUnknownAvailableStaysAbsentAndAKnownFalseStaysFalse() throws {
        let decoded = try decodeJSON(ProviderCapabilitySnapshot.self, snapshot)
        let encoded = try IndeRunCapacitorBridge().encode(capabilities: [decoded])
        let provider = try XCTUnwrap((encoded["providers"] as? [[String: Any]])?.first)
        let task = try XCTUnwrap(((provider["capabilities"] as? [String: Any])?["taskCapabilities"] as? [[String: Any]])?.first)
        let states = try XCTUnwrap(task["controlStates"] as? [[String: Any]])
        XCTAssertEqual(states[1]["available"] as? Bool, false)
        XCTAssertFalse(states[2].keys.contains("available"), "unknown became \(String(describing: states[2]["available"]))")
        XCTAssertFalse(states[2]["range"].map { ($0 as? [String: Any])?.keys.contains("default") ?? false } ?? true)

        let voice = try XCTUnwrap((task["voices"] as? [[String: Any]])?.first)
        let voiceStates = try XCTUnwrap(voice["controlStates"] as? [[String: Any]])
        XCTAssertEqual(voiceStates[0]["available"] as? Bool, false)
        XCTAssertFalse(voiceStates[1].keys.contains("available"))
    }

    func testNoControlKeysAppearWhenAProviderDeclaresNone() throws {
        var bare = snapshot
        var descriptor = try XCTUnwrap(bare["descriptor"] as? [String: Any])
        var capability = try XCTUnwrap((descriptor["taskCapabilities"] as? [[String: Any]])?.first)
        capability["controls"] = nil
        descriptor["taskCapabilities"] = [capability]
        bare["descriptor"] = descriptor
        bare["capabilities"] = ["available": true, "taskCapabilities": [["kind": "text_to_speech"]]]

        let encoded = try IndeRunCapacitorBridge().encode(capabilities: [try decodeJSON(ProviderCapabilitySnapshot.self, bare)])
        let provider = try XCTUnwrap((encoded["providers"] as? [[String: Any]])?.first)
        let declared = try XCTUnwrap(((provider["descriptor"] as? [String: Any])?["taskCapabilities"] as? [[String: Any]])?.first)
        XCTAssertFalse(declared.keys.contains("controls"))
        let live = try XCTUnwrap(((provider["capabilities"] as? [String: Any])?["taskCapabilities"] as? [[String: Any]])?.first)
        XCTAssertFalse(live.keys.contains("controlStates"))
    }

    // MARK: - Outcomes and rejection codes

    func testAnErrorTerminalPassesControlOutcomesThroughUnchanged() throws {
        let terminal: [String: Any] = [
            "schemaVersion": "1.1",
            "runId": "run_err",
            "outcome": "error",
            "error": ["schemaVersion": "1.1", "errorClass": "Internal", "message": "audio session lost"],
            "output": [
                "type": "playback",
                "playback": [:],
                "speech": [
                    "locale": "de-AT",
                    "controls": [
                        ["id": "speech.speakingRate", "requested": 0.85, "effective": 0.85, "status": "applied", "method": "platform_synthesis"],
                        ["id": "speech.pitch", "requested": 1.05, "status": "not_applied", "reason": "unsupported"]
                    ]
                ]
            ]
        ]
        let event = try decodeJSON(StreamEvent.self, [
            "schemaVersion": "1.1", "runId": "run_err", "sequence": 3, "timestamp": 1_700_000_000_000,
            "type": "terminal", "payload": terminal
        ] as [String: Any])
        let encoded = try IndeRunCapacitorBridge().encode(streamEvent: event)
        assertSameJSON(encoded["payload"], terminal, "error terminal")
    }

    func testTheControlRejectionCodesEncodeWithTheirWireSpelling() throws {
        var provenance = sampleProvenance(providerId: "speech.test")
        provenance.routeRejections = [
            ExecutionProvenanceRouteRejection(codes: [.speechControlUnsupported, .speechControlOutOfRange], providerId: "speech.test")
        ]
        let error = IndeRunError(
            details: nil,
            errorClass: .Unavailable,
            message: "No provider.",
            provenance: provenance,
            providerId: nil,
            retryable: nil,
            retryAfterMs: nil,
            runId: "run_1",
            schemaVersion: .the11
        )
        let encoded = try IndeRunCapacitorBridge().encode(error: error)
        let rejection = ((encoded["provenance"] as? [String: Any])?["routeRejections"] as? [[String: Any]])?.first
        XCTAssertEqual(rejection?["codes"] as? [String], ["speech_control_unsupported", "speech_control_out_of_range"])
    }
}
