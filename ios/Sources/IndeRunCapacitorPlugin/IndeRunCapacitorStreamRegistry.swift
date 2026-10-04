import Foundation
import IndeRunCore

/// Tracks the streaming runs the bridge is currently pumping, keyed by the
/// bridge-local `streamId`.
///
/// Two things make this more than a dictionary. A cancel can arrive before the run
/// it refers to exists — `startStream` has to reach route selection before there is
/// anything to cancel — so a cancel requested in that window is recorded and applied
/// on attach. And cancelling a run is *not* cancelling the pump task: the engine
/// answers a cancel with its one `cancelled` terminal event, which the pump still has
/// to deliver. Task cancellation is reserved for teardown, where the webview is going
/// away and nobody is left to receive a terminal.
///
/// Deliberately free of any Capacitor dependency, so it is exercised by `swift test`
/// on macOS where `canImport(Capacitor)` is false.
final class StreamRegistry {
    enum AttachOutcome: Equatable {
        case attached
        /// A cancel arrived before the run did; the caller must apply it.
        case cancelRequested(reason: String?)
    }

    private struct Entry {
        var run: StreamRun?
        var task: Task<Void, Never>?
        var cancelRequested = false
        var cancelReason: String?
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    var activeCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    /// Reserves the id so a cancel arriving before the run can be recorded rather
    /// than dropped as unknown.
    func open(streamId: String) {
        lock.lock()
        defer { lock.unlock() }
        if entries[streamId] == nil {
            entries[streamId] = Entry()
        }
    }

    func attach(streamId: String, run: StreamRun) -> AttachOutcome {
        lock.lock()
        guard var entry = entries[streamId] else {
            // Torn down while the engine was still selecting a route.
            lock.unlock()
            return .cancelRequested(reason: nil)
        }
        if entry.cancelRequested {
            let reason = entry.cancelReason
            lock.unlock()
            return .cancelRequested(reason: reason)
        }
        entry.run = run
        entries[streamId] = entry
        lock.unlock()
        return .attached
    }

    func store(task: Task<Void, Never>, for streamId: String) {
        lock.lock()
        defer { lock.unlock() }
        guard var entry = entries[streamId] else {
            task.cancel()
            return
        }
        entry.task = task
        entries[streamId] = entry
    }

    /// Cancels the run if it has attached, otherwise records the request for attach.
    /// An unknown id — already finished, or never started — is a silent no-op, which
    /// is what makes cancelling after the terminal harmless.
    func requestCancel(streamId: String, reason: String?) {
        lock.lock()
        guard var entry = entries[streamId] else {
            lock.unlock()
            return
        }
        if entry.cancelRequested {
            lock.unlock()
            return
        }
        entry.cancelRequested = true
        entry.cancelReason = reason
        let run = entry.run
        entries[streamId] = entry
        lock.unlock()

        // Never under the lock: cancel reaches into engine code.
        run?.cancel(reason: reason)
    }

    func finish(streamId: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeValue(forKey: streamId)
    }

    /// Teardown. Cancels each run first so providers unwind, then the pump tasks,
    /// which at this point have nobody left to deliver to.
    func cancelAll(reason: String?) {
        lock.lock()
        let draining = entries
        entries.removeAll()
        lock.unlock()

        for (_, entry) in draining {
            entry.run?.cancel(reason: reason)
            entry.task?.cancel()
        }
    }
}
