package app.independo.inderun.capacitor

import app.independo.inderun.core.ProviderRegistry
import java.util.concurrent.atomic.AtomicReference

/**
 * What one `configure()` built: the engine every call uses, and the providers and runtimes the
 * bridge constructed for its registry that hold something to release (the system speech
 * provider's TTS binding, a neural runtime's loaded model).
 *
 * Upstream's `close()` closes no provider and no runtime: the registry is the application's, and
 * whoever creates a thing closes it. Here the bridge is that application. So [close] closes the
 * engine first — its streams end, its runs finish, its artifacts go — and only then the owned
 * resources, each at most once: a configuration closed by `close()` and later replaced by
 * `configure()` is not released twice.
 *
 * Generic over the engine only so the JVM tests can drive it without building one.
 */
internal class BridgedConfiguration<E : Any>(
    val engine: E,
    owned: List<AutoCloseable>,
    private val closeEngine: suspend (E) -> Unit
) {
    private val owned = AtomicReference(owned)

    /**
     * Closes every owned resource even when the engine or an earlier resource fails to close,
     * then rethrows the first failure with the others suppressed onto it.
     */
    suspend fun close() {
        var failure: Throwable? = null
        try {
            closeEngine(engine)
        } catch (error: Throwable) {
            failure = error
        }
        for (resource in owned.getAndSet(emptyList())) {
            try {
                resource.close()
            } catch (error: Throwable) {
                failure?.addSuppressed(error) ?: run { failure = error }
            }
        }
        failure?.let { throw it }
    }
}

/** A registry, and what the bridge constructed for it that it must close. */
internal class BridgedRegistry(val registry: ProviderRegistry, val owned: List<AutoCloseable>)

/** Closes resources from a configuration that never took effect; one failing does not stop the rest. */
internal fun closeQuietly(resources: List<AutoCloseable>) {
    resources.forEach { runCatching { it.close() } }
}
