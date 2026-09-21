import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
@testable import IndeRunCapacitorPlugin

final class IndeRunCapacitorBridgeTests: XCTestCase {

    // MARK: - CapacitorRunOptions decoding

    func testDecodesConfigureOptionsWithOpenAI() throws {
        let json: [String: Any] = [
            "openAI": [
                "model": "gpt-5.2",
                "endpointUrl": "/api/inderun/openai-responses",
                "auth": "none",
                "authContextRef": "openai/main",
                "timeoutMs": 30_000
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let options = try JSONDecoder().decode(CapacitorRunOptions.self, from: data)

        XCTAssertEqual(options.openAI?.model, "gpt-5.2")
        XCTAssertEqual(options.openAI?.endpointURL, "/api/inderun/openai-responses")
        XCTAssertEqual(options.openAI?.auth, "none")
        XCTAssertEqual(options.openAI?.authContextRef, "openai/main")
        XCTAssertEqual(options.openAI?.timeoutMs, 30_000)
        XCTAssertNil(options.allowDirectOpenAIEndpoint)
    }

    // Regression: the wire key is `endpointUrl` (what src/definitions.ts and
    // IndeRunSerializer.kt both use). iOS previously decoded `endpointURL`, so a
    // TypeScript-supplied endpoint was dropped and the provider silently fell back to
    // the default OpenAI Responses endpoint.
    func testDecodesEndpointUrlUsingTheTypeScriptWireKey() throws {
        let json: [String: Any] = [
            "openAI": [
                "model": "gpt-5.2",
                "endpointUrl": "https://proxy.example/api/openai-responses"
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let options = try JSONDecoder().decode(CapacitorRunOptions.self, from: data)

        XCTAssertEqual(options.openAI?.endpointURL, "https://proxy.example/api/openai-responses")
    }

    func testIgnoresTheLegacySwiftCasedEndpointKey() throws {
        let json: [String: Any] = [
            "openAI": [
                "model": "gpt-5.2",
                "endpointURL": "https://proxy.example/api/openai-responses"
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let options = try JSONDecoder().decode(CapacitorRunOptions.self, from: data)

        XCTAssertNil(options.openAI?.endpointURL)
    }

    func testDecodesConfigureOptionsWithAllOptionalFieldsAbsent() throws {
        let data = try JSONSerialization.data(withJSONObject: [String: Any]())
        let options = try JSONDecoder().decode(CapacitorRunOptions.self, from: data)

        XCTAssertNil(options.openAI)
        XCTAssertNil(options.allowDirectOpenAIEndpoint)
    }

    func testDecodesOpenAIOptionsWithOnlyRequiredFields() throws {
        let json: [String: Any] = ["openAI": ["model": "gpt-4"]]
        let data = try JSONSerialization.data(withJSONObject: json)
        let options = try JSONDecoder().decode(CapacitorRunOptions.self, from: data)

        XCTAssertEqual(options.openAI?.model, "gpt-4")
        XCTAssertNil(options.openAI?.endpointURL)
        XCTAssertNil(options.openAI?.auth)
        XCTAssertNil(options.openAI?.authContextRef)
        XCTAssertNil(options.openAI?.timeoutMs)
    }

    func testDecodesAllowDirectOpenAIEndpoint() throws {
        let json: [String: Any] = ["allowDirectOpenAIEndpoint": true]
        let data = try JSONSerialization.data(withJSONObject: json)
        let options = try JSONDecoder().decode(CapacitorRunOptions.self, from: data)

        XCTAssertEqual(options.allowDirectOpenAIEndpoint, true)
    }

    // MARK: - encode(error:)

    func testEncodesIndeRunErrorRequiredFieldsOnly() throws {
        let bridge = IndeRunCapacitorBridge()
        let error = IndeRunError(
            details: nil,
            errorClass: .Unavailable,
            message: "Not configured.",
            providerId: nil,
            retryable: nil,
            retryAfterMs: nil,
            runId: nil,
            schemaVersion: .the10
        )

        let encoded = try bridge.encode(error: error)

        XCTAssertEqual(encoded["schemaVersion"] as? String, "1.0")
        XCTAssertEqual(encoded["errorClass"] as? String, "Unavailable")
        XCTAssertEqual(encoded["message"] as? String, "Not configured.")
        XCTAssertNil(encoded["providerId"])
        XCTAssertNil(encoded["retryable"])
        XCTAssertNil(encoded["retryAfterMs"])
        XCTAssertNil(encoded["runId"])
    }

    func testEncodesIndeRunErrorWithAllOptionalFields() throws {
        let bridge = IndeRunCapacitorBridge()
        let error = IndeRunError(
            details: nil,
            errorClass: .RateLimited,
            message: "Too many requests.",
            providerId: "openai",
            retryable: true,
            retryAfterMs: 2_000,
            runId: "run_abc",
            schemaVersion: .the10
        )

        let encoded = try bridge.encode(error: error)

        XCTAssertEqual(encoded["errorClass"] as? String, "RateLimited")
        XCTAssertEqual(encoded["providerId"] as? String, "openai")
        XCTAssertEqual(encoded["retryable"] as? Bool, true)
        XCTAssertEqual(encoded["retryAfterMs"] as? Int, 2_000)
        XCTAssertEqual(encoded["runId"] as? String, "run_abc")
    }

    // MARK: - encode(capabilities:)

    private func makeSnapshot(
        providerId: String,
        type: ProviderDescriptor.ProviderType,
        transport: ProviderDescriptor.TransportType,
        streamingStyle: ProviderDescriptor.StreamingStyle? = nil,
        streaming: Bool,
        cancel: ProviderDescriptor.CancelSemantics,
        limits: ProviderDescriptor.ResourceLimits? = nil,
        privacy: ProviderDescriptor.PrivacyDescriptor? = nil,
        capabilities: ProviderDynamicCapabilities
    ) -> ProviderCapabilitySnapshot {
        ProviderCapabilitySnapshot(
            providerId: providerId,
            descriptor: ProviderDescriptor(
                id: providerId,
                type: type,
                transport: transport,
                streamingStyle: streamingStyle,
                supports: ProviderDescriptor.SupportsCapabilities(
                    run: true,
                    streaming: streaming,
                    realtime: false,
                    tools: false,
                    reasoningEvents: false,
                    structuredOutput: false,
                    multimodal: false
                ),
                cancel: cancel,
                tasks: ["text_to_text"],
                limits: limits,
                privacy: privacy
            ),
            capabilities: capabilities
        )
    }

    func testEncodesCapabilitySnapshotsInsideTheProvidersEnvelope() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(capabilities: [
            makeSnapshot(
                providerId: "openai",
                type: .cloud,
                transport: .http,
                streamingStyle: .tokens,
                streaming: true,
                cancel: .hard,
                limits: ProviderDescriptor.ResourceLimits(maxInputTokens: 128_000, maxOutputTokens: 4_096),
                privacy: ProviderDescriptor.PrivacyDescriptor(dataLeavesDevice: true, regions: ["us"]),
                capabilities: ProviderDynamicCapabilities(available: true)
            )
        ])

        let providers = try XCTUnwrap(encoded["providers"] as? [[String: Any]])
        XCTAssertEqual(providers.count, 1)
        XCTAssertEqual(providers[0]["providerId"] as? String, "openai")

        let descriptor = try XCTUnwrap(providers[0]["descriptor"] as? [String: Any])
        XCTAssertEqual(descriptor["id"] as? String, "openai")
        XCTAssertEqual(descriptor["type"] as? String, "cloud")
        XCTAssertEqual(descriptor["transport"] as? String, "http")
        XCTAssertEqual(descriptor["streamingStyle"] as? String, "tokens")
        XCTAssertEqual(descriptor["cancel"] as? String, "hard")
        XCTAssertEqual(descriptor["tasks"] as? [String], ["text_to_text"])

        let supports = try XCTUnwrap(descriptor["supports"] as? [String: Any])
        XCTAssertEqual(supports["run"] as? Bool, true)
        XCTAssertEqual(supports["streaming"] as? Bool, true)
        XCTAssertEqual(supports["multimodal"] as? Bool, false)

        let limits = try XCTUnwrap(descriptor["limits"] as? [String: Any])
        XCTAssertEqual(limits["maxInputTokens"] as? Int, 128_000)
        XCTAssertNil(limits["maxImageBytes"])

        let privacy = try XCTUnwrap(descriptor["privacy"] as? [String: Any])
        XCTAssertEqual(privacy["dataLeavesDevice"] as? Bool, true)
        XCTAssertEqual(privacy["regions"] as? [String], ["us"])
    }

    /// `in_process` is the one descriptor constant a future upstream rename to Swift
    /// casing would silently corrupt on the wire, since the JS union spells it out.
    func testEncodesTheInProcessTransportWithItsWireSpelling() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(capabilities: [
            makeSnapshot(
                providerId: "local.onnx.genai.apple",
                type: .local,
                transport: .inProcess,
                streaming: false,
                cancel: .soft,
                capabilities: ProviderDynamicCapabilities(available: false, reason: "No model package.")
            )
        ])

        let providers = try XCTUnwrap(encoded["providers"] as? [[String: Any]])
        let descriptor = try XCTUnwrap(providers[0]["descriptor"] as? [String: Any])
        XCTAssertEqual(descriptor["transport"] as? String, "in_process")
        XCTAssertNil(descriptor["streamingStyle"])

        let capabilities = try XCTUnwrap(providers[0]["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["available"] as? Bool, false)
        XCTAssertEqual(capabilities["reason"] as? String, "No model package.")
    }

    /// Absence means "inherit the static declaration". A null would be a third state
    /// consumers do not have, so the unset optionals must not reach the wire at all.
    func testOmitsUnsetDynamicCapabilityFlagsRatherThanEncodingNull() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(capabilities: [
            makeSnapshot(
                providerId: "apple.foundation-models",
                type: .local,
                transport: .systemService,
                streamingStyle: .snapshots,
                streaming: true,
                cancel: .soft,
                capabilities: ProviderDynamicCapabilities(available: true)
            )
        ])

        let providers = try XCTUnwrap(encoded["providers"] as? [[String: Any]])
        let descriptor = try XCTUnwrap(providers[0]["descriptor"] as? [String: Any])
        XCTAssertEqual(descriptor["transport"] as? String, "system_service")
        XCTAssertEqual(descriptor["streamingStyle"] as? String, "snapshots")
        XCTAssertNil(descriptor["limits"])
        XCTAssertNil(descriptor["privacy"])

        let capabilities = try XCTUnwrap(providers[0]["capabilities"] as? [String: Any])
        XCTAssertNil(capabilities["streamingAvailable"])
        XCTAssertNil(capabilities["streamingUnavailableReason"])
        XCTAssertNil(capabilities["cancellationAvailable"])
        XCTAssertNil(capabilities["reason"])
    }

    func testEncodesStreamingTakenAwayAtRuntime() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(capabilities: [
            makeSnapshot(
                providerId: "openai",
                type: .cloud,
                transport: .http,
                streamingStyle: .tokens,
                streaming: true,
                cancel: .hard,
                capabilities: ProviderDynamicCapabilities(
                    available: true,
                    streamingAvailable: false,
                    streamingUnavailableReason: "Host has no streaming HTTP client.",
                    cancellationAvailable: true
                )
            )
        ])

        let providers = try XCTUnwrap(encoded["providers"] as? [[String: Any]])
        let capabilities = try XCTUnwrap(providers[0]["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["streamingAvailable"] as? Bool, false)
        XCTAssertEqual(
            capabilities["streamingUnavailableReason"] as? String,
            "Host has no streaming HTTP client."
        )
        XCTAssertEqual(capabilities["cancellationAvailable"] as? Bool, true)
    }

    func testEncodesAnEmptyRegistryAsAnEmptyProvidersArray() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(capabilities: [])

        XCTAssertEqual(try XCTUnwrap(encoded["providers"] as? [[String: Any]]).count, 0)
    }

    // MARK: - mapAuthMode

    func testMapAuthModeNoneString() {
        let bridge = IndeRunCapacitorBridge()
        XCTAssertEqual(bridge.mapAuthMode("none"), .none)
    }

    func testMapAuthModeUnknownStringDefaultsToAuthContextRef() {
        let bridge = IndeRunCapacitorBridge()
        XCTAssertEqual(bridge.mapAuthMode("some_future_value"), .authContextRef)
    }

    func testMapAuthModeNilDefaultsToAuthContextRef() {
        let bridge = IndeRunCapacitorBridge()
        XCTAssertEqual(bridge.mapAuthMode(nil), .authContextRef)
    }
}
