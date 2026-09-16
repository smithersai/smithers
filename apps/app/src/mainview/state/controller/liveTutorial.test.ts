import type { LiveTutorialRun } from "@smthrs/rpc/LiveTutorial"
import { expect,test } from "bun:test"
import { createAppStore } from "../AppStore"
import { PRACTICE_CARD } from "../practice/PracticeRepository"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createLiveTutorialController } from "./liveTutorial"
const base = "a".repeat(40), sha = "b".repeat(40)
const plan = { id: "live-plan-id", title: "Fix the missing greeting", summary: "Handle absent and empty names", baseCommitId: base, steps: ["Reproduce both cases", "Implement fallback", "Run the tests"], files: ["src/hello.ts"] }
const complete = (operation: LiveTutorialRun["operation"]): LiveTutorialRun => ({ sessionId: "session", runId: `run-${operation}`, operation, phase: "completed", createdAt: 1, updatedAt: 2, result: "Actual agent result", events: [{ id: "step-1", label: "Inspect source", status: "completed", startedAt: 1, finishedAt: 2, detail: "Source read" }],
  ...(operation === "plan" ? { plan } : {}),
  ...(operation === "implement" ? { plan, baseCommitId: base, branch: "fix/live", commits: [{ commitId: sha, parentCommitId: base, message: "Default missing greetings", files: ["src/hello.ts"], additions: 1, deletions: 1 }],
    diff: [{ path: "src/hello.ts", changeType: "modified", additions: 1, deletions: 1, isBinary: false, patch: "@@ -1 +1 @@\n-old\n+new" }], files: { "src/hello.ts": 'export const greet = (name) => `Hello, ${name || "world"}!`' }, tests: { command: "node --test", exitCode: 0, output: "3 tests pass" } } : {}),
  ...(operation === "change" ? { change: { id: "live-change", title: "Fix greetings", summary: "Handle missing names", baseCommitId: base, commitIds: [sha] } } : {}) })
async function setup(answer: (operation: LiveTutorialRun["operation"], body: Record<string, unknown>) => Promise<LiveTutorialRun | Response> = async op => complete(op)) {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const calls: Array<{ operation: string; body: Record<string, unknown> }> = []
  const dispose: Array<() => void> = []
  const ctx = { store, commandActor: "user", baseUrl: "", onDispose: (fn: () => void) => { dispose.push(fn) }, boundedFetch: async (url: string, init: RequestInit) => {
    const operation = url.split("/").at(-1)!.replace(/^run-/, "") as LiveTutorialRun["operation"]
    const body = init.body ? JSON.parse(String(init.body)) : {}
    calls.push({ operation, body })
    const result = await answer(operation, body)
    return result instanceof Response ? result : Response.json(result, { status: 202 })
  }, errorMessageOf: async () => "Unavailable" } as unknown as ControllerContext
  Object.assign(ctx, { toastRuns: new Map(), toastDebounceMs: 5, toastAutoDismissMs: 10_000, unref: () => {} })
  const failures = createFailureController(ctx)
  const background: Promise<unknown>[] = []
  ctx.withToast = ((...args: Parameters<typeof failures.withToast>) => {
    const work = failures.withToast(...args)
    background.push(work)
    return work
  }) as typeof ctx.withToast
  const live = createLiveTutorialController(ctx, store.nextOrdinal)
  // Existing receipt tests wait explicitly for background settlement; command callers do not.
  const finished = Object.fromEntries(Object.entries(live).map(([name, method]) => [name, async (...args: unknown[]) => {
    const before = background.length
    const result = await (method as (...args: unknown[]) => unknown)(...args)
    const outcomes = await Promise.all(background.slice(before))
    return outcomes.at(-1) ?? result
  }])) as unknown as typeof live
  const step = async () => { }
  return { store, storage, calls, ctx, live, finished, background, step, dispose: () => dispose.forEach(fn => fn()) }
}

