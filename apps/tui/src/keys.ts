/**
 * The TUI key contract. Keep labels short: this registry feeds the footer,
 * the which-key panel, the home screen, and the generated key list.
 */

export type KeyContext =
  | "global"
  | "composer"
  | "working"
  | "shell"
  | "panel"
  | "picker"
  | "form"
  | "approval"
  | "selection"
  | "completion"

export interface Binding {
  readonly id: string
  /** Alternative spellings for one action. */
  readonly keys: ReadonlyArray<string>
  /** How the popup and footer spell a long key list. */
  readonly display?: string
  /** One to three words. */
  readonly label: string
  readonly context: KeyContext
  readonly group: string
}

/** The keys the application handles. Text input is intentionally not listed. */
export const registry: ReadonlyArray<Binding> = [
  // Always available while the composer owns the screen.
  { id: "keys", keys: ["?"], label: "Keys", context: "global", group: "Global" },
  { id: "clear", keys: ["ctrl+c"], label: "Clear", context: "global", group: "Global" },
  { id: "exit", keys: ["ctrl+d"], label: "Exit", context: "global", group: "Global" },
  { id: "timeline", keys: ["ctrl+t"], label: "Timeline", context: "global", group: "Global" },
  { id: "expand", keys: ["ctrl+o"], label: "Expand", context: "global", group: "Global" },
  { id: "editor", keys: ["ctrl+g"], label: "Edit prompt", context: "global", group: "Global" },
  { id: "palette", keys: ["ctrl+k"], label: "Search", context: "global", group: "Global" },
  { id: "summary", keys: ["ctrl+s"], label: "Summary", context: "global", group: "Tabs" },
  // Ctrl+Left/Right stay as aliases; macOS takes them for Spaces by default.
  { id: "next-tab", keys: ["ctrl+]", "ctrl+right"], label: "Next tab", context: "global", group: "Tabs" },
  { id: "previous-tab", keys: ["ctrl+\\", "ctrl+left"], label: "Previous tab", context: "global", group: "Tabs" },
  { id: "scroll", keys: ["pageup", "pagedown"], label: "Scroll", context: "global", group: "Global" },
  { id: "scroll-line", keys: ["shift+up", "shift+down"], display: "shift+↑/↓", label: "Scroll a line", context: "global", group: "Global" },

  { id: "send", keys: ["enter"], label: "Send", context: "composer", group: "Composer" },
  { id: "queue", keys: ["alt+enter"], label: "Queue", context: "composer", group: "Composer" },
  { id: "restore", keys: ["alt+up"], label: "Restore queue", context: "composer", group: "Composer" },
  { id: "newline", keys: ["shift+enter", "ctrl+j", "linefeed"], label: "New line", context: "composer", group: "Composer" },
  { id: "history", keys: ["up", "down"], label: "History", context: "composer", group: "Composer" },
  { id: "model", keys: ["ctrl+l"], label: "Pick model", context: "composer", group: "Composer" },
  { id: "next-model", keys: ["ctrl+p"], label: "Next model", context: "composer", group: "Composer" },
  { id: "previous-model", keys: ["ctrl+shift+p"], label: "Previous model", context: "composer", group: "Composer" },
  { id: "thinking", keys: ["shift+tab"], label: "Thinking level", context: "composer", group: "Composer" },
  { id: "commands", keys: ["/"], label: "Commands", context: "composer", group: "Composer" },
  { id: "mention", keys: ["@"], label: "Mention file", context: "composer", group: "Composer" },
  { id: "shell-input", keys: ["!"], label: "Shell mode", context: "composer", group: "Composer" },

  { id: "steer", keys: ["enter"], label: "Steer", context: "working", group: "Working" },
  { id: "queue-working", keys: ["alt+enter"], label: "Queue", context: "working", group: "Working" },
  { id: "restore-working", keys: ["alt+up"], label: "Restore queue", context: "working", group: "Working" },
  { id: "interrupt", keys: ["esc"], label: "Interrupt", context: "working", group: "Working" },

  { id: "run-shell", keys: ["enter"], label: "Run command", context: "shell", group: "Shell" },
  { id: "cancel-shell", keys: ["esc"], label: "Cancel", context: "shell", group: "Shell" },

  { id: "close-panel", keys: ["esc"], label: "Chat", context: "panel", group: "Panel" },
  { id: "focus-composer", keys: ["i"], label: "Composer", context: "panel", group: "Panel" },
  { id: "navigate", keys: ["j", "k", "h", "l", "up", "down", "left", "right"], display: "hjkl/arrows", label: "Navigate", context: "panel", group: "Panel" },
  { id: "expand-row", keys: ["enter", "space"], label: "Expand row", context: "panel", group: "Panel" },
  { id: "diff", keys: ["d"], label: "Toggle diff", context: "panel", group: "Panel" },
  { id: "split", keys: ["v"], label: "Split diff", context: "panel", group: "Panel" },
  { id: "retry", keys: ["r"], label: "Retry", context: "panel", group: "Panel" },
  { id: "stop", keys: ["x"], label: "Stop", context: "panel", group: "Panel" },
  { id: "approve-form", keys: ["a"], label: "Action", context: "panel", group: "Panel" },
  { id: "undo", keys: ["u"], label: "Undo changes", context: "panel", group: "Panel" },
  { id: "next-panel-tab", keys: ["tab"], label: "Next tab", context: "panel", group: "Tabs" },

  { id: "close-picker", keys: ["esc"], label: "Close", context: "picker", group: "Picker" },
  { id: "pick-move", keys: ["up", "down", "ctrl+p", "ctrl+n"], display: "up/down", label: "Move", context: "picker", group: "Picker" },
  { id: "pick-page", keys: ["pageup", "pagedown"], label: "Page", context: "picker", group: "Picker" },
  { id: "pick", keys: ["enter"], label: "Choose", context: "picker", group: "Picker" },

  { id: "close-form", keys: ["esc"], label: "Close", context: "form", group: "Form" },
  { id: "next-field", keys: ["tab", "down"], label: "Next field", context: "form", group: "Form" },
  { id: "previous-field", keys: ["shift+tab", "up"], label: "Previous field", context: "form", group: "Form" },
  { id: "toggle-field", keys: ["space"], label: "Toggle", context: "form", group: "Form" },
  { id: "choose-field", keys: ["left", "right"], label: "Choose", context: "form", group: "Form" },
  { id: "run-form", keys: ["enter"], label: "Run", context: "form", group: "Form" },

  { id: "allow", keys: ["y"], label: "Allow", context: "approval", group: "Approval" },
  { id: "deny", keys: ["n"], label: "Deny", context: "approval", group: "Approval" },
  { id: "allow-all", keys: ["a"], label: "Allow all", context: "approval", group: "Approval" },

  { id: "selection-move", keys: ["up", "down", "left", "right", "home", "end"], display: "arrows/home/end", label: "Move", context: "selection", group: "Inspection" },
  { id: "selection-milestone", keys: ["[", "]", "shift+left", "shift+right"], display: "[/]", label: "Milestone", context: "selection", group: "Inspection" },
  { id: "selection-close", keys: ["esc", "enter"], label: "Live", context: "selection", group: "Inspection" },

  { id: "complete-move", keys: ["up", "down", "ctrl+p", "ctrl+n"], display: "up/down", label: "Move", context: "completion", group: "Completion" },
  { id: "complete", keys: ["tab"], label: "Complete", context: "completion", group: "Completion" },
  { id: "complete-run", keys: ["enter"], label: "Choose", context: "completion", group: "Completion" },
  { id: "complete-close", keys: ["esc"], label: "Close", context: "completion", group: "Completion" }
]

