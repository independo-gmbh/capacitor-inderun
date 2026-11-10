#if canImport(Capacitor)
import Capacitor
#else
typealias JSObject = [String: Any]
#endif
import Foundation
import IndeRunAppleProviders
import IndeRunCore
import IndeRunContracts
import IndeRunCoreAIProviders
import IndeRunNeuralSpeech
import IndeRunOnnxProviders
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

/// `systemSpeech` arrives as `true` or as an options object; see `SystemSpeechBootstrapOptions`
/// in src/definitions.ts. `false` is read as not asking for it, the same as leaving it out.
struct SystemSpeechBootstrapOptions: Decodable {
    let enabled: Bool
    let id: String?

    private enum CodingKeys: String, CodingKey {
        case id
    }

    init(from decoder: Decoder) throws {
        if let flag = try? decoder.singleValueContainer().decode(Bool.self) {
            enabled = flag
            id = nil
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = true
        id = try container.decodeIfPresent(String.self, forKey: .id)
    }
}

/// One neural speech provider; see `NeuralSpeechBootstrapOptions` in src/definitions.ts.
struct NeuralSpeechBootstrapOptions: Decodable {
    let modelPackage: ModelPackage
    /// `onnx` when absent; `coreai` runs a `format: "coreai"` package on Apple Core AI.
    let runtime: String?
    let id: String?
    let timeoutMs: Int?
    let autoDownload: Bool?
}

/// A developer-supplied ONNX text model; see `OnnxProviderBootstrapOptions` in src/definitions.ts.
struct OnnxBootstrapOptions: Decodable {
    let modelPackage: ModelPackage
    let id: String?
    let timeoutMs: Int?
}

struct CapacitorRunOptions: Decodable {
    let openAI: OpenAIProviderBootstrapOptions?
    let onnx: OnnxBootstrapOptions?
    /// Profile name to ordered target ids, as `IndeRun(modelProfiles:)` takes it.
    let modelProfiles: [String: [String]]?
    let systemSpeech: SystemSpeechBootstrapOptions?
    let neuralSpeech: [NeuralSpeechBootstrapOptions]?
    let allowDirectOpenAIEndpoint: Bool? // web-only, no-op on native
}

/// A registry and what the bridge constructed for it that holds something to release.
struct BridgedRegistry {
    let registry: ProviderRegistry
    /// One closer per runtime the bridge built, in registration order.
    let owned: [@Sendable () async -> Void]
}

/// What one `configure` built: the engine every call uses, and the providers' runtimes the bridge
/// constructed for its registry.
///
/// Upstream's `close()` closes no provider and no runtime: the registry is the application's,
/// and whoever creates a thing closes it. Here the bridge is that application, so closing a
/// configuration closes the engine first -- its streams end, its runs finish, its artifacts go --
/// and then releases the loaded models. The owned resources are released at most once, so a
/// configuration closed by `close()` and later replaced by `configure` is not released twice.
final class BridgedConfiguration: @unchecked Sendable {
    let engine: IndeRun
    /// The registry `configure` built the engine over; `nil` for an engine installed directly.
    let registry: ProviderRegistry?
    private let lock = NSLock()
    private var owned: [@Sendable () async -> Void]

    init(engine: IndeRun, registry: ProviderRegistry? = nil, owned: [@Sendable () async -> Void] = []) {
        self.engine = engine
        self.registry = registry
        self.owned = owned
    }

    func close() async {
        await engine.close()
        let release = lock.withLock {
            let pending = owned
            owned = []
            return pending
        }
        for close in release {
            await close()
        }
    }
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
    ///
    /// Held with the runtimes the bridge built for its registry, which close after it.
    private let engineLock = NSLock()
    private var configuration: BridgedConfiguration?
    let streams = StreamRegistry()

    deinit {
        streams.cancelAll(reason: "Capacitor bridge deallocated.")
        if let configuration {
            Task { await configuration.close() }
        }
    }

    /// Synchronous on purpose: decoding, validation and the engine swap all happen on the
    /// plugin call, so configurations take effect in the order Capacitor delivered them and a
    /// call issued right after `configure` already reaches the new engine. Only closing the
    /// replaced engine is asynchronous; the caller awaits the returned configuration's `close()`
    /// before resolving.
    ///
    /// - Returns: The configuration this one replaced, still to be closed.
    func configure(options: JSObject) throws -> BridgedConfiguration? {
        let runOptions = try decodeConfigureOptions(from: options)
        // Validated and built before anything is replaced, so a refused configuration
        // leaves the previous engine in place rather than half of each.
        let modelProfiles = try makeModelProfiles(runOptions.modelProfiles)
        let built = try makeRegistry(
            openAI: runOptions.openAI,
            onnx: runOptions.onnx,
            systemSpeech: runOptions.systemSpeech,
            neuralSpeech: runOptions.neuralSpeech
        )
        return swap(
            BridgedConfiguration(
                engine: IndeRun(registry: built.registry, hostServices: DefaultHostServices.make(), modelProfiles: modelProfiles),
                registry: built.registry,
                owned: built.owned
            )
        )
    }

    /// Makes `configuration` the one every later call uses, at once, and hands back the one it
    /// replaced for the caller to close.
    func swap(_ newConfiguration: BridgedConfiguration) -> BridgedConfiguration? {
        engineLock.withLock {
            let previous = configuration
            configuration = newConfiguration
            return previous
        }
    }

