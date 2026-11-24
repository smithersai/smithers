import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Debug from "../src/debug.ts"

const tracker = () => {
  let at = 1000
  const lines: Array<string> = []
  const debug = Debug.make({ enabled: true, now: () => at, sink: (text) => lines.push(text) })
  return {
    debug,
    advance: (ms: number) => {
      at += ms
    },
    records: (): Array<Record<string, unknown>> => {
      debug.flush()
      return lines.join("").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))
    }
  }
}

it("is off unless SMITHERS_DEBUG is true, and every call is a shared no-op", () => {
  expect(Debug.enabled).toBe(process.env.SMITHERS_DEBUG === "true")
  let wrote = false
  const off = Debug.make({ enabled: false, now: () => 5, sink: () => (wrote = true) })
  expect(off).toBe(Debug.make({ enabled: false, now: () => 9, sink: () => {} }))
  expect(off.startTimer()).toBe(0)
  expect(off.endTimer("x", 0)).toBe(0)
  off.logEvent("worker:model-delta", "stream")
  off.keypress("char")
  off.logRender(0, 0, 3)
  off.frame()
  off.endSync("slow", -100)
  off.blocked(50)
  off.finish()
  expect(wrote).toBe(false)
  expect(off.summary().renders.count).toBe(0)
})

it("records a render with its duration, triggers, cause, queue depth and active streams", () => {
  const { advance, debug, records } = tracker()
  debug.logEvent("worker:model-delta", "stream")
  debug.logEvent("worker:model-delta", "stream")
  debug.logEvent("files")
  const start = debug.startTimer()
  advance(7)
  const body = debug.startTimer()
  advance(2)
  debug.logRender(start, body, 4)
  debug.logRender(debug.startTimer(), debug.startTimer(), 0)
  const all = records()
  expect(all.filter((each) => each.type === "event").map((each) => [each.source, each.kind, each.queueDepth])).toEqual([
    ["worker:model-delta", "stream", 1],
    ["worker:model-delta", "stream", 2],
    ["files", "other", 3]
  ])
  const [first, second] = all.filter((each) => each.type === "render")
  expect(first).toMatchObject({
    ms: 9,
    bodyMs: 7,
    commitMs: 2,
    cause: "stream",
    triggers: { "worker:model-delta": 2, files: 1 },
    queueDepth: 3,
    activeStreams: 4
  })
  // The first render consumed the queue.
  expect(second).toMatchObject({ ms: 0, cause: "other", triggers: {}, queueDepth: 0 })
})

it("names input and mixed renders", () => {
  const { debug, records } = tracker()
  debug.keypress("char")
  debug.logRender(debug.startTimer(), debug.startTimer(), 0)
  debug.keypress("return")
  debug.logEvent("chat:model-delta", "stream")
  debug.logRender(debug.startTimer(), debug.startTimer(), 1)
  expect(records().filter((each) => each.type === "render").map((each) => each.cause)).toEqual(["input", "mixed"])
  expect(debug.summary().rendersByCause).toEqual({ input: 1, mixed: 1 })
})

it("measures a key to the next painted frame, with or without a React render between", () => {
  const { advance, debug, records } = tracker()
  debug.frame()
  debug.keypress("char")
  advance(3)
  debug.logEvent("worker:model-delta", "stream")
  debug.frame()
  debug.keypress("ctrl+char")
  advance(40)
  debug.logRender(debug.startTimer(), debug.startTimer(), 1)
  advance(10)
  debug.frame()
  debug.frame()
  const keys = records().filter((each) => each.type === "key")
  expect(keys).toEqual([
    { type: "key", t: 3, key: "char", timeToGlyphMs: 3, queueDepth: 2 },
    { type: "key", t: 53, key: "ctrl+char", timeToGlyphMs: 50, timeToRenderMs: 40, queueDepth: 0 }
  ])
  expect(debug.summary().timeToGlyph).toEqual({ count: 2, p50: 3, p95: 50, p99: 50, worst: 50 })
})

it("records only synchronous operations over 5 ms, with where they were called from", () => {
  const { advance, debug, records } = tracker()
  const quick = debug.startTimer()
  advance(Debug.slowMs)
  debug.endSync("session.append", quick)
  const slow = debug.startTimer()
  advance(12.5)
  debug.endSync("session.load", slow)
  debug.blocked(80)
  expect(debug.endTimer("warm", slow)).toBe(12.5)
  const all = records()
  const sync = all.filter((each) => each.type === "sync")
  expect(sync).toHaveLength(1)
  expect(sync[0]).toMatchObject({ label: "session.load", ms: 12.5 })
  expect(String(sync[0]!.origin)).toContain("debug.test.ts")
  expect(all.filter((each) => each.type === "blocked")).toEqual([{ type: "blocked", t: 17.5, ms: 80 }])
  expect(all.filter((each) => each.type === "timer")).toEqual([{ type: "timer", t: 17.5, label: "warm", ms: 12.5 }])
  expect(debug.summary().slowSync).toMatchObject({ count: 1, worst: 12.5 })
  expect(debug.summary().blocked).toMatchObject({ count: 1, worst: 80 })
})