test("a quota refusal keeps the Worker's reason for whose budget ran out", async () => {
  const message = "Practice agent runs for everyone have reached their daily limit."
  const t = await setup(async () => Response.json({ code: "turn_rate_limited", message, retryAt: new Date(Date.now() + 60_000).toISOString() }, { status: 429 }))
  expect(await t.finished.research()).toContain("for everyone")
  const rejected = [...t.store.collections.cards.values()].find(card => card.kind === "run-trace")!
  expect(rejected.kind === "run-trace" && (rejected.payload.input?.liveTutorialLimit as { message?: string }).message).toBe(message)
  expect(await t.finished.retry(rejected.id)).toContain("for everyone")
  t.dispose()
  await t.store.settled?.()
  await t.store.dispose?.()
})

test("rate limits without a JSON deadline use the server Retry-After header", async () => {
  const before = Date.now()
  const t = await setup(async () => new Response("Busy", { status: 429, headers: { "Retry-After": "120" } }))
  await t.finished.research()
  const rejected = [...t.store.collections.cards.values()].find(card => card.kind === "run-trace")!
  const receipt = rejected.kind === "run-trace" ? rejected.payload.input?.liveTutorialLimit as { retryAt: number } : undefined
  expect(receipt?.retryAt).toBeGreaterThanOrEqual(before + 120_000)
  expect(receipt?.retryAt).toBeLessThanOrEqual(Date.now() + 120_000)
  t.dispose()
})

for (const operation of ["research", "poc", "plan"] as const) {
  test(`${operation} acknowledges before launch resolves and shows a background toast`, async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const t = await setup(async op => { await gate; return complete(op) })
    const result = await Promise.race([t.live[operation](), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(result).toEqual({ value: `Live ${operation} requested in the background. You can keep chatting.` })
    await t.live[operation]()
    expect(t.calls).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["running"])
    release()
    await Promise.all(t.background)
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["ok"])
    t.dispose()
  })
}

test("background launch failure resolves the running toast honestly", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const t = await setup(async () => { await gate; throw Error("Connection lost") })
  await t.live.research()
  await new Promise(resolve => setTimeout(resolve, 15))
  release()
  await Promise.all(t.background)
  const toast = [...t.store.collections.toasts.values()][0]!
  expect(toast.status).toBe("failed")
  expect(toast.detail).toBe("Connection lost")
  const card = t.store.collections.cards.get("live-tutorial-research")!
  expect(card.kind === "run-trace" && card.payload.phase).toBe("launching")
  t.dispose()
})

test("losing observation preserves the remote phase and reconnects the same request", async () => {
  let reconnect = false
  const running = { ...complete("research"), phase: "running" as const }
  const t = await setup(async (_operation, body) => {
    if (reconnect) return complete("research")
    if (!body.idempotencyKey) throw Error("Connection lost")
    return running
  })
  await t.finished.research()
  const interrupted = t.store.collections.cards.get("live-tutorial-research")!
  if (interrupted.kind !== "run-trace") throw Error("Expected run")
  expect(interrupted.payload.phase).toBe("running")
  expect(interrupted.payload.runId).toBe(running.runId)
  expect(interrupted.payload.input?.liveTutorialSnapshot).toEqual(running)
  expect(interrupted.payload.observationError).toBe("Connection lost")
  expect([...t.store.collections.toasts.values()][0]?.status).toBe("failed")
  reconnect = true
  await t.finished.retry(interrupted.id)
  const launches = t.calls.filter(call => call.body.idempotencyKey)
  expect(launches).toHaveLength(2)
  expect(launches[1]?.body.idempotencyKey).toBe(launches[0]?.body.idempotencyKey)
  const completed = t.store.collections.cards.get(interrupted.id)!
  expect(completed.kind === "run-trace" && completed.payload.phase).toBe("completed")
  expect(completed.kind === "run-trace" && completed.payload.observationError).toBeUndefined()
  expect([...t.store.collections.toasts.values()][0]?.status).toBe("ok")
  t.dispose()
})

