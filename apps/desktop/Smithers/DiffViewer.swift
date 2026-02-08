import SwiftUI

struct DiffViewer: View {
    let title: String
    let summary: String?
    let diff: String
    let document: DiffDocument
    let onOpenInTab: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var selectedFileId: String?
    @State private var wrapLines: Bool = false
    @State private var compactMode: Bool = true
    @State private var hunkIndex: Int = 0
    @State private var scrollTarget: String?

    init(title: String, summary: String?, diff: String, onOpenInTab: (() -> Void)? = nil) {
        self.title = title
        self.summary = summary
        self.diff = diff
        self.onOpenInTab = onOpenInTab
        self.document = DiffParser.parse(diff)
        _selectedFileId = State(initialValue: document.files.first?.id)
    }

    var body: some View {
        VStack(spacing: 0) {
            DiffViewerHeader(
                title: title,
                summary: summary ?? document.summaryText,
                wrapLines: $wrapLines,
                compactMode: $compactMode,
                hunkState: hunkState,
                onJumpPrev: { jumpHunk(-1) },
                onJumpNext: { jumpHunk(1) },
                onOpenInTab: onOpenInTab == nil ? nil : {
                    onOpenInTab?()
                    dismiss()
                },
                onClose: { dismiss() }
            )

            Divider()

            HStack(spacing: 0) {
                DiffFileListView(
                    files: document.files,
                    selectedFileId: $selectedFileId
                )
                .frame(width: 240)

                Divider()

                DiffContentView(
                    document: document,
                    selectedFileId: $selectedFileId,
                    wrapLines: wrapLines,
                    compactMode: compactMode,
                    scrollTarget: $scrollTarget
                )
            }
        }
        .frame(minWidth: 900, minHeight: 600)
    }

    private var hunkAnchors: [HunkAnchor] {
        document.files.flatMap { file in
            file.hunks.enumerated().map { index, _ in
                HunkAnchor(id: "\(file.id)::hunk::\(index)", fileId: file.id)
            }
        }
    }

    private var hunkState: HunkNavigatorState {
        HunkNavigatorState(
            index: hunkAnchors.isEmpty ? 0 : min(hunkIndex, hunkAnchors.count - 1),
            count: hunkAnchors.count
        )
    }

    private func jumpHunk(_ delta: Int) {
        guard !hunkAnchors.isEmpty else { return }
        var next = hunkIndex + delta
        if next < 0 { next = hunkAnchors.count - 1 }
        if next >= hunkAnchors.count { next = 0 }
        hunkIndex = next
        let anchor = hunkAnchors[next]
        selectedFileId = anchor.fileId
        scrollTarget = anchor.id
    }
}

private struct DiffViewerHeader: View {
    let title: String
    let summary: String
    @Binding var wrapLines: Bool
    @Binding var compactMode: Bool
    let hunkState: HunkNavigatorState
    let onJumpPrev: () -> Void
    let onJumpNext: () -> Void
    let onOpenInTab: (() -> Void)?
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                Text(summary)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            HStack(spacing: 6) {
                Button {
                    onJumpPrev()
                } label: {
                    Image(systemName: "chevron.up")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(hunkState.count == 0)

                Button {
                    onJumpNext()
                } label: {
                    Image(systemName: "chevron.down")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(hunkState.count == 0)

                Text(hunkState.label)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 56, alignment: .center)
            }

            Toggle(isOn: $compactMode) {
                Text("Compact")
                    .font(.system(size: 11, weight: .medium))
            }
            .toggleStyle(.switch)

            Toggle(isOn: $wrapLines) {
                Text("Wrap")
                    .font(.system(size: 11, weight: .medium))
            }
            .toggleStyle(.switch)

            if let onOpenInTab {
                Button {
                    onOpenInTab()
                } label: {
                    Label("Full Screen", systemImage: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Open in a new tab")
            }

            Button("Close") {
                onClose()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(12)
        .background(DiffTheme.headerBackground)
    }
}

private struct DiffFileListView: View {
    let files: [DiffFile]
    @Binding var selectedFileId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(files) { file in
                    Button {
                        selectedFileId = file.id
                    } label: {
                        DiffFileRow(file: file, isSelected: selectedFileId == file.id)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
        }
        .background(DiffTheme.sidebarBackground)
    }
}

private struct DiffFileRow: View {
    let file: DiffFile
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(file.status.badge)
                .font(.system(size: 9, weight: .semibold))
                .frame(width: 16, height: 16)
                .background(file.status.badgeColor.opacity(0.25))
                .foregroundStyle(file.status.badgeColor)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(file.displayPath)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(file.summaryText)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(isSelected ? DiffTheme.sidebarSelection : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct DiffContentView: View {
    let document: DiffDocument
    @Binding var selectedFileId: String?
    let wrapLines: Bool
    let compactMode: Bool
    @Binding var scrollTarget: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(document.files) { file in
                        DiffFileSection(file: file, wrapLines: wrapLines, compactMode: compactMode)
                            .id(file.id)
                    }
                }
                .padding(.bottom, 24)
            }
            .background(DiffTheme.canvasBackground)
            .onChange(of: selectedFileId) { _, newValue in
                guard let newValue else { return }
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(newValue, anchor: .top)
                }
            }
            .onChange(of: scrollTarget) { _, newValue in
                guard let newValue else { return }
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(newValue, anchor: .top)
                }
            }
        }
    }
}

