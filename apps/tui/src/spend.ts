/**
 * The machine's durable spend ledger: one append-only JSONL file per UTC day.
 *
 * The journal `Budget` normally recovers from is per run, and this host runs on
 * the memory engine with none, so the per-day cap and a run's recovered spend
 * both read this file. Several `smithers-tui` processes on one machine append
 * to the same day file; a SQLite writer lock guards tail repair and append.
 * Closing the connection (including process death) releases the lock. An unreadable line
 * fails the read (the budget then refuses, loudly) instead of counting as zero,
 * except a torn final line from a crash, which is skipped and removed before
 * the next append.
 */
import type * as Budget from "@smthrs/agent/Budget"
import * as Effect from "effect/Effect"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const directory = (): string =>
  join(process.env.SMITHERS_TUI_SESSION_DIR ?? join(homedir(), ".smithers", "tui"), "spend")

const fileFor = (root: string, day: string): string => join(root, `${day}.jsonl`)

const isEntry = (value: unknown): value is Budget.LedgerEntry =>
  typeof value === "object" && value !== null &&
  typeof (value as Budget.LedgerEntry).day === "string" &&
  typeof (value as Budget.LedgerEntry).runId === "string" &&
  typeof (value as Budget.LedgerEntry).stepKey === "string" &&
  Number.isFinite((value as Budget.LedgerEntry).spent) &&
  ((value as Budget.LedgerEntry).costUsd === undefined ||
    (Number.isFinite((value as Budget.LedgerEntry).costUsd) && (value as Budget.LedgerEntry).costUsd! >= 0))

/** One day's entries; the first record of a `(runId, stepKey)` wins. */
const read = (root: string, day: string): ReadonlyArray<Budget.LedgerEntry> => {
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

const previousDay = (day: string): string => new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10)

export const ledger = (root: string = directory()): Budget.Ledger => ({
  total: (day) => Effect.try(() => read(root, day).reduce((sum, entry) => sum + entry.spent, 0)),
  record: (entry) =>
    Effect.try(() => {
      // A retried record may append twice; `read` keeps the first.
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const file = fileFor(root, entry.day)
      // Use the host SQLite lock rather than a lockfile that survives a crash.
      // Never unlink it: all writers must coordinate on the same inode.
      const lockFile = `${file}.lock.sqlite`
      const lock = new DatabaseSync(lockFile)
      try {
        chmodSync(lockFile, 0o600)
        lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE")
        const fd = openSync(file, "a+", 0o600)
        try {
          const bytes = readFileSync(fd)
          const end = bytes.lastIndexOf(10) + 1
          if (end < bytes.length) ftruncateSync(fd, end)
          appendFileSync(fd, JSON.stringify(entry) + "\n")
          chmodSync(file, 0o600)
        } finally {
          closeSync(fd)
        }
      } finally {
        lock.close()
      }
    }),
  // A run's steps sit in the day it started or the next; older days are never rescanned.
  run: (runId) =>
    Effect.try(() => {
      const today = new Date().toISOString().slice(0, 10)
      const held = new Map<string, Budget.Charge>()
      for (const day of [previousDay(today), today]) {
        for (const entry of read(root, day)) {
          if (entry.runId !== runId) continue
          held.set(entry.stepKey, {
            spent: entry.spent,
            ...(entry.costUsd === undefined ? {} : { costUsd: entry.costUsd })
          })
        }
      }
      return held
    })
})
