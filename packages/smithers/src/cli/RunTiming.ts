/**
 * Where a run's time and tokens went, folded from the events `runs show`
 * already reads.
 *
 * The need is concrete. Every per-call table in the 2026-10 speed comparison
 * with stock Codex was built by throwaway scripts reading
 * `flows_journal_events` out of a benchmark trial's `control.db`, because the
 * status card answers what a run did and not how long each part of it took.
 * This is that report: one row per model call, one per frame, the run's wall
 * time split into model wait, cells, judge, compaction and other, its tokens
 * and cost by purpose, and the least-squares speed fit the comparison used.
 *
 * Pure and total like `Forensics`: a function of the `ControlEvent` stream, so
 * a run copied from another machine and a run read through `--remote` report
 * the same numbers, and a malformed journal yields a sparse report, never a
 * throw. A field a newer journal carries (wire `timing`, a `purpose`, a
 * compaction's cause) is read when present; a number worked out without it is
 * named in {@link Report.derived}.
 *
 * Durations are whole milliseconds. Offsets count from the run's first event,
 * and a call's stage offsets from the call's own start. No key ends in
 * `token` or `tokens`: the journal's redaction replaces such a value, and a
 * report is pasted into issues and bug reports.
 *
 * @since 1.0.0
 */

import { ControlSchema } from "@smthrs/control"
import {
  asNumber,
  asRecord,
  asString,
  callScope,
  foreignVerdict,
  timeOf,
  uniqueCallEvents
} from "@smthrs/gateway/Diagnosis"
import { terminalSafe } from "../internal/Failure.ts"
import { observational } from "./RunActivity.vibe"

/**
 * When one model call's stream reached each stage as the harness saw it, in
 * milliseconds from the call's start: the `stages` a settle record carries.
 * These readings are taken after the host's own handling of the stream, so the
 * gap between one and the same stage of {@link Timing} is time the host spent.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stages {
  readonly firstEventMs?: number
  readonly firstThinkingMs?: number
  readonly firstOutputMs?: number
  readonly lastOutputMs?: number
}

/**
 * When each stage of one model call was reached on the wire, in milliseconds
 * from the call's start: the `timing` record the model package measures. A
 * stage the wire did not see is absent.
 *
 * @category models
 * @since 1.0.0
 */
export interface Timing extends Stages {
  readonly preparedMs?: number
  readonly signedMs?: number
  readonly sentMs?: number
  readonly headersMs?: number
  readonly completedMs?: number
  readonly closedMs?: number
}

const stageNames = [
  "firstEventMs",
  "firstThinkingMs",
  "firstOutputMs",
  "lastOutputMs"
] as const satisfies ReadonlyArray<
  keyof Stages
>
const timingNames = [
  "preparedMs",
  "signedMs",
  "sentMs",
  "headersMs",
  ...stageNames,
  "completedMs",
  "closedMs"
] as const satisfies ReadonlyArray<keyof Timing>

/**
 * One try of a model call that failed and was tried again inside the call,
 * in milliseconds from the call's start.
 *
 * @category models
 * @since 1.0.0
 */
export interface FailedTry {
  readonly sentMs?: number
  readonly failedMs: number
  readonly code: string
  readonly httpStatus?: number
}

/**
 * One model call's token counts. `uncached` is `input` less `cached`, and
 * `written` is the output less `thinking`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Usage {
  readonly input: number
  readonly cached: number
  readonly uncached: number
  readonly thinking: number
  readonly written: number
}

/**
 * One model call. A re-ask of a frame and a call that never settled are rows
 * of their own.
 *
 * @category models
 * @since 1.0.0
 */
export interface ModelCall {
  /** Position among the run's model calls, from 1. */
  readonly index: number
  readonly frame: number
  /** Which ask of the frame this is: 1, or more after a rejected reply. */
  readonly ask: number
  readonly purpose: string
  /** The step that made the call, for a run whose steps keep frames of their own. */
  readonly step?: string
  readonly startMs: number
  /** The call's recorded duration; for an unsettled call, the time until the event that ended it. */
  readonly durationMs: number
  readonly settled: boolean
  /** Time before the first thinking or output token, as the harness saw it when it timed the stream. */
  readonly waitMs?: number
  readonly thinkingMs?: number
  readonly writingMs?: number
  /** Time between the first output reaching the wire and reaching the harness: `stages` less `timing`. */
  readonly hostMs?: number
  readonly stages?: Stages
  readonly timing?: Timing
  readonly requestBytes?: number
  readonly servedTier?: string
  readonly usage?: Usage
  /** Tokens the call spent: its usage, or the ledger's entry for a call that never settled. */
  readonly spent?: number
  readonly cacheShare?: number
  readonly costUsd?: number
  /** Tries of this one call, the answered one and the wire's retries inside it included. */
  readonly tries: number
  /** The tries that failed before the answered one, as the wire timed them. */
  readonly failedTries?: ReadonlyArray<FailedTry>
  /** What the call's cell amounted to: `calls`, `no_call`, `comment_only`, `threw`, `rejected`. */
  readonly work?: string
  /** Whether the call's cell made a flow call or, in a journal that does not say, changed the workspace. */
  readonly moved?: boolean
  /** Why the reply was rejected before its cell ran. */
  readonly rejected?: string
}

/**
 * A span of wall time split so that every instant belongs to one part.
 *
 * `judgeMs` is the time a judge reading held the run up. A reading that
 * settles beside a model call, a compaction or a cell costs no wall time and
 * counts under that part.
 *
 * @category models
 * @since 1.0.0
 */
export interface Time {
  readonly modelMs: number
  readonly cellsMs: number
  readonly judgeMs: number
  readonly compactionMs: number
  readonly otherMs: number
}

/**
 * One frame's share of the run, from its first model request to the next
 * frame's. `start` is the run before its first request and `end` the run
 * after its last turn closed.
 *
 * @category models
 * @since 1.0.0
 */
export interface Frame extends Time {
  readonly frame: number | "start" | "end"
  readonly step?: string
  readonly wallMs: number
  /** Calls counted under `modelMs`: a compaction's summary call is compaction time. */
  readonly modelCalls: number
  readonly cellCalls: number
}

/**
 * Tokens and cost of one purpose. A split the records do not carry is absent.
 *
 * @category models
 * @since 1.0.0
 */
export interface Spend {
  readonly purpose: string
  /** Model calls or judge readings. */
  readonly calls: number
  readonly input?: number
  readonly cached?: number
  readonly uncached?: number
  readonly thinking?: number
  readonly written?: number
  readonly spent: number
  readonly costUsd: number
}

/**
 * One compaction.
 *
 * @category models
 * @since 1.0.0
 */
export interface Compaction {
  readonly frame?: number
  readonly startMs: number
  readonly durationMs?: number
  readonly cause?: string
  /** Context size before and after, in tokens. */
  readonly contextBefore?: number
  readonly contextAfter?: number
  /** Tokens the removed messages held. */
  readonly freed?: number
  readonly marks?: { readonly kept: number; readonly squashed: number; readonly removed: number }
  /** Tokens its summary call spent. */
  readonly spent?: number
}

/**
 * One judge reading that acted on the run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Fired {
  readonly frame?: number
  readonly purpose: string
  readonly startMs: number
  readonly latencyMs: number
  /** What fired: trigger or monitor names, `nudged`, `demanded`, `refused`, `acted`. */
  readonly fired: ReadonlyArray<string>
}

/**
 * Call duration fitted as `fixedMs + perThinkingMs * thinking + perWrittenMs *
 * written` by least squares over the settled calls.
 *
 * @category models
 * @since 1.0.0
 */
export interface Speed {
  readonly calls: number
  readonly fixedMs: number
  readonly perThinkingMs: number
  readonly perWrittenMs: number
  readonly r2: number
}