test("an incomplete result keeps its completion receipt and retries without a new implementation", async () => {
  let verified = false
  const t = await setup(async operation => {
    const run = complete(operation)
    return operation === "implement" && !verified ? { ...run, commits: [] } : run
  })
  await t.finished.plan()
  await t.finished.implement(PRACTICE_CARD.plan)
  const interrupted = t.store.collections.cards.get(PRACTICE_CARD.run)!
  if (interrupted.kind !== "run-trace") throw Error("Expected run")
  expect(interrupted.payload.phase).toBe("completed")
  expect(interrupted.payload.observationError).toContain("verified commits")
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)).toBeUndefined()
  verified = true
  await t.finished.retry(interrupted.id)
  const launches = t.calls.filter(call => call.operation === "implement")
  expect(launches).toHaveLength(2)
  expect(launches[1]?.body.idempotencyKey).toBe(launches[0]?.body.idempotencyKey)
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("commit-pick")
  t.dispose()
})


for (const operation of ["implement", "change"] as const) {
  test(`${operation} also returns while its launch is unresolved`, async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const t = await setup(async op => { if (op === operation) await gate; return complete(op) })
    await t.finished.plan()
    if (operation === "change") await t.finished.implement(PRACTICE_CARD.plan)
    const start = () => operation === "implement" ? t.live.implement(PRACTICE_CARD.plan) : t.live.createChange([sha])
    const result = await Promise.race([start(), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(result).toEqual({ value: `Live ${operation} requested in the background. You can keep chatting.` })
    await start()
    expect(t.calls.filter(call => call.operation === operation)).toHaveLength(1)
    release()
    await Promise.all(t.background)
    t.dispose()
  })
}

test("a practice Change opens only the matching completed implementation diff without another request", async () => {
  const t = await setup()
  await t.finished.plan()
  await t.finished.implement(PRACTICE_CARD.plan)
  await t.finished.createChange([sha])
  const before = t.calls.length
  expect(await t.live.showDiff("live-change")).toEqual({ value: "src/hello.ts\n@@ -1 +1 @@\n-old\n+new" })
  expect(t.calls).toHaveLength(before)
  const diff = [...t.store.collections.cards.values()].find(card => card.kind === "diff")
  expect(diff?.payload).toMatchObject({ from: base, to: sha, files: complete("implement").diff })
  t.dispose()
})

for (const mismatch of ["identity", "session", "base", "selection", "incomplete"] as const) {
  test(`a practice Change refuses a ${mismatch} mismatch instead of borrowing the current diff`, async () => {
    const t = await setup()
    await t.finished.plan()
    await t.finished.implement(PRACTICE_CARD.plan)
    await t.finished.createChange([sha])
    const changed = complete("change")
    if (mismatch === "identity") changed.change!.id = "different-change"
    if (mismatch === "session") changed.sessionId = "another-session"
    if (mismatch === "base") changed.change!.baseCommitId = "c".repeat(40)
    if (mismatch === "selection") changed.change!.commitIds = ["c".repeat(40)]
    if (mismatch === "incomplete") changed.phase = "running"
    t.store.dispatch({ type: "card.updated", actor: "system", id: "live-tutorial-change", patch: {
      payload: { input: { liveTutorialSnapshot: changed } }
    } })
    const before = t.calls.length
    expect(await t.live.showDiff("live-change")).toBe("No recorded diff matches this Change.")
    expect([...t.store.collections.cards.values()].some(card => card.kind === "diff")).toBe(false)
    expect(t.calls).toHaveLength(before)
    t.dispose()
  })
}

test("a selected subset cannot display the full implementation's aggregate diff", async () => {
  const t = await setup(async operation => {
    const run = complete(operation)
    if (operation === "implement") run.commits!.push({ ...run.commits![0]!, commitId: "c".repeat(40), parentCommitId: sha })
    return run
  })
  await t.finished.plan()
  await t.finished.implement(PRACTICE_CARD.plan)
  await t.finished.createChange([sha])
  expect(await t.live.showDiff("live-change")).toBe("No recorded diff matches this Change.")
  expect([...t.store.collections.cards.values()].some(card => card.kind === "diff")).toBe(false)
  t.dispose()
})