export interface KeyEventLike {
  readonly name: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly option?: boolean
}

export const normalizeName = (name: string): string =>
  name === "kpenter" || name === "return" ? "enter" : name === "escape" ? "esc" : name

/** Canonical terminal spelling, useful for tests and dispatch. */
export const token = (event: KeyEventLike): string => {
  const modifiers = [
    event.ctrl === true ? "ctrl" : undefined,
    event.meta === true || event.option === true ? "alt" : undefined,
    event.shift === true ? "shift" : undefined
  ].filter((value): value is string => value !== undefined)
  return [...modifiers, normalizeName(event.name)].join("+")
}

const tokenParts = (value: string): { readonly modifiers: ReadonlySet<string>; readonly name: string } => {
  const parts = value.split("+")
  return { modifiers: new Set(parts.slice(0, -1)), name: normalizeName(parts.at(-1) ?? "") }
}

export const matches = (event: KeyEventLike, key: string): boolean => {
  const expected = tokenParts(key)
  const actual = tokenParts(token(event))
  return actual.name === expected.name &&
    actual.modifiers.size === expected.modifiers.size &&
    [...actual.modifiers].every((modifier) => expected.modifiers.has(modifier))
}

export const bindingFor = (event: KeyEventLike, context?: KeyContext): Binding | undefined =>
  registry.find((binding) => (context === undefined || binding.context === context || binding.context === "global") &&
    binding.keys.some((key) => matches(event, key)))