/**
 * A straight line through one stage of the calls: `fixedMs + perMs * tokens`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Line {
  readonly fixedMs: number
  readonly perMs: number
  readonly r2: number
}

/**
 * Thinking and writing fitted separately from the wire's `timing`: headers to
 * first output against thinking tokens, and first to last output against
 * written tokens, with the mean wait for headers beside them.
 *
 * @category models
 * @since 1.0.0
 */
export interface StageFit {
  readonly calls: number
  readonly headersMeanMs: number
  readonly thinking?: Line
  readonly writing?: Line
}

/**
 * One number the report worked out because the journal did not record it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Derived {
  readonly field: string
  readonly from: string
}

/**
 * Where one run's time and tokens went.
 *
 * @category models
 * @since 1.0.0
 */
export interface Report {
  readonly runId?: string
  readonly status?: string
  readonly startedAt?: number
  readonly endedAt?: number
  /** First to last event the fold was given; `time` and `frames` each sum to it. */
  readonly wallMs: number
  readonly time: Time
  /** By purpose; the rows sum to `total`. */
  readonly spend: ReadonlyArray<Spend>
  readonly total: { readonly calls: number; readonly spent: number; readonly costUsd: number }
  /** The run's usage ledger, when it kept one. */
  readonly ledger?: { readonly entries: number; readonly spent: number; readonly costUsd: number }
  /** Cached share of the input tokens the model calls sent. */
  readonly cacheShare?: number
  readonly calls: ReadonlyArray<ModelCall>
  readonly frames: ReadonlyArray<Frame>
  /** Flow calls the cells made, and the part of `time.cellsMs` spent inside them. */
  readonly flowCalls: { readonly calls: number; readonly durationMs: number }
  /** Cells by what they amounted to, when the journal records it. */
  readonly cellWork?: Readonly<Record<string, number>>
  /** Thinking and writing fitted apart, from the wire's stages. */
  readonly stageFit?: StageFit
  /** Over the calls that carry wire timing: the time before each request was sent. */
  readonly beforeSent?: { readonly calls: number; readonly durationMs: number }
  /** Over the calls that carry both records: the time in the host after the first output reached the wire. */
  readonly host?: { readonly calls: number; readonly durationMs: number }
  /** Settled calls whose reply was rejected or whose frame left the workspace unchanged. */
  readonly unmoved: { readonly calls: number; readonly durationMs: number; readonly spent: number }
  readonly compactions: ReadonlyArray<Compaction>
  readonly judge: { readonly readings: number; readonly latencyMs: number; readonly fired: ReadonlyArray<Fired> }
  readonly speed?: Speed
  readonly derived: ReadonlyArray<Derived>
}

/** What an instant of the run is spent on, most specific first. */
const parts = ["model", "compaction", "calls", "cells", "judge"] as const
type Part = typeof parts[number]

interface Interval {
  readonly part: Part
  readonly from: number
  readonly to: number
}

interface Call {
  frame: number
  ask: number
  purpose: string
  step: string | undefined
  frameKey: string
  startAt: number
  durationMs: number
  settled: boolean
  retries: number
  tries: number | undefined
  attempts: number | undefined
  failedTries: ReadonlyArray<FailedTry> | undefined
  stages: Stages | undefined
  timing: Timing | undefined
  requestBytes: number | undefined
  servedTier: string | undefined
  usage: Usage | undefined
  spent: number | undefined
  costUsd: number | undefined
  moved: boolean | undefined
  work: string | undefined
  rejected: string | undefined
  /** Whether a ledger entry has been matched to the call. */
  paid: boolean
}

interface Reading {
  readonly purpose: string
  readonly frame: number | undefined
  readonly endAt: number
  readonly latencyMs: number
  readonly input: number
  readonly output: number
  readonly fired: ReadonlyArray<string>
  /** Whether the reading's own record priced it; the ledger prices the rest. */
  readonly priced: boolean
  costUsd: number
}

/** One execution's position: the run itself, or one step of a module run. */
interface Scope {
  readonly executionId: string | undefined
  turns: number
  frame: number | undefined
  open: Call | undefined
  last: Call | undefined
  cellAt: number | undefined
}

/** Seat-model purposes; every other labelled spend is a judge-model reading. */
const modelPurposes: ReadonlySet<string> = new Set(["frame", "compaction"])

/** The purpose a classifier's readings are filed under when no record labels them. */
const readingPurposes: Readonly<Record<string, string>> = {
  supervisor: "judge",
  compaction: "marks",
  completion: "claim"
}

/**
 * Classifier families whose reading also writes a record of its own
 * (`supervisor-settled`, `relevance-settled`, `claim-demanded`), which is the
 * one counted.
 */
const recordedFamilies: ReadonlySet<string> = new Set(["supervisor", "relevance", "completion"])

const purposeOrder = ["frame", "compaction", "judge", "marks", "claim", "relevance", "reading"]

const usageEvent = "flows.agent.usage.v1"

/** Every number the fold may work out instead of read, and what it works it out from. */
const derivations = {
  time: "event stamps: model, compaction, cells, then judge",
  frames: "that split, cut at each frame's first request",
  "call frame": "turns opened before the request",
  "call total": "request stamp to settle stamp",
  "call tries": "1 + model-retried records inside the call",
  "call moved": "mutation-observed; a rejected reply moved nothing",
  "unsettled call total": "request stamp to the event that ended the call",
  "unsettled call tokens": "the ledger entry written while the call was open",
  "reading cost": "one ledger entry split across readings by tokens",
  "compaction total": "summary request stamp to compaction-settled stamp",
  "judge fired": "crossed monitors and the nudged flag"
} as const

const terminal: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])
const statuses: ReadonlySet<string> = new Set(ControlSchema.RunStatus.literals)

const count = (value: unknown): number | undefined => {
  const number = asNumber(value)
  return number !== undefined && Number.isFinite(number) && number >= 0 ? number : undefined
}

/** A call's counts from its `usage`, with the settle's own `output` split where usage reports no thinking. */
const usageOf = (value: unknown, split?: unknown): Usage | undefined => {
  const usage = asRecord(value)
  const input = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  if (input === undefined && output === undefined) return undefined
  const cached = Math.min(count(usage.cachedInputTokens) ?? 0, input ?? 0)
  const thinking = Math.min(count(usage.reasoningTokens) ?? count(asRecord(split).thinking) ?? 0, output ?? 0)
  return {
    input: input ?? 0,
    cached,
    uncached: (input ?? 0) - cached,
    thinking,
    written: (output ?? 0) - thinking
  }
}

const reached = <Name extends string>(
  record: unknown,
  names: ReadonlyArray<Name>
): { readonly [K in Name]?: number } | undefined => {
  const stages = names.flatMap((name) => {
    const at = count(asRecord(record)[name])
    return at === undefined ? [] : [[name, at] as const]
  })
  return stages.length === 0 ? undefined : Object.fromEntries(stages) as { readonly [K in Name]?: number }
}

/** The strings of a journaled list of names, made terminal-inert. */
const names = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.flatMap((name) => typeof name === "string" ? [terminalSafe(name)] : []) : []

const failedTriesOf = (value: unknown): ReadonlyArray<FailedTry> | undefined => {
  if (!Array.isArray(value)) return undefined
  const tries = value.flatMap((entry): Array<FailedTry> => {
    const failed = asRecord(entry)
    const failedMs = count(failed.failedMs)
    const sentMs = count(failed.sentMs)
    const httpStatus = count(failed.httpStatus)
    return failedMs === undefined ? [] : [{
      ...(sentMs === undefined ? {} : { sentMs }),
      failedMs,
      code: terminalSafe(asString(failed.code) ?? "?"),
      ...(httpStatus === undefined ? {} : { httpStatus })
    }]
  })
  return tries.length === 0 ? undefined : tries
}

