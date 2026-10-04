import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
@testable import IndeRunCapacitorPlugin

/// Records the cancel calls a fake `StreamRun` receives, so a test can assert both
/// that a cancel arrived and what reason it carried.
private final class CancelRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [String?] = []

    func record(_ reason: String?) {
        lock.lock()
        defer { lock.unlock() }
        calls.append(reason)
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return calls.count
    }

    var reasons: [String?] {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }
}

final class IndeRunCapacitorStreamRegistryTests: XCTestCase {

    private func makeRun(recorder: CancelRecorder) -> StreamRun {
        let (events, continuation) = AsyncThrowingStream<StreamEvent, Error>.makeStream()
        continuation.finish()
        return StreamRun(
            handle: StreamRunHandle(
                providerId: nil,
                runId: "run_1",
                schemaVersion: .the10,
                startedAt: 1_700_000_000_000
            ),
            events: events,
            cancel: { reason in recorder.record(reason) }
        )
    }

    func testAttachesAndFinishesByStreamId() {
        let registry = StreamRegistry()
        let recorder = CancelRecorder()

        registry.open(streamId: "s1")
        XCTAssertEqual(registry.attach(streamId: "s1", run: makeRun(recorder: recorder)), .attached)
        XCTAssertEqual(registry.activeCount, 1)

        registry.finish(streamId: "s1")
        XCTAssertEqual(registry.activeCount, 0)
    }

    /// A cancel can beat the engine's route selection. It must be held and applied
    /// when the run finally attaches, not dropped.
    func testCancelBeforeAttachIsAppliedOnAttachWithItsReason() {
        let registry = StreamRegistry()
        let recorder = CancelRecorder()

        registry.open(streamId: "s1")
        registry.requestCancel(streamId: "s1", reason: "user left")
        // Nothing to cancel yet, so nothing was called.
        XCTAssertEqual(recorder.count, 0)

        let outcome = registry.attach(streamId: "s1", run: makeRun(recorder: recorder))
        XCTAssertEqual(outcome, .cancelRequested(reason: "user left"))
    }

    func testCancelAfterFinishIsANoOp() {
        let registry = StreamRegistry()
        let recorder = CancelRecorder()

        registry.open(streamId: "s1")
        registry.attach(streamId: "s1", run: makeRun(recorder: recorder))
        registry.finish(streamId: "s1")

        registry.requestCancel(streamId: "s1", reason: "too late")
        XCTAssertEqual(recorder.count, 0)
    }

    func testCancelForAnUnknownStreamIdIsANoOp() {
        let registry = StreamRegistry()
        registry.requestCancel(streamId: "never_opened", reason: nil)
        XCTAssertEqual(registry.activeCount, 0)
    }

    func testRepeatedCancelCancelsTheRunExactlyOnce() {
        let registry = StreamRegistry()
        let recorder = CancelRecorder()

        registry.open(streamId: "s1")
        registry.attach(streamId: "s1", run: makeRun(recorder: recorder))

        registry.requestCancel(streamId: "s1", reason: "first")
        registry.requestCancel(streamId: "s1", reason: "second")

        XCTAssertEqual(recorder.reasons, ["first"])
    }

    func testConcurrentStreamsAreIsolated() {
        let registry = StreamRegistry()
        let first = CancelRecorder()
        let second = CancelRecorder()

        registry.open(streamId: "s1")
        registry.open(streamId: "s2")
        registry.attach(streamId: "s1", run: makeRun(recorder: first))
        registry.attach(streamId: "s2", run: makeRun(recorder: second))

        registry.requestCancel(streamId: "s1", reason: "only the first")

        XCTAssertEqual(first.reasons, ["only the first"])
        XCTAssertEqual(second.count, 0)
        XCTAssertEqual(registry.activeCount, 2)
    }

    func testCancelAllCancelsEveryRunOnceAndEmptiesTheRegistry() {
        let registry = StreamRegistry()
        let first = CancelRecorder()
        let second = CancelRecorder()

        registry.open(streamId: "s1")
        registry.open(streamId: "s2")
        registry.attach(streamId: "s1", run: makeRun(recorder: first))
        registry.attach(streamId: "s2", run: makeRun(recorder: second))

        registry.cancelAll(reason: "torn down")

        XCTAssertEqual(first.reasons, ["torn down"])
        XCTAssertEqual(second.reasons, ["torn down"])
        XCTAssertEqual(registry.activeCount, 0)
    }

    func testAttachAfterTeardownReportsCancelRequested() {
        let registry = StreamRegistry()
        let recorder = CancelRecorder()

        registry.open(streamId: "s1")
        registry.cancelAll(reason: "torn down")

        // The entry is gone, so the run that arrives late must be cancelled by its caller.
        XCTAssertEqual(
            registry.attach(streamId: "s1", run: makeRun(recorder: recorder)),
            .cancelRequested(reason: nil)
        )
    }
}
