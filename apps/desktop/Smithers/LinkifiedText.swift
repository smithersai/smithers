import Foundation
import SwiftUI

struct LinkifiedText: View {
    @ObservedObject var workspace: WorkspaceState
    let text: String
    let font: Font
    let baseColor: Color
    var linkColor: Color = .blue
    var selectionEnabled: Bool = false

    var body: some View {
        let attributed = linkify(text)
        if selectionEnabled {
            Text(attributed)
                .textSelection(.enabled)
        } else {
            Text(attributed)
        }
    }

    private func linkify(_ text: String) -> AttributedString {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        let matches = Self.filePattern.matches(in: text, range: fullRange)

        var result = AttributedString()
        var cursor = 0

        for match in matches {
            guard match.range.location >= cursor else { continue }

            let prefixRange = NSRange(location: cursor, length: match.range.location - cursor)
            if prefixRange.length > 0 {
                let prefix = nsText.substring(with: prefixRange)
                result.append(makeSegment(prefix, color: baseColor))
            }

            let matchText = nsText.substring(with: match.range)
            let path = nsText.substring(with: match.range(at: 1))
            let line = intCapture(nsText, range: match.range(at: 2))
            let column = intCapture(nsText, range: match.range(at: 3))

            if isURLPrefix(text: nsText, matchRange: match.range) {
                result.append(makeSegment(matchText, color: baseColor))
            } else if let link = workspace.makeOpenFileURL(path: path, line: line, column: column) {
                var linkChunk = makeSegment(matchText, color: linkColor)
                linkChunk.link = link
                linkChunk.underlineStyle = .single
                result.append(linkChunk)
            } else {
                result.append(makeSegment(matchText, color: baseColor))
            }

            cursor = match.range.location + match.range.length
        }

        if cursor < nsText.length {
            let tailRange = NSRange(location: cursor, length: nsText.length - cursor)
            let tail = nsText.substring(with: tailRange)
            result.append(makeSegment(tail, color: baseColor))
        }

        return result
    }

    private func makeSegment(_ text: String, color: Color) -> AttributedString {
        var chunk = AttributedString(text)
        chunk.font = font
        chunk.foregroundColor = color
        return chunk
    }

    private func intCapture(_ text: NSString, range: NSRange) -> Int? {
        guard range.location != NSNotFound else { return nil }
        return Int(text.substring(with: range))
    }

    private func isURLPrefix(text: NSString, matchRange: NSRange) -> Bool {
        guard matchRange.location >= 3 else { return false }
        let prefixRange = NSRange(location: matchRange.location - 3, length: 3)
        return text.substring(with: prefixRange) == "://"
    }

    private static let filePattern = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_./-])((?:(?:~[A-Za-z0-9._-]*)/|/|\./|\.\./)?[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?(?::(\d+))?"#,
        options: []
    )
}