const span = (from: number | undefined, to: number | undefined): number | undefined =>
  from === undefined || to === undefined || to < from ? undefined : to - from

/**
 * Least squares of `y = a + b * thinking + c * written` by the normal
 * equations. Nothing is fitted from fewer than four calls, or from calls whose
 * thinking and written counts move together, because no fit can then tell the
 * two rates apart.
 */
const fit = (
  rows: ReadonlyArray<readonly [thinking: number, written: number, durationMs: number]>
): Speed | undefined => {
  if (rows.length < 4) return undefined
  const matrix = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  for (const [thinking, written, duration] of rows) {
    const x = [1, thinking, written]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) matrix[i]![j]! += x[i]! * x[j]!
      matrix[i]![3]! += x[i]! * duration
    }
  }
  const scale = matrix.map((row, index) => Math.abs(row[index]!))
  for (let i = 0; i < 3; i++) {
    let pivot = i
    for (let k = i + 1; k < 3; k++) if (Math.abs(matrix[k]![i]!) > Math.abs(matrix[pivot]![i]!)) pivot = k
    ;[matrix[i], matrix[pivot]] = [matrix[pivot]!, matrix[i]!]
    const head = matrix[i]![i]!
    if (Math.abs(head) <= 1e-9 * Math.max(1, scale[i]!)) return undefined
    for (let j = i; j < 4; j++) matrix[i]![j]! /= head
    for (let k = 0; k < 3; k++) {
      if (k === i) continue
      const factor = matrix[k]![i]!
      for (let j = i; j < 4; j++) matrix[k]![j]! -= factor * matrix[i]![j]!
    }
  }
  const [fixedMs, perThinkingMs, perWrittenMs] = [matrix[0]![3]!, matrix[1]![3]!, matrix[2]![3]!]
  const mean = rows.reduce((total, row) => total + row[2], 0) / rows.length
  let spread = 0
  let residual = 0
  for (const [thinking, written, duration] of rows) {
    spread += (duration - mean) ** 2
    residual += (duration - (fixedMs + perThinkingMs * thinking + perWrittenMs * written)) ** 2
  }
  return { calls: rows.length, fixedMs, perThinkingMs, perWrittenMs, r2: spread === 0 ? 1 : 1 - residual / spread }
}

/** Least squares of one stage's time on one token count; nothing from fewer than three calls or one count. */
const line = (points: ReadonlyArray<readonly [tokens: number, ms: number]>): Line | undefined => {
  if (points.length < 3) return undefined
  const mean = (index: 0 | 1) => points.reduce((sum, point) => sum + point[index], 0) / points.length
  const [x, y] = [mean(0), mean(1)]
  const spread = points.reduce((sum, point) => sum + (point[0] - x) ** 2, 0)
  if (spread === 0) return undefined
  const perMs = points.reduce((sum, point) => sum + (point[0] - x) * (point[1] - y), 0) / spread
  const fixedMs = y - perMs * x
  const total = points.reduce((sum, point) => sum + (point[1] - y) ** 2, 0)
  const residual = points.reduce((sum, point) => sum + (point[1] - fixedMs - perMs * point[0]) ** 2, 0)
  return { fixedMs, perMs, r2: total === 0 ? 1 : 1 - residual / total }
}

/**
 * Folds one run's events into its timing report.
 *
 * @param events the run's watch stream, in order
 * @param runId the run being reported; a `control.run.*` verdict stamped with
 *   another run's id, such as a child's, sets neither its status nor its span
 * @category constructors
 * @since 1.0.0
 */
