#if canImport(Capacitor)
import Capacitor
#else
typealias JSObject = [String: Any]
#endif
import Foundation
import IndeRunAppleProviders
import IndeRunCore
import IndeRunContracts
import IndeRunOpenAIProviders
import IndeRunSwift

/// One OpenAI-compatible target is registered per entry in `models`, with id
/// `openai:<model>` -- the id scheme the web SDK and the upstream factories use, so a
/// model profile names the same targets on every platform.
struct OpenAIProviderBootstrapOptions: Codable {
    let models: [String]
    let endpointURL: String?
    let auth: String?
    let authContextRef: String?
    let timeoutMs: Int?

    // The property keeps Swift's `URL` capitalisation to match OpenAIProviderOptions,
    // but the wire key is whatever `ConfigureOptions` in src/definitions.ts sends --
    // `endpointUrl`, which is also what IndeRunSerializer.kt reads on Android. Without
    // this mapping the field silently decodes as nil and the provider falls back to the
    // default endpoint.
    enum CodingKeys: String, CodingKey {
        case models
        case endpointURL = "endpointUrl"
        case auth
        case authContextRef
        case timeoutMs
    }
}

struct CapacitorRunOptions: Codable {
    let openAI: OpenAIProviderBootstrapOptions?
    /// Profile name to ordered target ids, as `IndeRun(modelProfiles:)` takes it.
    let modelProfiles: [String: [String]]?
    let allowDirectOpenAIEndpoint: Bool? // web-only, no-op on native
}

/// Unlike `run(request)`, which takes the request at the options root, `startStream`
/// nests it under `request` so the envelope can also carry the bridge-local
/// `streamId`. See `StartStreamOptions` in src/definitions.ts.
struct CapacitorStartStreamOptions: Codable {
    let streamId: String
    let request: TaskRequest
}

/// `startPrepare` mirrors `startStream`: the `PrepareRequest` nested under `request`, beside
/// the bridge-local `streamId`. See `StartPrepareOptions` in src/definitions.ts.
struct CapacitorStartPrepareOptions: Codable {
    let streamId: String
    let request: PrepareRequest
}

struct CapacitorCancelStreamOptions: Codable {
    let streamId: String
    let reason: String?
}

/// A Capacitor plugin method must resolve an object, never a top-level array, so the
/// snapshots travel wrapped. `IndeRunCapacitor` unwraps them on the JS side.
private struct CapabilitiesEnvelope: Encodable {
    let providers: [ProviderCapabilitySnapshot]
}

/// `ArtifactChunk` as it crosses the bridge: a Capacitor call resolves JSON, which has no
/// byte type, so `bytes` travels as base64. Transport only; see `BridgedArtifactChunk` in
/// src/definitions.ts, which decodes it back.
private struct BridgedArtifactChunk: Encodable {
    let artifactId: String
    let offset: Int
    let bytes: String
    let totalBytes: Int
    let done: Bool
}

/// Called with an already-encoded event/error for one run. The plugin turns these
/// into `notifyListeners` calls; taking them as closures keeps the pump testable
/// without Capacitor.
typealias StreamEventSink = @Sendable (String, JSObject) -> Void
typealias StreamErrorSink = @Sendable (String, JSObject) -> Void

final class IndeRunCapacitorBridge {
    /// The one engine every call uses, built by `configure` and kept until the next one.
    /// Long-lived on purpose: artifacts are engine-owned and die with the engine, and a
    /// provider that loads a model keeps it loaded only as long as its engine is in use.
    /// Locked, because the plugin calls in from tasks of its own.
    private let engineLock = NSLock()
    private var engine: IndeRun?
    let streams = StreamRegistry()

    deinit {
        streams.cancelAll(reason: "Capacitor bridge deallocated.")
        if let engine {
            Task { await engine.close() }
        }
    }

