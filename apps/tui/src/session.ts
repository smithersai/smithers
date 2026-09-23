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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type * as Context from "./context.ts"
import * as Shell from "./shell.ts"
import * as Transcript from "./transcript.ts"

export type Record =
  | { readonly type: "session"; readonly version: 1; readonly id: string; readonly cwd: string; readonly createdAt: number }
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
export const directory = (cwd: string): string => join(root(), `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)

export interface Writer {
  readonly file: string
  readonly append: (record: Record) => void
}

/** A new session file, written lazily so an empty session leaves nothing behind. */
export const create = (cwd: string): Writer => {
  const id = randomUUID()
  const folder = directory(cwd)
  const file = join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`)
  let opened = false
  return {
    file,
    append: (record) => {
      if (!opened) {
        mkdirSync(folder, { recursive: true })
        appendFileSync(file, JSON.stringify({ type: "session", version: 1, id, cwd, createdAt: Date.now() }) + "\n")
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

/** What a session file rebuilds: the screen, the agent's context, and the prompt history. */
export const restore = (records: ReadonlyArray<Record>): {
  readonly transcript: Transcript.Transcript
  readonly entries: Array<Context.Entry>
  readonly prompts: Array<string>
  readonly name: string | undefined
} => {
  let transcript = Transcript.empty
  const entries: Array<Context.Entry> = []
  const prompts: Array<string> = []
  let name: string | undefined
  for (const record of records) {
    switch (record.type) {
      case "name":
        name = record.name
        break
      case "user":
        transcript = Transcript.user(transcript, record.text, record.steered === true ? true : false)
        prompts.push(record.text)
        break
      case "event":
        transcript = Transcript.apply(transcript, record.event, record.at)
        break
      case "shell":
        transcript = Transcript.shell(transcript, record.result, record.excluded)
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
  return { transcript, entries, prompts, name }
}