private struct DiffFileSection: View {
    let file: DiffFile
    let wrapLines: Bool
    let compactMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DiffFileHeader(file: file)
            ForEach(Array(file.hunks.enumerated()), id: \.element.id) { index, hunk in
                DiffHunkView(
                    hunk: hunk,
                    wrapLines: wrapLines,
                    compactMode: compactMode,
                    anchorId: "\(file.id)::hunk::\(index)"
                )
            }
            Divider()
        }
    }
}

private struct DiffFileHeader: View {
    let file: DiffFile

    var body: some View {
        HStack(spacing: 12) {
            Text(file.displayPath)
                .font(.system(size: 12, weight: .semibold))
            Text(file.summaryText)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 12)
        .background(DiffTheme.fileHeaderBackground)
    }
}

private struct DiffHunkView: View {
    let hunk: DiffHunk
    let wrapLines: Bool
    let compactMode: Bool
    let anchorId: String
    @State private var showAll: Bool = false

    var body: some View {
        let rows = displayRows
        VStack(alignment: .leading, spacing: 0) {
            DiffHunkHeader(text: hunk.header)
            ForEach(rows) { row in
                DiffRowView(
                    row: row,
                    wrapLines: wrapLines,
                    onReveal: {
                        showAll = true
                    }
                )
            }
        }
        .id(anchorId)
    }

    private var displayRows: [DiffRow] {
        if showAll || !compactMode {
            return hunk.rows
        }
        return DiffRowCompactor.compact(rows: hunk.rows, keepHead: 3, keepTail: 3)
    }
}

private struct DiffHunkHeader: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(DiffTheme.hunkText)
            .padding(.vertical, 4)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DiffTheme.hunkBackground)
    }
}

private struct DiffRowView: View {
    let row: DiffRow
    let wrapLines: Bool
    let onReveal: (() -> Void)?

    var body: some View {
        if row.kind == .meta || row.kind == .skip {
            DiffMetaRowView(row: row, onReveal: onReveal)
        } else {
            let inline = DiffHighlighter.highlight(row: row)
            HStack(spacing: 0) {
                DiffSideView(
                    side: row.left,
                    kind: row.kind,
                    wrapLines: wrapLines,
                    isLeft: true,
                    attributedText: inline?.left
                )
                Divider()
                DiffSideView(
                    side: row.right,
                    kind: row.kind,
                    wrapLines: wrapLines,
                    isLeft: false,
                    attributedText: inline?.right
                )
            }
            .background(DiffTheme.rowBackground(for: row.kind))
        }
    }
}

private struct DiffSideView: View {
    let side: DiffSide?
    let kind: DiffRowKind
    let wrapLines: Bool
    let isLeft: Bool
    let attributedText: AttributedString?

