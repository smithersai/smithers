/**
 * Composer logic that owes nothing to the renderer: prompt history, slash
 * commands, and the double-press window for Ctrl+C.
 */

/** pi keeps this many prompts and skips a repeat of the latest one. */
export const historyLimit = 100

/** A second Ctrl+C within this window exits (pi's `lastSigintTime`). */
export const exitWindowMs = 500

/**
 * Prompt history, browsed with Up and Down. `index` is how far back the
 * composer currently shows; -1 is the draft being typed.
 */
export class History {
  private entries: Array<string> = []
  private index = -1
  private draft = ""

  constructor(initial: ReadonlyArray<string> = []) {
    for (const entry of initial) this.add(entry)
  }

  add(entry: string): void {
    const text = entry.trim()
    this.index = -1
    if (text === "" || this.entries.at(-1) === text) return
    this.entries.push(text)
    if (this.entries.length > historyLimit) this.entries.shift()
  }

  get browsing(): boolean {
    return this.index >= 0
  }

  /** The older entry to show, or undefined at the oldest. */
  up(current: string): string | undefined {
    if (this.index + 1 >= this.entries.length) return undefined
    if (this.index === -1) this.draft = current
    this.index++
    return this.entries[this.entries.length - 1 - this.index]
  }

  /** The newer entry to show, the draft past the newest, or undefined when not browsing. */
  down(): string | undefined {
    if (this.index < 0) return undefined
    this.index--
    return this.index === -1 ? this.draft : this.entries[this.entries.length - 1 - this.index]
  }
}

export interface Command {
  readonly name: string
  readonly args?: string
  readonly description: string
}

export const commands: ReadonlyArray<Command> = [
  { name: "model", args: "[query]", description: "Pick a model" },
  { name: "thinking", args: "[level]", description: "Set the reasoning effort" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Resume a session" },
  { name: "session", description: "Show the session file and tokens" },
  { name: "name", args: "<name>", description: "Name this session" },
  { name: "copy", description: "Copy the last answer" },
  { name: "hotkeys", description: "Show the keys" },
  { name: "quit", description: "Quit" }
]

/** Commands whose name starts with what follows `/`, while no argument is typed. */
export const matching = (text: string): ReadonlyArray<Command> => {
  if (!text.startsWith("/") || text.includes(" ") || text.includes("\n")) return []
  const typed = text.slice(1)
  return commands.filter((command) => command.name.startsWith(typed))
}

/** `/model gpt` → `{ name: "model", argument: "gpt" }`. */
export const parseCommand = (text: string): { readonly name: string; readonly argument: string } | undefined => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match === null ? undefined : { name: match[1]!, argument: (match[2] ?? "").trim() }
}

export const thinkingLevels = ["none", "minimal", "low", "medium", "high", "xhigh"] as const
export type Thinking = (typeof thinkingLevels)[number] | undefined

/** Shift+Tab: the provider default, then each level, then back to the default. */
export const nextThinking = (current: Thinking): Thinking => {
  if (current === undefined) return thinkingLevels[0]
  const at = thinkingLevels.indexOf(current)
  return at === thinkingLevels.length - 1 ? undefined : thinkingLevels[at + 1]
}

export const keys: ReadonlyArray<readonly [key: string, action: string]> = [
  ["enter", "send; while working, steer the next cell"],
  ["alt+enter", "queue a follow-up for after the turn"],
  ["alt+up", "move queued follow-ups back to the editor"],
  ["shift+enter, ctrl+j", "newline"],
  ["esc", "interrupt the turn or shell command"],
  ["ctrl+c", "clear; twice to exit"],
  ["ctrl+d", "exit when the editor is empty"],
  ["up, down", "prompt history"],
  ["ctrl+l", "pick a model"],
  ["ctrl+p, shift+ctrl+p", "next, previous model"],
  ["shift+tab", "cycle reasoning effort"],
  ["ctrl+o", "expand cells and output"],
  ["ctrl+g", "edit the prompt in $EDITOR"],
  ["pageup, pagedown", "scroll"],
  ["!cmd, !!cmd", "run a shell command; !! keeps it out of context"],
  ["/", "commands"]
]

/** Formats a token count the way pi's footer does: 950, 1.2k, 45k, 1.2M. */
export const tokens = (count: number): string => {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
