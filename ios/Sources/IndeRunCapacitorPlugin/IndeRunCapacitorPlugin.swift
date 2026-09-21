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
        CAPPluginMethod(name: "cancelStream", returnType: CAPPluginReturnPromise)
    ]

    private let implementation = IndeRunCapacitorBridge()

    /// CAPPlugin has no teardown hook — `load()` has no counterpart — so deinit is
    /// the only place left to stop runs the webview can no longer receive. The pump
    /// tasks hold `self` weakly precisely so this can run.
    deinit {
        implementation.teardownStreams()
    }

    @objc func configure(_ call: CAPPluginCall) {
        do {
            try implementation.configure(options: call.jsObjectRepresentation)
            call.resolve()
        } catch let error as IndeRunException {
            let contractError = error.toContractError()
            let details = try? implementation.encode(error: contractError)
            call.reject(contractError.message, contractError.errorClass.rawValue, error, details)
        } catch {
            let normalized = toIndeRunException(error)
            let contractError = normalized.toContractError()
            let details = try? implementation.encode(error: contractError)
            call.reject(contractError.message, contractError.errorClass.rawValue, normalized, details)
        }
    }

    @objc func run(_ call: CAPPluginCall) {
        Task {
            do {
                let result = try await implementation.run(requestObject: call.jsObjectRepresentation)
                call.resolve(result)
            } catch let error as IndeRunException {
                let contractError = error.toContractError()
                let details = try? implementation.encode(error: contractError)
                call.reject(contractError.message, contractError.errorClass.rawValue, error, details)
            } catch {
                let normalized = toIndeRunException(error)
                let contractError = normalized.toContractError()
                let details = try? implementation.encode(error: contractError)
                call.reject(contractError.message, contractError.errorClass.rawValue, normalized, details)
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
            } catch let error as IndeRunException {
                let contractError = error.toContractError()
                let details = try? implementation.encode(error: contractError)
                call.reject(contractError.message, contractError.errorClass.rawValue, error, details)
            } catch {
                let normalized = toIndeRunException(error)
                let contractError = normalized.toContractError()
                let details = try? implementation.encode(error: contractError)
                call.reject(contractError.message, contractError.errorClass.rawValue, normalized, details)
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
                    onEvent: { [weak self] streamId, event in
                        self?.notifyListeners(
                            "indeRunStreamEvent",
                            data: ["streamId": streamId, "event": event],
                            retainUntilConsumed: true
                        )
                    },
                    onError: { [weak self] streamId, error in
                        self?.notifyListeners(
                            "indeRunStreamError",
                            data: ["streamId": streamId, "error": error],
                            retainUntilConsumed: true
                        )
                    }
                )
                call.resolve(handle)
            } catch let error as IndeRunException {
                let contractError = error.toContractError()
                let details = try? self.implementation.encode(error: contractError)
                call.reject(contractError.message, contractError.errorClass.rawValue, error, details)
            } catch {
                let normalized = toIndeRunException(error)
                let contractError = normalized.toContractError()
                let details = try? self.implementation.encode(error: contractError)
                call.reject(contractError.message, contractError.errorClass.rawValue, normalized, details)
            }
        }
    }

    /// Resolves for an unknown or already-finished run: cancelling after the terminal
    /// is a no-op by contract, not an error.
    @objc func cancelStream(_ call: CAPPluginCall) {
        do {
            try implementation.cancelStream(options: call.jsObjectRepresentation)
            call.resolve()
        } catch let error as IndeRunException {
            let contractError = error.toContractError()
            let details = try? implementation.encode(error: contractError)
            call.reject(contractError.message, contractError.errorClass.rawValue, error, details)
        } catch {
            let normalized = toIndeRunException(error)
            let contractError = normalized.toContractError()
            let details = try? implementation.encode(error: contractError)
            call.reject(contractError.message, contractError.errorClass.rawValue, normalized, details)
        }
    }
}
#endif
