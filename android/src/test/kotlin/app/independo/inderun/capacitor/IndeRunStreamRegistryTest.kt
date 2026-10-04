package app.independo.inderun.capacitor

import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.StreamRunHandle
import app.independo.inderun.core.StreamRun
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IndeRunStreamRegistryTest {

    private fun run(record: (String?) -> Unit): StreamRun = StreamRun(
        handle = StreamRunHandle(
            runId = "run_1",
            schemaVersion = SchemaVersion.V1_0,
            startedAt = 1_700_000_000_000.0
        ),
        events = emptyFlow(),
        onCancel = record
    )

    @Test
    fun `attaches and closes by stream id`() {
        val registry = IndeRunStreamRegistry()

        registry.open("s1")
        assertEquals(AttachOutcome.Attached, registry.attach("s1", run {}))
        assertEquals(1, registry.activeCount)

        registry.close("s1")
        assertEquals(0, registry.activeCount)
    }

    /**
     * A cancel can beat the engine's route selection. It must be held and applied when
     * the run finally attaches, not dropped.
     */
    @Test
    fun `cancel before attach is applied on attach with its reason`() {
        val registry = IndeRunStreamRegistry()
        val reasons = mutableListOf<String?>()

        registry.open("s1")
        registry.requestCancel("s1", "user left")
        // Nothing to cancel yet, so nothing was called.
        assertTrue(reasons.isEmpty())

        val outcome = registry.attach("s1", run { reasons.add(it) })
        assertEquals(AttachOutcome.CancelRequested("user left"), outcome)
    }

    @Test
    fun `cancel after close is a no-op`() {
        val registry = IndeRunStreamRegistry()
        val reasons = mutableListOf<String?>()

        registry.open("s1")
        registry.attach("s1", run { reasons.add(it) })
        registry.close("s1")

        registry.requestCancel("s1", "too late")
        assertTrue(reasons.isEmpty())
    }

    @Test
    fun `cancel for an unknown stream id is a no-op`() {
        val registry = IndeRunStreamRegistry()

        registry.requestCancel("never_opened", null)
        assertEquals(0, registry.activeCount)
    }

    @Test
    fun `repeated cancel cancels the run exactly once`() {
        val registry = IndeRunStreamRegistry()
        val reasons = mutableListOf<String?>()

        registry.open("s1")
        registry.attach("s1", run { reasons.add(it) })

        registry.requestCancel("s1", "first")
        registry.requestCancel("s1", "second")

        assertEquals(listOf("first"), reasons)
    }

    @Test
    fun `concurrent streams are isolated`() {
        val registry = IndeRunStreamRegistry()
        val first = mutableListOf<String?>()
        val second = mutableListOf<String?>()

        registry.open("s1")
        registry.open("s2")
        registry.attach("s1", run { first.add(it) })
        registry.attach("s2", run { second.add(it) })

        registry.requestCancel("s1", "only the first")

        assertEquals(listOf("only the first"), first)
        assertTrue(second.isEmpty())
        assertEquals(2, registry.activeCount)
    }

    @Test
    fun `cancelAll cancels every run once and empties the registry`() {
        val registry = IndeRunStreamRegistry()
        val first = mutableListOf<String?>()
        val second = mutableListOf<String?>()

        registry.open("s1")
        registry.open("s2")
        registry.attach("s1", run { first.add(it) })
        registry.attach("s2", run { second.add(it) })

        registry.cancelAll("torn down")

        assertEquals(listOf("torn down"), first)
        assertEquals(listOf("torn down"), second)
        assertEquals(0, registry.activeCount)
    }

    /**
     * Teardown also cancels the collecting jobs — at that point nobody is left to
     * receive a terminal event.
     */
    @Test
    fun `cancelAll cancels the collecting job`() {
        val registry = IndeRunStreamRegistry()
        val job = Job()

        registry.open("s1")
        registry.attach("s1", run {})
        registry.attachJob("s1", job)

        assertFalse(job.isCancelled)
        registry.cancelAll(null)
        assertTrue(job.isCancelled)
    }

    @Test
    fun `attach after teardown reports cancel requested`() {
        val registry = IndeRunStreamRegistry()

        registry.open("s1")
        registry.cancelAll("torn down")

        // The entry is gone, so the run that arrives late must be cancelled by its caller.
        assertEquals(AttachOutcome.CancelRequested(null), registry.attach("s1", run {}))
    }

    @Test
    fun `a job attached to a closed stream is cancelled immediately`() {
        val registry = IndeRunStreamRegistry()
        val job = Job()

        registry.attachJob("never_opened", job)
        assertTrue(job.isCancelled)
    }
}