export const fold = (events: ReadonlyArray<ControlSchema.ControlEvent>, runId?: string): Report => {
  const calls: Array<Call> = []
  const readings: Array<Reading> = []
  const intervals: Array<Interval> = []
  const compactions: Array<{ compaction: Omit<Compaction, "startMs">; from: number }> = []
  const scopes = new Map<string, Scope>()
  const frameStarts = new Map<string, { frame: number; step: string | undefined; from: number }>()
  const cellCalls = new Map<string, number>()
  /** A frame's own split, as its turn-closed record carries it. */
  const frameTimes = new Map<string, Record<string, unknown>>()
  const cellWork: Record<string, number> = {}
  const openCalls = new Map<string, number>()
  /** Spend the ledger recorded that no call or reading record accounts for, by purpose. */
  const loose = new Map<string, { calls: number; spent: number; costUsd: number }>()
  const ledger = { entries: 0, spent: 0, costUsd: 0 }
  const ledgered = new Set<string>()
  let batch: {
    spent: number
    costUsd: number
    purpose: string | undefined
    parts: ReadonlyArray<Record<string, unknown>>
    readings: Array<Reading>
  } | undefined
  /** Readings journaled since the last ledger entry closed, which a later entry may pay for. */
  let unpaid: Array<Reading> = []
  let status: string | undefined
  let startedAt: number | undefined
  let endedAt: number | undefined
  let lastTurnClosed: number | undefined
  const noted = new Set<keyof typeof derivations>()
  const note = (field: keyof typeof derivations): void => void noted.add(field)

  const scopeOf = (key: string, executionId: string | undefined): Scope => {
    let scope = scopes.get(key)
    if (scope === undefined) {
      scope = { executionId, turns: 0, frame: undefined, open: undefined, last: undefined, cellAt: undefined }
      scopes.set(key, scope)
    }
    return scope
  }
  /** A ledger entry with no record beside it: one call of its purpose, when it names one. */
  const leave = (purpose: string, spent: number, costUsd: number): void => {
    const row = loose.get(purpose) ?? { calls: 0, spent: 0, costUsd: 0 }
    loose.set(purpose, { calls: row.calls + 1, spent: row.spent + spent, costUsd: row.costUsd + costUsd })
  }
  const tokensOf = (paid: ReadonlyArray<Reading>): number =>
    paid.reduce((total, reading) => total + reading.input + reading.output, 0)
  /**
   * Splits what is left of one ledger entry's cost, after the readings whose
   * own records priced them, across the rest by their tokens.
   */
  const pay = (paid: ReadonlyArray<Reading>, costUsd: number): void => {
    const unpriced = paid.filter((reading) => !reading.priced)
    const rest = Math.max(
      0,
      costUsd - paid.reduce((total, reading) => total + (reading.priced ? reading.costUsd : 0), 0)
    )
    const tokens = tokensOf(unpriced)
    if (unpriced.length > 0 && paid.length > 1) note("reading cost")
    for (const reading of unpriced) {
      reading.costUsd += rest * (tokens === 0 ? 1 / unpriced.length : (reading.input + reading.output) / tokens)
    }
  }
  const settleBatch = (): void => {
    if (batch === undefined) return
    const entry = batch
    batch = undefined
    if (entry.readings.length === 0) return leave(entry.purpose ?? "unattributed", entry.spent, entry.costUsd)
    if (entry.parts.length === 0) return pay(entry.readings, entry.costUsd)
    // An entry that names its parts says what each purpose cost; nothing is split.
    for (const part of entry.parts) {
      const paid = entry.readings.filter((reading) => reading.purpose === part.purpose && !reading.priced)
      for (const reading of paid) reading.costUsd += (count(part.costUsd) ?? 0) / paid.length
    }
  }
  /** Ends a call no model-settled record closed, at the event that ended it. */
  const abandon = (scope: Scope, at: number): Call | undefined => {
    const call = scope.open
    if (call === undefined) return undefined
    scope.open = undefined
    call.durationMs = Math.max(0, at - call.startAt)
    note("unsettled call total")
    return call
  }
  const request = (
    scope: Scope,
    key: string,
    step: string | undefined,
    at: number,
    payload: Record<string, unknown>
  ) => {
    const recorded = count(payload.frame)
    if (recorded === undefined) note("call frame")
    const frame = recorded ?? Math.max(0, scope.turns - 1)
    const frameKey = `${key}\u0000${frame}`
    if (!frameStarts.has(frameKey)) frameStarts.set(frameKey, { frame, step, from: at })
    scope.frame = frame
    scope.open = {
      frame,
      ask: count(payload.attempt) ?? 1,
      purpose: asString(payload.purpose) ?? "frame",
      step,
      frameKey,
      startAt: at,
      durationMs: 0,
      settled: false,
      retries: 0,
      tries: undefined,
      attempts: undefined,
      failedTries: undefined,
      stages: undefined,
      timing: undefined,
      requestBytes: undefined,
      servedTier: undefined,
      usage: undefined,
      spent: undefined,
      costUsd: undefined,
      moved: undefined,
      work: undefined,
      rejected: undefined,
      paid: false
    }
    calls.push(scope.open)
    return scope.open
  }
  /** Fills a call from the record that settled it: a model-settled, or a compaction's `summaryCall`. */
  const settle = (call: Call, record: Record<string, unknown>, at: number): void => {
    const timing = asRecord(record.timing)
    const recorded = count(record.durationMillis)
    if (recorded === undefined) note("call total")
    call.settled = true
    call.durationMs = recorded ?? Math.max(0, at - call.startAt)
    call.purpose = asString(record.purpose) ?? call.purpose
    call.tries = count(record.tries)
    if (call.tries === undefined) note("call tries")
    call.attempts = count(timing.attempts)
    call.failedTries = failedTriesOf(timing.failedTries)
    call.stages = reached(record.stages, stageNames)
    call.timing = reached(record.timing, timingNames)
    call.requestBytes = count(timing.requestBytes)
    call.servedTier = asString(record.servedTier) ?? asString(timing.servedTier)
    call.usage = usageOf(record.usage, record.output)
    if (call.usage !== undefined) {
      call.spent = count(asRecord(record.usage).totalTokens) ??
        call.usage.input + call.usage.thinking + call.usage.written
    }
    call.costUsd = count(record.costUsd) ?? call.costUsd
  }
  const read = (reading: Omit<Reading, "costUsd" | "priced">, payload: Record<string, unknown>): void => {
    const costUsd = count(payload.costUsd)
    const entry = { ...reading, priced: costUsd !== undefined, costUsd: costUsd ?? 0 }
    readings.push(entry)
    if (batch === undefined) unpaid.push(entry)
    else batch.readings.push(entry)
  }
  const latency = (at: number, payload: Record<string, unknown>): number => {
    const latencyMs = count(payload.latencyMs) ?? 0
    if (latencyMs > 0) intervals.push({ part: "judge", from: at - latencyMs, to: at })
    return latencyMs
  }

  for (const event of uniqueCallEvents(events)) {
    if (observational.has(event.kind) || foreignVerdict(event, runId)) continue
    const payload = asRecord(event.payload)
    const at = timeOf(event)
    startedAt = startedAt === undefined ? at : Math.min(startedAt, at)
    endedAt = endedAt === undefined ? at : Math.max(endedAt, at)
    const key = callScope(event) ?? ""
    const scope = scopeOf(key, asString(asRecord(payload.step).executionId) ?? event.runId)
    const step = asString(asRecord(payload.step).stepId)

    // The ledger journals a usage record on its own, or as an engine event
    // when a flow call spent it. A step key is one entry whichever form holds it.
    const usage = event.kind === usageEvent
      ? payload
      : event.kind === "control.engine.event" && payload.eventType === usageEvent
      ? asRecord(payload.payload)
      : undefined
    if (usage !== undefined) {
      const spent = count(usage.spent)
      const stepKey = asString(usage.stepKey)
      if (spent === undefined || (stepKey !== undefined && ledgered.has(stepKey))) continue
      if (stepKey !== undefined) ledgered.add(stepKey)
      const costUsd = count(usage.costUsd) ?? 0
      // A reading the agent's own cell asked for is keyed `call-reading/` and has no record beside it.
      const purpose = asString(usage.purpose) ?? (stepKey?.startsWith("call-reading/") ? "reading" : undefined)
      ledger.entries += 1
      ledger.spent += spent
      ledger.costUsd += costUsd
      if (purpose === "reading") {
        leave(purpose, spent, costUsd)
        continue
      }
      const reading = purpose === undefined
        ? stepKey?.startsWith("boundary-usage/") === true
        : !modelPurposes.has(purpose)
      if (reading) {
        settleBatch()
        // An entry is journaled before the readings it paid for. One journaled
        // after them is theirs when it spent exactly what they did.
        if (unpaid.length > 0 && tokensOf(unpaid) === spent) pay(unpaid, costUsd)
        else {batch = {
            spent,
            costUsd,
            purpose,
            parts: Array.isArray(usage.parts) ? usage.parts.map(asRecord) : [],
            readings: []
          }}
        unpaid = []
        continue
      }
      // Prefer the exact step, then the native execution. Legacy records may
      // pay only an unambiguous call; journal order cannot identify concurrent work.
      const executionId = event.kind === "control.engine.event" ? asString(payload.executionId) : undefined
      const candidates = (key !== "" ?
        [scope] :
        [...scopes.values()].filter((entry) => executionId === undefined || entry.executionId === executionId)).flatMap(
          (entry) => entry.open ?? entry.last ?? []
        ).filter((call) =>
          !call.paid && (purpose === undefined || call.purpose === purpose) &&
          (count(usage.frame) === undefined || call.frame === count(usage.frame))
        )
      const call = candidates.length === 1 ? candidates[0] : undefined
      // Unmatched spend is reconciled against the ledger after call usage is folded.
      if (call !== undefined) {
        call.paid = true
        call.spent ??= spent
        call.costUsd ??= costUsd
      }
      continue
    }
    if (event.kind.startsWith("control.run.")) {
      const suffix = event.kind.slice("control.run.".length)
      if (!statuses.has(suffix)) continue
      status = suffix
      if (terminal.has(suffix)) { for (const entry of scopes.values()) abandon(entry, at) }
      continue
    }
    if (!event.kind.startsWith("control.agent.")) continue

    switch (event.kind.slice("control.agent.".length)) {
      case "turn-opened":
        scope.turns += 1
        break
      case "turn-closed": {
        const frame = count(payload.frame)
        if (frame !== undefined && payload.time !== undefined) {
          frameTimes.set(`${step === undefined ? "" : terminalSafe(step)}\u0000${frame}`, asRecord(payload.time))
        }
        abandon(scope, at)
        lastTurnClosed = lastTurnClosed === undefined ? at : Math.max(lastTurnClosed, at)
        break
      }
      case "model-requested":
        abandon(scope, at)
        request(scope, key, step, at, payload)
        break
      case "model-retried":
        if (scope.open !== undefined) scope.open.retries += 1
        break
      case "model-settled": {
        // A journal that kept no request record still holds the call's duration.
        const call = scope.open ?? request(scope, key, step, at - (count(payload.durationMillis) ?? 0), payload)
        scope.open = undefined
        scope.last = call
        settle(call, payload, at)
        break
      }
      case "cell-rejected-in-frame":
        if (scope.last !== undefined) {
          scope.last.rejected = asString(payload.code) ?? "rejected"
          scope.last.moved = false
        }
        break
      case "mutation-observed":
        // A cell that recorded its own work has already said whether the call moved anything.
        if (
          scope.last !== undefined && scope.last.rejected === undefined && scope.last.work === undefined &&
          typeof payload.mutated === "boolean"
        ) {
          scope.last.moved = payload.mutated
          note("call moved")
        }
        break
      case "cell-produced":
        scope.cellAt = at
        break
      case "cell-settled": {
        if (scope.cellAt !== undefined) intervals.push({ part: "cells", from: scope.cellAt, to: at })
        scope.cellAt = undefined
        const kind = asString(asRecord(payload.work).kind)
        if (kind === undefined) break
        cellWork[terminalSafe(kind)] = (cellWork[terminalSafe(kind)] ?? 0) + 1
        if (scope.last !== undefined) {
          scope.last.work = terminalSafe(kind)
          scope.last.moved = kind === "calls"
        }
        break
      }
      case "cell-call-started": {
        const frameKey = `${key}\u0000${scope.frame ?? Math.max(0, scope.turns - 1)}`
        cellCalls.set(frameKey, (cellCalls.get(frameKey) ?? 0) + 1)
        openCalls.set(`${key}\u0000${asString(payload.callId) ?? asString(payload.flowName) ?? ""}`, at)
        break
      }
      case "cell-call-settled": {
        const id = `${key}\u0000${asString(payload.callId) ?? asString(payload.flowName) ?? ""}`
        const recorded = count(payload.durationMillis)
        const from = recorded === undefined ? openCalls.get(id) : at - recorded
        openCalls.delete(id)
        if (from !== undefined) intervals.push({ part: "calls", from, to: at })
        break
      }
      case "compaction-settled": {
        const recorded = count(payload.durationMillis)
        // Its summary call settles here, on `summaryCall`, and not as a model-settled of its own.
        const settledHere = payload.summaryCall === undefined ? undefined : asRecord(payload.summaryCall)
        if (scope.open?.purpose !== "compaction" && settledHere !== undefined) {
          // A journal that kept no request record for it still holds the call's duration.
          abandon(scope, at)
          request(scope, key, step, at - (recorded ?? 0), { frame: payload.frame, purpose: "compaction" })
        }
        const summary = scope.open?.purpose === "compaction" ? scope.open : undefined
        if (summary !== undefined && settledHere !== undefined) {
          scope.open = undefined
          settle(summary, settledHere, at)
        } else if (summary !== undefined) abandon(scope, at)
        const from = recorded !== undefined ? at - recorded : summary?.startAt ?? at
        if (recorded === undefined && summary !== undefined) note("compaction total")
        const marks = asRecord(payload.marks)
        const frame = count(payload.frame) ?? summary?.frame
        const durationMs = recorded ?? (summary === undefined ? undefined : at - from)
        const cause = names(payload.causes).join(", ") || undefined
        const before = count(asRecord(payload.context).before)
        const after = count(asRecord(payload.context).after)
        const freed = count(payload.removed)
        intervals.push({ part: "compaction", from, to: at })
        compactions.push({
          from,
          compaction: {
            ...(frame === undefined ? {} : { frame }),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(cause === undefined ? {} : { cause: terminalSafe(cause) }),
            ...(before === undefined ? {} : { contextBefore: before }),
            ...(after === undefined ? {} : { contextAfter: after }),
            ...(freed === undefined ? {} : { freed }),
            ...(payload.marks === undefined ? {} : {
              marks: {
                kept: count(marks.kept) ?? 0,
                squashed: count(marks.squashed) ?? 0,
                removed: count(marks.removed) ?? 0
              }
            }),
            ...(summary?.spent === undefined ? {} : { spent: summary.spent })
          }
        })
        break
      }
      case "supervisor-settled": {
        const usage = asRecord(payload.usage)
        const monitors = Array.isArray(payload.monitors)
          ? payload.monitors.flatMap((monitor) => {
            const entry = asRecord(monitor)
            return entry.crossed === true ? [terminalSafe(asString(entry.id) ?? "crossed")] : []
          })
          : []
        // A reading journaled before it named its triggers still says which monitors crossed.
        if (!Array.isArray(payload.triggers) && (payload.crossed === true || payload.nudged === true)) {
          note("judge fired")
        }
        const suppressed = asString(payload.compactSuppressed)
        read({
          purpose: asString(payload.purpose) ?? "judge",
          frame: count(payload.frame),
          endAt: at,
          latencyMs: latency(at, payload),
          input: count(usage.inputTokens) ?? 0,
          output: count(usage.outputTokens) ?? 0,
          fired: [
            ...names(payload.triggers),
            ...(monitors.length === 0 && payload.crossed === true ? ["crossed"] : monitors),
            ...(payload.nudged === true ? ["nudged"] : []),
            ...(names(payload.compact).length > 0 ? ["compact"] : []),
            ...(suppressed === undefined ? [] : [`compact suppressed: ${terminalSafe(suppressed)}`])
          ]
        }, payload)
        break
      }
      case "relevance-settled":
      case "claim-demanded": {
        const claim = event.kind.endsWith("claim-demanded")
        const usage = asRecord(payload.usage)
        const next = count(payload.nextFrame)
        read({
          purpose: asString(payload.purpose) ?? (claim ? "claim" : "relevance"),
          frame: claim ? (next === undefined ? undefined : Math.max(0, next - 1)) : count(payload.frame),
          endAt: at,
          latencyMs: latency(at, payload),
          input: count(usage.inputTokens) ?? 0,
          output: count(usage.outputTokens) ?? 0,
          fired: [...(payload.demanded === true ? ["demanded"] : []), ...(payload.refused === true ? ["refused"] : [])]
        }, payload)
        break
      }
      case "decision-settled": {
        const family = (asString(payload.classifier) ?? "").split("/")[0] ?? ""
        const latencyMs = latency(at, payload)
        if (recordedFamilies.has(family)) break
        const usage = asRecord(payload.usage)
        read({
          purpose: asString(payload.purpose) ?? readingPurposes[family] ??
            (family === "" ? "judge" : terminalSafe(family)),
          frame: count(payload.frame),
          endAt: at,
          latencyMs,
          input: count(usage.inputTokens) ?? 0,
          output: count(usage.outputTokens) ?? 0,
          fired: payload.acted === true ? ["acted"] : []
        }, payload)
        break
      }
    }
  }
  settleBatch()
  const start = startedAt ?? 0
  const end = endedAt ?? start
  for (const scope of scopes.values()) {
    abandon(scope, end)
    if (scope.cellAt !== undefined) intervals.push({ part: "cells", from: scope.cellAt, to: end })
  }
  for (const call of calls) {
    intervals.push({
      part: call.purpose === "compaction" ? "compaction" : "model",
      from: call.startAt,
      to: call.startAt + call.durationMs
    })
  }

  // Frame spans tile the run: before the first request, one per frame from its
  // first request, and after the last turn closed.
  const starts = [...frameStarts.entries()].sort(([, left], [, right]) => left.from - right.from)
  const spans: Array<{ key: string; frame: Frame["frame"]; step: string | undefined; from: number }> = [
    { key: "start", frame: "start", step: undefined, from: start },
    ...starts.map(([key, value]) => ({ key, frame: value.frame, step: value.step, from: value.from }))
  ]
  if (lastTurnClosed !== undefined && starts.length > 0 && lastTurnClosed >= starts.at(-1)![1].from) {
    spans.push({ key: "end", frame: "end", step: undefined, from: lastTurnClosed })
  }
  const empty = (): Record<Part | "other", number> => ({
    model: 0,
    compaction: 0,
    calls: 0,
    cells: 0,
    judge: 0,
    other: 0
  })
  const overall = empty()
  const perSpan = spans.map(empty)
  const clamp = (at: number): number => Math.min(end, Math.max(start, at))
  const edges = intervals.flatMap((interval) => {
    const from = clamp(interval.from)
    const to = clamp(interval.to)
    return to > from ? [{ at: from, part: interval.part, delta: 1 }, { at: to, part: interval.part, delta: -1 }] : []
  }).sort((left, right) => left.at - right.at)
  const cuts = [...new Set([start, end, ...edges.map((edge) => edge.at), ...spans.map((entry) => clamp(entry.from))])]
    .sort((left, right) => left - right)
  const active: Record<Part, number> = { model: 0, compaction: 0, calls: 0, cells: 0, judge: 0 }
  let edge = 0
  let current = 0
  for (const [index, from] of cuts.entries()) {
    const to = cuts[index + 1]
    if (to === undefined) break
    while (edge < edges.length && edges[edge]!.at <= from) {
      active[edges[edge]!.part] += edges[edge]!.delta
      edge += 1
    }
    while (current + 1 < spans.length && spans[current + 1]!.from <= from) current += 1
    const part = parts.find((name) => active[name] > 0) ?? "other"
    overall[part] += to - from
    perSpan[current]![part] += to - from
  }
  const frames = spans.flatMap((entry, index): Array<Frame> => {
    const split = perSpan[index]!
    const wallMs = split.model + split.compaction + split.calls + split.cells + split.judge + split.other
    if (wallMs === 0 && typeof entry.frame === "string") return []
    return [{
      frame: entry.frame,
      ...(entry.step === undefined ? {} : { step: terminalSafe(entry.step) }),
      wallMs,
      modelMs: split.model,
      modelCalls: calls.filter((call) => call.frameKey === entry.key && call.purpose !== "compaction").length,
      cellsMs: split.calls + split.cells,
      cellCalls: cellCalls.get(entry.key) ?? 0,
      judgeMs: split.judge,
      compactionMs: split.compaction,
      otherMs: split.other
    }]
  })
  const recordedTime = (frame: Frame) => frameTimes.get(`${frame.step ?? ""}\u0000${frame.frame}`)
  if (end > start) note("time")
  if (frames.some((frame) => typeof frame.frame === "number" && recordedTime(frame) === undefined)) note("frames")
  if (calls.some((call) => !call.settled && call.spent !== undefined)) note("unsettled call tokens")

  const rows = new Map<string, { -readonly [K in keyof Spend]: Spend[K] }>()
  const rowOf = (purpose: string) => {
    let row = rows.get(purpose)
    if (row === undefined) {
      row = { purpose, calls: 0, spent: 0, costUsd: 0 }
      rows.set(purpose, row)
    }
    return row
  }
  const add = (
    row: { [K in "input" | "cached" | "uncached" | "thinking" | "written"]?: number },
    more: Partial<Usage>
  ) => {
    for (const name of ["input", "cached", "uncached", "thinking", "written"] as const) {
      if (more[name] !== undefined) row[name] = (row[name] ?? 0) + more[name]
    }
  }
  for (const call of calls) {
    const row = rowOf(call.purpose)
    row.calls += 1
    row.spent += call.spent ?? 0
    row.costUsd += call.costUsd ?? 0
    if (call.usage !== undefined) add(row, call.usage)
  }
  for (const reading of readings) {
    const row = rowOf(reading.purpose)
    row.calls += 1
    row.spent += reading.input + reading.output
    row.costUsd += reading.costUsd
    add(row, { input: reading.input, written: reading.output })
  }
  for (const [purpose, more] of loose) {
    if (purpose === "unattributed") continue
    const row = rowOf(purpose)
    row.calls += more.calls
    row.spent += more.spent
    row.costUsd += more.costUsd
  }
  const rank = (purpose: string): number => {
    const index = purposeOrder.indexOf(purpose)
    return index < 0 ? purposeOrder.length : index
  }
  const spend: Array<Spend> = [...rows.values()].sort((left, right) => rank(left.purpose) - rank(right.purpose))
    .map((row) => ({ ...row, purpose: terminalSafe(row.purpose) }))
  const remainingSpent = Math.max(0, ledger.spent - spend.reduce((total, row) => total + row.spent, 0))
  const remainingCost = Math.max(0, ledger.costUsd - spend.reduce((total, row) => total + row.costUsd, 0))
  // Grouping costs by purpose changes addition order; ignore only summation round-off.
  const costRounding = Number.EPSILON * ledger.costUsd * Math.max(ledger.entries, spend.length)
  if (ledger.entries > 0 && (remainingSpent > 0 || remainingCost > costRounding)) {
    // Spend the ledger holds and no call or reading record explains.
    spend.push({
      purpose: "unattributed",
      calls: 0,
      spent: remainingSpent,
      costUsd: remainingCost
    })
  }
  const total = {
    calls: spend.reduce((sum, row) => sum + row.calls, 0),
    spent: spend.reduce((sum, row) => sum + row.spent, 0),
    costUsd: spend.reduce((sum, row) => sum + row.costUsd, 0)
  }

  const seat = calls.flatMap((call) => call.usage === undefined ? [] : [call.usage])
  const sent = seat.reduce((sum, usage) => sum + usage.input, 0)
  const judged = calls.filter((call) => call.settled && call.moved !== undefined)
  const unmoved = judged.filter((call) => call.moved === false)
  const speed = fit(
    calls.flatMap((call) =>
      call.settled && call.usage !== undefined
        ? [[call.usage.thinking, call.usage.written, call.durationMs] as const]
        : []
    )
  )
  const hostOf = (call: Call): number | undefined =>
    call.stages?.firstOutputMs === undefined || call.timing?.firstOutputMs === undefined
      ? undefined
      : call.stages.firstOutputMs - call.timing.firstOutputMs
  const totalOf = (durations: ReadonlyArray<number>) => ({
    calls: durations.length,
    durationMs: durations.reduce((sum, duration) => sum + duration, 0)
  })
  const headers = calls.flatMap((call) => call.timing?.headersMs ?? [])
  const thinkingLine = line(calls.flatMap((call) => {
    const taken = span(call.timing?.headersMs, call.timing?.firstOutputMs)
    return taken === undefined || call.usage === undefined ? [] : [[call.usage.thinking, taken] as const]
  }))
  const writingLine = line(calls.flatMap((call) => {
    const taken = span(call.timing?.firstOutputMs, call.timing?.lastOutputMs)
    return taken === undefined || call.usage === undefined ? [] : [[call.usage.written, taken] as const]
  }))
  const sentAfter = calls.flatMap((call) => call.timing?.sentMs ?? [])
  const inHost = calls.flatMap((call) => hostOf(call) ?? [])
  const fired = readings.flatMap((reading): Array<Fired> =>
    reading.fired.length === 0 ? [] : [{
      ...(reading.frame === undefined ? {} : { frame: reading.frame }),
      purpose: terminalSafe(reading.purpose),
      startMs: reading.endAt - reading.latencyMs - start,
      latencyMs: reading.latencyMs,
      fired: reading.fired
    }]
  )

  return {
    ...(runId === undefined ? {} : { runId }),
    ...(status === undefined ? {} : { status }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    wallMs: end - start,
    time: {
      modelMs: overall.model,
      cellsMs: overall.calls + overall.cells,
      judgeMs: overall.judge,
      compactionMs: overall.compaction,
      otherMs: overall.other
    },
    spend,
    total,
    ...(ledger.entries === 0 ? {} : { ledger }),
    ...(sent === 0 ? {} : { cacheShare: seat.reduce((sum, usage) => sum + usage.cached, 0) / sent }),
    calls: calls.map((call, index): ModelCall => {
      // The harness's readings are the wait the run lived through; the wire's stand in where it took none.
      const token = (stages: Stages | undefined) =>
        stages?.firstThinkingMs !== undefined || stages?.firstOutputMs !== undefined
      const stream = token(call.stages) ? call.stages : token(call.timing) ? call.timing : undefined
      const first = stream === undefined
        ? undefined
        : Math.min(stream.firstThinkingMs ?? Infinity, stream.firstOutputMs ?? Infinity)
      const end = call.timing?.completedMs ?? call.durationMs
      const thinkingMs = span(stream?.firstThinkingMs, stream?.firstOutputMs ?? end)
      const writingMs = span(stream?.firstOutputMs, stream?.lastOutputMs ?? end)
      const hostMs = hostOf(call)
      return {
        index: index + 1,
        frame: call.frame,
        ask: call.ask,
        purpose: terminalSafe(call.purpose),
        ...(call.step === undefined ? {} : { step: terminalSafe(call.step) }),
        startMs: call.startAt - start,
        durationMs: call.durationMs,
        settled: call.settled,
        ...(first === undefined ? {} : { waitMs: first }),
        ...(thinkingMs === undefined ? {} : { thinkingMs }),
        ...(writingMs === undefined ? {} : { writingMs }),
        ...(hostMs === undefined ? {} : { hostMs }),
        ...(call.stages === undefined ? {} : { stages: call.stages }),
        ...(call.timing === undefined ? {} : { timing: call.timing }),
        ...(call.requestBytes === undefined ? {} : { requestBytes: call.requestBytes }),
        ...(call.servedTier === undefined ? {} : { servedTier: terminalSafe(call.servedTier) }),
        ...(call.usage === undefined ? {} : { usage: call.usage }),
        ...(call.spent === undefined ? {} : { spent: call.spent }),
        ...(call.usage === undefined || call.usage.input === 0
          ? {}
          : { cacheShare: call.usage.cached / call.usage.input }),
        ...(call.costUsd === undefined ? {} : { costUsd: call.costUsd }),
        // The harness counts its own tries; the wire counts the tries inside the answered one.
        tries: (call.tries ?? 1 + call.retries) + Math.max(0, (call.attempts ?? 1) - 1),
        ...(call.failedTries === undefined ? {} : { failedTries: call.failedTries }),
        ...(call.work === undefined ? {} : { work: call.work }),
        ...(call.moved === undefined ? {} : { moved: call.moved }),
        ...(call.rejected === undefined ? {} : { rejected: terminalSafe(call.rejected) })
      }
    }),
    // A frame's own record of its split stands in place of the one worked out from stamps.
    frames: frames.map((frame): Frame => {
      const time = recordedTime(frame)
      return time === undefined ? frame : {
        ...frame,
        wallMs: count(time.wallMs) ?? frame.wallMs,
        modelMs: count(time.modelMs) ?? frame.modelMs,
        cellsMs: count(time.cellMs) ?? frame.cellsMs,
        judgeMs: count(time.judgeMs) ?? frame.judgeMs,
        compactionMs: count(time.compactionMs) ?? frame.compactionMs,
        otherMs: count(time.otherMs) ?? frame.otherMs
      }
    }),
    ...(Object.keys(cellWork).length === 0 ? {} : { cellWork }),
    ...(headers.length === 0 ? {} : {
      stageFit: {
        calls: headers.length,
        headersMeanMs: headers.reduce((sum, ms) => sum + ms, 0) / headers.length,
        ...(thinkingLine === undefined ? {} : { thinking: thinkingLine }),
        ...(writingLine === undefined ? {} : { writing: writingLine })
      }
    }),
    flowCalls: { calls: [...cellCalls.values()].reduce((sum, calls) => sum + calls, 0), durationMs: overall.calls },
    ...(sentAfter.length === 0 ? {} : { beforeSent: totalOf(sentAfter) }),
    ...(inHost.length === 0 ? {} : { host: totalOf(inHost) }),
    unmoved: {
      calls: unmoved.length,
      durationMs: unmoved.reduce((sum, call) => sum + call.durationMs, 0),
      spent: unmoved.reduce((sum, call) => sum + (call.spent ?? 0), 0)
    },
    compactions: compactions.map(({ compaction, from }) => ({ ...compaction, startMs: from - start })),
    judge: {
      readings: readings.length,
      latencyMs: readings.reduce((sum, reading) => sum + reading.latencyMs, 0),
      fired
    },
    ...(speed === undefined ? {} : { speed }),
    derived: Object.entries(derivations).flatMap(([field, from]) =>
      noted.has(field as keyof typeof derivations) ? [{ field, from }] : []
    )
  }
}

const dash = "—"
const seconds = (ms: number | undefined): string => ms === undefined ? dash : (ms / 1000).toFixed(1)
const stamp = (ms: number | undefined): string => ms === undefined ? dash : (ms / 1000).toFixed(3)
const whole = (value: number | undefined): string => value === undefined ? dash : value.toLocaleString("en-US")
const percent = (share: number | undefined): string => share === undefined ? dash : (share * 100).toFixed(1)
const some = (count: number, one: string, many = `${one}s`): string => `${whole(count)} ${count === 1 ? one : many}`

/** Aligned columns two spaces apart: the first left, the rest right. */
const grid = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>, left = 1): Array<string> => {
  const widths = header.map((name, column) => Math.max(name.length, ...rows.map((row) => row[column]!.length)))
  return [header, ...rows].map((row) =>
    row.map((cell, column) => column < left ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)).join("  ")
      .trimEnd()
  )
}

