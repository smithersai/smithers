/**
 * Performance tracing for the terminal UI, on only when `SMITHERS_DEBUG=true`.
 *
 * Records are JSON lines appended to `$TMPDIR/smthrs-tui-debug.log` (or
 * `/tmp`) and mirrored to stderr; run with `2>file` to keep the screen clean,
 * or set `SMTHRS_DEBUG_STDERR=false`. Lines are buffered and written off the
 * hot path. `SMITHERS_DEBUG` is read once: when it is not `true` every export is a
 * shared no-op, so a call site costs one `if (Debug.enabled)` test.
 *
 * Record types: `event` (a notification asking for a render, with the queue
 * depth it leaves), `render` (one App render: body and commit time, what
 * triggered it, active streams), `key` (keypress to the next painted frame,
 * the time to glyph), `sync` (a synchronous operation over 5 ms and where it
 * was called from), `blocked` (the event loop held longer than 5 ms),
 * `timer`, and `summary` on exit.
 */
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import * as Timer from "./timer.ts"

/** What asked for a render: a streamed worker or model event, the person's input, or anything else. */
export type Kind = "stream" | "input" | "other"

export interface Options {
  readonly enabled: boolean
  /** Monotonic milliseconds. */
  readonly now: () => number
  /** Receives whole JSON lines, each ending in a newline. */
  readonly sink: (text: string) => void
  /** Asks for `flush` soon; absent, the caller flushes. */
  readonly schedule?: (flush: () => void) => void
}

export interface Distribution {
  readonly count: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly worst: number
}

export interface Summary {
  readonly seconds: number
  readonly renders: Distribution
  readonly rendersPerSecond: number
  readonly peakRendersPerSecond: number
  readonly rendersByCause: Readonly<Record<string, number>>
  readonly timeToGlyph: Distribution
  readonly events: number
  readonly maxQueueDepth: number
  readonly slowSync: Distribution
  readonly blocked: Distribution
}

export interface Tracker {
  readonly enabled: boolean
  /** The time now, to hand back to `endTimer`, `endSync` or `logRender`; 0 when off. */
  readonly startTimer: () => number
  /** Records how long `label` took since `start`, and returns it. */
  readonly endTimer: (label: string, start: number) => number
  /** Records a synchronous operation only when it took longer than `slowMs`, with its caller's stack. */
  readonly endSync: (label: string, start: number) => void
  /** A notification that will ask for a render; counted until a render consumes it. */
  readonly logEvent: (source: string, kind?: Kind) => void
  /** One committed render: `start` at the top of the component, `bodyEnd` before it returned. */
  readonly logRender: (start: number, bodyEnd: number, activeStreams: number) => void
  /** A key arrived; `name` must not carry typed text. */
  readonly keypress: (name: string) => void
  /** The renderer painted a frame: settles every key waiting for its glyph. */
  readonly frame: () => void
  /** The event loop was held `ms` longer than a timer asked. */
  readonly blocked: (ms: number) => void
  readonly summary: () => Summary
  /** Writes the summary record and everything buffered. */
  readonly finish: () => void
  readonly flush: () => void
}

/** A synchronous operation or event-loop hold longer than this is recorded. */
export const slowMs = 5

const sampleLimit = 50_000

const round = (ms: number): number => Math.round(ms * 1000) / 1000

class Samples {
  private readonly values: Array<number> = []
  private total = 0
  private worst = 0
  add(ms: number): void {
    // Past the limit the oldest samples are overwritten; count and worst stay exact.
    if (this.values.length < sampleLimit) this.values.push(ms)
    else this.values[this.total % sampleLimit] = ms
    this.total++
    if (ms > this.worst) this.worst = ms
  }
  distribution(): Distribution {
    const sorted = [...this.values].sort((left, right) => left - right)
    const at = (quantile: number): number =>
      sorted.length === 0 ? 0 : round(sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!)
    return { count: this.total, p50: at(0.5), p95: at(0.95), p99: at(0.99), worst: round(this.worst) }
  }
}

const noop = (): void => {}
const zero = (): number => 0
const empty: Distribution = { count: 0, p50: 0, p95: 0, p99: 0, worst: 0 }
const off: Tracker = {
  enabled: false,
  startTimer: zero,
  endTimer: zero,
  endSync: noop,
  logEvent: noop,
  logRender: noop,
  keypress: noop,
  frame: noop,
  blocked: noop,
  summary: () => ({
    seconds: 0,
    renders: empty,
    rendersPerSecond: 0,
    peakRendersPerSecond: 0,
    rendersByCause: {},
    timeToGlyph: empty,
    events: 0,
    maxQueueDepth: 0,
    slowSync: empty,
    blocked: empty
  }),
  finish: noop,
  flush: noop
}

/** The frames that called the operation, without this module's own. */
const origin = (): string =>
  (new Error().stack ?? "").split("\n").slice(3, 8).map((line) => line.trim().replace(/^at /, "")).join(" < ")

