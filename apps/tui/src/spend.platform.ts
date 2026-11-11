/**
 * The platform code of spend.vibe: where the day files live and their
 * synchronous reads and appends, which a .vibe file does not import.
 */
import type * as Budget from "@smthrs/agent/Budget"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Where this machine's spend files live: `$SMITHERS_TUI_SESSION_DIR/spend`,
 * else `~/.smithers/tui/spend`.
 * @throws {never}
 */
export function directory(): string {
  return join(process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui"), "spend")
}

const fileFor = (root: string, day: string): string => join(root, `${day}.jsonl`)

const isEntry = (value: unknown): value is Budget.LedgerEntry =>
  typeof value === "object" && value !== null &&
  typeof (value as Budget.LedgerEntry).day === "string" &&
  typeof (value as Budget.LedgerEntry).runId === "string" &&
  typeof (value as Budget.LedgerEntry).stepKey === "string" &&
  Number.isFinite((value as Budget.LedgerEntry).spent) &&
  ((value as Budget.LedgerEntry).costUsd === undefined ||
    (Number.isFinite((value as Budget.LedgerEntry).costUsd) && (value as Budget.LedgerEntry).costUsd! >= 0))

/**
 * One day's entries; the first record of a `(runId, stepKey)` wins. An
 * unreadable line throws, except a torn final line from a crash, which is skipped.
 */
export const read = (root: string, day: string): ReadonlyArray<Budget.LedgerEntry> => {
  const file = fileFor(root, day)
  if (!existsSync(file)) return []
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  const torn = !text.endsWith("\n")
  const seen = new Set<string>()
  const entries: Array<Budget.LedgerEntry> = []
  lines.forEach((line, index) => {
    if (line === "" || (torn && index === lines.length - 1)) return
    const parsed: unknown = JSON.parse(line)
    if (!isEntry(parsed)) throw new Error(`${file} line ${index + 1} is not a spend record`)
    const key = JSON.stringify([parsed.runId, parsed.stepKey])
    if (seen.has(key)) return
    seen.add(key)
    entries.push(parsed)
  })
  return entries
}

/** Appends one record to its day file; the directory and the file stay private to this user. */
export const append = (root: string, entry: Budget.LedgerEntry): void => {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const file = fileFor(root, entry.day)
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
}