    var body: some View {
        HStack(spacing: 8) {
            Text(side?.number.map(String.init) ?? "")
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(DiffTheme.lineNumber)
                .frame(width: 40, alignment: .trailing)

            let text = buildText()

            if wrapLines {
                text
            } else {
                text.fixedSize(horizontal: true, vertical: false)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DiffTheme.sideBackground(for: kind, isLeft: isLeft))
    }

    private func buildText() -> Text {
        if let attributedText {
            return Text(attributedText)
        }
        return Text(side?.text ?? "")
            .font(.system(size: 12, weight: .regular, design: .monospaced))
            .foregroundStyle(DiffTheme.textColor(for: kind, isLeft: isLeft))
    }
}

private struct DiffMetaRowView: View {
    let row: DiffRow
    let onReveal: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Text(row.note ?? row.left?.text ?? "")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(DiffTheme.metaText)
            Spacer()
            if row.kind == .skip, let onReveal {
                Button("Show") {
                    onReveal()
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DiffTheme.metaBackground)
    }
}

private enum DiffRowCompactor {
    static func compact(rows: [DiffRow], keepHead: Int, keepTail: Int) -> [DiffRow] {
        guard keepHead >= 0, keepTail >= 0 else { return rows }
        var result: [DiffRow] = []
        var buffer: [DiffRow] = []

        func flushBuffer() {
            guard !buffer.isEmpty else { return }
            if buffer.count > keepHead + keepTail + 1 {
                let hidden = buffer.count - keepHead - keepTail
                result.append(contentsOf: buffer.prefix(keepHead))
                result.append(
                    DiffRow(
                        kind: .skip,
                        left: DiffSide(number: nil, text: ""),
                        right: nil,
                        note: "\(hidden) unchanged lines"
                    )
                )
                result.append(contentsOf: buffer.suffix(keepTail))
            } else {
                result.append(contentsOf: buffer)
            }
            buffer.removeAll()
        }

        for row in rows {
            if row.kind == .context {
                buffer.append(row)
            } else {
                flushBuffer()
                result.append(row)
            }
        }
        flushBuffer()
        return result
    }
}

private enum DiffHighlighter {
    struct InlinePair {
        let left: AttributedString
        let right: AttributedString
    }

    static func highlight(row: DiffRow) -> InlinePair? {
        guard row.kind == .change,
              let leftText = row.left?.text,
              let rightText = row.right?.text else {
            return nil
        }
        return highlight(left: leftText, right: rightText)
    }

    private static func highlight(left: String, right: String) -> InlinePair? {
        if left.count > 500 || right.count > 500 {
            return nil
        }

        let leftChars = Array(left)
        let rightChars = Array(right)
        let ops = diffOps(left: leftChars, right: rightChars)
        let font = Font.system(size: 12, weight: .regular, design: .monospaced)

        var leftAttributed = AttributedString()
        var rightAttributed = AttributedString()

        var leftSegment = ""
        var rightSegment = ""
        var leftKind: EditKind = .equal
        var rightKind: EditKind = .equal

        func flushLeft() {
            guard !leftSegment.isEmpty else { return }
            leftAttributed.append(makeSegment(leftSegment, kind: leftKind, font: font, isLeft: true))
            leftSegment = ""
        }

        func flushRight() {
            guard !rightSegment.isEmpty else { return }
            rightAttributed.append(makeSegment(rightSegment, kind: rightKind, font: font, isLeft: false))
            rightSegment = ""
        }

        for op in ops {
            switch op {
            case .equal(let ch):
                if leftKind != .equal {
                    flushLeft()
                    leftKind = .equal
                }
                if rightKind != .equal {
                    flushRight()
                    rightKind = .equal
                }
                leftSegment.append(ch)
                rightSegment.append(ch)
            case .delete(let ch):
                if leftKind != .delete {
                    flushLeft()
                    leftKind = .delete
                }
                leftSegment.append(ch)
            case .insert(let ch):
                if rightKind != .insert {
                    flushRight()
                    rightKind = .insert
                }
                rightSegment.append(ch)
            }
        }

        flushLeft()
        flushRight()

        return InlinePair(left: leftAttributed, right: rightAttributed)
    }

    private enum EditOp {
        case equal(Character)
        case delete(Character)
        case insert(Character)
    }

    private enum EditKind {
        case equal
        case delete
        case insert
    }

    private static func diffOps(left: [Character], right: [Character]) -> [EditOp] {
        let m = left.count
        let n = right.count
        var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)

        if m > 0 && n > 0 {
            for i in 1...m {
                for j in 1...n {
                    if left[i - 1] == right[j - 1] {
                        dp[i][j] = dp[i - 1][j - 1] + 1
                    } else {
                        dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
                    }
                }
            }
        }

