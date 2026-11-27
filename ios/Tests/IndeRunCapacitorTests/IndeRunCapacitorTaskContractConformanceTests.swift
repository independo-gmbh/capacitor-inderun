import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
import IndeRunSwift
@testable import IndeRunCapacitorPlugin

/// Counts the engine's capability probes. The router probes every registered provider for every
/// request it routes, after the engine's request validation, so a probe is the sign that a request
/// got past the bridge and past validation. It reports itself unavailable, so nothing ever runs.
private final class ProbeRecordingProvider: ProviderAdapter, @unchecked Sendable {
    static let id = "test.probe-recording"
    private let lock = NSLock()
    private var recordedProbes = 0

    var probes: Int { lock.withLock { recordedProbes } }

    func describe() -> ProviderDescriptor {
        ProviderDescriptor(
            cancel: .hard,
            id: Self.id,
            limits: nil,
            model: nil,
            privacy: ProviderPrivacy(dataLeavesDevice: false, regions: nil),
            streamingStyle: nil,
            supports: ProviderSupports(
                multimodal: false,
                realtime: false,
                reasoningEvents: false,
                run: true,
                streaming: true,
                structuredOutput: false,
                tools: false
            ),
            taskCapabilities: [
                ProviderTaskCapability(
                    cancel: .hard,
                    controls: nil,
                    inputs: [.text],
                    interaction: ProviderTaskInteraction(prepare: nil, run: true, stream: true),
                    kind: "text_to_speech",
                    locales: ["de-AT", "en-GB"],
                    outputs: [
                        ProviderTaskOutput(delivery: .playback, mediaTypes: nil),
                        ProviderTaskOutput(delivery: .artifact, mediaTypes: ["audio/wav"])
                    ],
                    privacy: nil
                )
            ],
            tasks: ["text_to_speech"],
            transport: .inProcess,
            type: .local
        )
    }

    func capabilities(host: HostServices) async -> ProviderDynamicCapabilities {
        lock.withLock { recordedProbes += 1 }
        return ProviderDynamicCapabilities(
            available: false,
            cancellationAvailable: nil,
            reason: "test provider never runs",
            streamingAvailable: nil,
            streamingUnavailableReason: nil,
            taskCapabilities: nil
        )
    }

    func run(request: TaskRequest, context: RunContext) async throws -> TaskResult {
        XCTFail("the probe-recording provider must never run")
        throw createInternal(message: "unreachable")
    }
}

/// Task-contract conformance: the vendored `text-to-speech.json` fixture through the bridge's two
/// `TaskRequest` entry points, `run(requestObject:)` and `startStream(options:)`, which are what the
/// plugin's `run` and `startStream` call. The iOS counterpart of Android's
/// `TaskContractConformanceTest`.
///
/// - `invalidPayloads` (JSON the Codable types would lose) are refused by the core's raw check with
///   the normalized validation error, and the engine is never reached.
/// - `invalidRequests` (decodable, but against the per-kind rules) decode without losing the
///   offending field and are refused by the engine's request validation, before routing.
/// - Every current case decodes to exactly the request the fixture holds and reaches routing, and
///   its result or terminal comes back out exactly as the fixture holds it.
final class IndeRunCapacitorTaskContractConformanceTests: XCTestCase {

    private func entries(_ name: String) throws -> [[String: Any]] {
        let fixture = try taskContractFixture("text-to-speech.json")
        let entries = try XCTUnwrap(fixture[name] as? [[String: Any]], "fixture has no \(name)")
        XCTAssertFalse(entries.isEmpty, "fixture has no \(name)")
        return entries
    }

    /// A fresh copy of the entry's request, typed as the plugin hands it over.
    private func request(_ entry: [String: Any]) throws -> JSObject {
        try XCTUnwrap(jsonCopy(entry["request"] as Any) as? JSObject)
    }

    private func id(_ entry: [String: Any]) -> String {
        entry["id"] as? String ?? "<no id>"
    }

    private func configuredBridge() async throws -> (IndeRunCapacitorBridge, ProbeRecordingProvider) {
        let provider = ProbeRecordingProvider()
        let registry = ProviderRegistry()
        try registry.register(provider)
        // `playback_run` names the `speech` profile; an unknown profile is itself a validation issue.
        let engine = IndeRun(
            registry: registry,
            hostServices: DefaultHostServices.make(),
            modelProfiles: try ModelProfiles(["speech": [ProbeRecordingProvider.id]])
        )
        let bridge = IndeRunCapacitorBridge()
        await bridge.install(engine: engine)
        return (bridge, provider)
    }

    private func runCall(_ bridge: IndeRunCapacitorBridge, _ request: JSObject) -> () async throws -> Void {
        { _ = try await bridge.run(requestObject: request) }
    }

