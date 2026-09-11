import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as Redaction from "@smthrs/journal/Redaction"
import { RunRecordSchema, TargetRunEventSchema } from "@smthrs/rpc/TargetGraph"
import type { RunRecord, RunReplayResponse, TargetRunEvent } from "@smthrs/rpc/TargetGraph"
import { readJournalLines } from "./JournalLines"
import type { TargetRun } from "./Targets"

type HistoryLine = { readonly type: "record"; readonly record: RunRecord } | { readonly type: "event"; readonly event: TargetRunEvent }

interface StoredRun {
  record: RunRecord
  /** The resident event tail; undefined once evicted, replay then re-reads the journal. */
  events: Array<TargetRunEvent> | undefined
  readonly path: string
  queue: Promise<void>
  appendError?: Error
  /** Retained stdout/stderr characters, kept under MAX_RETAINED_LOG_CHARS. */
  logChars: number
  /** Log characters written to the journal, kept under the on-disk cap. */
  journalChars: number
  /** The truncation marker was written; later log frames are dropped. */
  truncated: boolean
  /** Log characters enqueued for append and not yet written or failed. */
  pendingChars: number
  /** Callers waiting for `pendingChars` to fall back under MAX_PENDING_LOG_CHARS. */
  readonly waiters: Array<() => void>
}

export interface TargetRunHistory {
  /** Wait for queued writes; reject if any append in this store failed. */
  readonly flush: () => Promise<void>
  readonly start: (run: TargetRun) => Promise<void>
  /**
   * Queues the frame for the journal. Resolves at once while the run's
   * unwritten log backlog is under MAX_PENDING_LOG_CHARS, otherwise when it
   * drains under it; a producer that awaits it paces itself to the disk.
   * Never rejects: an append failure is recorded on the run and by `flush`.
   */
  readonly event: (run: TargetRun, event: TargetRunEvent) => Promise<void>
  readonly list: (repoId: string, repo: string) => Promise<ReadonlyArray<RunRecord>>
  readonly replay: (runId: string, repos?: ReadonlyArray<{ readonly id: string; readonly path: string }>) => Promise<RunReplayResponse | undefined>
}

/*
 * The in-memory cap on one run's retained stdout/stderr. The .jsonl journal on
 * disk keeps every appended frame up to MAX_JOURNAL_LOG_CHARS; append failures mark the run
 * degraded and stop further writes. This bounds the heap per run, because a
 * chatty node emits megabytes. The TAIL is what a human reads, so eviction
 * drops the OLDEST log frames and never a structured frame
 * (started/node/summary/exit/error), which the timeline and overlay need whole.
 */
export const MAX_RETAINED_LOG_CHARS = 1_000_000

/*
 * The unwritten log backlog one run may hold before `event` stops resolving at
 * once. A child can outrun the disk by orders of magnitude; without a high
 * water mark the append chain grows with every frame the child ever wrote.
 */
export const MAX_PENDING_LOG_CHARS = 4_000_000

/*
 * How many settled runs keep their event tail in memory. Records (one small
 * object per run) stay resident for `list`; a replay of an evicted run
 * re-reads its journal, capped the same way. Live runs are never evicted, nor
 * are degraded ones: their acknowledged prefix is the truth, not the disk.
 */
export const MAX_RESIDENT_RUNS = 16

/*
 * The stdout/stderr characters one run's journal keeps on disk. Past it the
 * journal records JOURNAL_TRUNCATED_MARKER once as a stderr frame and drops
 * further log frames; structured frames are still written.
 */
export const MAX_JOURNAL_LOG_CHARS = 32_000_000

export const JOURNAL_TRUNCATED_MARKER = "[smithers: run output exceeded the journal cap; later output was not recorded]\n"

/** Journals read at once while a repository's history loads. */
export const MAX_JOURNAL_LOADS = 4

const uiDir = (repo: string): string => join(repo, ".flows", "ui")
const runsDir = (repo: string): string => join(uiDir(repo), "runs")
const encode = (line: HistoryLine): string => `${JSON.stringify(line)}\n`

