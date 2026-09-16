import { expect, test } from "bun:test"
import { Schema } from "effect"
import * as Health from "@smthrs/control/Health"
import { StatusRollupSchema, PtyStatusFrameSchema, type StatusRollup } from "@smthrs/rpc/Health"
import { acceptStatus, expireStatus } from "./HealthStatus"
import { statusPresentation } from "../StatusDetails"
import { createHealthStatusController } from "./controller/health-status"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

export const reading = (overrides: Partial<StatusRollup> = {}): StatusRollup => ({
  subjectId: "session:pty-1", state: "running", activity: "working", health: "healthy", attention: "none", freshness: "fresh",
  reason: "ok", updatedAt: 100,
  provenance: { checkerId: "semantic.test", monitorId: "monitor-1", observedAt: 100, expiresAt: 200,
    evidenceSeq: 1, incarnation: "opaque-owner", version: 2 }, ...overrides
})

test("runtime-free wire schema decodes the host projection and rejects unsafe counters and cross-session frames", () => {
  const observed: Health.HealthObservation = { subjectId: "pty-1", state: "running", checkerId: "semantic.test",
    monitorId: "host", incarnation: "opaque-owner", evidenceSeq: 1, observedAt: 100, expiresAt: 200, durationMs: 5,
    outcome: "ok", report: { activity: "idle", reason: "ok" } }
  for (const state of ["accepted", "running", "parked", "waiting-approval", "completed", "failed", "cancelled", "spawning", "exited"] as const) {
    const host = Health.rollup({ subjectId: "pty-1", state: state as Health.SubjectState, incarnation: "opaque-owner", now: 150,
      updatedAt: 100, latest: { observation: { ...observed, state: state as Health.SubjectState }, sequence: 3 } })
    expect(StatusRollupSchema.parse(Schema.encodeSync(Health.StatusRollup)(host))).toEqual(host)
  }
  expect(StatusRollupSchema.safeParse({ ...reading(), provenance: { ...reading().provenance, version: -1 } }).success).toBe(false)
  expect(StatusRollupSchema.safeParse({ ...reading(), updatedAt: Infinity }).success).toBe(false)
  expect(PtyStatusFrameSchema.safeParse({ type: "pty.status", sessionId: "other", status: reading() }).success).toBe(false)
  expect(StatusRollupSchema.parse({ ...reading(), detail: "terminal bytes", token: "secret" })).toEqual(reading())
})

test("expiry withdraws activity without erasing authoritative approval, known waits or terminal outcome", () => {
  expect(expireStatus(reading(), 199).activity).toBe("working")
  expect(expireStatus(reading(), 200)).toMatchObject({ activity: "unknown", health: "unknown", attention: "none", freshness: "stale", state: "running" })
  expect(expireStatus(reading({ activity: "needs-input", attention: "needs-input" }), 200).attention).toBe("none")
  expect(expireStatus(reading({ state: "waiting-approval", health: "awaiting-human", attention: "awaiting-approval" }), 200))
    .toMatchObject({ health: "awaiting-human", attention: "awaiting-approval", freshness: "stale" })
  expect(expireStatus(reading({ state: "parked", reason: "quota-wait" }), 200).health).toBe("healthy")
  expect(expireStatus(reading({ state: "parked", health: "awaiting-human" }), 200).health).toBe("awaiting-human")
  expect(expireStatus(reading({ state: "exited", health: "failing", attention: "unhealthy" }), 200).health).toBe("failing")
  expect(expireStatus(reading({ provenance: undefined }), 150).freshness).toBe("stale")
  expect(expireStatus(reading(), 99).freshness).toBe("stale")
})

test("publication order uses opaque owner, evidence then version, and an equal replay cannot revive stale activity", () => {
  const current = reading()
  expect(acceptStatus(current, reading({ provenance: { ...current.provenance!, evidenceSeq: 0, version: 99 } }))).toBe(false)
  expect(acceptStatus(current, reading({ provenance: { ...current.provenance!, version: 1 } }))).toBe(false)
  expect(acceptStatus(expireStatus(current, 200), current)).toBe(false)
  expect(acceptStatus(current, reading({ provenance: { ...current.provenance!, incarnation: "new-owner", version: 0 } }))).toBe(true)
})