        var ops: [EditOp] = []
        var i = m
        var j = n
        while i > 0 || j > 0 {
            if i > 0, j > 0, left[i - 1] == right[j - 1] {
                ops.append(.equal(left[i - 1]))
                i -= 1
                j -= 1
            } else if j > 0, i == 0 || dp[i][j - 1] >= dp[i - 1][j] {
                ops.append(.insert(right[j - 1]))
                j -= 1
            } else if i > 0 {
                ops.append(.delete(left[i - 1]))
                i -= 1
            }
        }

        return ops.reversed()
    }

    private static func makeSegment(_ text: String, kind: EditKind, font: Font, isLeft: Bool) -> AttributedString {
        var chunk = AttributedString(text)
        chunk.font = font

        switch kind {
        case .equal:
            chunk.foregroundColor = Color.primary
        case .delete:
            chunk.foregroundColor = isLeft ? DiffTheme.inlineDeleteText : DiffTheme.inlineDeleteText
            chunk.backgroundColor = DiffTheme.inlineDeleteBackground
        case .insert:
            chunk.foregroundColor = isLeft ? DiffTheme.inlineAddText : DiffTheme.inlineAddText
            chunk.backgroundColor = DiffTheme.inlineAddBackground
        }

        return chunk
    }
}

struct DiffTheme {
    static let headerBackground = Color(nsColor: NSColor(red: 0.14, green: 0.15, blue: 0.17, alpha: 1))
    static let sidebarBackground = Color(nsColor: NSColor(red: 0.12, green: 0.13, blue: 0.15, alpha: 1))
    static let sidebarSelection = Color(nsColor: NSColor(red: 0.20, green: 0.22, blue: 0.26, alpha: 1))
    static let canvasBackground = Color(nsColor: NSColor(red: 0.10, green: 0.11, blue: 0.13, alpha: 1))
    static let fileHeaderBackground = Color(nsColor: NSColor(red: 0.16, green: 0.17, blue: 0.20, alpha: 1))
    static let hunkBackground = Color(nsColor: NSColor(red: 0.15, green: 0.18, blue: 0.24, alpha: 1))
    static let hunkText = Color(nsColor: NSColor(red: 0.65, green: 0.75, blue: 0.95, alpha: 1))
    static let lineNumber = Color(nsColor: .secondaryLabelColor)
    static let metaBackground = Color(nsColor: NSColor(red: 0.13, green: 0.14, blue: 0.18, alpha: 1))
    static let metaText = Color(nsColor: NSColor(red: 0.72, green: 0.76, blue: 0.86, alpha: 1))
    static let inlineDeleteBackground = Color(nsColor: NSColor(red: 0.40, green: 0.18, blue: 0.20, alpha: 1))
    static let inlineAddBackground = Color(nsColor: NSColor(red: 0.14, green: 0.36, blue: 0.22, alpha: 1))
    static let inlineDeleteText = Color(nsColor: NSColor(red: 0.98, green: 0.78, blue: 0.78, alpha: 1))
    static let inlineAddText = Color(nsColor: NSColor(red: 0.82, green: 0.98, blue: 0.88, alpha: 1))

    static func rowBackground(for kind: DiffRowKind) -> Color {
        switch kind {
        case .add, .delete, .change:
            return Color.clear
        case .context, .meta, .skip:
            return Color.clear
        }
    }

    static func sideBackground(for kind: DiffRowKind, isLeft: Bool) -> Color {
        switch kind {
        case .add:
            return isLeft ? Color.clear : Color(nsColor: NSColor(red: 0.13, green: 0.26, blue: 0.18, alpha: 1))
        case .delete:
            return isLeft ? Color(nsColor: NSColor(red: 0.29, green: 0.16, blue: 0.18, alpha: 1)) : Color.clear
        case .change:
            return isLeft ? Color(nsColor: NSColor(red: 0.23, green: 0.15, blue: 0.17, alpha: 1)) : Color(nsColor: NSColor(red: 0.12, green: 0.24, blue: 0.18, alpha: 1))
        case .context:
            return Color.clear
        case .meta, .skip:
            return metaBackground
        }
    }

