import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
import IndeRunSwift
@testable import IndeRunCapacitorPlugin

/// Counts the runs of an owned closer, and checks it ran after its engine closed.
private final class CloseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var closes: [Bool] = []

    /// One closer per call; `engine` is the engine it belongs to.
    func closer(after engine: IndeRun) -> @Sendable () async -> Void {
        { [self] in
            let engineClosed = await engine.checkCapabilities().isEmpty
            lock.withLock { closes.append(engineClosed) }
        }
    }

    var count: Int { lock.withLock { closes.count } }
    var allAfterTheEngine: Bool { lock.withLock { closes.allSatisfy { $0 } } }
}

final class IndeRunCapacitorSpeechTests: XCTestCase {

    /// A speech package whose files are not there: enough to register, describe and probe a
    /// neural provider, never enough to load one.
    private let speechPackage: [String: Any] = [
        "id": "articulino",
        "format": "onnx",
        "version": "1.0.0",
        "tasks": ["text_to_speech"],
        "source": ["sourceType": "filesystem", "ref": "/nonexistent/inderun-capacitor-tests/articulino"],
        "speech": [
            "pipeline": "articulino",
            "sampleRate": 44100,
            "graphs": ["text": "text.onnx", "vocoder": "vocoder.onnx"],
            "voices": [["id": "lena", "name": "Lena", "locales": ["de-AT"], "file": "voices/lena.safetensors"]]
        ]
    ]

    private func decodeOptions(_ json: [String: Any]) throws -> CapacitorRunOptions {
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(CapacitorRunOptions.self, from: data)
    }

    private func makeRegistry(_ json: [String: Any]) throws -> BridgedRegistry {
        let options = try decodeOptions(json)
        return try IndeRunCapacitorBridge().makeRegistry(
            openAI: options.openAI,
            onnx: options.onnx,
            systemSpeech: options.systemSpeech,
            neuralSpeech: options.neuralSpeech
        )
    }

    private func providerIds(_ registry: BridgedRegistry) -> Set<String> {
        Set(registry.registry.list().map { $0.describe().id })
    }

    private func makeEngine() -> IndeRun {
        IndeRun(registry: ProviderRegistry(), hostServices: DefaultHostServices.make())
    }

    // MARK: - Decoding

    func testDecodesSystemSpeechAsTrueOrAsAnOptionsObject() throws {
        let flag = try XCTUnwrap(decodeOptions(["systemSpeech": true]).systemSpeech)
        XCTAssertTrue(flag.enabled)
        XCTAssertNil(flag.id)

        let object = try XCTUnwrap(decodeOptions(["systemSpeech": ["id": "speech.apple"]]).systemSpeech)
        XCTAssertTrue(object.enabled)
        XCTAssertEqual(object.id, "speech.apple")

        XCTAssertEqual(try decodeOptions(["systemSpeech": false]).systemSpeech?.enabled, false)
        XCTAssertNil(try decodeOptions([:]).systemSpeech)
    }

    func testDecodesANeuralSpeechEntryWithItsModelPackage() throws {
        let options = try decodeOptions([
            "neuralSpeech": [["modelPackage": speechPackage, "id": "speech.neural", "timeoutMs": 8000, "autoDownload": true]]
        ])

        let entry = try XCTUnwrap(options.neuralSpeech?.first)
        XCTAssertEqual(entry.modelPackage.id, "articulino")
        XCTAssertEqual(entry.modelPackage.speech?.voices.first?.id, "lena")
        XCTAssertEqual(entry.modelPackage.source?.sourceType, .filesystem)
        XCTAssertNil(entry.runtime)
        XCTAssertEqual(entry.id, "speech.neural")
        XCTAssertEqual(entry.timeoutMs, 8000)
        XCTAssertEqual(entry.autoDownload, true)
    }

    // MARK: - Registry contents

    func testRegistersNoSpeechProviderUnlessAsked() throws {
        let built = try makeRegistry([:])

        XCTAssertFalse(providerIds(built).contains("apple_system_speech"))
        XCTAssertTrue(built.owned.isEmpty)
        XCTAssertFalse(try makeRegistry(["systemSpeech": false]).registry.list().contains { $0.describe().id == "apple_system_speech" })
    }