    private func streamCall(_ bridge: IndeRunCapacitorBridge, _ request: JSObject, _ streamId: String) -> () async throws -> Void {
        {
            _ = try await bridge.startStream(
                options: ["streamId": streamId, "request": request],
                onEvent: { _, _ in XCTFail("no event may reach a refused or unrouted stream") },
                onError: { _, _ in XCTFail("no error event may reach a refused or unrouted stream") }
            )
        }
    }

    /// The normalized validation error: `Internal`, the engine's message prefix, and the offending
    /// fields in `details.validationIssues`.
    private func assertValidationError(_ error: IndeRunError?, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let error else { return }
        XCTAssertEqual(error.errorClass, .Internal, label, file: file, line: line)
        XCTAssertTrue(error.message.hasPrefix("Validation failed for TaskRequest: "), "\(label): \(error.message)", file: file, line: line)
        XCTAssertNotNil(error.details?["validationIssues"], "\(label): no details.validationIssues in \(String(describing: error.details))", file: file, line: line)
    }

    func testEveryInvalidPayloadIsRefusedByTheRawCheckBeforeTheEngineIsReached() async throws {
        let (bridge, provider) = try await configuredBridge()
        for entry in try entries("invalidPayloads") {
            let id = id(entry)
            let expected = RawTaskRequestValidation.issues(try request(entry))
            XCTAssertFalse(expected.isEmpty, "\(id): the core raw check finds nothing")

            for (label, call) in [("run", runCall(bridge, try request(entry))), ("stream", streamCall(bridge, try request(entry), "s_\(id)"))] {
                let error = await refusal("\(id) (\(label))", call)
                assertValidationError(error, "\(id) (\(label))")
                XCTAssertEqual(error?.message, "Validation failed for TaskRequest: " + expected.joined(separator: "; "), "\(id) (\(label))")
                // The issues cross to JS intact, as an array of the core's own messages.
                let encoded = try error.map { try bridge.encode(error: $0) }
                let details = encoded?["details"] as? [String: Any]
                XCTAssertEqual(details?["validationIssues"] as? [String], expected, "\(id) (\(label))")
            }
        }
        XCTAssertEqual(provider.probes, 0, "an invalid payload reached the engine's routing")
    }

    func testEveryInvalidRequestKeepsItsOffendingFieldAndIsRefusedByTheEngineValidation() async throws {
        let (bridge, provider) = try await configuredBridge()
        for entry in try entries("invalidRequests") {
            let id = id(entry)
            XCTAssertEqual(RawTaskRequestValidation.issues(try request(entry)), [], "\(id): the raw check is targeted, the engine owns these rules")
            // Nothing the engine has to see is lost on the way in.
            let decoded = try IndeRunCapacitorBridge.decodeTaskRequest(try request(entry))
            assertSameJSON(try jsonObject(decoded), try request(entry), "\(id) decoded request")

            assertValidationError(await refusal("\(id) (run)", runCall(bridge, try request(entry))), "\(id) (run)")
            assertValidationError(await refusal("\(id) (stream)", streamCall(bridge, try request(entry), "s_\(id)")), "\(id) (stream)")
        }
        XCTAssertEqual(provider.probes, 0, "an invalid request reached the engine's routing")
    }

    func testEveryCurrentCaseReachesRoutingUnchangedAndItsOutcomeEncodesFaithfully() async throws {
        for entry in try entries("cases") {
            let id = id(entry)
            let decoded = try IndeRunCapacitorBridge.decodeTaskRequest(try request(entry))
            assertSameJSON(try jsonObject(decoded), try request(entry), "\(id) decoded request")

            // Past the bridge and the engine's validation: routing probes the provider.
            let (bridge, provider) = try await configuredBridge()
            let call = entry["terminal"] != nil ? streamCall(bridge, try request(entry), "s_\(id)") : runCall(bridge, try request(entry))
            let error = await refusal(id, call)
            XCTAssertFalse(error?.message.hasPrefix("Validation failed") ?? true, "\(id) was refused: \(String(describing: error?.message))")
            XCTAssertGreaterThan(provider.probes, 0, "\(id) did not reach routing")

            if let result = entry["result"] {
                let encoded = try bridge.encode(result: try decodeJSON(TaskResult.self, result))
                assertSameJSON(encoded, result, "\(id) result")
            }

            if let terminal = entry["terminal"] as? [String: Any] {
                let event = try decodeJSON(StreamEvent.self, [
                    "schemaVersion": "1.1",
                    "runId": terminal["runId"] as Any,
                    "sequence": 4,
                    "timestamp": 1_700_000_000_000,
                    "type": "terminal",
                    "payload": terminal
                ] as [String: Any])
                let encoded = try bridge.encode(streamEvent: event)
                assertSameJSON(encoded["payload"], terminal, "\(id) terminal")
            }
        }
    }
}
