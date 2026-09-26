/**
 * The pages a run's role tasks retrieved, and the evidence they become.
 *
 * A `web-fetch` call is a sealed step: a later task of the same run asking
 * for the same URL is answered from the run's record without the handler
 * running. So retrievals are kept per run, not per task, and a task's
 * result gets every page it fetched itself plus every page of the run it
 * cites. With a directory, each retrieval is appended to a file named by the
 * run as it happens, so a run resumed after a host restart still has the
 * pages its earlier turns read.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type * as Profile from "../Profile.ts"
import type * as RoleHost from "../RoleHost.ts"
import { sha256Hex } from "./digest.ts"

/**
 * Where a host keeps each run's retrievals.
 *
 * @private
 * @since 1.0.0
 */
export interface Store {
  readonly append: (run: string, retrieved: RoleHost.Retrieved) => void
  readonly read: (run: string) => ReadonlyArray<RoleHost.Retrieved>
}

const parse = (line: string): ReadonlyArray<RoleHost.Retrieved> => {
  try {
    const value = JSON.parse(line) as RoleHost.Retrieved
    return typeof value.url === "string" && typeof value.retrievedAt === "string" ? [value] : []
  } catch {
    // A line cut by a crash mid-append is not a record.
    return []
  }
}

/** Runs a memory store remembers; the oldest is forgotten past it. */
const memoryRuns = 256

/**
 * A store in `directory`, one file per run, or in memory for the last 256
 * runs when there is none.
 *
 * @private
 * @since 1.0.0
 */
export const store = (directory: string | undefined): Store => {
  if (directory === undefined) {
    const runs = new Map<string, Array<RoleHost.Retrieved>>()
    return {
      append: (run, retrieved) => {
        const held = runs.get(run) ?? []
        runs.delete(run)
        runs.set(run, [...held, retrieved])
        if (runs.size > memoryRuns) runs.delete(runs.keys().next().value!)
      },
      read: (run) => runs.get(run) ?? []
    }
  }
  const file = (run: string) => join(directory, `${sha256Hex(run)}.jsonl`)
  return {
    append: (run, retrieved) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      appendFileSync(file(run), `${JSON.stringify(retrieved)}\n`, { mode: 0o600 })
    },
    read: (run) => {
      try {
        return readFileSync(file(run), "utf8").split("\n").flatMap(parse)
      } catch {
        // Nothing was fetched in this run: the file was never written.
        return []
      }
    }
  }
}

/**
 * One task's view of its run's retrievals.
 *
 * @private
 * @since 1.0.0
 */
export interface TaskLog {
  readonly log: RoleHost.RetrievalLog
  /** The pages this task fetched, and every page of the run. */
  readonly entries: Effect.Effect<{
    readonly own: ReadonlyArray<RoleHost.Retrieved>
    readonly run: ReadonlyArray<RoleHost.Retrieved>
  }>
}

/**
 * The log of one task of `run`.
 *
 * @private
 * @since 1.0.0
 */
export const task = (store: Store, run: string): TaskLog => {
  const own: Array<RoleHost.Retrieved> = []
  return {
    log: {
      record: (retrieved) =>
        Effect.sync(() => {
          own.push(retrieved)
          store.append(run, retrieved)
        })
    },
    entries: Effect.sync(() => ({ own, run: store.read(run) }))
  }
}

const isResult = (value: unknown): value is Profile.RoleResult =>
  typeof value === "object" && value !== null && Array.isArray((value as { evidence?: unknown }).evidence)

/**
 * `result` with one `url` evidence item, with its retrieval time, for each
 * page the task fetched and each page of the run the result cites (by its
 * URL or the URL it was asked for). Anything that is not a role result is
 * returned as it is.
 *
 * @private
 * @since 1.0.0
 */
export const withEvidence = <A>(
  result: A,
  entries: { readonly own: ReadonlyArray<RoleHost.Retrieved>; readonly run: ReadonlyArray<RoleHost.Retrieved> }
): A => {
  if (!isResult(result)) return result
  const text = JSON.stringify(result)
  const cited = entries.run.filter((entry) => text.includes(entry.url) || text.includes(entry.requested))
  if (entries.own.length + cited.length === 0) return result
  const evidence = [...result.evidence]
  const seen = new Set<string>()
  for (const entry of [...entries.own, ...cited]) {
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    const detail = `retrieved ${entry.retrievedAt}${entry.requested === entry.url ? "" : ` from ${entry.requested}`}`
    evidence.push({ kind: "url", ref: entry.url, detail })
  }
  return { ...result, evidence }
}