    func testRegistersSystemSpeechWhenAsked() throws {
        XCTAssertTrue(providerIds(try makeRegistry(["systemSpeech": true])).contains("apple_system_speech"))

        let custom = providerIds(try makeRegistry(["systemSpeech": ["id": "speech.apple"]]))
        XCTAssertTrue(custom.contains("speech.apple"))
        XCTAssertFalse(custom.contains("apple_system_speech"))
    }

    func testRegistersOneNeuralProviderPerEntryUnderTheUpstreamId() throws {
        let built = try makeRegistry([
            "neuralSpeech": [
                ["modelPackage": speechPackage],
                ["modelPackage": speechPackage, "id": "speech.neural", "runtime": "onnx", "autoDownload": true]
            ]
        ])

        let ids = providerIds(built)
        XCTAssertTrue(ids.contains("local.onnx.speech.apple:articulino"))
        XCTAssertTrue(ids.contains("speech.neural"))
        XCTAssertEqual(built.registry.get(id: "speech.neural")?.describe().model, "articulino")
        XCTAssertFalse(built.registry.allowsAutoDownload(id: "local.onnx.speech.apple:articulino"))
        XCTAssertTrue(built.registry.allowsAutoDownload(id: "speech.neural"))
        // One runtime per entry, each the bridge's to close.
        XCTAssertEqual(built.owned.count, 2)
    }

    private let textPackage: [String: Any] = [
        "id": "phi-mini",
        "format": "onnx",
        "tasks": ["text_to_text"],
        "source": ["sourceType": "filesystem", "ref": "/nonexistent/inderun-capacitor-tests/phi-mini"]
    ]

    func testRegistersTheOnnxTextProviderUnderTheUpstreamId() throws {
        let built = try makeRegistry(["onnx": ["modelPackage": textPackage]])

        XCTAssertTrue(providerIds(built).contains("local.onnx.genai.apple"))
        // The provider owns the runtime it built, so the provider is the bridge's to close.
        XCTAssertEqual(built.owned.count, 1)
    }

    func testTheOnnxTextProviderIsClosedWithTheNeuralRuntimes() throws {
        let built = try makeRegistry([
            "onnx": ["modelPackage": textPackage],
            "neuralSpeech": [["modelPackage": speechPackage]]
        ])

        XCTAssertEqual(built.owned.count, 2)
    }

    func testARefusedRegistrationAfterTheOnnxProviderReleasesIt() throws {
        let options = try decodeOptions([
            "onnx": ["modelPackage": textPackage],
            "neuralSpeech": [["modelPackage": speechPackage, "runtime": "tflite"]]
        ])
        var released: [@Sendable () async -> Void] = []

        XCTAssertThrowsError(
            try IndeRunCapacitorBridge().makeRegistry(
                openAI: nil,
                onnx: options.onnx,
                neuralSpeech: options.neuralSpeech,
                release: { released = $0 }
            )
        )
        XCTAssertEqual(released.count, 1)
    }

    func testReconfiguringWithOnnxHandsTheOldTextProviderBackToClose() async throws {
        let bridge = IndeRunCapacitorBridge()
        _ = try bridge.configure(options: ["onnx": ["modelPackage": textPackage]])

        let replaced = try XCTUnwrap(try bridge.configure(options: ["onnx": ["modelPackage": textPackage]]))
        XCTAssertNotNil(replaced.registry?.get(id: "local.onnx.genai.apple"))
        await replaced.close()

        // Closed once with its configuration; the new one still serves.
        let providers = try await bridge.checkCapabilities()["providers"] as? [[String: Any]] ?? []
        XCTAssertTrue(providers.contains { $0["providerId"] as? String == "local.onnx.genai.apple" })
    }

    func testRegistersTheOnnxTextProviderUnderAConfiguredId() throws {
        let built = try makeRegistry(["onnx": ["modelPackage": textPackage, "id": "text.phi", "timeoutMs": 9_000]])

        let ids = providerIds(built)
        XCTAssertTrue(ids.contains("text.phi"))
        XCTAssertFalse(ids.contains("local.onnx.genai.apple"))
    }

    func testRegistersNoOnnxTextProviderUnlessAsked() throws {
        XCTAssertFalse(providerIds(try makeRegistry([:])).contains("local.onnx.genai.apple"))
    }