    /// Synchronous on purpose: decoding, validation and the engine swap all happen on the
    /// plugin call, so configurations take effect in the order Capacitor delivered them and a
    /// call issued right after `configure` already reaches the new engine. Only closing the
    /// replaced engine is asynchronous; the caller awaits the returned engine's `close()` before
    /// resolving.
    ///
    /// - Returns: The engine this configuration replaced, still to be closed.
    func configure(options: JSObject) throws -> IndeRun? {
        let runOptions = try decodeConfigureOptions(from: options)
        // Validated and built before anything is replaced, so a refused configuration
        // leaves the previous engine in place rather than half of each.
        let modelProfiles = try makeModelProfiles(runOptions.modelProfiles)
        let registry = try makeRegistry(openAI: runOptions.openAI)
        return swap(
            engine: IndeRun(registry: registry, hostServices: DefaultHostServices.make(), modelProfiles: modelProfiles)
        )
    }

    /// Makes `engine` the one every later call uses, at once, and hands back the one it
    /// replaced for the caller to close.
    func swap(engine newEngine: IndeRun) -> IndeRun? {
        engineLock.withLock {
            let previous = engine
            engine = newEngine
            return previous
        }
    }

    /// `swap` followed by closing the replaced engine: returns when the old one has closed,
    /// which upstream defines as its streams and prepares ending in their cancelled terminal
    /// and its in-flight runs finishing -- no longer.
    func install(engine newEngine: IndeRun) async {
        await swap(engine: newEngine)?.close()
    }

    /// The configured engine, closed or not: a closed one answers every call the way
    /// upstream defines (`engine_closed`), which is what the bridge reports.
    private func requireEngine(before call: String) throws -> IndeRun {
        guard let engine = engineLock.withLock({ engine }) else {
            throw createUnavailable(message: "Capacitor IndeRun has not been configured. Configure providers before calling \(call).")
        }
        return engine
    }

    func run(requestObject: JSObject) async throws -> JSObject {
        let engine = try requireEngine(before: "run(request)")
        let request = try decodeRequest(from: requestObject)
        let result = try await engine.run(request: request)
        return try encode(result)
    }

    func checkCapabilities() async throws -> JSObject {
        let engine = try requireEngine(before: "checkCapabilities()")
        return try encode(capabilities: await engine.checkCapabilities())
    }

    func startStream(
        options: JSObject,
        onEvent: @escaping StreamEventSink,
        onError: @escaping StreamErrorSink
    ) async throws -> JSObject {
        let engine = try requireEngine(before: "stream(request)")
        let start = try decodeStartStreamOptions(from: options)
        return try await startBridgedRun(streamId: start.streamId, onEvent: onEvent, onError: onError) {
            try await engine.stream(request: start.request)
        }
    }

    /// A prepare run is a `StreamRun` upstream, so it is registered, pumped and cancelled
    /// exactly like a stream.
    func startPrepare(
        options: JSObject,
        onEvent: @escaping StreamEventSink,
        onError: @escaping StreamErrorSink
    ) async throws -> JSObject {
        let engine = try requireEngine(before: "prepare(request)")
        let start = try decodeStartPrepareOptions(from: options)
        return try await startBridgedRun(streamId: start.streamId, onEvent: onEvent, onError: onError) {
            try await engine.prepare(request: start.request)
        }
    }

    private func startBridgedRun(
        streamId: String,
        onEvent: @escaping StreamEventSink,
        onError: @escaping StreamErrorSink,
        start: () async throws -> StreamRun
    ) async throws -> JSObject {
        // Reserved before the engine is reached, so a cancel arriving during route
        // selection is recorded rather than dropped as an unknown id.
        streams.open(streamId: streamId)

        let run: StreamRun
        do {
            run = try await start()
        } catch {
            streams.finish(streamId: streamId)
            throw error
        }

        if case .cancelRequested(let reason) = streams.attach(streamId: streamId, run: run) {
            run.cancel(reason: reason)
        }

        // Weak, so a live run cannot keep the bridge alive past the plugin's deinit;
        // the plugin's teardown cancels these tasks, which then release the bridge.
        let task = Task { [weak self] in
            guard let self else { return }
            await self.pump(streamId: streamId, run: run, onEvent: onEvent, onError: onError)
        }
        streams.store(task: task, for: streamId)

        return try encode(handle: run.handle)
    }

