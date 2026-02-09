import AppKit
import STTextView

final class MultiCursorTextView: STTextView {
    private struct RangeKey: Hashable {
        let location: Int
        let length: Int
    }

    override func mouseDown(with event: NSEvent) {
        if inputContext?.handleEvent(event) == true {
            return
        }

        guard isSelectable, event.type == .leftMouseDown else {
            super.mouseDown(with: event)
            return
        }

        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == [.option] {
            let point = convert(event.locationInWindow, from: nil)
            if addInsertionPoint(at: point) {
                return
            }
        }

        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if handleMultiCursorKeyDown(event) {
            return
        }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if handleMultiCursorKeyEquivalent(event) {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        groupedUndoIfNeeded {
            super.insertText(string, replacementRange: replacementRange)
        }
    }

    override func deleteBackward(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteBackward(sender)
        }
    }

    override func deleteForward(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteForward(sender)
        }
    }

    override func deleteBackwardByDecomposingPreviousCharacter(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteBackwardByDecomposingPreviousCharacter(sender)
        }
    }

    override func deleteWordBackward(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteWordBackward(sender)
        }
    }

    override func deleteWordForward(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteWordForward(sender)
        }
    }

    override func deleteToBeginningOfLine(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteToBeginningOfLine(sender)
        }
    }

    override func deleteToEndOfLine(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteToEndOfLine(sender)
        }
    }

    override func deleteToBeginningOfParagraph(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteToBeginningOfParagraph(sender)
        }
    }

    override func deleteToEndOfParagraph(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.deleteToEndOfParagraph(sender)
        }
    }

    override func delete(_ sender: Any?) {
        groupedUndoIfNeeded {
            super.delete(sender)
        }
    }

    override func copy(_ sender: Any?) {
        let ranges = selectionRanges()
        guard ranges.count > 1 else {
            super.copy(sender)
            return
        }

        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()

        let fullText = attributedString()
        var items: [NSPasteboardItem] = []
        items.reserveCapacity(ranges.count)

        for range in ranges {
            let substring = range.length > 0 ? fullText.attributedSubstring(from: range) : NSAttributedString(string: "")
            let item = NSPasteboardItem()
            if let rtf = substring.rtf(from: NSRange(location: 0, length: substring.length)) {
                item.setData(rtf, forType: .rtf)
            }
            item.setString(substring.string, forType: .string)
            items.append(item)
        }

        pasteboard.writeObjects(items)
    }

    override func paste(_ sender: Any?) {
        if !handleDistributedPaste(preferRichText: true) {
            super.paste(sender)
        }
    }

    override func pasteAsPlainText(_ sender: Any?) {
        if !handleDistributedPaste(preferRichText: false) {
            super.pasteAsPlainText(sender)
        }
    }

    override func pasteAsRichText(_ sender: Any?) {
        if !handleDistributedPaste(preferRichText: true) {
            super.pasteAsRichText(sender)
        }
    }

    private func handleMultiCursorKeyDown(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == [] && event.charactersIgnoringModifiers == "\u{1b}" {
            if collapseToSingleCursor() {
                return true
            }
        }

        if flags.contains(.option), flags.contains(.shift), !flags.contains(.command), !flags.contains(.control) {
            let characters = event.charactersIgnoringModifiers ?? ""
            let upArrow = String(UnicodeScalar(UInt32(NSUpArrowFunctionKey))!)
            let downArrow = String(UnicodeScalar(UInt32(NSDownArrowFunctionKey))!)
            if characters == upArrow {
                return addCursorOnAdjacentLine(direction: -1)
            }
            if characters == downArrow {
                return addCursorOnAdjacentLine(direction: 1)
            }
        }

        return false
    }

    private func handleMultiCursorKeyEquivalent(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard let characters = event.charactersIgnoringModifiers?.lowercased() else { return false }

        if flags == [.command], characters == "d" {
            return selectNextOccurrence()
        }

        if flags == [.command, .shift], characters == "l" {
            return selectAllOccurrences()
        }

        return false
    }

    private func groupedUndoIfNeeded(_ action: () -> Void) {
        let shouldGroup = selectionRanges().count > 1
        if shouldGroup {
            breakUndoCoalescing()
            undoManager?.beginUndoGrouping()
        }
        action()
        if shouldGroup {
            undoManager?.endUndoGrouping()
            breakUndoCoalescing()
        }
    }

    private func selectionRanges() -> [NSRange] {
        textLayoutManager.textSelections.flatMap { selection in
            selection.textRanges.map { NSRange($0, in: textContentManager) }
        }
    }

    private func primarySelectionRange() -> NSRange? {
        guard let selection = textLayoutManager.textSelections.last,
              let textRange = selection.textRanges.last
        else { return nil }
        return NSRange(textRange, in: textContentManager)
    }

    private func applySelections(_ ranges: [NSRange], primaryRange: NSRange?) {
        let textLength = attributedString().length
        var sanitized: [NSRange] = []
        sanitized.reserveCapacity(ranges.count)

        for range in ranges {
            guard range.location != NSNotFound else { continue }
            let clampedLocation = min(max(0, range.location), textLength)
            let maxLength = max(0, textLength - clampedLocation)
            let clampedLength = min(max(0, range.length), maxLength)
            sanitized.append(NSRange(location: clampedLocation, length: clampedLength))
        }

        let deduped = dedupeRanges(sanitized, keepLast: true)
        guard !deduped.isEmpty else { return }

        var ordered = deduped
        if let primaryRange,
           let idx = ordered.firstIndex(where: { $0.location == primaryRange.location && $0.length == primaryRange.length }) {
            let primary = ordered.remove(at: idx)
            ordered.append(primary)
        }

        if let primary = ordered.last,
           let textRange = NSTextRange(primary, in: textContentManager) {
            setSelectedTextRange(textRange)
        }

        let selections = ordered.compactMap { range -> NSTextSelection? in
            guard let textRange = NSTextRange(range, in: textContentManager) else { return nil }
            return NSTextSelection(range: textRange, affinity: .downstream, granularity: .character)
        }

        guard !selections.isEmpty else { return }
        textLayoutManager.textSelections = selections
        needsLayout = true
        needsDisplay = true
    }

    private func dedupeRanges(_ ranges: [NSRange], keepLast: Bool) -> [NSRange] {
        var seenEmpty: Set<Int> = []
        var seenRanges: Set<RangeKey> = []
        var output: [NSRange] = []

        let sequence = keepLast ? ranges.reversed() : ranges
        for range in sequence {
            if range.length == 0 {
                if seenEmpty.contains(range.location) { continue }
                seenEmpty.insert(range.location)
            } else {
                let key = RangeKey(location: range.location, length: range.length)
                if seenRanges.contains(key) { continue }
                seenRanges.insert(key)
            }
            output.append(range)
        }

        if keepLast {
            output.reverse()
        }

        return output
    }

    private func addInsertionPoint(at point: CGPoint) -> Bool {
        guard let location = textLayoutManager.location(
            interactingAt: point,
            inContainerAt: textLayoutManager.documentRange.location
        ), let textRange = NSTextRange(location: location, end: location) else {
            return false
        }

        let newRange = NSRange(textRange, in: textContentManager)
        var ranges = selectionRanges()
        ranges.append(newRange)
        applySelections(ranges, primaryRange: newRange)
        return true
    }

    private func collapseToSingleCursor() -> Bool {
        guard selectionRanges().count > 1,
              let primary = primarySelectionRange()
        else { return false }

        let insertion = primary.location + primary.length
        let collapsed = NSRange(location: insertion, length: 0)
        applySelections([collapsed], primaryRange: collapsed)
        return true
    }

    private func selectNextOccurrence() -> Bool {
        guard let baseRange = primarySelectionRange() else { return false }

        if baseRange.length == 0 {
            if selectionRanges().count == 1, selectWordAtPrimary() {
                return true
            }
            return false
        }

        let fullText = attributedString().string as NSString
        let needle = fullText.substring(with: baseRange)
        guard !needle.isEmpty else { return false }

        let existing = selectionRanges()
        let startLocation = baseRange.location + baseRange.length
        guard let nextRange = findNextOccurrence(
            needle: needle,
            in: fullText,
            startLocation: startLocation,
            skipping: existing
        ) else { return false }

        var ranges = existing
        ranges.append(nextRange)
        applySelections(ranges, primaryRange: nextRange)
        return true
    }

    private func selectAllOccurrences() -> Bool {
        guard var baseRange = primarySelectionRange() else { return false }
        if baseRange.length == 0 {
            guard selectionRanges().count == 1,
                  let wordRange = wordRangeForPrimarySelection()
            else { return false }
            baseRange = wordRange
        }

        let fullText = attributedString().string as NSString
        let needle = fullText.substring(with: baseRange)
        guard !needle.isEmpty else { return false }

        var ranges: [NSRange] = []
        var searchRange = NSRange(location: 0, length: fullText.length)
        while true {
            let found = fullText.range(of: needle, options: [], range: searchRange)
            if found.location == NSNotFound {
                break
            }
            ranges.append(found)
            let nextLocation = found.location + max(found.length, 1)
            if nextLocation >= fullText.length {
                break
            }
            searchRange = NSRange(location: nextLocation, length: fullText.length - nextLocation)
        }

        guard !ranges.isEmpty else { return false }
        applySelections(ranges, primaryRange: baseRange)
        return true
    }

    private func selectWordAtPrimary() -> Bool {
        guard let wordRange = wordRangeForPrimarySelection(),
              let textRange = NSTextRange(wordRange, in: textContentManager)
        else { return false }
        setSelectedTextRange(textRange)
        return true
    }

    private func wordRangeForPrimarySelection() -> NSRange? {
        guard let primarySelection = textLayoutManager.textSelections.last,
              let wordSelection = textLayoutManager.textSelectionNavigation.textSelection(for: .word, enclosing: primarySelection),
              let textRange = wordSelection.textRanges.first
        else { return nil }
        return NSRange(textRange, in: textContentManager)
    }

    private func findNextOccurrence(
        needle: String,
        in text: NSString,
        startLocation: Int,
        skipping ranges: [NSRange]
    ) -> NSRange? {
        let length = text.length
        guard length > 0 else { return nil }
        let skip = ranges

        func isSkipped(_ range: NSRange) -> Bool {
            skip.contains { NSIntersectionRange($0, range).length > 0 }
        }

        var searchStart = min(max(0, startLocation), length)
        while searchStart < length {
            let searchRange = NSRange(location: searchStart, length: length - searchStart)
            let found = text.range(of: needle, options: [], range: searchRange)
            if found.location == NSNotFound {
                break
            }
            if !isSkipped(found) {
                return found
            }
            searchStart = found.location + max(found.length, 1)
        }

        var wrapStart = 0
        let wrapLimit = min(startLocation, length)
        while wrapStart < wrapLimit {
            let searchRange = NSRange(location: wrapStart, length: wrapLimit - wrapStart)
            let found = text.range(of: needle, options: [], range: searchRange)
            if found.location == NSNotFound {
                break
            }
            if !isSkipped(found) {
                return found
            }
            wrapStart = found.location + max(found.length, 1)
        }

        return nil
    }

    private func addCursorOnAdjacentLine(direction: Int) -> Bool {
        let fullText = attributedString().string as NSString
        let selections = textLayoutManager.textSelections
        guard !selections.isEmpty else { return false }

        var ranges = selectionRanges()
        var newRanges: [NSRange] = []

        for selection in selections {
            for textRange in selection.textRanges {
                let nsRange = NSRange(textRange, in: textContentManager)
                let insertionLocation = selection.affinity == .upstream
                    ? nsRange.location
                    : nsRange.location + nsRange.length
                if let newLocation = adjacentLineLocation(from: insertionLocation, direction: direction, text: fullText) {
                    newRanges.append(NSRange(location: newLocation, length: 0))
                }
            }
        }

        guard !newRanges.isEmpty else { return false }
        ranges.append(contentsOf: newRanges)
        applySelections(ranges, primaryRange: newRanges.last)
        return true
    }

    private func adjacentLineLocation(from location: Int, direction: Int, text: NSString) -> Int? {
        let textLength = text.length
        let clamped = min(max(0, location), textLength)
        let lineRange = text.lineRange(for: NSRange(location: clamped, length: 0))
        let column = clamped - lineRange.location

        if direction < 0 {
            guard lineRange.location > 0 else { return nil }
            let prevIndex = max(0, lineRange.location - 1)
            let prevLineRange = text.lineRange(for: NSRange(location: prevIndex, length: 0))
            let lineEnd = max(prevLineRange.location, NSMaxRange(prevLineRange) - 1)
            return min(prevLineRange.location + column, lineEnd)
        }

        let nextIndex = NSMaxRange(lineRange)
        guard nextIndex < textLength else { return nil }
        let nextLineRange = text.lineRange(for: NSRange(location: nextIndex, length: 0))
        let lineEnd = max(nextLineRange.location, NSMaxRange(nextLineRange) - 1)
        return min(nextLineRange.location + column, lineEnd)
    }

    private func handleDistributedPaste(preferRichText: Bool) -> Bool {
        let ranges = selectionRanges()
        guard ranges.count > 1 else { return false }
        guard let items = NSPasteboard.general.pasteboardItems, items.count > 1 else { return false }

        var payloads: [String] = []
        payloads.reserveCapacity(items.count)

        for item in items {
            if preferRichText, let data = item.data(forType: .rtf),
               let attributed = NSAttributedString(rtf: data, documentAttributes: nil) {
                payloads.append(attributed.string)
                continue
            }
            if let string = item.string(forType: .string) {
                payloads.append(string)
            }
        }

        guard !payloads.isEmpty else { return false }

        let orderedRanges = ranges.sorted { $0.location < $1.location }
        var replacements: [(NSTextRange, String)] = []
        replacements.reserveCapacity(orderedRanges.count)

        for (idx, range) in orderedRanges.enumerated() {
            guard let textRange = NSTextRange(range, in: textContentManager) else { continue }
            let payload = payloads[idx % payloads.count]
            replacements.append((textRange, payload))
        }

        guard !replacements.isEmpty else { return false }

        for (textRange, payload) in replacements {
            if !shouldChangeText(in: textRange, replacementString: payload) {
                return true
            }
        }

        groupedUndoIfNeeded {
            for (textRange, payload) in replacements.sorted(by: { $0.0.location > $1.0.location }) {
                replaceCharacters(in: textRange, with: payload)
            }
        }

        return true
    }
}
