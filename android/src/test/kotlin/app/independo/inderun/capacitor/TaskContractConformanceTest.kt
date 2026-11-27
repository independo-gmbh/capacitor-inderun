package app.independo.inderun.capacitor

import app.independo.inderun.contracts.IndeRunErrorClass
import app.independo.inderun.contracts.SchemaVersion
import app.independo.inderun.contracts.StreamEvent
import app.independo.inderun.contracts.TaskRequest
import app.independo.inderun.contracts.TaskResult
import app.independo.inderun.core.ClockService
import app.independo.inderun.core.ConnectivityService
import app.independo.inderun.core.HostServices
import app.independo.inderun.core.IndeRunException
import app.independo.inderun.core.ProviderRegistry
import app.independo.inderun.core.SecureStorageService
import app.independo.inderun.core.rawTaskRequestIssues
import app.independo.inderun.sdk.IndeRun
import app.independo.inderun.sdk.generated.IndeRunApi
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * Task-contract conformance: the vendored `text-to-speech.json` fixture through the bridge's two
 * request entry points ([TaskRequestEntry.run] and [TaskRequestEntry.stream], which the plugin's
 * `run` and `startStream` call).
 *
 * - `invalidPayloads` (JSON the typed Kotlin API cannot express) are refused by the raw check with
 *   the normalized validation error, and the engine is never called.
 * - `invalidRequests` (expressible, but against the per-kind rules) parse without losing the
 *   offending field and are refused by the engine's request validation, before routing, so no
 *   provider is reached.
 * - Every current case reaches the engine as the request the fixture holds, and its result or
 *   terminal comes back out exactly as the fixture holds it.
 */
class TaskContractConformanceTest {

    private val fixture = taskContractFixture("text-to-speech.json")

    private fun entries(name: String): List<JSONObject> = fixture.getJSONArray(name).objects().also {
        assertTrue("fixture has no $name", it.isNotEmpty())
    }

    /** A fresh copy, so nothing a parse does to the object can leak into the next assertion. */
    private fun request(entry: JSONObject): JSONObject = JSONObject(entry.getJSONObject("request").toString())

    /** Stands in for the engine and records every call; `run` answers with [result]. */
    private class RecordingEngine(private val result: TaskResult? = null) {
        val calls = mutableListOf<Pair<String, Any?>>()

        val api: IndeRunApi = Proxy.newProxyInstance(
            IndeRunApi::class.java.classLoader,
            arrayOf(IndeRunApi::class.java)
        ) { proxy, method, args ->
            if (method.declaringClass == Any::class.java) {
                return@newProxyInstance when (method.name) {
                    "equals" -> proxy === args?.get(0)
                    "hashCode" -> System.identityHashCode(proxy)
                    else -> "RecordingEngine"
                }
            }
            calls += method.name to args?.firstOrNull()
            when (method.name) {
                "run" -> result ?: throw AssertionError("run reached the engine without a result to answer with")
                // A StreamRun cannot be built outside the engine; reaching the call is what is tested.
                "stream" -> throw StreamReached()
                else -> throw AssertionError("unexpected engine call ${method.name}")
            }
        } as IndeRunApi
    }

    private class StreamReached : RuntimeException()

    private fun hostServices() = HostServices(
        connectivity = object : ConnectivityService {
            override fun isOnline(): Boolean = true
        },
        secureStorage = object : SecureStorageService {
            override fun get(authContextRef: String): String? = null
            override fun put(authContextRef: String, value: String) = Unit
            override fun remove(authContextRef: String) = Unit
        },
        clock = object : ClockService {
            override fun elapsedRealtimeMillis(): Long = 0
        }
    )

