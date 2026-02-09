import SwiftUI

private struct ShortcutContextState: Hashable {
    let prefixActive: Bool
    let commandPaletteOpen: Bool
    let searchOpen: Bool
    let nvimEnabled: Bool
    let nvimMode: NvimModeKind

    var primaryCategory: ShortcutCategory? {
        if prefixActive { return .tabs }
        if commandPaletteOpen { return .commandPalette }
        if searchOpen { return .search }
        if nvimEnabled { return .neovim }
        return nil
    }

    var activeCategories: Set<ShortcutCategory> {
        guard let primaryCategory else { return [] }
        return [primaryCategory]
    }

    var animationKey: String {
        [
            prefixActive ? "prefix" : "",
            commandPaletteOpen ? "palette" : "",
            searchOpen ? "search" : "",
            nvimEnabled ? "nvim" : "",
            nvimEnabled ? nvimMode.rawValue : "",
        ]
        .joined(separator: ":")
    }
}

private struct ShortcutSection: Identifiable {
    let id: ShortcutCategory
    let title: String
    let entries: [ShortcutEntry]
    let isActive: Bool
    let isDimmed: Bool
}

struct KeyboardShortcutsPanel: View {
    @ObservedObject var workspace: WorkspaceState
    @ObservedObject var tmuxKeyHandler: TmuxKeyHandler
    @State private var prefixPulse = false

    var body: some View {
        let theme = workspace.theme
        let context = ShortcutContextState(
            prefixActive: tmuxKeyHandler.prefixActive,
            commandPaletteOpen: workspace.isCommandPalettePresented,
            searchOpen: workspace.isSearchPresented,
            nvimEnabled: workspace.isNvimModeEnabled,
            nvimMode: workspace.nvimMode
        )
        let sections = buildSections(context: context)

        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Shortcuts")
                    .font(.system(size: Typography.base, weight: .semibold))
                    .foregroundStyle(theme.mutedForegroundColor.opacity(0.85))
                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(section.title)
                            .font(.system(size: Typography.s, weight: .semibold))
                            .foregroundStyle(theme.mutedForegroundColor.opacity(0.8))
                            .scaleEffect(section.id == .tabs && prefixPulse ? 1.05 : 1.0)
                        ForEach(section.entries) { entry in
                            ShortcutRow(entry: entry, theme: theme)
                        }
                    }
                    .opacity(section.isDimmed ? 0.3 : 1.0)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.panelBackgroundColor)
        .accessibilityIdentifier("KeyboardShortcutsPanel")
        .onChange(of: tmuxKeyHandler.prefixActive) { _, active in
            guard active else { return }
            withAnimation(.easeOut(duration: 0.12)) {
                prefixPulse = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                withAnimation(.easeOut(duration: 0.2)) {
                    prefixPulse = false
                }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: context.animationKey)
    }

    private func buildSections(context: ShortcutContextState) -> [ShortcutSection] {
        let activeCategories = context.activeCategories
        let visibleEntries = ShortcutCatalog.entries.filter { entry in
            switch entry.context {
            case .always:
                return true
            case .prefixActive:
                return true
            case .commandPaletteOpen:
                return context.commandPaletteOpen
            case .searchOpen:
                return context.searchOpen
            case .neovimMode(let mode):
                return context.nvimEnabled && context.nvimMode == mode
            }
        }

        var entriesByCategory: [ShortcutCategory: [ShortcutEntry]] = [:]
        for entry in visibleEntries {
            entriesByCategory[entry.category, default: []].append(entry)
        }

        var categories = ShortcutCategory.ordered.filter { entriesByCategory[$0] != nil }
        if !activeCategories.isEmpty {
            let activeOrder: [ShortcutCategory] = [.commandPalette, .search, .tabs, .neovim, .general]
            let activeIndex: [ShortcutCategory: Int] = Dictionary(
                uniqueKeysWithValues: activeOrder.enumerated().map { ($0.element, $0.offset) }
            )
            let baseIndex: [ShortcutCategory: Int] = Dictionary(
                uniqueKeysWithValues: ShortcutCategory.ordered.enumerated().map { ($0.element, $0.offset) }
            )
            categories.sort { lhs, rhs in
                let lhsActive = activeCategories.contains(lhs)
                let rhsActive = activeCategories.contains(rhs)
                if lhsActive != rhsActive {
                    return lhsActive
                }
                if lhsActive {
                    return (activeIndex[lhs] ?? 0) < (activeIndex[rhs] ?? 0)
                }
                return (baseIndex[lhs] ?? 0) < (baseIndex[rhs] ?? 0)
            }
        }

        let hasActive = !activeCategories.isEmpty
        return categories.compactMap { category in
            guard let entries = entriesByCategory[category], !entries.isEmpty else { return nil }
            let isActive = activeCategories.contains(category)
            let isDimmed = hasActive && !isActive
            return ShortcutSection(
                id: category,
                title: sectionTitle(for: category, context: context),
                entries: entries,
                isActive: isActive,
                isDimmed: isDimmed
            )
        }
    }

    private func sectionTitle(for category: ShortcutCategory, context: ShortcutContextState) -> String {
        switch category {
        case .tabs:
            return "Tabs (⌃B+)"
        case .neovim:
            return "Neovim (\(context.nvimMode.displayName))"
        default:
            return category.rawValue
        }
    }
}

private struct ShortcutRow: View {
    let entry: ShortcutEntry
    let theme: AppTheme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(entry.keys)
                .font(.system(size: Typography.s, weight: .medium, design: .monospaced))
                .foregroundStyle(theme.foregroundColor.opacity(0.75))
                .frame(minWidth: 48, alignment: .leading)
            Text(entry.label)
                .font(.system(size: Typography.s, weight: .regular))
                .foregroundStyle(theme.mutedForegroundColor.opacity(0.7))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
    }
}
