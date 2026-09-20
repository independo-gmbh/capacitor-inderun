import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
@testable import IndeRunCapacitorPlugin

/// Collects what the pump hands to its sinks.
private final class SinkRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [JSObject] = []
    private var errors: [JSObject] = []

    func recordEvent(_ event: JSObject) {
        lock.lock()
        defer { lock.unlock() }
        events.append(event)
    }

    func recordError(_ error: JSObject) {
        lock.lock()
        defer { lock.unlock() }
        errors.append(error)
    }

    var eventTypes: [String] {
        lock.lock()
        defer { lock.unlock() }
        return events.compactMap { $0["type"] as? String }
    }

    var eventSequences: [Int] {
        lock.lock()
        defer { lock.unlock() }
        return events.compactMap { $0["sequence"] as? Int }
    }

    var errorClasses: [String] {
        lock.lock()
        defer { lock.unlock() }
        return errors.compactMap { $0["errorClass"] as? String }
    }
}

final class IndeRunCapacitorStreamPumpTests: XCTestCase {

    private func event(_ sequence: Int, type: String = "content_delta") -> StreamEvent {
        StreamEvent(
            payload: .content(text: "chunk\(sequence)"),
            runId: "run_1",
            schemaVersion: .the10,
            sequence: sequence,
            timestamp: 1_700_000_000_000,
            type: type
        )
    }

    private func cancelledTerminal(_ sequence: Int) -> StreamEvent {
        StreamEvent(
            payload: Payload(
                terminalOutcome: .cancelled(runId: "run_1", partialText: "part", reason: "stopped")
            ),
            runId: "run_1",
            schemaVersion: .the10,
            sequence: sequence,
            timestamp: 1_700_000_000_000,
            type: "terminal"
        )
    }

    private func makeRun(
        continuation: inout AsyncThrowingStream<StreamEvent, Error>.Continuation?,
        cancel: @escaping @Sendable (String?) -> Void = { _ in }
    ) -> StreamRun {
        let (events, made) = AsyncThrowingStream<StreamEvent, Error>.makeStream()
        continuation = made
        return StreamRun(
            handle: StreamRunHandle(
                providerId: nil,
                runId: "run_1",
                schemaVersion: .the10,
                startedAt: 1_700_000_000_000
            ),
            events: events,
            cancel: cancel
        )
    }

    private func pump(_ bridge: IndeRunCapacitorBridge, _ run: StreamRun, _ recorder: SinkRecorder) -> Task<Void, Never> {
        Task {
            await bridge.pump(
                streamId: "s1",
                run: run,
                onEvent: { _, event in recorder.recordEvent(event) },
                onError: { _, error in recorder.recordError(error) }
            )
        }
    }

    func testForwardsEveryEventInOrderAndFinishesTheRegistryEntry() async {
        let bridge = IndeRunCapacitorBridge()
        let recorder = SinkRecorder()
        var continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation?
        let run = makeRun(continuation: &continuation)

        bridge.streams.open(streamId: "s1")
        bridge.streams.attach(streamId: "s1", run: run)
        let task = pump(bridge, run, recorder)

        continuation?.yield(event(0))
        continuation?.yield(event(1))
        continuation?.finish()
        await task.value

        XCTAssertEqual(recorder.eventSequences, [0, 1])
        XCTAssertTrue(recorder.errorClasses.isEmpty)
        XCTAssertEqual(bridge.streams.activeCount, 0)
    }

    /// A provider failure is already a terminal event by the time it reaches the
    /// pump; anything actually thrown out of the sequence is a bridge fault.
    func testMapsAThrownStreamErrorToASingleNormalizedErrorSink() async {
        let bridge = IndeRunCapacitorBridge()
        let recorder = SinkRecorder()
        var continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation?
        let run = makeRun(continuation: &continuation)

        bridge.streams.open(streamId: "s1")
        let task = pump(bridge, run, recorder)

        continuation?.yield(event(0))
        continuation?.finish(
            throwing: IndeRunException(errorClass: .Internal, message: "pump blew up")
        )
        await task.value

        XCTAssertEqual(recorder.eventSequences, [0])
        XCTAssertEqual(recorder.errorClasses, ["Internal"])
        XCTAssertEqual(bridge.streams.activeCount, 0)
    }

    /// Cancelling a run must not stop the pump: the engine answers a cancel with its
    /// one `cancelled` terminal, and that still has to be delivered.
    func testCancelDuringEmitStillForwardsTheCancelledTerminal() async {
        let bridge = IndeRunCapacitorBridge()
        let recorder = SinkRecorder()
        var continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation?

        // Stand in for the engine: a cancel produces the cancelled terminal and ends
        // the sequence.
        nonisolated(unsafe) var capture: AsyncThrowingStream<StreamEvent, Error>.Continuation?
        let run = makeRun(continuation: &continuation, cancel: { _ in
            capture?.yield(
                StreamEvent(
                    payload: Payload(
                        terminalOutcome: .cancelled(runId: "run_1", partialText: "chunk0", reason: "stopped")
                    ),
                    runId: "run_1",
                    schemaVersion: .the10,
                    sequence: 1,
                    timestamp: 1_700_000_000_000,
                    type: "terminal"
                )
            )
            capture?.finish()
        })
        capture = continuation

        bridge.streams.open(streamId: "s1")
        bridge.streams.attach(streamId: "s1", run: run)
        let task = pump(bridge, run, recorder)

        continuation?.yield(event(0))
        bridge.streams.requestCancel(streamId: "s1", reason: "stopped")
        await task.value

        XCTAssertEqual(recorder.eventTypes, ["content_delta", "terminal"])
        XCTAssertTrue(recorder.errorClasses.isEmpty)
    }

    /// Teardown cancels the pump task itself. That is our own doing, with no one left
    /// to receive anything, so it must not be reported as a bridge failure.
    func testOwnTaskCancellationProducesNoErrorSink() async {
        let bridge = IndeRunCapacitorBridge()
        let recorder = SinkRecorder()
        var continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation?
        let run = makeRun(continuation: &continuation)

        bridge.streams.open(streamId: "s1")
        let task = pump(bridge, run, recorder)

        continuation?.yield(event(0))
        continuation?.finish(throwing: CancellationError())
        await task.value

        XCTAssertEqual(recorder.eventSequences, [0])
        XCTAssertTrue(recorder.errorClasses.isEmpty)
    }

    func testForwardsAnUnknownEventTypeWithoutTreatingItAsTerminal() async {
        let bridge = IndeRunCapacitorBridge()
        let recorder = SinkRecorder()
        var continuation: AsyncThrowingStream<StreamEvent, Error>.Continuation?
        let run = makeRun(continuation: &continuation)

        bridge.streams.open(streamId: "s1")
        let task = pump(bridge, run, recorder)

        continuation?.yield(event(0, type: "some_future_type"))
        continuation?.yield(cancelledTerminal(1))
        continuation?.finish()
        await task.value

        XCTAssertEqual(recorder.eventTypes, ["some_future_type", "terminal"])
    }
}