/** The context's own keys first, then the global ones. */
export const bindingsFor = (context: KeyContext): ReadonlyArray<Binding> => [
  ...registry.filter((binding) => binding.context === context),
  ...(context === "global" ? [] : registry.filter((binding) => binding.context === "global"))
]

export const hintsFor = (context: KeyContext): ReadonlyArray<Binding> => {
  const preferred: Record<KeyContext, ReadonlyArray<string>> = {
    global: ["palette", "summary", "next-tab", "keys"],
    composer: ["palette", "summary", "next-tab", "keys"],
    working: ["interrupt", "steer", "queue-working", "keys"],
    shell: ["run-shell", "cancel-shell", "keys"],
    panel: ["navigate", "expand-row", "close-panel", "keys"],
    picker: ["pick-move", "pick", "close-picker"],
    form: ["next-field", "previous-field", "run-form", "close-form"],
    approval: ["allow", "deny", "allow-all"],
    selection: ["selection-move", "selection-milestone", "selection-close"],
    completion: ["complete-move", "complete", "complete-run", "complete-close"]
  }
  const available = bindingsFor(context)
  return preferred[context].map((id) => available.find((binding) => binding.id === id)).filter(
    (binding): binding is Binding => binding !== undefined
  )
}

export const displayKeys = (binding: Binding): string =>
  binding.display ?? binding.keys.filter((key) => key !== "linefeed").join("/")

/** The footer shows only the first spelling. */
export const primaryKey = (binding: Binding): string => binding.display ?? binding.keys[0]!

/** Every binding by group, for `/hotkeys` and the Ctrl+O home screen. */
export const groups = (
  bindings: ReadonlyArray<Binding> = registry
): ReadonlyArray<{ readonly group: string; readonly bindings: ReadonlyArray<Binding> }> =>
  [...new Set(bindings.map((binding) => binding.group))].map((group) => ({
    group,
    bindings: bindings.filter((binding) => binding.group === group)
  }))

/** `/hotkeys` text: group headings, then aligned key and label columns. */
export const sheet = (): string => {
  const width = Math.max(...registry.map((binding) => displayKeys(binding).length)) + 2
  return groups().map(({ group, bindings }) =>
    [group, ...bindings.map((binding) => `  ${displayKeys(binding).padEnd(width)}${binding.label}`)].join("\n")
  ).join("\n\n")
}

/** Registry completeness invariant used by tests and development assertions. */
export const duplicateKeys = (): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const binding of registry) for (const key of binding.keys) {
    const scoped = `${binding.context}:${key}`
    if (seen.has(scoped)) duplicates.add(scoped)
    seen.add(scoped)
  }
  return [...duplicates]
}
