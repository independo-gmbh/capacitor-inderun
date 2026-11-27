package app.independo.inderun.capacitor

import app.independo.inderun.core.StreamRun
import app.independo.inderun.sdk.generated.IndeRunApi
import com.getcapacitor.JSObject
import org.json.JSONObject

/**
 * The bridge's two `TaskRequest` entry points: a request JSON from JS in, the engine call out.
 * `run` and `startStream` in [IndeRunCapacitorPlugin] go through here and nowhere else, so the raw
 * check that [IndeRunSerializer.parseTaskRequest] runs first always sits between a JS caller and
 * the engine. A request the raw check refuses throws before the engine is called; everything else
 * is the engine's to validate. Kept apart from the plugin so the JVM tests drive the same path.
 */
internal object TaskRequestEntry {
    suspend fun run(engine: IndeRunApi, requestJson: JSONObject): JSObject {
        val request = IndeRunSerializer.parseTaskRequest(requestJson)
        return IndeRunSerializer.encodeTaskResult(engine.run(request))
    }

    suspend fun stream(engine: IndeRunApi, requestJson: JSONObject): StreamRun {
        val request = IndeRunSerializer.parseTaskRequest(requestJson)
        return engine.stream(request)
    }
}
