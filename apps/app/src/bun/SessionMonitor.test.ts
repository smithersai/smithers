import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as Health from "@smthrs/control/Health"
import type { PtySession } from "@smthrs/rpc/LocalApp"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSessionMonitor, type SessionMonitor } from "./SessionMonitor"
import { openLocalHealthJournal } from "./LocalHealthJournal"

const until = async (check: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout
  while (!check() && Date.now() < end) await Bun.sleep(10)
  expect(check()).toBe(true)
}
const fixture = (count = 1) => {
  const sessions = new Map<string, PtySession>(Array.from({ length: count }, (_, index) => [String(index), {
    sessionId: String(index), kind: "harness", harnessId: "claude", cwd: "/tmp", pid: 100 + index, alive: true
  }]))
  let cursor = 0
  let output = "private terminal content"
  const manager = {
    list: () => [...sessions.values()].map((session) => ({ ...session })),
    get: (id: string) => { const session = sessions.get(id); return session && { ...session } },
    replay: (id: string) => sessions.has(id)
      ? { data: output, start: 0, cursor, truncated: false, alive: sessions.get(id)!.alive, code: sessions.get(id)?.exitCode ?? null }
      : undefined,
    read: (id: string) => sessions.has(id) ? { output, alive: sessions.get(id)!.alive, truncated: false } : undefined
  }
  const frames: Array<Health.StatusRollup> = []
  const publish = (_topic: string, message: unknown) => {
    frames.push((message as { status: Health.StatusRollup }).status)
  }
  return { sessions, manager, frames, publish, move: () => { cursor += 100; output += "spinner" } }
}
const config = (probe: Health.HealthChecker["probe"], overrides: Partial<Health.CheckPolicy> = {}): Health.HealthConfig => ({
  checkers: [{ id: "test.semantic", probe }],
  bindings: { claude: { checkerId: "test.semantic", policy: {
    intervalMs: 50, timeoutMs: 50, ttlMs: 200, ...overrides
  } } }
})

test("quiet and chatty live sessions have unknown semantic activity by default", async () => {
  const f = fixture()
  const monitor = await createSessionMonitor(f)
  try {
    await until(() => monitor.status("0")?.freshness === "fresh")
    expect(monitor.status("0")?.activity).toBe("unknown")
    expect(monitor.status("0")?.health).toBe("unknown")
    f.move()
    expect(monitor.status("0")?.activity).toBe("unknown")
    expect(monitor.status("0")?.attention).toBe("none")
  } finally { await monitor.stop() }
})

test("a configured semantic checker reports input needs without receiving terminal text", async () => {
  const f = fixture()
  const contexts: Health.ProbeContext[] = []
  const monitor = await createSessionMonitor({ ...f, configuration: config((context) => {
    contexts.push(context)
    return Effect.succeed({ activity: "needs-input", reason: "awaiting-reply" })
  }) })
  try {
    await until(() => monitor.status("0")?.attention === "needs-input")
    expect(contexts[0]?.session?.outputTail).toBeUndefined()
    expect("pid" in contexts[0]!.session!).toBe(false)
    expect(monitor.status("0")?.state).toBe("running")
    expect(f.frames.some((frame) => frame.attention === "needs-input")).toBe(true)
  } finally { await monitor.stop() }
})

test("working expires locally and emits stale even before the next configured check", async () => {
  const f = fixture()
  const monitor = await createSessionMonitor({ ...f, configuration: config(
    () => Effect.succeed({ activity: "working" }), { intervalMs: 1000, timeoutMs: 10, ttlMs: 50 }
  ) })
  try {
    await until(() => monitor.status("0")?.activity === "working")
    await until(() => f.frames.some((frame) => frame.freshness === "stale"))
    expect(monitor.status("0")?.activity).toBe("unknown")
    expect(monitor.status("0")?.health).toBe("unknown")
  } finally { await monitor.stop() }
})