    /// `swap` followed by closing the replaced configuration: returns when the old engine has
    /// closed, which upstream defines as its streams and prepares ending in their cancelled
    /// terminal and its in-flight runs finishing, and its owned runtimes have been released.
    func install(engine newEngine: IndeRun, owned: [@Sendable () async -> Void] = []) async {
        await swap(BridgedConfiguration(engine: newEngine, owned: owned))?.close()
    }

    /// The configured engine, closed or not: a closed one answers every call the way
    /// upstream defines (`engine_closed`), which is what the bridge reports.
    private func requireEngine(before call: String) throws -> IndeRun {
        guard let engine = engineLock.withLock({ configuration?.engine }) else {
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

    /// Closes the configured engine, then the runtimes the bridge built for it, and keeps the
    /// engine, so every later call fails the way the closed engine fails it until `configure`
    /// installs a new one. Nothing configured is nothing to close.
    func close() async {
        await engineLock.withLock({ configuration })?.close()
    }

    /// Plugin teardown: stops the runs the webview can no longer receive, then closes the
    /// engine and its runtimes without waiting -- nobody is left to wait.
    func teardown() {
        streams.cancelAll(reason: "Capacitor plugin torn down.")
        if let configuration = engineLock.withLock({ configuration }) {
            Task { await configuration.close() }
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

    /// Runs the closers of runtimes built for a configuration that never took effect, without
    /// waiting: `configure` stays synchronous, and nothing is loaded into a runtime this early.
    static func releaseInBackground(_ closers: [@Sendable () async -> Void]) {
        guard !closers.isEmpty else { return }
        Task {
            for close in closers {
                await close()
            }
        }
    }

    /// - Parameter release: What happens to the runtimes already built when a later step throws;
    ///   a test seam, the default closes them in the background.
    func makeRegistry(
        openAI: OpenAIProviderBootstrapOptions?,
        onnx: OnnxBootstrapOptions? = nil,
        systemSpeech: SystemSpeechBootstrapOptions? = nil,
        neuralSpeech: [NeuralSpeechBootstrapOptions]? = nil,
        release: ([@Sendable () async -> Void]) -> Void = IndeRunCapacitorBridge.releaseInBackground
    ) throws -> BridgedRegistry {
        let registry = ProviderRegistry()
        var owned: [@Sendable () async -> Void] = []
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

        if let onnx {
            // The provider builds its own `SystemOnnxGenAiRuntime` when none is passed, loads the
            // model lazily and has no close; nothing here for the bridge to own.
            try registry.register(
                OnnxRuntimeAppleProvider(
                    options: OnnxProviderOptions(
                        id: onnx.id ?? OnnxRuntimeAppleProvider.defaultId,
                        modelPackage: onnx.modelPackage,
                        timeout: onnx.timeoutMs.map { .milliseconds($0) }
                    )
                )
            )
        }

        // Opt-in (ADR 018): the router probes every registered provider on every request, so
        // an app that does not speak should not pay for a voice listing.
        if let systemSpeech, systemSpeech.enabled {
            try registry.register(AppleSystemSpeechProvider(id: systemSpeech.id ?? AppleSystemSpeechProvider.defaultId))
        }

        do {
            for entry in neuralSpeech ?? [] {
                let (provider, close) = try makeNeuralSpeechProvider(entry)
                // Owned before registering, so a refused registration still closes it.
                owned.append(close)
                try registry.register(provider, options: ProviderRegistrationOptions(autoDownload: entry.autoDownload ?? false))
            }
        } catch {
            release(owned)
            throw error
        }

        return BridgedRegistry(registry: registry, owned: owned)
    }

    /// One provider and its own runtime, closed with the configuration: the provider has no close
    /// of its own, and the runtime is what holds the loaded model.
    ///
    /// `coreai` composes what `makeCoreAINeuralSpeechProvider(options:)` composes -- the same id
    /// prefix, a `CoreAINeuralSpeechRuntime` with default options -- rather than calling it,
    /// because the factory keeps the runtime to itself and the bridge has to close it. Below
    /// iOS 27, or in a build without the Core AI SDK, the runtime reports itself unavailable and
    /// routing skips the provider; the bridge does not check the OS.
    private func makeNeuralSpeechProvider(
        _ entry: NeuralSpeechBootstrapOptions
    ) throws -> (NeuralSpeechProvider, @Sendable () async -> Void) {
        let timeout: Duration? = entry.timeoutMs.map { .milliseconds($0) }
        switch entry.runtime ?? "onnx" {
        case "onnx":
            let runtime = OnnxNeuralSpeechRuntime()
            let provider = NeuralSpeechProvider(
                options: NeuralSpeechProviderOptions(id: entry.id, modelPackage: entry.modelPackage, runtime: runtime, timeout: timeout)
            )
            return (provider, { await runtime.close() })
        case "coreai":
            let runtime = CoreAINeuralSpeechRuntime()
            let provider = NeuralSpeechProvider(
                options: NeuralSpeechProviderOptions(
                    id: entry.id ?? "\(NeuralSpeechProvider.coreAIDefaultId):\(entry.modelPackage.id)",
                    modelPackage: entry.modelPackage,
                    runtime: runtime,
                    timeout: timeout
                )
            )
            return (provider, { await runtime.close() })
        case let other:
            throw createInternal(message: "\(other) neural speech runtime is not available on this platform")
        }
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
