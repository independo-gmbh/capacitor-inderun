import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
import IndeRunSwift
@testable import IndeRunCapacitorPlugin

/// Writes one fixed artifact per run, so a test can check that an artifact produced by one
/// bridge call is readable by a later one -- which only holds while both reach the same engine.
private final class ArtifactFixtureProvider: ProviderAdapter, @unchecked Sendable {
    static let id = "test.artifact-fixture"
    static let bytes = Data([0, 1, 2, 255])

    func describe() -> ProviderDescriptor {
        ProviderDescriptor(
            cancel: .hard,
            id: Self.id,
            limits: nil,
            model: nil,
            privacy: nil,
            streamingStyle: nil,
            supports: ProviderSupports(
                multimodal: false,
                realtime: false,
                reasoningEvents: false,
                run: true,
                streaming: false,
                structuredOutput: false,
                tools: false
            ),
            taskCapabilities: [
                ProviderTaskCapability(
                    cancel: .hard,
                    inputs: [.text],
                    interaction: ProviderTaskInteraction(prepare: nil, run: true, stream: false),
                    kind: "text_to_speech",
                    locales: ["de-AT"],
                    outputs: [ProviderTaskOutput(delivery: .artifact, mediaTypes: ["audio/wav"])],
                    privacy: nil
                )
            ],
            tasks: ["text_to_speech"],
            transport: .inProcess,
            type: .local
        )
    }

    func capabilities(host: HostServices) async -> ProviderDynamicCapabilities {
        ProviderDynamicCapabilities(
            available: true,
            cancellationAvailable: nil,
            reason: nil,
            streamingAvailable: nil,
            streamingUnavailableReason: nil,
            taskCapabilities: nil
        )
    }

    func run(request: TaskRequest, context: RunContext) async throws -> TaskResult {
        let writer = context.artifacts.create(spec: ArtifactSpec(mediaType: "audio/wav"))
        try writer.write(Self.bytes)
        let artifact = try writer.finish()
        return TaskResult(
            finishReason: .stop,
            output: TaskOutput(artifact: artifact, playback: nil, preparation: nil, speech: nil, text: nil, type: .artifact),
            provenance: nil,
            runId: context.runId,
            schemaVersion: .the10,
            telemetry: TaskResultTelemetry(errorClass: nil, providerUsed: Self.id, reportedModel: nil, totalMs: 0),
            usage: nil
        )
    }
}

/// Collects what the pump hands to its sinks.
private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [JSObject] = []

    func record(_ event: JSObject) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(event)
    }

    var events: [JSObject] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}

final class IndeRunCapacitorEngineTests: XCTestCase {

    private let speechRequest: JSObject = [
        "schemaVersion": "1.0",
        "task": ["kind": "text_to_speech"],
        "speech": ["text": "Der Bus kommt.", "locale": "de-AT"],
        "delivery": ["mode": "artifact"]
    ]

    private func makeEngine() throws -> IndeRun {
        let registry = ProviderRegistry()
        try registry.register(ArtifactFixtureProvider())
        return IndeRun(registry: registry, hostServices: DefaultHostServices.make())
    }

    private func configuredBridge() async throws -> IndeRunCapacitorBridge {
        let bridge = IndeRunCapacitorBridge()
        await bridge.install(engine: try makeEngine())
        return bridge
    }

    private func artifactId(of result: JSObject) throws -> String {
        let output = try XCTUnwrap(result["output"] as? [String: Any])
        let artifact = try XCTUnwrap(output["artifact"] as? [String: Any])
        return try XCTUnwrap(artifact["id"] as? String)
    }

