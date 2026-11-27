import XCTest
import Foundation
import IndeRunContracts
import IndeRunCore
@testable import IndeRunCapacitorPlugin

/// The vendored task-contract fixture, read in place from `test-fixtures/` at the repository root
/// (the one copy; see its README), never copied into the test target.
func taskContractFixture(_ name: String, file: StaticString = #filePath) throws -> [String: Any] {
    var root = URL(fileURLWithPath: "\(file)")
    // ios/Tests/IndeRunCapacitorTests/<file>.swift -> the repository root.
    for _ in 0..<4 {
        root.deleteLastPathComponent()
    }
    let url = root.appendingPathComponent("test-fixtures/task-contracts/\(name)")
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
    return try XCTUnwrap(object as? [String: Any], "\(url.path) is not a JSON object")
}

/// A fresh deep copy of a JSON value, as `JSONSerialization` would hand it over.
func jsonCopy(_ value: Any) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), options: [.fragmentsAllowed])
}

/// A Codable value as the JSON object it encodes to.
func jsonObject<T: Encodable>(_ value: T) throws -> NSDictionary {
    let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    return try XCTUnwrap(object as? NSDictionary)
}

/// A JSON object decoded into a contract type, the way the bridge decodes what JS sends.
func decodeJSON<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
}

/// Structural JSON equality: `NSDictionary` compares nested objects, arrays and numbers by value,
/// so key order and `0.9` vs `0.90` do not matter, while a missing key or an extra one does.
func assertSameJSON(_ actual: Any?, _ expected: Any?, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
    guard let actual = actual as? NSDictionary, let expected = expected as? NSDictionary else {
        XCTFail("\(label): not both JSON objects (\(String(describing: actual)) vs \(String(describing: expected)))", file: file, line: line)
        return
    }
    XCTAssertEqual(actual, expected, label, file: file, line: line)
}

/// The refusal `body` raises, as the contract error the plugin rejects with.
func refusal(_ label: String, _ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async -> IndeRunError? {
    do {
        try await body()
        XCTFail("\(label): expected a refusal", file: file, line: line)
        return nil
    } catch {
        return toIndeRunException(error).toContractError()
    }
}