    func testRegistersACoreAIProviderUnderTheUpstreamId() throws {
        var coreAIPackage = speechPackage
        coreAIPackage["format"] = "coreai"
        let built = try makeRegistry([
            "neuralSpeech": [
                ["modelPackage": coreAIPackage, "runtime": "coreai"],
                ["modelPackage": coreAIPackage, "runtime": "coreai", "id": "speech.coreai", "autoDownload": true]
            ]
        ])

        let ids = providerIds(built)
        XCTAssertTrue(ids.contains("local.coreai.speech.apple:articulino"))
        XCTAssertTrue(ids.contains("speech.coreai"))
        XCTAssertFalse(ids.contains("local.onnx.speech.apple:articulino"))
        XCTAssertTrue(built.registry.allowsAutoDownload(id: "speech.coreai"))
        XCTAssertEqual(built.owned.count, 2)
    }

    func testTheOwnedCloserClosesTheCoreAIRuntime() async throws {
        var coreAIPackage = speechPackage
        coreAIPackage["format"] = "coreai"
        let built = try makeRegistry(["neuralSpeech": [["modelPackage": coreAIPackage, "runtime": "coreai"]]])
        let provider = try XCTUnwrap(built.registry.get(id: "local.coreai.speech.apple:articulino"))

        for close in built.owned {
            await close()
        }

        let after = await provider.capabilities(host: DefaultHostServices.make())
        XCTAssertFalse(after.available)
        XCTAssertEqual(after.reason, "runtime closed")
    }

    func testRefusesAnUnknownRuntime() throws {
        XCTAssertThrowsError(
            try makeRegistry(["neuralSpeech": [["modelPackage": speechPackage, "runtime": "tflite"]]])
        ) { error in
            let contractError = toIndeRunException(error).toContractError()
            XCTAssertEqual(contractError.errorClass, .Internal)
            XCTAssertEqual(contractError.message, "tflite neural speech runtime is not available on this platform")
        }
    }

    func testReleasesTheRuntimesAlreadyBuiltWhenALaterEntryIsRefused() throws {
        let options = try decodeOptions([
            "neuralSpeech": [
                ["modelPackage": speechPackage],
                // The same id again: registering it throws after the first runtime exists.
                ["modelPackage": speechPackage]
            ]
        ])
        var released: [@Sendable () async -> Void] = []

        XCTAssertThrowsError(
            try IndeRunCapacitorBridge().makeRegistry(
                openAI: nil,
                neuralSpeech: options.neuralSpeech,
                release: { released = $0 }
            )
        )
        // Both runtimes were built; the second was owned before its registration was refused.
        XCTAssertEqual(released.count, 2)
    }

    // MARK: - Closing what the bridge built

    func testANewConfigurationReleasesTheReplacedOnesRuntimesAfterItsEngine() async throws {
        let bridge = IndeRunCapacitorBridge()
        let recorder = CloseRecorder()
        let first = makeEngine()
        await bridge.install(engine: first, owned: [recorder.closer(after: first)])
        XCTAssertEqual(recorder.count, 0)

        let replaced = try bridge.configure(options: ["systemSpeech": true])
        XCTAssertEqual(recorder.count, 0)
        await replaced?.close()

        XCTAssertEqual(recorder.count, 1)
        XCTAssertTrue(recorder.allAfterTheEngine)
    }

    func testCloseReleasesTheRuntimesOnceAcrossALaterReconfigure() async throws {
        let bridge = IndeRunCapacitorBridge()
        let recorder = CloseRecorder()
        let engine = makeEngine()
        await bridge.install(engine: engine, owned: [recorder.closer(after: engine)])

        await bridge.close()
        XCTAssertEqual(recorder.count, 1)
        XCTAssertTrue(recorder.allAfterTheEngine)
        await bridge.close()

        // The closed configuration is replaced, and closed again: its runtimes are not.
        await bridge.install(engine: makeEngine())
        XCTAssertEqual(recorder.count, 1)
    }

    func testTeardownReleasesTheRuntimes() async throws {
        let bridge = IndeRunCapacitorBridge()
        let released = expectation(description: "owned runtime released")
        await bridge.install(engine: makeEngine(), owned: [{ released.fulfill() }])

        bridge.teardown()

        await fulfillment(of: [released], timeout: 5)
    }

