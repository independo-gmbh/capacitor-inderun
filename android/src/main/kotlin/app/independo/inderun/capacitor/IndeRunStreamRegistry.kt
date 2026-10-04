package app.independo.inderun.capacitor

import app.independo.inderun.core.StreamRun
import kotlinx.coroutines.Job

/**
 * The outcome of attaching a freshly started run to its reserved id.
 */
internal sealed interface AttachOutcome {
    data object Attached : AttachOutcome

    /** A cancel arrived before the run did; the caller must apply it. */
    data class CancelRequested(val reason: String?) : AttachOutcome
}

/**
 * Tracks the streaming runs the plugin is currently collecting, keyed by the
 * bridge-local `streamId`.
 *
 * Two things make this more than a map. A cancel can arrive before the run it refers
 * to exists — `startStream` has to reach route selection first — so a cancel in that
 * window is recorded and applied on attach. And cancelling a run is *not* cancelling
 * the collecting job: the engine answers a cancel with its one `cancelled` terminal
 * event, which the collector still has to deliver. Job cancellation is reserved for
 * teardown, where the webview is going away and nobody is left to receive a terminal.
 *
 * Deliberately free of any Capacitor dependency, so it is exercised by plain JVM unit
 * tests.
 */
internal class IndeRunStreamRegistry {
    private class Entry {
        var run: StreamRun? = null
        var job: Job? = null
        var cancelRequested: Boolean = false
        var cancelReason: String? = null
    }

    private val lock = Any()
    private val entries = mutableMapOf<String, Entry>()

    val activeCount: Int
        get() = synchronized(lock) { entries.size }

    /** Reserves the id so a cancel arriving before the run is recorded, not dropped. */
    fun open(streamId: String) {
        synchronized(lock) {
            entries.getOrPut(streamId) { Entry() }
        }
    }

    fun attach(streamId: String, run: StreamRun): AttachOutcome {
        synchronized(lock) {
            // Torn down while the engine was still selecting a route.
            val entry = entries[streamId] ?: return AttachOutcome.CancelRequested(null)
            if (entry.cancelRequested) {
                return AttachOutcome.CancelRequested(entry.cancelReason)
            }
            entry.run = run
            return AttachOutcome.Attached
        }
    }

    fun attachJob(streamId: String, job: Job) {
        val orphaned = synchronized(lock) {
            val entry = entries[streamId]
            if (entry == null) {
                true
            } else {
                entry.job = job
                false
            }
        }
        if (orphaned) {
            job.cancel()
        }
    }

    /**
     * Cancels the run if it has attached, otherwise records the request for attach. An
     * unknown id — already finished, or never started — is a silent no-op, which is what
     * makes cancelling after the terminal harmless.
     */
    fun requestCancel(streamId: String, reason: String?) {
        val run = synchronized(lock) {
            val entry = entries[streamId] ?: return
            if (entry.cancelRequested) return
            entry.cancelRequested = true
            entry.cancelReason = reason
            entry.run
        }

        // Never under the lock: cancel reaches into engine code.
        run?.cancel(reason)
    }

    fun close(streamId: String) {
        synchronized(lock) {
            entries.remove(streamId)
        }
    }

    /**
     * Teardown. Cancels each run first so providers unwind, then the collecting jobs,
     * which at this point have nobody left to deliver to.
     */
    fun cancelAll(reason: String?) {
        val draining = synchronized(lock) {
            val copy = entries.values.toList()
            entries.clear()
            copy
        }

        for (entry in draining) {
            entry.run?.cancel(reason)
            entry.job?.cancel()
        }
    }
}