/**
 * Renders the report as tables for a person. Every number printed is one the
 * report holds, in seconds where the report holds milliseconds.
 *
 * @category rendering
 * @since 1.0.0
 */
export const render = (report: Report): string => {
  const sections: Array<Array<string>> = []
  const settled = report.calls.filter((call) => call.settled)
  sections.push([
    `Run  ${[report.runId ?? "?", report.status ?? "?", `${seconds(report.wallMs)} s wall`].join(" · ")} · ${
      some(report.calls.length, "model call")
    }`
  ])
  if (report.wallMs > 0) {
    const share = (ms: number) => percent(ms / report.wallMs)
    sections.push([
      "Time",
      ...grid(["part", "s", "%"], [
        ["model", seconds(report.time.modelMs), share(report.time.modelMs)],
        ["cells", seconds(report.time.cellsMs), share(report.time.cellsMs)],
        ["judge", seconds(report.time.judgeMs), share(report.time.judgeMs)],
        ["compaction", seconds(report.time.compactionMs), share(report.time.compactionMs)],
        ["other", seconds(report.time.otherMs), share(report.time.otherMs)],
        ["wall", seconds(report.wallMs), share(report.wallMs)]
      ])
    ])
  }
  if (report.spend.length > 0) {
    const row = (entry: Spend | (Report["total"] & { readonly purpose: string })): Array<string> => {
      const split = entry as Partial<Spend>
      return [
        entry.purpose,
        String(entry.calls),
        whole(split.input),
        whole(split.cached),
        whole(split.thinking),
        whole(split.written),
        whole(entry.spent),
        entry.costUsd.toFixed(4)
      ]
    }
    sections.push([
      "Tokens",
      ...grid(
        ["purpose", "calls", "input", "cached", "thinking", "written", "tokens", "cost $"],
        [...report.spend.map(row), row({ ...report.total, purpose: "run" })]
      )
    ])
  }
  // Every table fits an 80-column terminal, so a call's time and its tokens are two tables.
  const table = <Row>(
    title: string,
    rows: ReadonlyArray<Row>,
    columns: ReadonlyArray<readonly [string, (row: Row) => string]>,
    left = 0
  ): void => {
    if (rows.length === 0) return
    sections.push([
      title,
      ...grid(columns.map(([name]) => name), rows.map((row) => columns.map(([, cell]) => cell(row))), left)
    ])
  }
  // The columns only wire timing fills are left out of a run that carries none.
  const timed = report.calls.some((call) => call.waitMs !== undefined || call.writingMs !== undefined)
  table<ModelCall>("Model calls (seconds)", report.calls, [
    ["#", (call) => String(call.index)],
    ["frame", (call) => call.step === undefined ? String(call.frame) : `${call.step}:${call.frame}`],
    ["ask", (call) => String(call.ask)],
    ["purpose", (call) => call.purpose],
    ["start", (call) => seconds(call.startMs)],
    ["total", (call) => call.settled ? seconds(call.durationMs) : `${seconds(call.durationMs)} unsettled`],
    ...(timed
      ? [
        ["wait", (call: ModelCall) => seconds(call.waitMs)],
        ["think", (call: ModelCall) => seconds(call.thinkingMs)],
        ["write", (call: ModelCall) => seconds(call.writingMs)]
      ] as const
      : [])
  ])
  table<ModelCall>("Model call tokens", report.calls, [
    ["#", (call) => String(call.index)],
    ["input", (call) => whole(call.usage?.input)],
    ["cached", (call) => whole(call.usage?.cached)],
    ["uncached", (call) => whole(call.usage?.uncached)],
    ["thinking", (call) => whole(call.usage?.thinking)],
    ["written", (call) => whole(call.usage?.written)],
    ["cache %", (call) => percent(call.cacheShare)],
    ["tries", (call) => String(call.tries)],
    ["moved", (call) =>
      call.rejected !== undefined
        ? "rejected"
        : call.moved === undefined
        ? dash
        : call.moved
        ? "yes"
        : call.work === "comment_only"
        ? "comment"
        : call.work ?? "no"]
  ])
  const staged = report.calls.filter((call) => call.timing !== undefined)
  table<ModelCall>("Wait by stage (seconds from the call's start)", staged, [
    ["#", (call) => String(call.index)],
    ["signed", (call) => stamp(call.timing?.signedMs)],
    ["sent", (call) => stamp(call.timing?.sentMs)],
    ["headers", (call) => stamp(call.timing?.headersMs)],
    ["1st event", (call) => stamp(call.timing?.firstEventMs)],
    ["1st thinking", (call) => stamp(call.timing?.firstThinkingMs)],
    ["1st output", (call) => stamp(call.timing?.firstOutputMs)],
    ["host", (call) => stamp(call.hostMs)]
  ])
  table<ModelCall>("After the first output (seconds from the call's start)", staged, [
    ["#", (call) => String(call.index)],
    ["last output", (call) => stamp(call.timing?.lastOutputMs)],
    ["completed", (call) => stamp(call.timing?.completedMs)],
    ["closed", (call) => stamp(call.timing?.closedMs)],
    ["tries", (call) => String(call.tries)],
    ["request bytes", (call) => whole(call.requestBytes)],
    ["tier", (call) => call.servedTier ?? dash]
  ])
  table<ModelCall>(
    "Stream as the harness saw it (seconds from the call's start)",
    report.calls.filter((call) => call.stages !== undefined),
    [
      ["#", (call) => String(call.index)],
      ["1st event", (call) => stamp(call.stages?.firstEventMs)],
      ["1st thinking", (call) => stamp(call.stages?.firstThinkingMs)],
      ["1st output", (call) => stamp(call.stages?.firstOutputMs)],
      ["last output", (call) => stamp(call.stages?.lastOutputMs)]
    ]
  )
  table<Frame>("Frames (seconds)", report.frames, [
    ["frame", (frame) => frame.step === undefined ? String(frame.frame) : `${frame.step}:${frame.frame}`],
    ["wall", (frame) => seconds(frame.wallMs)],
    ["model", (frame) => seconds(frame.modelMs)],
    ["calls", (frame) => String(frame.modelCalls)],
    ["cells", (frame) => seconds(frame.cellsMs)],
    ["cell calls", (frame) => String(frame.cellCalls)],
    ["judge", (frame) => seconds(frame.judgeMs)],
    ["compaction", (frame) => seconds(frame.compactionMs)],
    ["other", (frame) => seconds(frame.otherMs)]
  ], 1)
  table<Compaction>("Compactions (seconds)", report.compactions, [
    ["frame", (compaction) => compaction.frame === undefined ? dash : String(compaction.frame)],
    ["start", (compaction) => seconds(compaction.startMs)],
    ["total", (compaction) => seconds(compaction.durationMs)],
    ["cause", (compaction) => compaction.cause ?? dash],
    ["before", (compaction) => whole(compaction.contextBefore)],
    ["after", (compaction) => whole(compaction.contextAfter)],
    ["tokens", (compaction) => whole(compaction.spent)]
  ], 1)
  table<Fired>("Judge readings that fired (seconds)", report.judge.fired, [
    ["frame", (reading) => reading.frame === undefined ? dash : String(reading.frame)],
    ["purpose", (reading) => reading.purpose],
    ["start", (reading) => seconds(reading.startMs)],
    ["latency", (reading) => seconds(reading.latencyMs)],
    ["fired", (reading) => reading.fired.join(", ")]
  ], 1)
  table<Speed>("Speed", report.speed === undefined ? [] : [report.speed], [
    ["calls", (speed) => String(speed.calls)],
    ["fixed s per call", (speed) => seconds(speed.fixedMs)],
    ["ms per thinking token", (speed) => speed.perThinkingMs.toFixed(1)],
    ["ms per written token", (speed) => speed.perWrittenMs.toFixed(1)],
    ["R²", (speed) => speed.r2.toFixed(2)]
  ])
  const fit = report.stageFit
  table<readonly [string, Line]>(
    "Speed by stage (from the wire's timing)",
    fit === undefined
      ? []
      : [
        ...(fit.thinking === undefined ? [] : [["thinking", fit.thinking] as const]),
        ...(fit.writing === undefined
          ? []
          : [["writing", fit.writing] as const])
      ],
    [
      ["stage", ([stage]) => stage],
      ["calls", () => String(fit?.calls ?? 0)],
      ["fixed s", ([, fitted]) => seconds(fitted.fixedMs)],
      ["ms per token", ([, fitted]) => fitted.perMs.toFixed(1)],
      ["R²", ([, fitted]) => fitted.r2.toFixed(2)]
    ],
    1
  )
  const facts: Array<readonly [string, string]> = []
  if (fit !== undefined) facts.push(["Headers", `${stamp(fit.headersMeanMs)} s mean over ${some(fit.calls, "call")}`])
  if (report.cellWork !== undefined) {
    facts.push(["Cell work", Object.entries(report.cellWork).map(([kind, cells]) => `${kind} ${cells}`).join(" · ")])
  }
  const verdicts = settled.filter((call) => call.moved !== undefined).length
  if (verdicts > 0) {
    facts.push([
      "Moved nothing",
      `${report.unmoved.calls} of ${some(verdicts, "settled call")} · ${seconds(report.unmoved.durationMs)} s · ${
        whole(report.unmoved.spent)
      } tokens`
    ])
  }
  if (report.cacheShare !== undefined) facts.push(["Cache share", `${percent(report.cacheShare)} % of input`])
  if (report.beforeSent !== undefined) {
    facts.push([
      "Before sent",
      `${stamp(report.beforeSent.durationMs)} s over ${some(report.beforeSent.calls, "call")}`
    ])
  }
  if (report.host !== undefined) {
    facts.push([
      "In host",
      `${stamp(report.host.durationMs)} s over ${some(report.host.calls, "call")}, wire first output to harness`
    ])
  }
  if (report.flowCalls.calls > 0) {
    facts.push([
      "Flow calls",
      `${whole(report.flowCalls.calls)} · ${seconds(report.flowCalls.durationMs)} s of the cells time`
    ])
  }
  if (report.judge.readings > 0) {
    facts.push([
      "Judge",
      // Readings beside the loop cost latency and no wall time, so the two are not added.
      `${some(report.judge.readings, "reading")} · ${seconds(report.judge.latencyMs)} s latency, of which ${
        seconds(report.time.judgeMs)
      } s held the run`
    ])
  }
  if (report.ledger !== undefined) {
    facts.push([
      "Ledger",
      `${some(report.ledger.entries, "entry", "entries")} · ${whole(report.ledger.spent)} tokens · $${
        report.ledger.costUsd.toFixed(4)
      }`
    ])
  }
  if (facts.length > 0) sections.push(grid(["", ""], facts.map(([name, text]) => [name, text]), 2).slice(1))
  if (report.derived.length > 0) {
    sections.push(["Derived", ...grid(["", ""], report.derived.map((entry) => [entry.field, entry.from]), 2).slice(1)])
  }
  return sections.map((lines) => lines.join("\n")).join("\n\n")
}
