/**
 * Sessions on disk: one JSONL file per conversation, under
 * `~/.smithers/tui/sessions/<cwd slug>/` (or `$SMITHERS_TUI_SESSION_DIR`).
 *
 * The file is the transcript's own input: prompts, every harness event but
 * the model's token deltas, shell results and turn outcomes. Folding it
 * again rebuilds the screen and the conversation the next turn is told.
 * Credential shapes in that text are redacted before a line reaches the disk.
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Redaction from "@smthrs/journal/Redaction"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type * as Changes from "./changes.ts"
import type * as Context from "./context.ts"
import type * as Flows from "./flows.ts"
import type * as Monitors from "./monitors.ts"
import * as Panels from "./panels.ts"
import * as Shell from "./shell.ts"
import * as Transcript from "./transcript.ts"
import type * as Workspace from "./workspace.ts"

export type Record =
  | { readonly type: "caption"; readonly prose: string }
  | { readonly type: "panel"; readonly panel: Panels.Panel }
  | { readonly type: "tab"; readonly tab: Workspace.Tab }
  | { readonly type: "flow"; readonly run: Flows.Run }
  | { readonly type: "monitor"; readonly monitor: Monitors.Monitor }
  /** A delivered monitor update, or its failure. */
  | {
    readonly type: "monitor-update"
    readonly at: number
    readonly id: string
    readonly title: string
    readonly text: string
    readonly failed?: true
  }
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
    readonly outcome: { readonly _tag: string; readonly answer?: string; readonly message?: string; readonly headline?: string }
  }
  | { readonly type: "shell"; readonly at: number; readonly result: Shell.Result; readonly excluded: boolean }
  /** `/compact`: the model no longer receives the oldest `dropped` context entries. */
  | { readonly type: "compact"; readonly at: number; readonly dropped: number }
  /** The user reversed these calls' captured changes (call identities, `Changes.identity`). */
  | {
    readonly type: "undo"
    readonly at: number
    readonly calls: ReadonlyArray<string>
    readonly paths: ReadonlyArray<string>
    /** A worker tab's calls: that tab's file marks them; this record only tells the context. */
    readonly tab?: string
  }

export interface Summary {
  readonly file: string
  readonly name: string | undefined
  readonly firstPrompt: string
  readonly modified: number
  /** Set on a fork: the session file it was forked from. */
  readonly parent?: string
}

export const root = (): string =>
  process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui", "sessions")

const slug = (cwd: string): string => cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")

/** pi's directory slug, fenced by `--`, plus a hash of the exact path: `/a/b-c` and `/a/b/c` never share a folder. */
export const directory = (cwd: string): string =>
  join(root(), `--${slug(cwd)}--${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`)

/** The folder before the hash; shared by colliding paths, so its files are filtered by their header's cwd. */
const legacyDirectory = (cwd: string): string => join(root(), `--${slug(cwd)}--`)

/** Sessions hold prompts, code, diffs and shell output: owner-only folders and files. */
const privateFolder = (folder: string): void => {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  chmodSync(folder, 0o700)
}
const append = (file: string, text: string): void => appendFileSync(file, text, { mode: 0o600 })

const text = (value: string): string =>
  Redaction.defaultRules.reduce((redacted, rule) => redacted.replace(rule.pattern, rule.replace ?? Redaction.placeholder), value)

/** `value` as JSON with every string redacted. */
const strings = (value: unknown): string =>
  JSON.stringify(value, (_, each: unknown) => (typeof each === "string" ? text(each) : each))

/** A tab's or a flow run's result text, redacted; the rest of it is what a retry relaunches. */
const said = <A extends { readonly answer?: string; readonly message?: string }>(value: A): A => ({
  ...value,
  ...(value.answer === undefined ? {} : { answer: text(value.answer) }),
  ...(value.message === undefined ? {} : { message: text(value.message) })
})

/**
 * A record as a session file holds it: the journal's textual credential rules
 * applied to its text, so `!printenv` or an agent reading `~/.ssh` leaves
 * `[REDACTED]` on disk, not the secret. Field names are not judged, because a
 * call identity's `session` is not a credential and undo matches on it.
 *
 * What the TUI re-executes keeps its bytes: a placeholder in a `patch` is what
 * undo would write into the file, one in a flow run's input or a worker tab's
 * prompt is what retry would relaunch, one in a monitor's source is what its
 * next tick would run, and one in a view is what selecting its action would
 * send. `session` and `undo` hold ids and paths, which a rule could mistake for
 * a key (`~/sk-demo-project`).
 */
