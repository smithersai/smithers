import Foundation
import Dispatch
import AppKit
import STTextView
import SwiftTreeSitter
import QuartzCore

import TreeSitterSwift
import TreeSitterJavaScript
import TreeSitterPython
import TreeSitterJSON
import TreeSitterBash
import TreeSitterTypeScript
import TreeSitterTSX
import TreeSitterMarkdown
import TreeSitterMarkdownInline
import TreeSitterZig
import TreeSitterRust
import TreeSitterGo

struct SupportedLanguage {
    let language: Language
    let name: String
    let bundleName: String?

    static func fromFileName(_ fileName: String) -> SupportedLanguage? {
        let ext = (fileName as NSString).pathExtension
        if !ext.isEmpty {
            return from(fileExtension: ext)
        }
        switch fileName.lowercased() {
        case "makefile", "gnumakefile", "dockerfile":
            return make(tree_sitter_bash(), name: "Bash")
        default:
            return nil
        }
    }

    static func from(fileExtension ext: String) -> SupportedLanguage? {
        switch ext.lowercased() {
        case "swift":
            return make(tree_sitter_swift(), name: "Swift")
        case "js", "mjs", "cjs", "jsx":
            return make(tree_sitter_javascript(), name: "JavaScript")
        case "ts", "mts", "cts":
            return make(tree_sitter_typescript(), name: "TypeScript")
        case "tsx":
            return make(tree_sitter_tsx(), name: "TSX", bundleName: "TreeSitterTypeScript_TreeSitterTSX")
        case "py":
            return make(tree_sitter_python(), name: "Python")
        case "json":
            return make(tree_sitter_json(), name: "JSON")
        case "sh", "bash", "zsh":
            return make(tree_sitter_bash(), name: "Bash")
        case "md", "markdown":
            return make(tree_sitter_markdown(), name: "Markdown")
        case "zig", "zon":
            return make(tree_sitter_zig(), name: "Zig")
        case "rs":
            return make(tree_sitter_rust(), name: "Rust")
        case "go":
            return make(tree_sitter_go(), name: "Go")
        default:
            return nil
        }
    }

    private static func make(_ parser: OpaquePointer, name: String, bundleName: String? = nil) -> SupportedLanguage {
        SupportedLanguage(language: Language(language: parser), name: name, bundleName: bundleName)
    }
}

final class TreeSitterHighlighter {
    private struct HighlightSpan {
        let name: String
        let range: NSRange
    }