test("timeout and thrown errors produce safe stale observations", async () => {
  for (const [probe, reason] of [
    [() => Effect.never, "probe-timeout"],
    [() => { throw new Error("secret terminal text") }, "probe-error"]
  ] as const) {
    const f = fixture()
    const monitor = await createSessionMonitor({ ...f, configuration: config(probe, { timeoutMs: 10 }) })
    try {
      await until(() => monitor.status("0")?.reason === reason)
      expect(monitor.status("0")?.activity).toBe("unknown")
      expect(JSON.stringify(f.frames)).not.toContain("secret terminal text")
    } finally { await monitor.stop() }
  }
})

test("owner lifecycle change discards an in-flight report and persists the diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-session-health-"))
  const f = fixture()
  const release = Promise.withResolvers<Health.ProbeReport>()
  let started = false
  const monitor = await createSessionMonitor({ ...f, stateDir: directory, configuration: config(() => {
    started = true
    return Effect.promise(() => release.promise)
  }, { timeoutMs: 1000, ttlMs: 2000 }) })
  try {
    await until(() => started)
    f.sessions.set("0", { ...f.sessions.get("0")!, alive: false, exitCode: 9 })
    release.resolve({ activity: "working" })
    await until(() => monitor.status("0")?.provenance !== undefined)
    expect(monitor.status("0")?.state).toBe("exited")
    expect(monitor.status("0")?.activity).toBe("unknown")
    expect(monitor.status("0")?.health).toBe("failing")
  } finally { await monitor.stop() }
  const ledger = await openLocalHealthJournal(directory)
  try {
    const rows = await ledger.entries("session:0")
    expect(rows.entries.some((entry) => (entry.payload as { outcome?: string }).outcome === "discarded")).toBe(true)
    const discarded = rows.entries.find((entry) => (entry.payload as { outcome?: string }).outcome === "discarded")!
    expect(discarded.payload).toMatchObject({
      status: "exited", activity: "unknown", health: "failing", attention: "unhealthy", freshness: "stale"
    })
    expect(discarded.payload).not.toHaveProperty("provenance")
    expect(discarded.payload).not.toHaveProperty("version")
  } finally { await ledger.close(); await rm(directory, { recursive: true, force: true }) }
})

test("shutdown interrupts an active check; admission and concurrency are bounded", async () => {
  const f = fixture(6)
  let running = 0
  let peak = 0
  let finalized = 0
  const monitor: SessionMonitor = await createSessionMonitor({ ...f, configuration: {
    ...config(() => Effect.gen(function*() {
      running += 1
      peak = Math.max(peak, running)
      yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => { running -= 1; finalized += 1 })))
      return { activity: "working" as const }
    }), { timeoutMs: 1000, ttlMs: 2000 }),
    limits: { maxSubjects: 3, maxConcurrentProbes: 2 }
  } })
  await until(() => running === 2)
  const stopping = monitor.stop()
  expect(monitor.stop()).toBe(stopping)
  await stopping
  expect(peak).toBe(2)
  expect(running).toBe(0)
  expect(finalized).toBe(2)
  expect(f.sessions.size).toBe(6)
})

test("explicitly opting into output exposes only a bounded plain-text tail", async () => {
  const f = fixture()
  let tail: string | undefined
  const configuration = config((context) => {
    tail = context.session?.outputTail
    return Effect.succeed({ activity: "idle" })
  })
  const monitor = await createSessionMonitor({ ...f, configuration: {
    ...configuration,
    bindings: { claude: { ...configuration.bindings!.claude!, exposeOutput: true } }
  } })
  try {
    await until(() => tail !== undefined)
    expect(tail).toBe("private terminal content")
    await until(() => monitor.status("0")?.activity === "idle")
    expect(monitor.status("0")?.attention).toBe("none")
  } finally { await monitor.stop() }
})