/*
 * Build and test output routinely carries a credential a failing tool printed,
 * and the journal lives inside the repository. Log frames pass through the
 * engine journal's redactor before they are retained or written.
 */
const redactLog = Redaction.make()
const defaultRedact = (text: string): string => String(redactLog(text))

const logChars = (event: TargetRunEvent): number =>
  event.type === "stdout" || event.type === "stderr" ? event.data.length : 0

/**
 * Drops the OLDEST log frames until the retained tail fits the cap. Structured
 * frames survive whatever the volume: the timeline, the overlay and the
 * critical path are derived from them, so evicting one would silently change
 * what a replay shows. Returns the events kept and their character count.
 */
const capLogs = (events: Array<TargetRunEvent>): { events: Array<TargetRunEvent>; logChars: number } => {
  let total = events.reduce((sum, event) => sum + logChars(event), 0)
  if (total <= MAX_RETAINED_LOG_CHARS) return { events, logChars: total }
  const kept: Array<TargetRunEvent> = []
  for (const event of events) {
    const size = logChars(event)
    if (size > 0 && total > MAX_RETAINED_LOG_CHARS) {
      total -= size
      continue
    }
    kept.push(event)
  }
  return { events: kept, logChars: total }
}

interface Tail {
  events: Array<TargetRunEvent>
  logChars: number
}

/** Appends one frame and keeps the tail under the cap as it grows. */
const retain = (tail: Tail, event: TargetRunEvent): void => {
  tail.events.push(event)
  tail.logChars += logChars(event)
  if (tail.logChars > MAX_RETAINED_LOG_CHARS) {
    const capped = capLogs(tail.events)
    tail.events = capped.events
    tail.logChars = capped.logChars
  }
}

const applyEvent = (record: RunRecord, event: TargetRunEvent, endedAt: number): RunRecord => {
  if (event.type === "started") return { ...record, status: "running" }
  if (event.type === "summary") return { ...record, summary: event.summary }
  if (event.type === "exit") return {
    ...record, status: event.code === 0 ? "done" : "failed", endedAt, exitCode: event.code
  }
  return record
}

/*
 * Parses one journal line by line. The full text never exists in memory:
 * with `keep`, the event tail is capped while parsing, without it only the
 * record is derived. A repository's journals can total gigabytes; the peak is
 * one chunk plus one capped tail per concurrently loading journal.
 */
const readJournal = async (path: string, repoId: string, keep: boolean): Promise<{ record: RunRecord | undefined } & Tail> => {
  let record: RunRecord | undefined
  const tail: Tail = { events: [], logChars: 0 }
  try {
    for await (const line of readJournalLines(path)) {
      if (line === "") continue
      try {
        const parsed = JSON.parse(line) as { type?: unknown; record?: unknown; event?: unknown }
        if (parsed.type === "record") {
          const checked = RunRecordSchema.safeParse(parsed.record)
          if (checked.success && checked.data.repoId === repoId) record = checked.data
        } else if (parsed.type === "event") {
          const checked = TargetRunEventSchema.safeParse(parsed.event)
          if (checked.success) {
            if (keep) retain(tail, checked.data)
            // Terminal status/time comes from the final record. Rebuild the
            // durable prefix's other facts even when that record is missing.
            if (record !== undefined && checked.data.type !== "exit") record = applyEvent(record, checked.data, 0)
          }
        }
      } catch { /* A partial final line after a crash is ignored. */ }
    }
  } catch { return { record: undefined, events: [], logChars: 0 } }
  return { record, ...tail }
}

const settled = (stored: StoredRun): boolean => stored.record.status === "done" || stored.record.status === "failed"