    /** The refusal [block] raises, which must be the normalized validation error. */
    private fun validationIssuesOf(id: String, block: suspend () -> Unit): List<*> {
        val error = try {
            runBlocking { block() }
            fail("$id: expected a refusal")
            error("unreachable")
        } catch (error: IndeRunException) {
            error.toContractError()
        }
        assertEquals(id, IndeRunErrorClass.Internal, error.errorClass)
        assertTrue("$id: ${error.message}", error.message.startsWith("Validation failed for TaskRequest: "))
        val issues = error.details?.get("validationIssues") as? List<*>
        assertTrue("$id: no details.validationIssues in ${error.details}", !issues.isNullOrEmpty())
        // The issues cross to JS intact, as an array.
        val encoded = IndeRunSerializer.encodeError(error).getJSONObject("details").getJSONArray("validationIssues")
        assertEquals(id, issues, List(encoded.length()) { encoded.get(it) })
        return checkNotNull(issues)
    }

    @Test
    fun `every invalid payload is refused by the raw check before the engine is called`() {
        for (entry in entries("invalidPayloads")) {
            val id = entry.getString("id")
            val expected = rawTaskRequestIssues(request(entry))
            assertTrue("$id: the core raw check finds nothing", expected.isNotEmpty())

            val engine = RecordingEngine()
            assertEquals(id, expected, validationIssuesOf("$id (run)") { TaskRequestEntry.run(engine.api, request(entry)) })
            assertEquals(id, expected, validationIssuesOf("$id (stream)") { TaskRequestEntry.stream(engine.api, request(entry)) })
            assertEquals("$id reached the engine", emptyList<Pair<String, Any?>>(), engine.calls)
        }
    }

    @Test
    fun `every invalid request keeps its offending field and is refused by the engine's validation`() {
        for (entry in entries("invalidRequests")) {
            val id = entry.getString("id")
            assertEquals("$id: the raw check is targeted, the engine owns these rules", emptyList<String>(), rawTaskRequestIssues(request(entry)))
            // Nothing the engine has to see is lost on the way in.
            assertSameJson(id, request(entry), encodeRequestForTest(IndeRunSerializer.parseTaskRequest(request(entry))))

            // An empty registry: had validation passed, routing would fail with a different error.
            val engine = IndeRun(ProviderRegistry(), hostServices())
            validationIssuesOf("$id (run)") { TaskRequestEntry.run(engine, request(entry)) }
            validationIssuesOf("$id (stream)") { TaskRequestEntry.stream(engine, request(entry)) }
        }
    }

    @Test
    fun `every current case reaches the engine unchanged and its outcome encodes faithfully`() {
        for (entry in entries("cases")) {
            val id = entry.getString("id")
            val expectedRequest = request(entry)

            if (entry.has("result")) {
                val result = entry.getJSONObject("result")
                val engine = RecordingEngine(decodeResultForTest(result))
                val encoded = runBlocking { TaskRequestEntry.run(engine.api, request(entry)) }

                val (name, received) = engine.calls.single()
                assertEquals(id, "run", name)
                assertSameJson("$id request", expectedRequest, encodeRequestForTest(received as TaskRequest))
                assertSameJson("$id result", result, encoded)
            }

            if (entry.has("terminal")) {
                val terminal = entry.getJSONObject("terminal")
                val engine = RecordingEngine()
                try {
                    runBlocking { TaskRequestEntry.stream(engine.api, request(entry)) }
                    fail("$id: the stream did not reach the engine")
                } catch (_: StreamReached) {
                }
                val (name, received) = engine.calls.single()
                assertEquals(id, "stream", name)
                assertSameJson("$id request", expectedRequest, encodeRequestForTest(received as TaskRequest))

                val event = IndeRunSerializer.encodeStreamEvent(
                    StreamEvent(
                        payload = decodeTerminalPayloadForTest(terminal),
                        runId = terminal.getString("runId"),
                        schemaVersion = SchemaVersion.V1_1,
                        sequence = 4,
                        timestamp = 1_700_000_000_000.0,
                        type = "terminal"
                    )
                )
                assertSameJson("$id terminal", terminal, event.getJSONObject("payload"))
            }
        }
    }
}