test("expiry, lifecycle and removed-session pruning continue while probe admission is blocked", async () => {
  const f = fixture()
  let blocked = false
  let finalized = false
  const monitor = await createSessionMonitor({ ...f, configuration: {
    checkers: [
      { id: "working", probe: () => Effect.succeed({ activity: "working" }) },
      { id: "blocked", probe: () => Effect.sync(() => { blocked = true }).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => { finalized = true }))
      ) }
    ],
    bindings: {
      claude: { checkerId: "working", policy: { intervalMs: 500, timeoutMs: 10, ttlMs: 200 } },
      codex: { checkerId: "blocked", policy: { intervalMs: 10_000, timeoutMs: 10_000, ttlMs: 20_000 } }
    },
    limits: { maxSubjects: 1, maxConcurrentProbes: 1 }
  } })
  try {
    // A first SQLite open may consume a tiny TTL; wait for a committed fresh
    // reading rather than treating a probe invocation as durable publication.
    await until(() => f.frames.some((frame) => frame.activity === "working"), 8000)
    const working = [...f.frames].reverse().find((frame) => frame.activity === "working")!
    const original = f.sessions.get("0")!
    f.sessions.set("1", { ...original, sessionId: "1", harnessId: "codex", pid: 101 })
    await until(() => blocked)
    await until(() => f.frames.some((frame) => frame.subjectId === "session:0" &&
      frame.freshness === "stale" && frame.provenance?.version === working.provenance?.version))
    expect(finalized).toBe(false)
    f.sessions.set("0", { ...original, alive: false, exitCode: 7 })
    await until(() => f.frames.some((frame) => frame.subjectId === "session:0" && frame.state === "exited"))
    expect([...f.frames].reverse().find((frame) => frame.subjectId === "session:0")).toMatchObject({ state: "exited", health: "failing" })

    // Reusing an id is a fixture-only way to observe pruning: the blocked
    // probe cannot run another inventory scan or refresh the removed row.
    f.sessions.delete("0")
    await Bun.sleep(250)
    f.sessions.set("0", original)
    expect(monitor.status("0")?.freshness).toBe("unobserved")
    expect(monitor.status("0")?.provenance).toBeUndefined()
    expect(finalized).toBe(false)
  } finally { await monitor.stop() }
  expect(finalized).toBe(true)
  const stoppedFrames = f.frames.length
  await Bun.sleep(150)
  expect(f.frames).toHaveLength(stoppedFrames)
}, 20_000)

test("unchanged successes and failures coalesce without advancing uncommitted provenance, then renew", async () => {
  for (const initial of ["idle", "error"] as const) {
    const f = fixture()
    let mode: "idle" | "error" | "needs-input" = initial
    let probes = 0
    const monitor = await createSessionMonitor({ ...f, configuration: config(() => {
      probes += 1
      return mode === "error" ? Effect.fail("private error") : Effect.succeed({ activity: mode })
    }, { intervalMs: 10, timeoutMs: 10, ttlMs: 2000,
      backoff: { initialMs: 10, maxMs: 10, factor: 1 } }) })
    try {
      await until(() => monitor.status("0")?.provenance !== undefined)
      const committed = monitor.status("0")!.provenance!
      const startedProbes = probes
      await until(() => probes >= startedProbes + 2)
      expect(monitor.status("0")?.provenance).toEqual(committed)
      // Coalesced failed attempts still drive backoff, but neither successful
      // nor failed attempts pretend to have a newly committed journal stamp.
      await until(() => monitor.status("0")!.provenance!.version > committed.version)
      const renewed = monitor.status("0")!.provenance!
      expect(renewed.observedAt).toBeGreaterThanOrEqual(committed.observedAt + 1000)
      expect(probes).toBeGreaterThan(3)
      mode = "needs-input"
      await until(() => monitor.status("0")?.activity === "needs-input")
      expect(monitor.status("0")!.provenance!.version).toBeGreaterThan(renewed.version)
    } finally { await monitor.stop() }
  }
}, 20_000)