    static func textColor(for kind: DiffRowKind, isLeft: Bool) -> Color {
        switch kind {
        case .add:
            return isLeft ? Color.secondary : Color(nsColor: NSColor(red: 0.73, green: 0.94, blue: 0.78, alpha: 1))
        case .delete:
            return isLeft ? Color(nsColor: NSColor(red: 0.95, green: 0.65, blue: 0.65, alpha: 1)) : Color.secondary
        case .change:
            return isLeft ? Color(nsColor: NSColor(red: 0.95, green: 0.75, blue: 0.75, alpha: 1)) : Color(nsColor: NSColor(red: 0.78, green: 0.96, blue: 0.84, alpha: 1))
        case .context:
            return Color.primary
        case .meta, .skip:
            return Color.secondary
        }
    }
}

struct DiffDocument {
    let files: [DiffFile]

    var totalAdded: Int {
        files.reduce(0) { $0 + $1.added }
    }

    var totalRemoved: Int {
        files.reduce(0) { $0 + $1.removed }
    }

    var summaryText: String {
        "+\(totalAdded) -\(totalRemoved)"
    }
}

struct DiffFile: Identifiable {
    let id: String
    let displayPath: String
    let oldPath: String?
    let newPath: String?
    let status: DiffFileStatus
    let hunks: [DiffHunk]
    let added: Int
    let removed: Int

    var summaryText: String {
        "+\(added) -\(removed)"
    }
}

enum DiffFileStatus {
    case added
    case deleted
    case modified
    case renamed

    var badge: String {
        switch self {
        case .added: return "A"
        case .deleted: return "D"
        case .modified: return "M"
        case .renamed: return "R"
        }
    }

    var badgeColor: Color {
        switch self {
        case .added: return .green
        case .deleted: return .red
        case .modified: return .blue
        case .renamed: return .orange
        }
    }
}

struct DiffHunk: Identifiable {
    let id: UUID = UUID()
    let header: String
    let rows: [DiffRow]
}

struct DiffRow: Identifiable {
    let id: UUID
    let kind: DiffRowKind
    let left: DiffSide?
    let right: DiffSide?
    let note: String?

    init(kind: DiffRowKind, left: DiffSide?, right: DiffSide?, note: String? = nil) {
        self.id = UUID()
        self.kind = kind
        self.left = left
        self.right = right
        self.note = note
    }
}

struct HunkAnchor: Hashable {
    let id: String
    let fileId: String
}

struct HunkNavigatorState {
    let index: Int
    let count: Int

    var label: String {
        guard count > 0 else { return "0/0" }
        return "\(index + 1)/\(count)"
    }
}

struct DiffSide {
    let number: Int?
    let text: String
}

enum DiffRowKind {
    case context
    case add
    case delete
    case change
    case meta
    case skip
}

enum DiffParser {
    static func parse(_ diff: String) -> DiffDocument {
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var files: [DiffFile] = []
        var builder: DiffFileBuilder?
        var hunk: DiffHunkBuilder?

        func flushHunk() {
            guard var file = builder else { return }
            if let hunk = hunk {
                file.hunks.append(hunk.build())
                builder = file
            }
        }

        func flushFile() {
            flushHunk()
            if let file = builder {
                files.append(file.build())
            }
            builder = nil
            hunk = nil
        }

        for line in lines {
            if line.hasPrefix("diff --git ") {
                flushFile()
                let paths = parseDiffGitLine(line)
                builder = DiffFileBuilder(oldPath: paths.oldPath, newPath: paths.newPath)
                continue
            }

            guard var file = builder else { continue }

            if line.hasPrefix("@@") {
                flushHunk()
                let (oldStart, newStart) = parseHunkHeader(line)
                hunk = DiffHunkBuilder(header: line, oldStart: oldStart, newStart: newStart)
                builder = file
                continue
            }

            if line.hasPrefix("new file mode") {
                file.status = .added
                builder = file
                continue
            }

            if line.hasPrefix("deleted file mode") {
                file.status = .deleted
                builder = file
                continue
            }

            if line.hasPrefix("rename from ") {
                file.status = .renamed
                file.oldPath = String(line.dropFirst("rename from ".count))
                builder = file
                continue
            }

            if line.hasPrefix("rename to ") {
                file.status = .renamed
                file.newPath = String(line.dropFirst("rename to ".count))
                builder = file
                continue
            }

            if line.hasPrefix("--- ") {
                let path = String(line.dropFirst(4))
                if path == "/dev/null" {
                    file.status = .added
                } else {
                    file.oldPath = path
                }
                builder = file
                continue
            }

            if line.hasPrefix("+++ ") {
                let path = String(line.dropFirst(4))
                if path == "/dev/null" {
                    file.status = .deleted
                } else {
                    file.newPath = path
                }
                builder = file
                continue
            }

            if var currentHunk = hunk {
                let marker = line.first
                let text = marker == nil ? "" : String(line.dropFirst())
                switch marker {
                case " ":
                    currentHunk.addContext(text: text)
                case "-":
                    currentHunk.addDelete(text: text)
                    file.removed += 1
                case "+":
                    currentHunk.addAdd(text: text)
                    file.added += 1
                case "\\":
                    currentHunk.addMeta(text: line)
                default:
                    currentHunk.addMeta(text: line)
                }
                hunk = currentHunk
                builder = file
                continue
            }

            builder = file
        }

        flushFile()

        if files.isEmpty {
            let trimmed = diff.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let rows = lines.map { line in
                    DiffRow(kind: .meta, left: DiffSide(number: nil, text: line), right: nil, note: nil)
                }
                let hunk = DiffHunk(header: "Diff", rows: rows)
                let fallback = DiffFile(
                    id: "Changes",
                    displayPath: "Changes",
                    oldPath: nil,
                    newPath: nil,
                    status: .modified,
                    hunks: [hunk],
                    added: 0,
                    removed: 0
                )
                return DiffDocument(files: [fallback])
            }
        }