const line = (record: Record): string => {
  switch (record.type) {
    case "session":
    case "patch":
    case "undo":
    case "panel":
      return JSON.stringify(record) + "\n"
    case "tab":
      return JSON.stringify({ ...record, tab: said(record.tab) }) + "\n"
    case "flow":
      return JSON.stringify({ ...record, run: said(record.run) }) + "\n"
    case "monitor": {
      const { source, ...rest } = record.monitor
      return JSON.stringify({ ...record, monitor: { ...(JSON.parse(strings(rest)) as typeof rest), source } }) + "\n"
    }
    default:
      return strings(record) + "\n"
  }
}

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
  const prepare = () => {
    privateFolder(directory(cwd))
    privateFolder(folder)
  }
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
      prepare()
      writeFileSync(file, [header(), ...options.seed].map(line).join(""), {
        flag: "wx",
        mode: 0o600
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
        prepare()
        append(file, line(header()))
        opened = true
      }
      append(file, line(record))
    }
  }
}

/** Continues an existing file. */
export const reopen = (file: string): Writer => {
  let repaired = false
  return {
    file,
    append: (record) => {
      if (!repaired && existsSync(file)) chmodSync(file, 0o600)
      repaired = true
      append(file, line(record))
    }
  }
}

/** The disk refused a session record: a full disk, a removed folder, lost permission. */
export interface WriteFailed {
  readonly _tag: "SessionWriteFailed"
  readonly file: string
  readonly message: string
}

/**
 * `writer`, whose appends never throw: a turn, shell or undo settles on screen
 * even when its record cannot be saved. `report` hears the first failure of
 * each run of failures; a write that succeeds again ends the run.
 */
export const guarded = (writer: Writer, report: (failure: WriteFailed) => void): Writer => {
  let failing = false
  return {
    file: writer.file,
    append: (record) => {
      try {
        writer.append(record)
        failing = false
      } catch (error) {
        if (!failing) {
          report({ _tag: "SessionWriteFailed", file: writer.file, message: error instanceof Error ? error.message : String(error) })
        }
        failing = true
      }
    }
  }
}

/** Thrown for a record damaged before the file's last line; a torn last line (a crash mid-append) is dropped. */
export class Corrupt extends Error {
  constructor(readonly file: string, readonly line: number) {
    super(`Session ${basename(file)} is damaged at line ${line}`)
  }
}

const parse = (file: string, text: string): ReadonlyArray<Record> => {
  const lines = text.split("\n")
  const last = lines.findLastIndex((line) => line.trim() !== "")
  const records: Array<Record> = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    try {
      records.push(JSON.parse(line) as Record)
    } catch {
      if (index !== last) throw new Corrupt(file, index + 1)
    }
  }
  return records
}

export const load = (file: string): ReadonlyArray<Record> => parse(file, readFileSync(file, "utf8"))

/** Moves a file that failed to load out of the listing, beside it as `.damaged`, and says so. */
export const quarantine = (file: string, error: unknown): string => {
  const reason = error instanceof Error ? error.message : String(error)
  try {
    renameSync(file, `${file}.damaged`)
    return `${reason}; moved to ${basename(file)}.damaged`
  } catch {
    return reason
  }
}

/** A listing parses only the header, the first prompt and names, and skips a damaged file instead of failing the list. */
const summary = (file: string): (Summary & { readonly cwd?: string }) | undefined => {
  let header: Record | undefined
  let first: Record | undefined
  let named: Record | undefined
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const type = /^\{"type":"(session|user|name)"/.exec(line)?.[1]
      if (type === undefined || (type === "user" && first !== undefined)) continue
      let record: Record
      try {
        record = JSON.parse(line) as Record
      } catch {
        continue
      }
      if (record.type === "session") header ??= record
      else if (record.type === "user") first = record
      else named = record
    }
    return {
      file,
      ...(header?.type === "session" && header.parent !== undefined ? { parent: header.parent } : {}),
      name: named?.type === "name" ? named.name : undefined,
      firstPrompt: first?.type === "user" ? first.text : basename(file),
      modified: statSync(file).mtimeMs,
      ...(header?.type === "session" ? { cwd: header.cwd } : {})
    }
  } catch {
    return undefined
  }
}