    func testAConfigurationWithNeuralSpeechHandsItsRuntimeBackToClose() async throws {
        let bridge = IndeRunCapacitorBridge()
        _ = try bridge.configure(options: ["neuralSpeech": [["modelPackage": speechPackage]]])

        let replaced = try XCTUnwrap(try bridge.configure(options: ["systemSpeech": true]))
        let neural = try XCTUnwrap(replaced.registry?.get(id: "local.onnx.speech.apple:articulino"))
        let host = DefaultHostServices.make()
        let beforeClose = await neural.capabilities(host: host)
        XCTAssertNotEqual(beforeClose.reason, "runtime closed")

        await replaced.close()

        // The neural runtime the bridge built is closed with the configuration it belonged to.
        let afterClose = await neural.capabilities(host: host)
        XCTAssertEqual(afterClose.reason, "runtime closed")
        // The replaced engine is closed; the new one serves.
        let replacedProviders = await replaced.engine.checkCapabilities()
        XCTAssertTrue(replacedProviders.isEmpty)
        let providers = try await bridge.checkCapabilities()["providers"] as? [[String: Any]] ?? []
        XCTAssertTrue(providers.contains { $0["providerId"] as? String == "apple_system_speech" })
        XCTAssertFalse(providers.contains { $0["providerId"] as? String == "local.onnx.speech.apple:articulino" })
    }

    // MARK: - Wire shapes (contracts are Codable)

    func testDecodesATextToSpeechRequestFromTheCrossSDKVectors() throws {
        // `speak_local_required_with_profile` and `generate_*` from
        // contracts/fixtures/facade/speech.json (inderun v0.5.0-rc.20), expected requests.
        let playback: [String: Any] = [
            "schemaVersion": "1.0",
            "task": ["kind": "text_to_speech"],
            "speech": [
                "text": "Hallo",
                "locale": "de-DE",
                "localeMatch": "exact",
                "voice": ["providerId": "apple_system_speech", "id": "com.apple.voice.compact.de-DE.Anna", "gender": "female", "requirement": "required"]
            ],
            "delivery": ["mode": "playback"],
            "modelProfile": "speech",
            "constraints": ["privacy": "local_required", "timeoutMs": 2000],
            "preferences": ["optimizeFor": "latency"],
            "requestId": "req_speech_1"
        ]
        let request = try JSONDecoder().decode(TaskRequest.self, from: JSONSerialization.data(withJSONObject: playback))

        XCTAssertEqual(request.task.kind, .textToSpeech)
        XCTAssertEqual(request.speech?.text, "Hallo")
        XCTAssertEqual(request.speech?.localeMatch, .exact)
        XCTAssertEqual(request.speech?.voice?.id, "com.apple.voice.compact.de-DE.Anna")
        XCTAssertEqual(request.speech?.voice?.providerId, "apple_system_speech")
        XCTAssertEqual(request.speech?.voice?.gender, .female)
        XCTAssertEqual(request.speech?.voice?.requirement, .requirementLevelRequired)
        XCTAssertEqual(request.delivery?.mode, .playback)
        XCTAssertEqual(request.modelProfile, "speech")
        XCTAssertEqual(request.constraints?.privacy, .localRequired)

        // And back: the request the bridge would hand the engine is the one JS sent.
        let reencoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? NSDictionary
        XCTAssertEqual(reencoded, playback as NSDictionary)

        let artifact: [String: Any] = [
            "schemaVersion": "1.0",
            "task": ["kind": "text_to_speech"],
            "speech": ["text": "Hallo", "locale": "de-DE"],
            "delivery": ["mode": "artifact", "mediaTypes": ["audio/wav"], "destinationRef": "downloads"]
        ]
        let artifactRequest = try JSONDecoder().decode(TaskRequest.self, from: JSONSerialization.data(withJSONObject: artifact))
        XCTAssertEqual(artifactRequest.delivery?.mode, .artifact)
        XCTAssertEqual(artifactRequest.delivery?.mediaTypes, ["audio/wav"])
        XCTAssertEqual(artifactRequest.delivery?.destinationRef, "downloads")
    }
}
