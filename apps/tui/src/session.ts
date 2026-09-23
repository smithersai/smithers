/**
 * Sessions on disk: one JSONL file per conversation, under
 * `~/.smithers/tui/sessions/<cwd slug>/` (or `$SMITHERS_TUI_SESSION_DIR`).
 *
 * The file is the transcript's own input: prompts, every harness event but
 * the model's token deltas, shell results and turn outcomes. Folding it
 * again rebuilds the screen and the conversation the next turn is told.
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type * as Changes from "./changes.ts"
import type * as Context from "./context.ts"
import type * as Panels from "./panels.ts"
import * as Shell from "./shell.ts"
import * as Transcript from "./transcript.ts"
import type * as Workspace from "./workspace.ts"

export type Record =
  | { readonly type: "caption"; readonly prose: string }
  | { readonly type: "panel"; readonly panel: Panels.Panel }
  | { readonly type: "tab"; readonly tab: Workspace.Tab }
  | { readonly type: "patch"; readonly receipt: Changes.Receipt }
  | {
    readonly type: "session"
    readonly version: 1
    readonly id: string
    readonly cwd: string
    readonly createdAt: number
    /** The session this one was forked from (pi's `parentSession`). */
    readonly parent?: string
  }
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "user"; readonly at: number; readonly text: string; readonly steered?: boolean }
  | { readonly type: "event"; readonly at: number; readonly event: AgentEvent.AgentEvent }
  | {
    readonly type: "outcome"
    readonly at: number
    readonly prompt: string
    readonly outcome: { readonly _tag: string; readonly answer?: string; readonly message?: string }
  }
  | { readonly type: "shell"; readonly at: number; readonly result: Shell.Result; readonly excluded: boolean }

export interface Summary {
  readonly file: string
  readonly name: string | undefined
  readonly firstPrompt: string
  readonly modified: number
}

export const root = (): string =>
  process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui", "sessions")

/** pi's directory slug: the path with separators replaced, fenced by `--`. */
export const directory = (cwd: string): string =>
  join(root(), `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)

export interface Writer {
  readonly file: string
  readonly append: (record: Record) => void
}

/**
 * A new session file, written lazily so an empty session leaves nothing behind.
 * A `seed` (a fork's copied records) is written at once, or not at all.
 */
export const create = (
  cwd: string,
  kind: "chat" | "worker" = "chat",
  options: { readonly parent?: string; readonly seed?: ReadonlyArray<Record> } = {}
): Writer => {
  const id = randomUUID()
  const folder = kind === "worker" ? join(directory(cwd), "workers") : directory(cwd)
  const file = join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`)
  const header = (): Record => ({
    type: "session",
    version: 1,
    id,
    cwd,
    createdAt: Date.now(),
    ...(options.parent === undefined ? {} : { parent: options.parent })
  })
  let opened = false
  if (options.seed !== undefined && options.seed.length > 0) {
    try {
      mkdirSync(folder, { recursive: true })
      writeFileSync(file, [header(), ...options.seed].map((record) => JSON.stringify(record)).join("\n") + "\n", {
        flag: "wx"
      })
    } catch (error) {
      rmSync(file, { force: true })
      throw error
    }
    opened = true
  }
  return {
    file,
    append: (record) => {
      if (!opened) {
        mkdirSync(folder, { recursive: true })
        appendFileSync(file, JSON.stringify(header()) + "\n")
        opened = true
      }
      appendFileSync(file, JSON.stringify(record) + "\n")
    }
  }
}

/** Continues an existing file. */
export const reopen = (file: string): Writer => ({
  file,
  append: (record) => appendFileSync(file, JSON.stringify(record) + "\n")
})

export const load = (file: string): ReadonlyArray<Record> =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record)

/** Sessions for `cwd`, newest first. */
export const list = (cwd: string): ReadonlyArray<Summary> => {
  const folder = directory(cwd)
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = join(folder, name)
      const records = load(file)
      const named = records.findLast((record) => record.type === "name")
      const first = records.find((record) => record.type === "user")
      return {
        file,
        name: named?.type === "name" ? named.name : undefined,
        firstPrompt: first?.type === "user" ? first.text : basename(file),
        modified: statSync(file).mtimeMs
      }
    })
    .sort((a, b) => b.modified - a.modified)
}

export const latest = (cwd: string): string | undefined => list(cwd)[0]?.file

/** A user turn a fork can start before. `index` is its position in the file's records. */
export interface Turn {
  readonly index: number
  readonly at: number
  readonly text: string
}

/** pi's fork points: prompts that started a turn, newest first. A steer belongs to its turn; `!cmd` is not a turn. */
export const turns = (records: ReadonlyArray<Record>): ReadonlyArray<Turn> =>
  records
    .flatMap((record, index) =>
      record.type === "user" && record.steered !== true ? [{ index, at: record.at, text: record.text }] : []
    )
    .reverse()

export type Fork =
  | {
    readonly _tag: "Forked"
    readonly writer: Writer
    readonly records: ReadonlyArray<Record>
    readonly text: string
  }
  | { readonly _tag: "Stale" }

/** pi's /fork: a new session holding `source`'s records before `turn`. `source` is only read. */
export const fork = (source: string, cwd: string, turn: Turn): Fork => {
  const records = load(source)
  const at = records[turn.index]
  if (at?.type !== "user" || at.steered === true || at.at !== turn.at || at.text !== turn.text) return { _tag: "Stale" }
  const kept = records.slice(0, turn.index).filter((record) => record.type !== "session")
  const writer = create(cwd, "chat", { parent: source, seed: kept })
  return { _tag: "Forked", writer, records: kept, text: at.text }
}

/** What a session file rebuilds: the screen, the agent's context, and the prompt history. */
export const restore = (records: ReadonlyArray<Record>): {
  readonly transcript: Transcript.Transcript
  readonly workspace: Workspace.Snapshot
  readonly entries: Array<Context.Entry>
  readonly prompts: Array<string>
  readonly name: string | undefined
} => {
  const panels = new Map<string, Panels.Panel>()
  const tabs = new Map<string, Workspace.Tab>()
  let transcript = Transcript.empty
  const entries: Array<Context.Entry> = []
  const prompts: Array<string> = []
  let name: string | undefined
  for (const record of records) {
    switch (record.type) {
      case "caption":
        transcript = Transcript.caption(transcript, record.prose)
        break
      case "panel":
        panels.set(record.panel.id, record.panel)
        break
      case "tab":
        tabs.set(record.tab.id, record.tab)
        break
      case "patch":
        transcript = Transcript.patched(transcript, record.receipt)
        break
      case "name":
        name = record.name
        break
      case "user":
        transcript = Transcript.user(transcript, record.text, record.steered === true, record.at)
        prompts.push(record.text)
        break
      case "event":
        transcript = Transcript.apply(transcript, record.event, record.at)
        break
      case "shell":
        transcript = Transcript.shell(transcript, record.result, record.excluded, record.at)
        prompts.push(`${record.excluded ? "!!" : "!"}${record.result.command}`)
        if (!record.excluded) entries.push({ kind: "shell", text: Shell.contextText(record.result) })
        break
      case "outcome":
        if (record.outcome._tag === "done") {
          entries.push({ kind: "exchange", user: record.prompt, answer: record.outcome.answer ?? "" })
        } else {
          transcript = Transcript.failure(
            transcript,
            record.outcome._tag === "cancelled" ? "Stopped" : record.outcome.message ?? "Failed",
            record.at
          )
        }
        break
      case "session":
        break
    }
  }
  return { transcript, entries, prompts, name, workspace: { tabs: [...tabs.values()], panels: [...panels.values()] } }
}
