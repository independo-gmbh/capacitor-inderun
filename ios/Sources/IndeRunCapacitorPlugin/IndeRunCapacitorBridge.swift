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

struct OpenAIProviderBootstrapOptions: Codable {
    let model: String
    let endpointURL: String?
    let auth: String?
    let authContextRef: String?
    let timeoutMs: Int?
}

struct CapacitorRunOptions: Codable {
    let openAI: OpenAIProviderBootstrapOptions?
    let allowDirectOpenAIEndpoint: Bool? // web-only, no-op on native
}

/// Unlike `run(request)`, which takes the request at the options root, `startStream`
/// nests it under `request` so the envelope can also carry the bridge-local
/// `streamId`. See `StartStreamOptions` in src/definitions.ts.
struct CapacitorStartStreamOptions: Codable {
    let streamId: String
    let request: TaskRequest
}

struct CapacitorCancelStreamOptions: Codable {
    let streamId: String
    let reason: String?
}

/// Called with an already-encoded event/error for one run. The plugin turns these
/// into `notifyListeners` calls; taking them as closures keeps the pump testable
/// without Capacitor.
typealias StreamEventSink = @Sendable (String, JSObject) -> Void
typealias StreamErrorSink = @Sendable (String, JSObject) -> Void

final class IndeRunCapacitorBridge {
    private var configuredRegistry: ProviderRegistry?
    private var configuredHostServices: HostServices?
    let streams = StreamRegistry()

    deinit {
        streams.cancelAll(reason: "Capacitor bridge deallocated.")
    }

    func configure(options: JSObject) throws {
        let runOptions = try decodeConfigureOptions(from: options)
        configuredRegistry = try makeRegistry(openAI: runOptions.openAI)
        configuredHostServices = DefaultHostServices.make()
    }

    func run(requestObject: JSObject) async throws -> JSObject {
        guard let registry = configuredRegistry, let hostServices = configuredHostServices else {
            throw createUnavailable(message: "Capacitor IndeRun has not been configured. Configure providers before calling run(request).")
        }

        let request = try decodeRequest(from: requestObject)
        // IndeRun is a stateless coordinator; new per call is intentional — registry is cached above.
        let engine = IndeRun(registry: registry, hostServices: hostServices)
        let result = try await engine.run(request: request)
        return try encode(result)
    }

    func startStream(
        options: JSObject,
        onEvent: @escaping StreamEventSink,
        onError: @escaping StreamErrorSink
    ) async throws -> JSObject {
        guard let registry = configuredRegistry, let hostServices = configuredHostServices else {
            throw createUnavailable(message: "Capacitor IndeRun has not been configured. Configure providers before calling stream(request).")
        }

        let start = try decodeStartStreamOptions(from: options)
        // Reserved before the engine is reached, so a cancel arriving during route
        // selection is recorded rather than dropped as an unknown id.
        streams.open(streamId: start.streamId)

        let run: StreamRun
        do {
            // IndeRun is a stateless coordinator; new per call is intentional — registry is cached above.
            let engine = IndeRun(registry: registry, hostServices: hostServices)
            run = try await engine.stream(request: start.request)
        } catch {
            streams.finish(streamId: start.streamId)
            throw error
        }

        if case .cancelRequested(let reason) = streams.attach(streamId: start.streamId, run: run) {
            run.cancel(reason: reason)
        }

        let streamId = start.streamId
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

    func teardownStreams() {
        streams.cancelAll(reason: "Capacitor plugin torn down.")
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

    private func makeRegistry(openAI: OpenAIProviderBootstrapOptions?) throws -> ProviderRegistry {
        let registry = ProviderRegistry()
        try registry.register(AppleFoundationModelsProvider())

        if let openAI {
            try registry.register(
                OpenAIProvider(
                    options: OpenAIProviderOptions(
                        id: "openai",
                        model: openAI.model,
                        endpointURL: openAI.endpointURL ?? defaultOpenAIResponsesEndpoint,
                        auth: mapAuthMode(openAI.auth),
                        authContextRef: openAI.authContextRef,
                        timeoutMs: openAI.timeoutMs
                    )
                )
            )
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
        guard let dictionary = object as? JSObject else {
            throw createInternal(message: "Capacitor bridge failed to encode a JSON object.")
        }
        return dictionary
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