test("shared labels distinguish idle, human input, approval, stale activity, failure and unknown exit", () => {
  expect(statusPresentation(reading({ activity: "idle" }), "running", 150).label).toBe("Running · Idle")
  expect(statusPresentation(reading({ activity: "needs-input", attention: "needs-input" }), "running", 150).label).toBe("Running · Needs input")
  expect(statusPresentation(reading(), "running", 200).label).toBe("Running · Stale")
  expect(statusPresentation(reading({ state: "waiting-approval", attention: "awaiting-approval" }), "running", 200).label).toBe("Waiting for approval")
  expect(statusPresentation(reading({ state: "exited", health: "unknown" }), "running", 200).label).toBe("Exited · Outcome unknown")
  expect(statusPresentation(reading({ state: "failed", health: "failing" }), "running", 200).label).toBe("Failed")
  expect(statusPresentation(reading({ state: "parked", health: "awaiting-human" }), "running", 200).label).toBe("Parked · Needs attention")
})

test("one controller deadline expires hidden tabs and cards durably while offline; observations cannot exit an agent", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const finalizers: Array<() => void | Promise<void>> = []
  await store.dispatch({ type: "tab.opened", actor: "user", tab: { id: "pty-1", kind: "harness", title: "Test", sessionId: "pty-1", harnessId: "claude", cwd: "/tmp" } }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "agent", kind: "agent", title: "Test", status: "active", createdAt: 1, ordinal: 1,
    payload: { tabId: "pty-1", sessionId: "pty-1", harnessId: "claude", displayName: "Test", cwd: "/tmp", phase: "running", exitCode: null } } }).isPersisted.promise
  createHealthStatusController({ store, onDispose: (fn) => { finalizers.push(fn) }, unref: () => {} })
  const now = Date.now()
  const fresh = reading({ updatedAt: now, provenance: { ...reading().provenance!, observedAt: now, expiresAt: now + 100 } })
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "runs", kind: "run-list", title: "Runs", status: "active", createdAt: now, ordinal: 2,
    payload: { repo: "o/r", runs: [{ runId: "run-1", flowId: "test", status: "running", createdAt: now, turns: 0, calls: 0,
      statusRollup: { ...fresh, subjectId: "run:run-1" } }] } } }).isPersisted.promise
  await store.dispatch({ type: "pty.status.observed", actor: "system", sessionId: "pty-1", status: fresh }).isPersisted.promise
  /* The local variant: the cloud payload carries no PTY phase. */
  const agent = () => {
    const card = store.collections.cards.get("agent")
    if (card?.kind !== "agent") throw new Error("agent missing")
    const payload = card.payload
    if ("cloud" in payload) throw new Error("agent is the cloud variant")
    return { ...card, payload }
  }
  expect(agent().payload.statusRollup?.activity).toBe("working")
  await store.dispatch({ type: "pty.status.observed", actor: "system", sessionId: "pty-1", status: { ...fresh, state: "exited" } }).isPersisted.promise
  expect(agent().payload.phase).toBe("running")
  expect(agent().payload.statusRollup?.state).toBe("running")
  await Bun.sleep(140)
  expect(agent().payload.statusRollup).toMatchObject({ state: "running", freshness: "stale", activity: "unknown", health: "unknown" })
  const tab = store.collections.tabs.get("pty-1")
  expect(tab?.kind === "harness" && tab.statusRollup?.freshness).toBe("stale")
  const runList = store.collections.cards.get("runs")
  expect(runList?.kind === "run-list" && runList.payload.runs[0]?.statusRollup?.freshness).toBe("stale")
  expect([...store.collections.transitions.values()].filter((entry) => entry.type === "status.expired")).toHaveLength(1)
  for (const finalize of finalizers) await finalize()
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage })
  const saved = reopened.collections.cards.get("agent")
  expect(saved?.kind === "agent" && saved.payload.statusRollup?.freshness).toBe("stale")
  await reopened.dispatch({ type: "pty.exited", actor: "system", sessionId: "pty-1", code: null }).isPersisted.promise
  const exited = reopened.collections.cards.get("agent")
  expect(exited?.kind === "agent" && exited.payload.statusRollup).toMatchObject({ state: "exited", health: "unknown" })
  await reopened.dispose?.()
})

test("cloud agent status does not arm a timer the local status projector cannot expire", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "cloud", kind: "agent", title: "Cloud", status: "active", createdAt: 1, ordinal: 1,
    payload: { cloud: true, displayName: "Cloud", sessionId: "cloud", repo: "o/r", provider: null, workspaceId: null, state: "active", transcript: [], statusRollup: reading() } } }).isPersisted.promise
  const finalizers: Array<() => void> = []
  let timers = 0
  createHealthStatusController({ store, unref: () => { timers++ }, onDispose: fn => { finalizers.push(fn) } })
  expect(timers).toBe(0)
  for (const finalize of finalizers) finalize()
  await store.dispose?.()
})