    func cancelStream(options: JSObject) throws {
        let cancel = try decodeCancelStreamOptions(from: options)
        streams.requestCancel(streamId: cancel.streamId, reason: cancel.reason)
    }

    /// Like `run(request)`, the request arrives at the options root.
    func readArtifact(requestObject: JSObject) async throws -> JSObject {
        let engine = try requireEngine(before: "readArtifact(request)")
        let request = try decodeObject(ArtifactReadRequest.self, from: requestObject)
        return try encode(chunk: try await engine.readArtifact(request: request))
    }

    func disposeArtifact(artifactObject: JSObject) async throws {
        let engine = try requireEngine(before: "disposeArtifact(artifact)")
        let artifact = try decodeObject(MediaArtifact.self, from: artifactObject)
        await engine.disposeArtifact(artifact: artifact)
    }

    /// Closes the configured engine and keeps it, so every later call fails the way the
    /// closed engine fails it until `configure` installs a new one. Nothing configured is
    /// nothing to close.
    func close() async {
        await engineLock.withLock({ engine })?.close()
    }

    /// Plugin teardown: stops the runs the webview can no longer receive, then closes the
    /// engine without waiting for it -- nobody is left to wait.
    func teardown() {
        streams.cancelAll(reason: "Capacitor plugin torn down.")
        if let engine = engineLock.withLock({ engine }) {
            Task { await engine.close() }
        }
    }

    /// Forwards one run's canonical events to the sink until the stream ends.
    ///
    /// A provider failure has already become a terminal `error` event by the time it
    /// reaches here — the engine's Event Gate owns that. Anything thrown out of the
    /// sequence is a failure of this bridge, and is reported as one.
    func pump(
        streamId: String,
        run: StreamRun,
        onEvent: @escaping StreamEventSink,
        onError: @escaping StreamErrorSink
    ) async {
        do {
            for try await event in run.events {
                onEvent(streamId, try encode(streamEvent: event))
            }
        } catch is CancellationError {
            // Our own task cancellation, from teardown. The webview is going away and
            // no one is left to receive a terminal event; not a bridge fault.
        } catch {
            let contractError = toIndeRunException(error).toContractError()
            if let encoded = try? encode(error: contractError) {
                onError(streamId, encoded)
            }
        }
        streams.finish(streamId: streamId)
    }

    func encode(error: IndeRunError) throws -> JSObject {
        try encodeObject(error)
    }

    // JSONEncoder omits nil optionals, so "emit only the fields this event actually
    // has" — which is what reconstitutes the right union branch on the JS side —
    // comes for free from the generated Codable conformances.
    func encode(streamEvent: StreamEvent) throws -> JSObject {
        try encodeObject(streamEvent)
    }

    func encode(handle: StreamRunHandle) throws -> JSObject {
        try encodeObject(handle)
    }

    /// The descriptor's enums carry explicit raw values (`in_process`, not `inProcess`),
    /// and JSONEncoder omits nil optionals — so an unset `streamingAvailable` arrives as
    /// an absent key rather than a null, which is what lets the JS side read absence as
    /// "inherit `descriptor.supports.streaming`".
    func encode(capabilities: [ProviderCapabilitySnapshot]) throws -> JSObject {
        try encodeObject(CapabilitiesEnvelope(providers: capabilities))
    }

    func encode(chunk: ArtifactChunk) throws -> JSObject {
        try encodeObject(
            BridgedArtifactChunk(
                artifactId: chunk.artifactId,
                offset: chunk.offset,
                bytes: chunk.bytes.base64EncodedString(),
                totalBytes: chunk.totalBytes,
                done: chunk.done
            )
        )
    }

