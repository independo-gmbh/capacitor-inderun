import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
@testable import IndeRunCapacitorPlugin

/// Encoding is what the JS side actually consumes, so these assert the exact key
/// sets rather than round-tripping: an optional that encodes as `null` instead of
/// being absent changes which union branch the consumer reconstitutes.
final class IndeRunCapacitorStreamCodecTests: XCTestCase {

    private func event(
        type: String,
        sequence: Int = 0,
        payload: Payload?,
        runId: String = "run_1"
    ) -> StreamEvent {
        StreamEvent(
            payload: payload,
            runId: runId,
            schemaVersion: .the10,
            sequence: sequence,
            timestamp: 1_700_000_000_000,
            type: type
        )
    }

    func testEncodesContentDeltaWithOnlyTheTextField() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(
            streamEvent: event(type: "content_delta", payload: .content(text: "hello"))
        )

        XCTAssertEqual(encoded["schemaVersion"] as? String, "1.0")
        XCTAssertEqual(encoded["runId"] as? String, "run_1")
        XCTAssertEqual(encoded["sequence"] as? Int, 0)
        XCTAssertEqual(encoded["type"] as? String, "content_delta")

        let payload = try XCTUnwrap(encoded["payload"] as? [String: Any])
        XCTAssertEqual(payload["text"] as? String, "hello")
        XCTAssertEqual(Set(payload.keys), ["text"])
    }

    func testEncodesTerminalCompletedOutcome() throws {
        let bridge = IndeRunCapacitorBridge()
        let outcome = StreamTerminalOutcome.completed(
            runId: "run_1",
            finalText: "all done",
            finishReason: .stop,
            usage: TaskResultUsage(inputTokens: 3, outputTokens: 5, totalTokens: 8),
            telemetry: StreamTerminalOutcomeTelemetry(providerUsed: "openai", totalMs: 42)
        )

        let encoded = try bridge.encode(
            streamEvent: event(type: "terminal", sequence: 4, payload: Payload(terminalOutcome: outcome))
        )
        let payload = try XCTUnwrap(encoded["payload"] as? [String: Any])

        XCTAssertEqual(payload["outcome"] as? String, "completed")
        XCTAssertEqual(payload["finalText"] as? String, "all done")
        XCTAssertEqual(payload["finishReason"] as? String, "stop")
        XCTAssertEqual((payload["usage"] as? [String: Any])?["totalTokens"] as? Int, 8)
        XCTAssertEqual((payload["telemetry"] as? [String: Any])?["providerUsed"] as? String, "openai")
        // The error/cancellation branches' fields must not leak into a completion.
        XCTAssertNil(payload["error"])
        XCTAssertNil(payload["partialText"])
        XCTAssertNil(payload["reason"])
    }

    /// Terminal errors nest deeper than anything `run()` produces, which is the case
    /// that would break `encodeObject`'s `as? JSObject` cast if a nil ever encoded as
    /// NSNull.
    func testEncodesTerminalErrorOutcomeWithNestedDetails() throws {
        let bridge = IndeRunCapacitorBridge()
        let error = IndeRunError(
            details: ["endpoint": JSONAny("https://example.test")],
            errorClass: .RateLimited,
            message: "Too many requests.",
            providerId: "openai",
            retryable: true,
            retryAfterMs: 2_000,
            runId: "run_1",
            schemaVersion: .the10
        )
        let outcome = StreamTerminalOutcome.failed(runId: "run_1", error: error, partialText: "half ")

        let encoded = try bridge.encode(
            streamEvent: event(type: "terminal", sequence: 7, payload: Payload(terminalOutcome: outcome))
        )
        let payload = try XCTUnwrap(encoded["payload"] as? [String: Any])
        let encodedError = try XCTUnwrap(payload["error"] as? [String: Any])

        XCTAssertEqual(payload["outcome"] as? String, "error")
        XCTAssertEqual(payload["partialText"] as? String, "half ")
        XCTAssertEqual(encodedError["errorClass"] as? String, "RateLimited")
        XCTAssertEqual(encodedError["retryAfterMs"] as? Int, 2_000)
        XCTAssertEqual((encodedError["details"] as? [String: Any])?["endpoint"] as? String,
                       "https://example.test")
    }

    func testEncodesTerminalCancelledOutcomeWithAndWithoutReason() throws {
        let bridge = IndeRunCapacitorBridge()

        let withReason = try bridge.encode(
            streamEvent: event(
                type: "terminal",
                payload: Payload(
                    terminalOutcome: .cancelled(runId: "run_1", partialText: "part", reason: "user left")
                )
            )
        )
        XCTAssertEqual((withReason["payload"] as? [String: Any])?["reason"] as? String, "user left")

        let withoutReason = try bridge.encode(
            streamEvent: event(
                type: "terminal",
                payload: Payload(
                    terminalOutcome: .cancelled(runId: "run_1", partialText: "part", reason: nil)
                )
            )
        )
        let payload = try XCTUnwrap(withoutReason["payload"] as? [String: Any])
        XCTAssertEqual(payload["outcome"] as? String, "cancelled")
        XCTAssertEqual(payload["partialText"] as? String, "part")
        // Absent, not null: a null would decode as a present-but-empty reason.
        XCTAssertFalse(payload.keys.contains("reason"))
    }

    func testEncodesLifecyclePhase() throws {
        let bridge = IndeRunCapacitorBridge()
        let payload = Payload(
            text: nil, phase: .providerSelected, finalText: nil, finishReason: nil, outcome: nil,
            runId: nil, schemaVersion: nil, telemetry: nil, usage: nil, error: nil,
            partialText: nil, reason: nil
        )

        let encoded = try bridge.encode(streamEvent: event(type: "lifecycle", payload: payload))
        XCTAssertEqual((encoded["payload"] as? [String: Any])?["phase"] as? String, "provider_selected")
    }

    /// The schema closes its union with an open catch-all branch; an unrecognized
    /// type must cross the bridge untouched rather than be rejected.
    func testEncodesAnUnknownEventTypeVerbatimWithoutPayload() throws {
        let bridge = IndeRunCapacitorBridge()
        let encoded = try bridge.encode(
            streamEvent: event(type: "some_future_type", sequence: 2, payload: nil)
        )

        XCTAssertEqual(encoded["type"] as? String, "some_future_type")
        XCTAssertFalse(encoded.keys.contains("payload"))
    }

    func testEncodesStreamRunHandleWithAndWithoutProviderId() throws {
        let bridge = IndeRunCapacitorBridge()

        let withProvider = try bridge.encode(
            handle: StreamRunHandle(
                providerId: "openai",
                runId: "run_1",
                schemaVersion: .the10,
                startedAt: 1_700_000_000_000
            )
        )
        XCTAssertEqual(withProvider["providerId"] as? String, "openai")
        XCTAssertEqual(withProvider["runId"] as? String, "run_1")
        XCTAssertEqual(withProvider["startedAt"] as? Double, 1_700_000_000_000)

        let withoutProvider = try bridge.encode(
            handle: StreamRunHandle(
                providerId: nil,
                runId: "run_1",
                schemaVersion: .the10,
                startedAt: 1_700_000_000_000
            )
        )
        XCTAssertFalse(withoutProvider.keys.contains("providerId"))
    }
}
