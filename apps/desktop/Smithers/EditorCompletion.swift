import Foundation

struct EditorCompletionRequest: Sendable {
    let text: String
    let cursorOffset: Int
    let line: Int
    let column: Int
    let fileURL: URL?
    let language: SupportedLanguage?
}

struct EditorEditLocation: Hashable, Sendable {
    let line: Int
    let column: Int
    let timestamp: Date
}