    func makeModelProfiles(_ profiles: [String: [String]]?) throws -> ModelProfiles {
        guard let profiles else { return .none }
        do {
            return try ModelProfiles(profiles)
        } catch let error as ModelProfilesConfigurationError {
            // Not an IndeRunError, so it would otherwise reach JS as a generic Internal
            // error without the reason.
            throw createInternal(message: error.description)
        }
    }

    func makeRegistry(openAI: OpenAIProviderBootstrapOptions?) throws -> ProviderRegistry {
        let registry = ProviderRegistry()
        try registry.register(AppleFoundationModelsProvider())

        if let openAI {
            // Upstream's `makeOpenAIRegistry` builds a registry of its own, while this one
            // also carries the on-device provider; `providerOptions(model:)` is the shared
            // half, so the target ids cannot drift from the factory's.
            guard !openAI.models.isEmpty else {
                throw createInternal(message: "Capacitor openAI bootstrap requires models to list at least one model.")
            }
            let factory = OpenAIFactoryOptions(
                models: openAI.models,
                endpointURL: openAI.endpointURL ?? defaultOpenAIResponsesEndpoint,
                auth: mapAuthMode(openAI.auth),
                authContextRef: openAI.authContextRef,
                timeoutMs: openAI.timeoutMs
            )
            for model in openAI.models {
                try registry.register(OpenAIProvider(options: factory.providerOptions(model: model)))
            }
        }

        return registry
    }

    private func decodeConfigureOptions(from object: JSObject) throws -> CapacitorRunOptions {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        return try JSONDecoder().decode(CapacitorRunOptions.self, from: data)
    }

    private func decodeStartStreamOptions(from object: JSObject) throws -> CapacitorStartStreamOptions {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        return try JSONDecoder().decode(CapacitorStartStreamOptions.self, from: data)
    }

    private func decodeStartPrepareOptions(from object: JSObject) throws -> CapacitorStartPrepareOptions {
        try decodeObject(CapacitorStartPrepareOptions.self, from: object)
    }

    private func decodeObject<T: Decodable>(_ type: T.Type, from object: JSObject) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        return try JSONDecoder().decode(type, from: data)
    }

    private func decodeCancelStreamOptions(from object: JSObject) throws -> CapacitorCancelStreamOptions {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        return try JSONDecoder().decode(CapacitorCancelStreamOptions.self, from: data)
    }

    private func decodeRequest(from object: JSObject) throws -> TaskRequest {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        return try JSONDecoder().decode(TaskRequest.self, from: data)
    }

    private func encode(_ result: TaskResult) throws -> JSObject {
        try encodeObject(result)
    }

    private func encodeObject<T: Encodable>(_ value: T) throws -> JSObject {
        let data = try JSONEncoder().encode(value)
        let object = try JSONSerialization.jsonObject(with: data, options: [])

        #if canImport(Capacitor)
        // Capacitor's JSObject is [String: any JSValue], and a plain `as?` cast cannot
        // produce one: JSONSerialization hands back NSDictionary/NSArray values, which do
        // not conform to JSValue, so anything with a nested object or array — a TaskResult's
        // `output`, a stream event's `payload`, the providers array — failed the cast and
        // surfaced as "Capacitor bridge failed to encode a JSON object". JSTypes coerces the
        // tree recursively, which is what the cast was standing in for.
        guard let dictionary = object as? [AnyHashable: Any],
              let coerced = JSTypes.coerceDictionaryToJSObject(dictionary) else {
            throw createInternal(message: "Capacitor bridge failed to encode a JSON object.")
        }
        return coerced
        #else
        // Standalone builds alias JSObject to [String: Any], where the cast is exact.
        guard let dictionary = object as? JSObject else {
            throw createInternal(message: "Capacitor bridge failed to encode a JSON object.")
        }
        return dictionary
        #endif
    }

    func mapAuthMode(_ value: String?) -> OpenAIAuthMode {
        switch value {
        case "none":
            return .none
        default:
            return .authContextRef
        }
    }
}