export const make = (options: Options): Tracker => {
  if (!options.enabled) return off
  const { now, sink } = options
  const began = now()
  let lines: Array<string> = []
  let scheduled = false
  const flush = (): void => {
    scheduled = false
    if (lines.length === 0) return
    const text = lines.join("")
    lines = []
    sink(text)
  }
  const emit = (type: string, fields: object): void => {
    lines.push(JSON.stringify({ type, t: round(now() - began), ...fields }) + "\n")
    if (!scheduled && options.schedule !== undefined) {
      scheduled = true
      options.schedule(flush)
    }
  }

  const renders = new Samples()
  const glyphs = new Samples()
  const slow = new Samples()
  const blocks = new Samples()
  const byCause: Record<string, number> = {}
  let events = 0
  let maxDepth = 0
  // Notifications no render has consumed yet.
  let pending = 0
  let pendingStream = 0
  let pendingInput = 0
  let triggers: Record<string, number> = {}
  let keys: Array<{ readonly name: string; readonly at: number; rendered?: number }> = []
  let second = Math.floor(began / 1000)
  let inSecond = 0
  let peak = 0

  const logEvent = (source: string, kind: Kind = "other"): void => {
    events++
    pending++
    if (kind === "stream") pendingStream++
    if (kind === "input") pendingInput++
    triggers[source] = (triggers[source] ?? 0) + 1
    if (pending > maxDepth) maxDepth = pending
    emit("event", { source, kind, queueDepth: pending })
  }

  const summary = (): Summary => {
    const seconds = (now() - began) / 1000
    const count = renders.distribution().count
    return {
      seconds: round(seconds),
      renders: renders.distribution(),
      rendersPerSecond: seconds > 0 ? round(count / seconds) : 0,
      peakRendersPerSecond: Math.max(peak, inSecond),
      rendersByCause: { ...byCause },
      timeToGlyph: glyphs.distribution(),
      events,
      maxQueueDepth: maxDepth,
      slowSync: slow.distribution(),
      blocked: blocks.distribution()
    }
  }

  return {
    enabled: true,
    startTimer: now,
    endTimer: (label, start) => {
      const ms = round(now() - start)
      emit("timer", { label, ms })
      return ms
    },
    endSync: (label, start) => {
      const ms = now() - start
      if (ms <= slowMs) return
      slow.add(ms)
      emit("sync", { label, ms: round(ms), origin: origin() })
    },
    logEvent,
    logRender: (start, bodyEnd, activeStreams) => {
      const end = now()
      const ms = end - start
      const cause = pendingInput > 0 ? (pendingStream > 0 ? "mixed" : "input") : pendingStream > 0 ? "stream" : "other"
      renders.add(ms)
      byCause[cause] = (byCause[cause] ?? 0) + 1
      const at = Math.floor(end / 1000)
      if (at !== second) {
        peak = Math.max(peak, inSecond)
        second = at
        inSecond = 0
      }
      inSecond++
      emit("render", {
        ms: round(ms),
        bodyMs: round(bodyEnd - start),
        commitMs: round(end - bodyEnd),
        cause,
        triggers,
        queueDepth: pending,
        activeStreams
      })
      for (const key of keys) key.rendered ??= end
      pending = 0
      pendingStream = 0
      pendingInput = 0
      triggers = {}
    },
    keypress: (name) => {
      keys.push({ name, at: now() })
      logEvent(`key:${name}`, "input")
    },
    frame: () => {
      if (keys.length === 0) return
      const end = now()
      for (const key of keys) {
        const ms = end - key.at
        glyphs.add(ms)
        emit("key", {
          key: key.name,
          timeToGlyphMs: round(ms),
          // Absent when the native editor drew the key with no React render.
          timeToRenderMs: key.rendered === undefined ? undefined : round(key.rendered - key.at),
          queueDepth: pending
        })
      }
      keys = []
    },
    blocked: (ms) => {
      blocks.add(ms)
      emit("blocked", { ms: round(ms) })
    },
    summary,
    finish: () => {
      emit("summary", summary())
      flush()
    },
    flush
  }
}

/** Where the records go. */
export const path = (): string => join(process.env.TMPDIR ?? "/tmp", "smthrs-tui-debug.log")

const file = path()
const mirror = process.env.SMTHRS_DEBUG_STDERR !== "false"
const tracker = make({
  enabled: process.env.SMITHERS_DEBUG === "true",
  now: () => performance.now(),
  sink: (text) => {
    try {
      appendFileSync(file, text, { mode: 0o600 })
      if (mirror) process.stderr.write(text)
    } catch {
      // Tracing must never take the terminal down.
    }
  },
  schedule: (flush) => {
    Timer.after(250, flush)
  }
})

export const enabled: boolean = tracker.enabled
export const { blocked, endSync, endTimer, finish, flush, frame, keypress, logEvent, logRender, startTimer, summary } =
  tracker

/** A printable key's text is the person's draft: only its class is recorded. */
export const keyName = (key: { readonly name?: string; readonly ctrl?: boolean; readonly meta?: boolean }): string => {
  const name = key.name ?? ""
  const base = name.length <= 1 ? "char" : name
  return `${key.ctrl === true ? "ctrl+" : ""}${key.meta === true ? "alt+" : ""}${base}`
}

const lagEvery = 20

/**
 * Call once at startup. Watches the event loop for holds over `slowMs` and
 * writes the summary when the process exits, Ctrl+C included. Nothing when off.
 */
export const install = (): void => {
  if (!tracker.enabled) return
  let last = performance.now()
  Timer.every(lagEvery, () => {
    const at = performance.now()
    const late = at - last - lagEvery
    last = at
    if (late > slowMs) blocked(late)
  })
  process.on("exit", finish)
}
