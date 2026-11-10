#if canImport(Capacitor)
import Capacitor
import Foundation
import IndeRunCore

@objc(IndeRunCapacitorPlugin)
public final class IndeRunCapacitorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IndeRunCapacitorPlugin"
    public let jsName = "IndeRunCapacitor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "run", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPrepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readArtifact", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disposeArtifact", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private let implementation = IndeRunCapacitorBridge()

    /// CAPPlugin has no teardown hook — `load()` has no counterpart — so deinit is
    /// the only place left to stop runs the webview can no longer receive and to close
    /// the engine. The pump tasks hold `self` weakly precisely so this can run.
    deinit {
        implementation.teardown()
    }

    /// Resolves once the engine this configuration replaces has closed.
    @objc func configure(_ call: CAPPluginCall) {
        Task {
            do {
                try await implementation.configure(options: call.jsObjectRepresentation)
                call.resolve()
            } catch {
                reject(call, with: error)
            }
        }
    }

    @objc func run(_ call: CAPPluginCall) {
        Task {
            do {
                let result = try await implementation.run(requestObject: call.jsObjectRepresentation)
                call.resolve(result)
            } catch {
                reject(call, with: error)
            }
        }
    }

    /// Reports every registered provider's static declaration and live availability
    /// without executing a task. Availability changes between calls — a local model can
    /// unload, cloud credentials can expire — so callers must not cache it across a run.
    @objc func checkCapabilities(_ call: CAPPluginCall) {
        Task {
            do {
                call.resolve(try await implementation.checkCapabilities())
            } catch {
                reject(call, with: error)
            }
        }
    }

    /// Resolves with the run handle. Only validation and route-selection failures
    /// reject here; a provider failure, a cancellation, or completion all arrive as
    /// the single terminal event on `indeRunStreamEvent`.
    ///
    /// `retainUntilConsumed` closes the listener-registration race from the native
    /// side: an event emitted before the JS listener is attached is retained and
    /// replayed rather than lost.
    @objc func startStream(_ call: CAPPluginCall) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let handle = try await self.implementation.startStream(
                    options: call.jsObjectRepresentation,
                    onEvent: self.streamEventSink(),
                    onError: self.streamErrorSink()
                )
                call.resolve(handle)
            } catch {
                self.reject(call, with: error)
            }
        }
    }

    /// Delivered exactly like `startStream` — same notifications, same `cancelStream` —
    /// because upstream's `prepare` returns the same `StreamRun`.
    @objc func startPrepare(_ call: CAPPluginCall) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let handle = try await self.implementation.startPrepare(
                    options: call.jsObjectRepresentation,
                    onEvent: self.streamEventSink(),
                    onError: self.streamErrorSink()
                )
                call.resolve(handle)
            } catch {
                self.reject(call, with: error)
            }
        }
    }

    /// Resolves for an unknown or already-finished run: cancelling after the terminal
    /// is a no-op by contract, not an error.
    @objc func cancelStream(_ call: CAPPluginCall) {
        do {
            try implementation.cancelStream(options: call.jsObjectRepresentation)
            call.resolve()
        } catch {
            reject(call, with: error)
        }
    }

    /// Resolves with `bytes` as base64; the JS side decodes it back into a `Uint8Array`.
    @objc func readArtifact(_ call: CAPPluginCall) {
        Task {
            do {
                call.resolve(try await implementation.readArtifact(requestObject: call.jsObjectRepresentation))
            } catch {
                reject(call, with: error)
            }
        }
    }

    @objc func disposeArtifact(_ call: CAPPluginCall) {
        Task {
            do {
                try await implementation.disposeArtifact(artifactObject: call.jsObjectRepresentation)
                call.resolve()
            } catch {
                reject(call, with: error)
            }
        }
    }

    /// Resolves once the engine has closed: its streams have reached their cancelled
    /// terminal and its in-flight runs have finished.
    @objc func close(_ call: CAPPluginCall) {
        Task {
            await implementation.close()
            call.resolve()
        }
    }

    private func streamEventSink() -> StreamEventSink {
        { [weak self] streamId, event in
            self?.notifyListeners(
                "indeRunStreamEvent",
                data: ["streamId": streamId, "event": event],
                retainUntilConsumed: true
            )
        }
    }

    private func streamErrorSink() -> StreamErrorSink {
        { [weak self] streamId, error in
            self?.notifyListeners(
                "indeRunStreamError",
                data: ["streamId": streamId, "error": error],
                retainUntilConsumed: true
            )
        }
    }

    /// Rejects with the canonical `IndeRunError` as the call's data, which is where
    /// `normalizePluginError` on the JS side finds it.
    private func reject(_ call: CAPPluginCall, with error: Error) {
        let exception = (error as? IndeRunException) ?? toIndeRunException(error)
        let contractError = exception.toContractError()
        let details = try? implementation.encode(error: contractError)
        call.reject(contractError.message, contractError.errorClass.rawValue, exception, details)
    }
}
#endif