const summaries = (folder: string): ReadonlyArray<Summary & { readonly cwd?: string }> =>
  existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith(".jsonl")).flatMap((name) => summary(join(folder, name)) ?? [])
    : []

/** Sessions for `cwd`, newest first. */
export const list = (cwd: string): ReadonlyArray<Summary> =>
  [
    ...summaries(directory(cwd)),
    ...summaries(legacyDirectory(cwd)).filter((row) => row.cwd === cwd)
  ]
    .map(({ cwd: _cwd, ...row }) => row)
    .sort((a, b) => b.modified - a.modified)

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
  const before: ReadonlyArray<Record> = records.slice(0, turn.index).filter((record) => record.type !== "session")
  // A worker started before the fork point may have settled after it: carry its last record, not a stale `requested`.
  type TabRecord = Extract<Record, { readonly type: "tab" }>
  const key = (tab: Workspace.Tab) => `${tab.id}\0${tab.file}`
  const last = new Map<string, TabRecord>()
  for (const record of records) if (record.type === "tab") last.set(key(record.tab), record)
  const settled = new Set<TabRecord>()
  for (const record of before) if (record.type === "tab") settled.add(last.get(key(record.tab))!)
  const copies = new Map<string, string>()
  try {
    const kept = [...before, ...[...settled].filter((record) => !before.includes(record))].map((record): Record => {
      if (record.type !== "tab") return record
      const original = record.tab.file
      if (!copies.has(original)) {
        const worker = create(cwd, "worker", {
          parent: original,
          seed: existsSync(original) ? load(original).filter((record) => record.type !== "session") : []
        })
        copies.set(original, worker.file)
      }
      return { ...record, tab: { ...record.tab, file: copies.get(original)! } }
    })
    const writer = create(cwd, "chat", { parent: source, seed: kept })
    return { _tag: "Forked", writer, records: kept, text: at.text }
  } catch (error) {
    for (const file of copies.values()) rmSync(file, { force: true })
    throw error
  }
}

/** What a session file rebuilds: the screen, the agent's context, and the prompt history. */
export const restore = (records: ReadonlyArray<Record>): {
  readonly transcript: Transcript.Transcript
  readonly workspace: Workspace.Snapshot
  readonly flows: ReadonlyArray<Flows.Run>
  readonly monitors: ReadonlyArray<Monitors.Monitor>
  readonly entries: Array<Context.Entry>
  readonly prompts: Array<string>
  readonly name: string | undefined
} => {
  const panels = new Map<string, Panels.Panel>()
  const tabs = new Map<string, Workspace.Tab>()
  const flows = new Map<string, Flows.Run>()
  const monitors = new Map<string, Monitors.Monitor>()
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
        Panels.keep(panels, record.panel)
        break
      case "tab":
        tabs.set(record.tab.id, record.tab)
        break
      case "flow":
        flows.set(record.run.id, record.run)
        break
      case "monitor":
        monitors.set(record.monitor.id, record.monitor)
        break
      case "monitor-update":
        transcript = record.failed === true
          ? Transcript.alert(transcript, `${record.title}: ${record.text}`, record.at)
          : Transcript.note(transcript, `${record.title}: ${record.text}`, record.at)
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
            record.outcome._tag === "cancelled" ? "Stopped" : record.outcome.headline ?? record.outcome.message ?? "Failed",
            record.at
          )
        }
        break
      case "undo":
        if (record.tab === undefined) transcript = Transcript.undone(transcript, record.calls, record.paths, record.at)
        entries.push({ kind: "undo", paths: record.paths })
        break
      case "compact":
        entries.splice(0, record.dropped)
        break
      case "session":
        break
    }
  }
  return {
    transcript,
    entries,
    prompts,
    name,
    workspace: { tabs: [...tabs.values()], panels: [...panels.values()] },
    flows: [...flows.values()],
    monitors: [...monitors.values()]
  }
}
