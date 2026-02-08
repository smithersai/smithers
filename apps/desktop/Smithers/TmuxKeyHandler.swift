import AppKit
import Foundation
import Dispatch

final class TmuxKeyHandler {
    private weak var workspace: WorkspaceState?
    private var monitor: Any?
    private var prefixActive = false
    private var prefixResetItem: DispatchWorkItem?
    private let prefixTimeout: TimeInterval = 1.0

    init(workspace: WorkspaceState) {
        self.workspace = workspace
    }

    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            return self?.handle(event) ?? event
        }
    }

    func remove() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
        if isPrefix(event) {
            activatePrefix()
            return nil
        }

        guard prefixActive else { return event }
        prefixActive = false
        prefixResetItem?.cancel()
        prefixResetItem = nil

        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if mods.contains(.command) || mods.contains(.option) {
            return event
        }

        let rawChars = event.characters ?? ""
        let chars = event.charactersIgnoringModifiers ?? rawChars
        let key = chars.lowercased()

        if rawChars == "&" {
            trigger { $0.closeSelectedTab() }
            return nil
        }

        switch key {
        case "c":
            trigger { $0.openTerminal() }
            return nil
        case "n":
            trigger { $0.selectNextTab() }
            return nil
        case "p":
            trigger { $0.selectPreviousTab() }
            return nil
        case "1", "2", "3", "4", "5", "6", "7", "8", "9":
            if let index = Int(key) {
                trigger { $0.selectTab(index: index - 1) }
                return nil
            }
            return event
        case "0":
            trigger { $0.selectTab(index: 9) }
            return nil
        default:
            return nil
        }
    }

    private func isPrefix(_ event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard mods.contains(.control), !mods.contains(.command), !mods.contains(.option), !mods.contains(.shift) else {
            return false
        }
        guard let chars = event.charactersIgnoringModifiers?.lowercased() else { return false }
        return chars == "b"
    }

    private func activatePrefix() {
        prefixActive = true
        prefixResetItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.prefixActive = false
        }
        prefixResetItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + prefixTimeout, execute: item)
    }

    private func trigger(_ action: @MainActor @escaping (WorkspaceState) -> Void) {
        guard let workspace else { return }
        Task { @MainActor in
            action(workspace)
        }
    }
}