it("summarizes percentiles, the worst frame and renders per second", () => {
  const { advance, debug, records } = tracker()
  for (let ms = 1; ms <= 100; ms++) {
    const start = debug.startTimer()
    advance(ms)
    debug.logRender(start, start, 0)
  }
  advance(4950)
  debug.finish()
  const summary = records().at(-1)!
  expect(summary).toMatchObject({
    type: "summary",
    seconds: 10,
    renders: { count: 100, p50: 50, p95: 95, p99: 99, worst: 100 },
    rendersPerSecond: 10,
    rendersByCause: { other: 100 },
    events: 0,
    maxQueueDepth: 0
  })
  // 1+2+…+44 ms is the first second: 44 renders end inside it.
  expect(summary.peakRendersPerSecond).toBe(44)
})

it("asks for one flush per batch", () => {
  const scheduled: Array<() => void> = []
  const lines: Array<string> = []
  const debug = Debug.make({
    enabled: true,
    now: () => 0,
    sink: (text) => lines.push(text),
    schedule: (flush) => scheduled.push(flush)
  })
  debug.logEvent("a")
  debug.logEvent("b")
  expect(scheduled).toHaveLength(1)
  expect(lines).toEqual([])
  scheduled[0]!()
  expect(lines).toHaveLength(1)
  expect(lines[0]!.split("\n")).toHaveLength(3)
  debug.logEvent("c")
  expect(scheduled).toHaveLength(2)
})

it("never records a printable key's text", () => {
  expect(Debug.keyName({ name: "s" })).toBe("char")
  expect(Debug.keyName({})).toBe("char")
  expect(Debug.keyName({ name: "c", ctrl: true })).toBe("ctrl+char")
  expect(Debug.keyName({ name: "return", meta: true })).toBe("alt+return")
})

it("with SMITHERS_DEBUG=true writes JSON lines to the log file and stderr, and a summary on exit", () => {
  const folder = mkdtempSync(join(tmpdir(), "tui-debug-"))
  try {
    const script = `
      import * as Debug from ${JSON.stringify(join(import.meta.dir, "../src/debug.ts"))}
      Debug.install()
      Debug.keypress("char")
      const start = Debug.startTimer()
      Debug.logRender(start, start, 2)
      Debug.frame()
      const began = Debug.startTimer()
      Bun.sleepSync(60)
      Debug.endSync("sleep", began)
      setTimeout(() => process.exit(0), 60)
    `
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, SMITHERS_TUI_SESSION_DIR: folder, ...env }
      })
    const off = run({ SMITHERS_DEBUG: "1" })
    expect(off.status).toBe(0)
    expect(off.stderr).toBe("")
    expect(() => readFileSync(join(folder, "debug.log"))).toThrow()

    const on = run({ SMITHERS_DEBUG: "true" })
    expect(on.status).toBe(0)
    const text = readFileSync(join(folder, "debug.log"), "utf8")
    expect(on.stderr).toBe(text)
    const types = text.trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type)
    expect(types.slice(0, 4)).toEqual(["event", "render", "key", "sync"])
    // The 60 ms sleep outlasts the 20 ms lag watcher; a hold shorter than its tick goes unseen.
    expect(types).toContain("blocked")
    expect(types.at(-1)).toBe("summary")

    rmSync(join(folder, "debug.log"))
    const quiet = run({ SMITHERS_DEBUG: "true", SMTHRS_DEBUG_STDERR: "false" })
    expect(quiet.stderr).toBe("")
    expect(readFileSync(join(folder, "debug.log"), "utf8")).toContain("\"type\":\"summary\"")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it("the trace is owner-only beside the TUI log, and a pre-planted symlink there gets nothing", () => {
  const folder = mkdtempSync(join(tmpdir(), "tui-debug-private-"))
  try {
    const script = `
      import * as Debug from ${JSON.stringify(join(import.meta.dir, "../src/debug.ts"))}
      console.log(Debug.path())
      Debug.keypress("char")
      Debug.finish()
    `
    const run = (home: string) =>
      spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, SMITHERS_TUI_SESSION_DIR: home, SMITHERS_DEBUG: "true", SMTHRS_DEBUG_STDERR: "false" }
      })
    const home = join(folder, "tui")
    const fresh = run(home)
    expect(fresh.status).toBe(0)
    expect(fresh.stdout.trim()).toBe(join(home, "debug.log"))
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, "debug.log")).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(home, "debug.log"), "utf8")).toContain("\"type\":\"summary\"")

    const planted = join(folder, "planted")
    mkdirSync(planted, { mode: 0o700 })
    const victim = join(folder, "victim.txt")
    writeFileSync(victim, "")
    symlinkSync(victim, join(planted, "debug.log"))
    expect(run(planted).status).toBe(0)
    expect(readFileSync(victim, "utf8")).toBe("")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