        return DiffDocument(files: files)
    }

    private static func parseDiffGitLine(_ line: String) -> (oldPath: String?, newPath: String?) {
        let rest = line.dropFirst("diff --git ".count)
        let tokens = readDiffTokens(String(rest), maxTokens: 2)
        let oldPath = tokens.first.map(normalizeDiffPath)
        let newPath = tokens.count > 1 ? normalizeDiffPath(tokens[1]) : nil
        return (oldPath, newPath)
    }

    private static func parseHunkHeader(_ line: String) -> (Int, Int) {
        let parts = line.split(separator: " ")
        guard parts.count >= 3 else { return (0, 0) }
        let oldPart = parts[1]
        let newPart = parts[2]
        let oldStart = parseRangeStart(oldPart)
        let newStart = parseRangeStart(newPart)
        return (oldStart, newStart)
    }

    private static func parseRangeStart(_ part: Substring) -> Int {
        let cleaned = part.trimmingCharacters(in: CharacterSet(charactersIn: "+-"))
        let numberText = cleaned.split(separator: ",").first ?? ""
        return Int(numberText) ?? 0
    }

    private static func readDiffTokens(_ line: String, maxTokens: Int) -> [String] {
        var tokens: [String] = []
        var current = ""
        var isQuoted = false
        var escapeNext = false

        for ch in line {
            if escapeNext {
                current.append(ch)
                escapeNext = false
                continue
            }
            if ch == "\\" {
                escapeNext = true
                continue
            }
            if ch == "\"" {
                isQuoted.toggle()
                continue
            }
            if ch == " " && !isQuoted {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                    if tokens.count == maxTokens {
                        break
                    }
                }
                continue
            }
            current.append(ch)
        }

        if !current.isEmpty && tokens.count < maxTokens {
            tokens.append(current)
        }

        return tokens
    }

    fileprivate static func normalizeDiffPath(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        if trimmed.hasPrefix("a/") {
            return String(trimmed.dropFirst(2))
        }
        if trimmed.hasPrefix("b/") {
            return String(trimmed.dropFirst(2))
        }
        return trimmed
    }
}

private struct DiffFileBuilder {
    var oldPath: String?
    var newPath: String?
    var status: DiffFileStatus = .modified
    var hunks: [DiffHunk] = []
    var added: Int = 0
    var removed: Int = 0

    init(oldPath: String?, newPath: String?) {
        self.oldPath = oldPath
        self.newPath = newPath
    }