    private enum Palette {
        static let baseForeground = NSColor.white
        static let keyword = NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1)
        static let string = NSColor(red: 0.90, green: 0.56, blue: 0.35, alpha: 1)
        static let comment = NSColor(white: 0.45, alpha: 1)
        static let commentMarker = NSColor(red: 0.92, green: 0.65, blue: 0.35, alpha: 1)
        static let number = NSColor(red: 0.82, green: 0.77, blue: 0.55, alpha: 1)
        static let type = NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1)
        static let function = NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1)
        static let constant = NSColor(red: 0.82, green: 0.77, blue: 0.55, alpha: 1)
        static let operatorToken = NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1)
        static let punctuation = NSColor(white: 0.70, alpha: 1)
        static let attribute = NSColor(red: 0.90, green: 0.56, blue: 0.35, alpha: 1)
        static let tag = NSColor(red: 0.90, green: 0.40, blue: 0.40, alpha: 1)
        static let property = NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1)
        static let constructor = NSColor(red: 0.82, green: 0.77, blue: 0.55, alpha: 1)
        static let parameter = NSColor(red: 0.82, green: 0.60, blue: 0.50, alpha: 1)
        static let label = NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1)
        static let module = NSColor(red: 0.78, green: 0.46, blue: 0.82, alpha: 1)
        static let heading = NSColor(red: 0.90, green: 0.40, blue: 0.40, alpha: 1)
        static let link = NSColor(red: 0.40, green: 0.65, blue: 0.90, alpha: 1)
        static let literal = NSColor(red: 0.90, green: 0.56, blue: 0.35, alpha: 1)
        static let reference = NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1)
        static let emphasis = NSColor(white: 0.85, alpha: 1)
        static let strong = NSColor(white: 0.95, alpha: 1)
        static let escape = NSColor(red: 0.35, green: 0.75, blue: 0.78, alpha: 1)
        static let diagnostic = NSColor.systemRed
    }

    private let baseFont: NSFont
    private let keywordFont: NSFont
    private let titleFont: NSFont
    private let baseAttributes: [NSAttributedString.Key: Any]

    private let parser = Parser()
    private let lang: SupportedLanguage
    private let query: Query?
    private let inlineParser: Parser?
    private let inlineQuery: Query?
    private let parseQueue = DispatchQueue(label: "com.smithers.syntaxHighlight", qos: .userInitiated)
    private var requestID: Int = 0
    private static let maxHighlightCharacters = 200_000
    private static let maxInlineHighlightCharacters = 80_000

    init(language: SupportedLanguage, font: NSFont) {
        self.lang = language
        self.baseFont = font
        self.keywordFont = Self.fontWithWeight(font, weight: .medium)
        self.titleFont = Self.fontWithWeight(font, weight: .bold)
        self.baseAttributes = [
            .foregroundColor: Palette.baseForeground,
            .font: font,
        ]
        try? parser.setLanguage(language.language)

        let config: LanguageConfiguration?
        if let bundleName = language.bundleName {
            config = try? LanguageConfiguration(language.language, name: language.name, bundleName: bundleName)
        } else {
            config = try? LanguageConfiguration(language.language, name: language.name)
        }
        self.query = config?.queries[.highlights]

        if language.name == "Markdown" {
            let inlineLang = Language(language: tree_sitter_markdown_inline())
            let ip = Parser()
            try? ip.setLanguage(inlineLang)
            self.inlineParser = ip
            let inlineConfig = try? LanguageConfiguration(
                inlineLang, name: "MarkdownInline",
                bundleName: "TreeSitterMarkdown_TreeSitterMarkdownInline"
            )
            self.inlineQuery = inlineConfig?.queries[.highlights]
        } else {
            self.inlineParser = nil
            self.inlineQuery = nil
        }
    }

    func highlight(text: String, textView: STTextView) {
        requestID += 1
        let currentID = requestID
        guard let query else { return }
        let source = text
        let length = (source as NSString).length
        if length > Self.maxHighlightCharacters {
            return
        }

        let shouldInline = length <= Self.maxInlineHighlightCharacters

        parseQueue.async { [weak self, weak textView] in
            guard let self else { return }
            guard let tree = self.parser.parse(source) else { return }
            let highlights = self.computeHighlights(tree: tree, query: query, text: source)
            let errorRanges = self.collectErrorRanges(from: tree)
            var inlineHighlights: [HighlightSpan] = []
            if shouldInline, let inlineParser = self.inlineParser, let inlineQuery = self.inlineQuery {
                if let inlineTree = inlineParser.parse(source) {
                    inlineHighlights = self.computeHighlights(tree: inlineTree, query: inlineQuery, text: source)
                }
            }

            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                guard currentID == self.requestID else { return }
                self.applyHighlights(
                    highlights + inlineHighlights,
                    errorRanges: errorRanges,
                    source: source,
                    textView: textView
                )
            }
        }
    }

    private func computeHighlights(tree: MutableTree, query: Query, text: String) -> [HighlightSpan] {
        let cursor = query.execute(in: tree)
        let highlights = cursor
            .resolve(with: .init(string: text))
            .highlights()
        return highlights.map { HighlightSpan(name: $0.name, range: $0.range) }
    }

    private func applyHighlights(
        _ highlights: [HighlightSpan],
        errorRanges: [NSRange],
        source: String,
        textView: STTextView
    ) {
        let fullRange = NSRange(location: 0, length: (source as NSString).length)
        guard let storage = (textView.textContentManager as? NSTextContentStorage)?.textStorage else { return }

        let startTime: CFTimeInterval? = PerformanceMonitor.shared.isActive ? CACurrentMediaTime() : nil
        storage.beginEditing()
        storage.addAttributes(baseAttributes, range: fullRange)
        textView.typingAttributes = baseAttributes

        for highlight in highlights {
            let nsRange = highlight.range
            guard nsRange.location >= 0,
                  nsRange.location + nsRange.length <= fullRange.length
            else { continue }

            if let color = Self.colorForCapture(highlight.name) {
                storage.addAttribute(.foregroundColor, value: color, range: nsRange)
            }
            if let font = fontForCapture(highlight.name) {
                storage.addAttribute(.font, value: font, range: nsRange)
            }
        }

        for range in errorRanges {
            guard range.location >= 0, range.location < fullRange.length else { continue }
            let clampedLength = min(max(1, range.length), fullRange.length - range.location)
            let safeRange = NSRange(location: range.location, length: clampedLength)
            storage.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: safeRange)
            storage.addAttribute(.underlineColor, value: Palette.diagnostic, range: safeRange)
        }

        storage.endEditing()
        if let startTime {
            PerformanceMonitor.shared.recordHighlight(duration: CACurrentMediaTime() - startTime)
        }
    }

    private func collectErrorRanges(from tree: MutableTree) -> [NSRange] {
        guard let root = tree.rootNode else { return [] }
        var ranges: [NSRange] = []
        collectErrorNodes(node: root, ranges: &ranges)
        return ranges
    }

    private func collectErrorNodes(node: Node, ranges: inout [NSRange]) {
        let isError = node.isMissing || node.nodeType == "ERROR"
        if isError {
            ranges.append(node.range)
        }
        guard node.hasError else { return }
        node.enumerateChildren { child in
            if child.hasError || child.isMissing || child.nodeType == "ERROR" {
                collectErrorNodes(node: child, ranges: &ranges)
            }
        }
    }

    private static func colorForCapture(_ name: String) -> NSColor? {
        if name.contains("comment.todo") || name.contains("comment.warning") || name.contains("comment.error") ||
            name.contains("comment.note") {
            return Palette.commentMarker
        }
        if name.contains("string.escape") || name.contains("string.special") {
            return Palette.escape
        }
        if name.contains("keyword.operator") {
            return Palette.operatorToken
        }
        if name.contains("variable.parameter") {
            return Palette.parameter
        }
        if name.contains("variable.member") || name.contains("variable.field") {
            return Palette.property
        }
        if name.contains("constant.builtin") || name.contains("constant.macro") {
            return Palette.constant
        }

        let base = name.components(separatedBy: ".").first ?? name
        switch base {
        case "keyword":
            return Palette.keyword
        case "string":
            return Palette.string
        case "comment":
            return Palette.comment
        case "number", "float", "boolean":
            return Palette.number
        case "type":
            return Palette.type
        case "function", "method":
            return Palette.function
        case "constant":
            return Palette.constant
        case "operator":
            return Palette.operatorToken
        case "punctuation":
            return Palette.punctuation
        case "attribute":
            return Palette.attribute
        case "tag":
            return Palette.tag
        case "property", "field":
            return Palette.property
        case "constructor":
            return Palette.constructor
        case "variable":
            if name == "variable.builtin" || name == "variable.parameter" {
                return Palette.keyword
            }
            return nil
        case "include", "namespace", "module":
            return Palette.module
        case "label":
            return Palette.label
        case "text":
            if name.contains("title") || name.contains("heading") {
                return Palette.heading
            }
            if name.contains("uri") || name.contains("link") {
                return Palette.link
            }
            if name.contains("literal") {
                return Palette.literal
            }
            if name.contains("reference") {
                return Palette.reference
            }
            if name.contains("emphasis") {
                return Palette.emphasis
            }
            if name.contains("strong") {
                return Palette.strong
            }
            return nil
        case "escape":
            return Palette.escape
        case "embedded":
            return nil
        case "parameter":
            return Palette.parameter
        case "preproc":
            return Palette.keyword
        case "define":
            return Palette.keyword
        case "conditional", "repeat", "exception":
            return Palette.keyword
        case "storageclass":
            return Palette.keyword
        case "none":
            return nil
        default:
            return nil
        }
    }

    private func fontForCapture(_ name: String) -> NSFont? {
        let base = name.components(separatedBy: ".").first ?? name
        if base == "keyword" {
            return keywordFont
        }
        if name.contains("title") || name.contains("strong") {
            return titleFont
        }
        return nil
    }

    private static func fontWithWeight(_ base: NSFont, weight: NSFont.Weight) -> NSFont {
        let traits: [NSFontDescriptor.TraitKey: Any] = [
            .weight: weight.rawValue,
        ]
        let descriptor = base.fontDescriptor.addingAttributes([
            .traits: traits,
        ])
        return NSFont(descriptor: descriptor, size: base.pointSize) ?? base
    }
}
