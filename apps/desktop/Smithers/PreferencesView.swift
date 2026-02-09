import SwiftUI
import AppKit

struct PreferencesView: View {
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        Form {
            Section("Editor") {
                Picker("Font", selection: $workspace.editorFontName) {
                    ForEach(workspace.availableEditorFonts, id: \.self) { name in
                        Text(displayName(for: name))
                            .tag(name)
                    }
                }
                HStack {
                    Text("Size")
                    Spacer()
                    Stepper(
                        value: $workspace.editorFontSize,
                        in: WorkspaceState.minEditorFontSize...WorkspaceState.maxEditorFontSize,
                        step: 1
                    ) {
                        Text("\(Int(workspace.editorFontSize)) pt")
                            .font(.system(size: Typography.base, weight: .semibold))
                    }
                }
                Picker("Scrollbar", selection: $workspace.scrollbarVisibilityMode) {
                    ForEach(ScrollbarVisibilityMode.allCases) { mode in
                        Text(mode.label)
                            .tag(mode)
                    }
                }
            }

            Section("Neovim") {
                HStack(spacing: 8) {
                    TextField("/path/to/nvim", text: $workspace.preferredNvimPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: Typography.base, design: .monospaced))
                    Button("Choose...") {
                        workspace.chooseNvimPath()
                    }
                }
                HStack {
                    Text(workspace.nvimPathStatusMessage)
                        .font(.system(size: Typography.s))
                        .foregroundStyle(workspace.nvimPathStatusIsError ? Color.red : Color.secondary)
                    Spacer()
                    Button("Use Default") {
                        workspace.clearNvimPath()
                    }
                }
            }

            Section("Keys") {
                Picker("Option as Meta", selection: $workspace.optionAsMeta) {
                    ForEach(OptionAsMeta.allCases) { option in
                        Text(option.label)
                            .tag(option)
                    }
                }
                .pickerStyle(.segmented)
            }
        }
        .padding(20)
        .frame(width: 520, height: 360)
    }

    private func displayName(for name: String) -> String {
        if let font = NSFont(name: name, size: 12) {
            return font.displayName ?? name
        }
        return name
    }
}
