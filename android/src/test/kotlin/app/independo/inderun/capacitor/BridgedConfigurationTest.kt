package app.independo.inderun.capacitor

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The bridge closes what it constructed (speech providers, the ONNX text provider, neural runtimes) after the engine,
 * on replace, on close and at teardown. The real providers need an Android `Context`, so these
 * use counting stand-ins for both the engine and the owned resources.
 */
class BridgedConfigurationTest {

    private class Log {
        val entries = mutableListOf<String>()
    }

    private class Resource(private val name: String, private val log: Log, private val failure: Throwable? = null) : AutoCloseable {
        override fun close() {
            log.entries += name
            failure?.let { throw it }
        }
    }

    private fun configuration(log: Log, vararg owned: AutoCloseable, engineFailure: Throwable? = null) =
        BridgedConfiguration("engine", owned.toList()) { _ ->
            log.entries += "engine"
            engineFailure?.let { throw it }
        }

    @Test
    fun `closing closes the engine first, then each owned resource`() = runBlocking {
        val log = Log()
        configuration(log, Resource("system speech", log), Resource("neural runtime", log)).close()

        assertEquals(listOf("engine", "system speech", "neural runtime"), log.entries)
    }

    @Test
    fun `replacing a configuration releases its ONNX text provider after its engine, not the new one`() = runBlocking {
        val log = Log()
        val old = configuration(log, Resource("old onnx text", log), Resource("old neural runtime", log))
        val replacement = configuration(log, Resource("new onnx text", log))

        // configure() swaps the new configuration in and closes the one it replaced.
        old.close()

        assertEquals(listOf("engine", "old onnx text", "old neural runtime"), log.entries)
        replacement.close()
        assertEquals(listOf("engine", "old onnx text", "old neural runtime", "engine", "new onnx text"), log.entries)
    }

    @Test
    fun `owned resources are released once across a close and a later replace`() = runBlocking {
        val log = Log()
        val closed = configuration(log, Resource("neural runtime", log))

        // close(), then configure() replacing the closed configuration: the engine close is
        // upstream's to make idempotent; the bridge's resources close once.
        closed.close()
        closed.close()

        assertEquals(listOf("engine", "neural runtime", "engine"), log.entries)
    }

    @Test
    fun `a failing engine close still releases every owned resource, then rethrows`() {
        val log = Log()
        val failure = IllegalStateException("engine")

        val thrown = assertThrows(IllegalStateException::class.java) {
            runBlocking { configuration(log, Resource("a", log), Resource("b", log), engineFailure = failure).close() }
        }

        assertSame(failure, thrown)
        assertEquals(listOf("engine", "a", "b"), log.entries)
    }

    @Test
    fun `a failing resource does not stop the rest, and its failure is reported`() {
        val log = Log()
        val first = IllegalStateException("a")
        val second = IllegalStateException("b")

        val thrown = assertThrows(IllegalStateException::class.java) {
            runBlocking {
                configuration(log, Resource("a", log, first), Resource("b", log, second), Resource("c", log)).close()
            }
        }

        assertSame(first, thrown)
        assertEquals(listOf(second), thrown.suppressed.toList())
        assertEquals(listOf("engine", "a", "b", "c"), log.entries)
    }

    @Test
    fun `closeQuietly closes everything from a configuration that never took effect`() {
        val log = Log()
        closeQuietly(listOf(Resource("a", log, IllegalStateException("a")), Resource("b", log)))

        assertEquals(listOf("a", "b"), log.entries)
    }
}