    func build() -> DiffFile {
        let resolvedOld = DiffParser.normalizeDiffPath(oldPath ?? "")
        let resolvedNew = DiffParser.normalizeDiffPath(newPath ?? "")
        let oldPathValue = resolvedOld.isEmpty ? nil : resolvedOld
        let newPathValue = resolvedNew.isEmpty ? nil : resolvedNew

        let displayPath: String
        if status == .renamed, let old = oldPathValue, let new = newPathValue {
            displayPath = "\(old) → \(new)"
        } else if let newPathValue {
            displayPath = newPathValue
        } else if let oldPathValue {
            displayPath = oldPathValue
        } else {
            displayPath = "Unknown file"
        }

        return DiffFile(
            id: displayPath,
            displayPath: displayPath,
            oldPath: oldPathValue,
            newPath: newPathValue,
            status: status,
            hunks: hunks,
            added: added,
            removed: removed
        )
    }
}

private struct DiffHunkBuilder {
    let header: String
    var oldLine: Int
    var newLine: Int
    var raw: [RawDiffLine] = []

    init(header: String, oldStart: Int, newStart: Int) {
        self.header = header
        self.oldLine = oldStart
        self.newLine = newStart
    }

    mutating func addContext(text: String) {
        raw.append(
            RawDiffLine(kind: .context, leftNumber: oldLine, rightNumber: newLine, text: text)
        )
        oldLine += 1
        newLine += 1
    }

    mutating func addDelete(text: String) {
        raw.append(
            RawDiffLine(kind: .delete, leftNumber: oldLine, rightNumber: nil, text: text)
        )
        oldLine += 1
    }

    mutating func addAdd(text: String) {
        raw.append(
            RawDiffLine(kind: .add, leftNumber: nil, rightNumber: newLine, text: text)
        )
        newLine += 1
    }

    mutating func addMeta(text: String) {
        raw.append(
            RawDiffLine(kind: .meta, leftNumber: nil, rightNumber: nil, text: text)
        )
    }

    func build() -> DiffHunk {
        DiffHunk(header: header, rows: DiffRowMerger.merge(raw: raw))
    }
}

private struct RawDiffLine {
    let kind: DiffRowKind
    let leftNumber: Int?
    let rightNumber: Int?
    let text: String
}

private enum DiffRowMerger {
    static func merge(raw: [RawDiffLine]) -> [DiffRow] {
        var rows: [DiffRow] = []
        var index = 0

        while index < raw.count {
            let line = raw[index]
            switch line.kind {
            case .delete:
                var deletes: [RawDiffLine] = []
                while index < raw.count, raw[index].kind == .delete {
                    deletes.append(raw[index])
                    index += 1
                }

                var adds: [RawDiffLine] = []
                var addIndex = index
                while addIndex < raw.count, raw[addIndex].kind == .add {
                    adds.append(raw[addIndex])
                    addIndex += 1
                }

                if !adds.isEmpty {
                    index = addIndex
                    let maxCount = max(deletes.count, adds.count)
                    for i in 0..<maxCount {
                        let left = i < deletes.count ? DiffSide(number: deletes[i].leftNumber, text: deletes[i].text) : nil
                        let right = i < adds.count ? DiffSide(number: adds[i].rightNumber, text: adds[i].text) : nil
                        let kind: DiffRowKind
                        if left != nil && right != nil {
                            kind = .change
                        } else if left != nil {
                            kind = .delete
                        } else {
                            kind = .add
                        }
                        rows.append(DiffRow(kind: kind, left: left, right: right))
                    }
                } else {
                    for delete in deletes {
                        rows.append(
                            DiffRow(
                                kind: .delete,
                                left: DiffSide(number: delete.leftNumber, text: delete.text),
                                right: nil
                            )
                        )
                    }
                }
            case .add:
                rows.append(
                    DiffRow(
                        kind: .add,
                        left: nil,
                        right: DiffSide(number: line.rightNumber, text: line.text)
                    )
                )
                index += 1
            case .context:
                rows.append(
                    DiffRow(
                        kind: .context,
                        left: DiffSide(number: line.leftNumber, text: line.text),
                        right: DiffSide(number: line.rightNumber, text: line.text)
                    )
                )
                index += 1
            case .meta:
                rows.append(
                    DiffRow(
                        kind: .meta,
                        left: DiffSide(number: nil, text: line.text),
                        right: nil
                    )
                )
                index += 1
            case .change, .skip:
                rows.append(
                    DiffRow(
                        kind: line.kind,
                        left: DiffSide(number: line.leftNumber, text: line.text),
                        right: DiffSide(number: line.rightNumber, text: line.text)
                    )
                )
                index += 1
            }
        }

        return rows
    }
}