    private func assertFails(
        _ body: () async throws -> Void,
        withCode code: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await body()
            XCTFail("Expected a failure with code \(code).", file: file, line: line)
        } catch {
            let contractError = toIndeRunException(error).toContractError()
            XCTAssertEqual(contractError.errorClass, .Unavailable, file: file, line: line)
            XCTAssertEqual(contractError.details?["code"]?.value as? String, code, file: file, line: line)
        }
    }

    // MARK: - One engine per configuration

    func testAnArtifactFromOneCallIsReadableByALaterCall() async throws {
        let bridge = try await configuredBridge()

        let result = try await bridge.run(requestObject: speechRequest)
        let chunk = try await bridge.readArtifact(requestObject: ["artifactId": try artifactId(of: result)])

        XCTAssertEqual(chunk["offset"] as? Int, 0)
        XCTAssertEqual(chunk["totalBytes"] as? Int, 4)
        XCTAssertEqual(chunk["done"] as? Bool, true)
        // Base64 on the wire: JSON has no byte type.
        XCTAssertEqual(chunk["bytes"] as? String, ArtifactFixtureProvider.bytes.base64EncodedString())
        XCTAssertEqual(chunk["bytes"] as? String, "AAEC/w==")
    }

    func testReadsARangeOfAnArtifact() async throws {
        let bridge = try await configuredBridge()
        let id = try artifactId(of: try await bridge.run(requestObject: speechRequest))

        let chunk = try await bridge.readArtifact(requestObject: ["artifactId": id, "offset": 1, "maxBytes": 2])

        XCTAssertEqual(chunk["offset"] as? Int, 1)
        XCTAssertEqual(chunk["done"] as? Bool, false)
        XCTAssertEqual(chunk["bytes"] as? String, Data([1, 2]).base64EncodedString())
    }

    func testADisposedArtifactIsNoLongerReadable() async throws {
        let bridge = try await configuredBridge()
        let result = try await bridge.run(requestObject: speechRequest)
        let output = try XCTUnwrap(result["output"] as? [String: Any])
        let artifact = try XCTUnwrap(output["artifact"] as? JSObject)

        try await bridge.disposeArtifact(artifactObject: artifact)
        // Idempotent, like upstream.
        try await bridge.disposeArtifact(artifactObject: artifact)

        await assertFails({
            _ = try await bridge.readArtifact(requestObject: ["artifactId": try self.artifactId(of: result)])
        }, withCode: "artifact_not_found")
    }

    func testANewConfigurationClosesTheEngineItReplaces() async throws {
        let bridge = IndeRunCapacitorBridge()
        let first = try makeEngine()
        await bridge.install(engine: first)
        let id = try artifactId(of: try await bridge.run(requestObject: speechRequest))

        await bridge.install(engine: try makeEngine())

        // Closed upstream: a closed engine reports no providers.
        let firstProviders = await first.checkCapabilities()
        XCTAssertTrue(firstProviders.isEmpty)
        // The artifact died with the engine that held it.
        await assertFails({
            _ = try await bridge.readArtifact(requestObject: ["artifactId": id])
        }, withCode: "artifact_not_found")
        // And the new engine serves calls.
        let providers = try await bridge.checkCapabilities()["providers"] as? [[String: Any]]
        XCTAssertEqual(providers?.first?["providerId"] as? String, ArtifactFixtureProvider.id)
    }

    // MARK: - configure ordering

    private func openAIOptions(_ model: String) -> JSObject {
        ["openAI": ["models": [model], "auth": "none"]]
    }

    private func providerIds(_ bridge: IndeRunCapacitorBridge) async throws -> Set<String> {
        let providers = try await bridge.checkCapabilities()["providers"] as? [[String: Any]] ?? []
        return Set(providers.compactMap { $0["providerId"] as? String })
    }

    func testBackToBackConfiguresLeaveTheLaterOneInstalled() async throws {
        let bridge = IndeRunCapacitorBridge()

        // Neither replaced engine is awaited, as when two plugin calls arrive back to back.
        _ = try bridge.configure(options: openAIOptions("first-model"))
        let replaced = try bridge.configure(options: openAIOptions("second-model"))

        let ids = try await providerIds(bridge)
        XCTAssertTrue(ids.contains("openai:second-model"))
        XCTAssertFalse(ids.contains("openai:first-model"))
        await replaced?.close()
        let afterClose = try await providerIds(bridge)
        XCTAssertTrue(afterClose.contains("openai:second-model"))
    }

    func testConfigureInstallsTheEngineBeforeItReturns() async throws {
        let bridge = IndeRunCapacitorBridge()

        XCTAssertNil(try bridge.configure(options: openAIOptions("gpt-5.2")))

        // The next call, issued without waiting for anything, reaches the configured engine.
        let ids = try await providerIds(bridge)
        XCTAssertTrue(ids.contains("openai:gpt-5.2"))
    }

    func testConfigureHandsBackTheReplacedEngineForTheCallerToClose() async throws {
        let bridge = IndeRunCapacitorBridge()
        let first = try makeEngine()
        await bridge.install(engine: first)

        let replaced = try bridge.configure(options: openAIOptions("gpt-5.2"))

        XCTAssertTrue(replaced === first)
        let stillOpen = await first.checkCapabilities()
        XCTAssertFalse(stillOpen.isEmpty)
        await replaced?.close()
        let closed = await first.checkCapabilities()
        XCTAssertTrue(closed.isEmpty)
    }

    func testARefusedConfigurationKeepsTheInstalledEngine() async throws {
        let bridge = try await configuredBridge()

        XCTAssertThrowsError(try bridge.configure(options: ["modelProfiles": ["auto": ["openai:gpt-5.2"]]]))

        let ids = try await providerIds(bridge)
        XCTAssertEqual(ids, [ArtifactFixtureProvider.id])
    }

    // MARK: - close

    func testCloseLeavesTheEngineClosedUntilTheNextConfiguration() async throws {
        let bridge = try await configuredBridge()

        await bridge.close()
        await bridge.close()

        await assertFails({ _ = try await bridge.run(requestObject: self.speechRequest) }, withCode: "engine_closed")
        await assertFails({ _ = try await bridge.readArtifact(requestObject: ["artifactId": "a"]) }, withCode: "engine_closed")
        // Upstream's closed engine reports no providers rather than failing.
        let providers = try await bridge.checkCapabilities()["providers"] as? [Any]
        XCTAssertEqual(providers?.count, 0)

        await bridge.install(engine: try makeEngine())
        let result = try await bridge.run(requestObject: speechRequest)
        XCTAssertNotNil(result["output"])
    }

    func testCloseBeforeConfigureDoesNothing() async {
        await IndeRunCapacitorBridge().close()
    }

    func testArtifactCallsBeforeConfigureFailAsUnavailable() async {
        let bridge = IndeRunCapacitorBridge()
        do {
            _ = try await bridge.readArtifact(requestObject: ["artifactId": "a"])
            XCTFail("Expected readArtifact to fail before configure.")
        } catch {
            let contractError = toIndeRunException(error).toContractError()
            XCTAssertEqual(contractError.errorClass, .Unavailable)
            XCTAssertTrue(contractError.message.contains("readArtifact(request)"))
        }
    }

    // MARK: - prepare

    func testPrepareIsPumpedLikeAStreamAndEndsInOneTerminal() async throws {
        let bridge = try await configuredBridge()
        let recorder = EventRecorder()
        let finished = expectation(description: "terminal delivered")

        let handle = try await bridge.startPrepare(
            options: ["streamId": "p1", "request": ["requestId": "prepare_1"]],
            onEvent: { streamId, event in
                XCTAssertEqual(streamId, "p1")
                recorder.record(event)
                if event["type"] as? String == "terminal" {
                    finished.fulfill()
                }
            },
            onError: { _, error in XCTFail("Unexpected bridge error: \(error)") }
        )

        XCTAssertEqual(handle["runId"] as? String, "prepare_1")
        await fulfillment(of: [finished], timeout: 5)

        let events = recorder.events
        XCTAssertEqual(events.count, 1)
        let payload = try XCTUnwrap(events.first?["payload"] as? [String: Any])
        XCTAssertEqual(payload["outcome"] as? String, "completed")
        let output = try XCTUnwrap(payload["output"] as? [String: Any])
        XCTAssertEqual(output["type"] as? String, "prepared")
        XCTAssertNotNil(output["preparation"] as? [Any])
    }

    func testPrepareOnAClosedEngineRejectsWithEngineClosed() async throws {
        let bridge = try await configuredBridge()
        await bridge.close()

        await assertFails({
            _ = try await bridge.startPrepare(
                options: ["streamId": "p1", "request": [String: Any]()],
                onEvent: { _, _ in },
                onError: { _, _ in }
            )
        }, withCode: "engine_closed")
        XCTAssertEqual(bridge.streams.activeCount, 0)
    }
}