export const createTargetRunHistory = (options: {
  readonly log?: (line: string) => void
  /** The on-disk log cap per journal; defaults to MAX_JOURNAL_LOG_CHARS. */
  readonly maxJournalLogChars?: number
  /** Redacts one log frame's text; defaults to the engine journal's redactor. */
  readonly redact?: (text: string) => string
} = {}): TargetRunHistory => {
  const maxJournalLogChars = options.maxJournalLogChars ?? MAX_JOURNAL_LOG_CHARS
  const redact = options.redact ?? defaultRedact
  const runs = new Map<string, StoredRun>()
  /*
   * One load per repository, INCLUDING the one still in flight: two requests
   * for the same repo can land together, and answering the second from the
   * half-loaded map shows an empty history and 404s a replay for runs that
   * are on disk.
   */
  const loading = new Map<string, Promise<void>>()
  /** Runs whose events are resident, least recently used first. */
  const resident = new Map<string, StoredRun>()

  const touch = (stored: StoredRun): void => {
    resident.delete(stored.record.runId)
    resident.set(stored.record.runId, stored)
    if (resident.size <= MAX_RESIDENT_RUNS) return
    for (const [runId, candidate] of resident) {
      if (resident.size <= MAX_RESIDENT_RUNS) break
      if (candidate === stored || !settled(candidate) || candidate.appendError !== undefined) continue
      resident.delete(runId)
      candidate.events = undefined
      candidate.logChars = 0
    }
  }

  const loadRepo = (repoId: string, repo: string): Promise<void> => {
    const inFlight = loading.get(repo)
    if (inFlight !== undefined) return inFlight
    const promise = readRepo(repoId, repo)
    loading.set(repo, promise)
    return promise
  }

  const readRepo = async (repoId: string, repo: string): Promise<void> => {
    const dir = runsDir(repo)
    let names: Array<string>
    try { names = await readdir(dir) } catch { return }
    const pending = names.filter((name) => name.endsWith(".jsonl")).sort()
    const load = async (name: string): Promise<void> => {
      const path = join(dir, name)
      /* Only the record is derived here; replay reads the tail on demand. */
      let { record } = await readJournal(path, repoId, false)
      if (record === undefined) return
      // A record that never settled belongs to a run that died with the
      // previous process; after a restart it can never finish, so report it
      // as failed instead of leaving it "running" forever.
      if (record.status === "pending" || record.status === "running") record = {
        ...record, status: "failed",
        journal: { state: "degraded", error: "Journal has no terminal record; the run was interrupted or an append failed." }
      }
      // A run started in this process is already registered; its live state wins.
      if (runs.has(record.runId)) return
      runs.set(record.runId, { record, events: undefined, path, queue: Promise.resolve(), logChars: 0, journalChars: 0, truncated: false, pendingChars: 0, waiters: [] })
    }
    await Promise.all(Array.from({ length: MAX_JOURNAL_LOADS }, async () => {
      for (let name = pending.shift(); name !== undefined; name = pending.shift()) await load(name)
    }))
  }

  const release = (stored: StoredRun, chars: number): void => {
    stored.pendingChars -= chars
    if (stored.pendingChars > MAX_PENDING_LOG_CHARS) return
    const waiters = stored.waiters.splice(0)
    for (const wake of waiters) wake()
  }

  return {
    flush: async () => {
      const storedRuns = [...runs.values()]
      await Promise.all(storedRuns.map((stored) => stored.queue))
      const errors = storedRuns.flatMap((stored) => stored.appendError === undefined ? [] : [stored.appendError])
      if (errors.length > 0) throw new AggregateError(errors, "Target run journal append failed.")
    },
    start: async (run) => {
      const dir = runsDir(run.repo)
      const record: RunRecord = {
        runId: run.runId, repoId: run.repoId, label: run.label, labels: [...run.labels], status: "pending", startedAt: run.startedAt
      }
      const path = join(dir, `${run.runId}.jsonl`)
      // Register now: the runner may emit while old journals are loading. Its
      // appends queue behind initialization instead of being silently dropped.
      const initialized = loadRepo(run.repoId, run.repo).then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        // Run output is local state: keep every journal out of commits.
        await writeFile(join(uiDir(run.repo), ".gitignore"), "*\n")
        await writeFile(path, encode({ type: "record", record }), { mode: 0o600 })
      })
      const stored: StoredRun = { record, events: [], path, queue: initialized, logChars: 0, journalChars: 0, truncated: false, pendingChars: 0, waiters: [] }
      runs.set(run.runId, stored)
      touch(stored)
      try {
        await initialized
      } catch (error) {
        if (runs.get(run.runId) === stored) {
          runs.delete(run.runId)
          resident.delete(run.runId)
        }
        throw error
      }
    },
    event: (run, raw) => {
      const stored = runs.get(run.runId)
      if (stored === undefined) return Promise.resolve()
      const endedAt = Date.now()
      const chars = logChars(raw)
      stored.pendingChars += chars
      stored.queue = stored.queue.then(async () => {
        // A missing frame must never be followed by an apparently complete
        // journal. Keep the first error and the last acknowledged prefix.
        if (stored.appendError !== undefined) return
        if (chars > 0 && stored.truncated) return
        // Redacting here, inside the queue, lets the pending budget pace a
        // producer by the redactor's cost as well as the disk's.
        const received = raw.type === "stdout" || raw.type === "stderr" ? { ...raw, data: redact(raw.data) } : raw
        const written = logChars(received)
        const event: TargetRunEvent = chars > 0 && stored.journalChars + written > maxJournalLogChars
          ? { type: "stderr", data: JOURNAL_TRUNCATED_MARKER, ...(raw.seq === undefined ? {} : { seq: raw.seq }) }
          : received
        const record = applyEvent(stored.record, event, endedAt)
        const line = encode({ type: "event", event }) + (event.type === "exit" ? encode({ type: "record", record }) : "")
        await appendFile(stored.path, line)
        stored.record = record
        if (event !== received) stored.truncated = true
        else stored.journalChars += written
        if (stored.events !== undefined) {
          const tail: Tail = { events: stored.events, logChars: stored.logChars }
          retain(tail, event)
          stored.events = tail.events
          stored.logChars = tail.logChars
        }
        // The exit frame settles the run; from here its tail may be evicted.
        if (event.type === "exit") touch(stored)
      }).catch((error: unknown) => {
        if (stored.appendError !== undefined) return
        const message = `Target run ${run.runId} journal append failed: ${error instanceof Error ? error.message : String(error)}`
        stored.appendError = new Error(message, { cause: error })
        stored.record = {
          ...stored.record,
          status: stored.record.status === "pending" || stored.record.status === "running" ? "failed" : stored.record.status,
          journal: { state: "degraded", error: message }
        }
        // Logging is diagnostic; even a throwing logger cannot erase the
        // failure retained for list/replay and the rejecting flush boundary.
        try { (options.log ?? console.error)(message) } catch { /* Error remains on the record. */ }
      }).finally(() => release(stored, chars))
      if (stored.pendingChars <= MAX_PENDING_LOG_CHARS) return Promise.resolve()
      return new Promise<void>((resolve) => stored.waiters.push(resolve))
    },
    list: async (repoId, repo) => {
      await loadRepo(repoId, repo)
      const selected = [...runs.values()].filter((stored) => stored.record.repoId === repoId)
      await Promise.all(selected.map((stored) => stored.queue))
      return selected.map((stored) => stored.record).sort((a, b) => b.startedAt - a.startedAt)
    },
    replay: async (runId, repos = []) => {
      for (const repo of repos) await loadRepo(repo.id, repo.path)
      const stored = runs.get(runId)
      if (stored === undefined) return undefined
      await stored.queue
      if (stored.events === undefined) {
        const loaded = await readJournal(stored.path, stored.record.repoId, true)
        // The queue is idle and the run settled, so the journal is complete;
        // a concurrent replay may have restored the tail meanwhile.
        if (stored.events === undefined) {
          stored.events = loaded.events
          stored.logChars = loaded.logChars
        }
      }
      touch(stored)
      const events = stored.events.map((event, index) => ({ event, index }))
        .sort((a, b) => (a.event.seq ?? a.index) - (b.event.seq ?? b.index) || a.index - b.index)
        .map(({ event }) => event)
      return { run: stored.record, events }
    }
  }
}
