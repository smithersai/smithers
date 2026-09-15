import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createLiveTutorialController, liveSnapshotOf } from "./liveTutorial"
import { PRACTICE_CARD, PRACTICE_REPO } from "../practice/PracticeRepository"
import { createDiffFilesSeam, PRACTICE_DIFF_CARD } from "../seams/DiffFilesSeam"
import { createGuideController } from "./guide"
import { createFailureController } from "./failures"
import type { LiveTutorialRun } from "@smthrs/rpc/LiveTutorial"
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
  const step = async (step: number) => { await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...(store.session().guide ?? initialGuide()), step } }).isPersisted.promise }
  return { store, storage, calls, ctx, live, finished, background, step, dispose: () => dispose.forEach(fn => fn()) }
}

test("a quota-rejected launch persists its deadline, never reconnects on reload, and can leave practice honestly", async () => {
  const retryAt = Date.now() + 60_000
  const t = await setup(async () => Response.json({ code: "turn_rate_limited", retryAt: new Date(retryAt).toISOString() }, { status: 429 }))
  await t.step(4)
  expect(await t.finished.research()).toContain("did not start")
  const rejected = [...t.store.collections.cards.values()].find(card => card.kind === "run-trace")!
  if (rejected.kind !== "run-trace") throw Error("Expected rejected research")
  expect(rejected.payload.phase).toBe("stopped")
  expect(rejected.status).toBe("active")
  expect(rejected.payload.input?.liveTutorialLimit).toEqual({ kind: "rate-limit", code: "turn_rate_limited", retryAt })
  expect(liveSnapshotOf(rejected)).toBeUndefined()
  expect(await t.finished.retry(rejected.id)).toContain("continue without practice")
  expect(t.calls).toHaveLength(1)
  t.dispose()
  await t.store.settled?.()
  await t.store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage: t.storage })
  const ctx = { ...t.ctx, store: restored }
  const live = createLiveTutorialController(ctx, restored.nextOrdinal)
  live.resume()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await live.retry(rejected.id)).toContain("did not start")
  expect(t.calls).toHaveLength(1)
  await createGuideController(ctx).guideAct("skip-practice")
  expect(restored.session().guide?.completed).not.toContain("issue.researched")
  expect(restored.session().guide?.step).toBeGreaterThan(4)
  t.dispose()
  await restored.settled?.()
  await restored.dispose?.()
})

test("a quota refusal keeps the Worker's reason for whose budget ran out", async () => {
  const message = "Practice agent runs for everyone have reached their daily limit."
  const t = await setup(async () => Response.json({ code: "turn_rate_limited", message, retryAt: new Date(Date.now() + 60_000).toISOString() }, { status: 429 }))
  await t.step(4)
  expect(await t.finished.research()).toContain("for everyone")
  const rejected = [...t.store.collections.cards.values()].find(card => card.kind === "run-trace")!
  expect(rejected.kind === "run-trace" && (rejected.payload.input?.liveTutorialLimit as { message?: string }).message).toBe(message)
  expect(await t.finished.retry(rejected.id)).toContain("for everyone")
  t.dispose()
  await t.store.settled?.()
  await t.store.dispose?.()
})

test("a limit deadline exposes an explicit retry without automatically spending another turn", async () => {
  let attempts = 0
  const t = await setup(async operation => ++attempts === 1
    ? Response.json({ retryAt: new Date(Date.now() + 150).toISOString() }, { status: 429 })
    : complete(operation))
  await t.step(4)
  await t.finished.research()
  const rejected = [...t.store.collections.cards.values()].find(card => card.kind === "run-trace")!
  for (let tick = 0; tick < 100; tick++) {
    const current = t.store.collections.cards.get(rejected.id)
    if (current?.kind === "run-trace" && current.payload.observationError?.includes("try again now")) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const ready = t.store.collections.cards.get(rejected.id)
  expect(ready?.kind === "run-trace" && ready.payload.observationError).toContain("try again now")
  t.live.resume()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(attempts).toBe(1)
  expect(await t.finished.retry(rejected.id)).toEqual({ value: "Live research completed." })
  expect(attempts).toBe(2)
  expect(t.calls[1]!.body.idempotencyKey).not.toBe(t.calls[0]!.body.idempotencyKey)
  expect(t.store.session().guide?.completed).toContain("issue.researched")
  t.dispose()
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
test("anonymous live plan→implementation uses real results once, and diff/file/Change preserve those revisions", async () => {
  const t = await setup()
  await t.step(5)
  expect(await t.finished.plan()).toEqual({ value: "Live plan completed." })
  expect(t.store.session().guide?.completed).toContain("plan.ready")
  expect(t.store.collections.identitySessions.get("identity")?.state).not.toBe("signed-in")
  await t.step(6)
  await t.finished.implement(PRACTICE_CARD.plan)
  await t.finished.implement(PRACTICE_CARD.plan)
  expect(t.calls.filter(call => call.operation === "implement")).toHaveLength(1)
  expect(t.calls.find(call => call.operation === "implement")?.body.planId).toBe(plan.id)
  const picker = t.store.collections.cards.get(PRACTICE_CARD.commits)
  expect(picker?.kind === "commit-pick" && picker.payload.rows[0]?.commitId).toBe(sha)
  expect(t.store.session().guide?.completed).toContain("commits.made")
  // Reading another practice file must not steal the diff frame's restoration.
  await t.store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: PRACTICE_CARD.file("README.md"), kind: "file", title: "README.md", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
    payload: { repo: PRACTICE_REPO, path: "README.md", content: "Example repository", truncated: false },
  } }).isPersisted.promise
  await t.store.dispatch({ type: "card.navigated", actor: "user", card: {
    ...t.store.collections.cards.get(PRACTICE_CARD.file("README.md"))!, kind: "file", title: "src/server.ts",
    payload: { repo: PRACTICE_REPO, path: "src/server.ts", content: "// HTTP server", truncated: false },
  } }).isPersisted.promise
  await t.step(7)
  await t.finished.showDiff()
  await t.step(8)
  const files = createDiffFilesSeam({ store: t.store, dispatch: t.store.dispatch, actor: () => "user", nextOrdinal: t.store.nextOrdinal, baseUrl: "", http: async () => { throw Error("must use actual saved run files") } })
  await files.openDiffFile(PRACTICE_DIFF_CARD, "src/hello.ts")
  const file = t.store.collections.cards.get(PRACTICE_DIFF_CARD)
  expect(file?.kind === "file" && file.payload.readAt?.commitId).toBe(sha)
  expect(file?.kind === "file" && file.payload.content).toContain('name || "world"')
  await t.step(9)
  await t.finished.createChange([sha])
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("change")
  await createGuideController(t.ctx).guideAct("back")
  const restored = t.store.collections.cards.get(PRACTICE_CARD.commits)
  expect(restored?.kind === "commit-pick" && restored.payload.rows[0]?.commitId).toBe(sha)
  expect(t.store.session().guide?.completed).toContain("change.opened")
  const navigation = createGuideController(t.ctx)
  const calls = t.calls.length
  await navigation.guideAct("next")
  expect(t.store.session().guide?.step).toBe(10)
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("change")
  await navigation.guideAct("back")
  expect(t.store.session().guide?.step).toBe(9)
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("commit-pick")
  await navigation.guideAct("back")
  expect(t.store.session().guide?.step).toBe(8)
  expect(t.store.collections.cards.get(PRACTICE_DIFF_CARD)?.kind).toBe("file")
  await navigation.guideAct("back")
  expect(t.store.session().guide?.step).toBe(7)
  expect(t.store.collections.cards.get(PRACTICE_DIFF_CARD)?.kind).toBe("diff")
  await navigation.guideAct("next")
  expect(t.store.session().guide?.step).toBe(8)
  expect(t.store.collections.cards.get(PRACTICE_DIFF_CARD)?.kind).toBe("file")
  // Revisited receipts move one beat per press; stale timers cannot skip the read.
  await navigation.guideAct("advance", "0:8")
  expect(t.store.session().guide?.step).toBe(8)
  await navigation.guideAct("next")
  expect(t.store.session().guide?.step).toBe(9)
  await navigation.guideAct("next")
  expect(t.store.session().guide?.step).toBe(10)
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("change")
  expect(t.calls).toHaveLength(calls)
  t.dispose()
})
test("failed tests never complete implementation or invent commits", async () => {
  const t = await setup(async operation => operation === "implement" ? { ...complete(operation), tests: { command: "node --test", exitCode: 1, output: "missing name failed" } } : complete(operation))
  await t.step(5); await t.finished.plan(); await t.step(6)
  expect(typeof await t.finished.implement(PRACTICE_CARD.plan)).toBe("string")
  expect(t.store.session().guide?.completed).not.toContain("commits.made")
  expect(t.store.collections.cards.has(PRACTICE_CARD.commits)).toBe(false)
  t.dispose()
})
test("a response from an earlier playthrough cannot complete a restarted tutorial", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const t = await setup(async operation => { await gate; return complete(operation) })
  await t.step(5)
  const request = t.live.plan()
  await t.store.settled?.()
  await t.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), playthrough: 2 } }).isPersisted.promise
  release(); await request; await Promise.all(t.background)
  expect(t.store.session().guide?.completed).not.toContain("plan.ready")
  expect(liveSnapshotOf(t.store.collections.cards.get(PRACTICE_CARD.plan))).toBeUndefined()
  t.dispose()
})

test("reload reconnects a lost response with its persisted request key", async () => {
  const t = await setup(async () => { throw Error("Connection lost after the server accepted the run") })
  await t.step(5)
  await t.finished.plan()
  const requestKey = t.calls[0]!.body.idempotencyKey
  t.dispose()
  const restored = await createAppStore({ kind: "localStorage", storage: t.storage })
  let reconnectKey: unknown
  const ctx = { ...t.ctx, store: restored, boundedFetch: async (_url: string, init: RequestInit) => {
    reconnectKey = JSON.parse(String(init.body)).idempotencyKey
    return Response.json(complete("plan"))
  } } as ControllerContext
  const live = createLiveTutorialController(ctx, restored.nextOrdinal)
  live.resume()
  for (let attempt = 0; attempt < 30; attempt++) {
    if (restored.session().guide?.completed?.includes("plan.ready")) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(reconnectKey).toBe(requestKey)
  expect(restored.session().guide?.completed).toContain("plan.ready")
  t.dispose()
})

test("reload reconciles a saved completed snapshot before its guide and artifact effects persisted", async () => {
  const t = await setup()
  await t.step(5); await t.finished.plan(); await t.step(6); await t.finished.implement(PRACTICE_CARD.plan)
  await t.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...t.store.session().guide!, step: 6, completed: t.store.session().guide!.completed!.filter(signal => signal !== "commits.made") } }).isPersisted.promise
  const interrupted = t.store.collections.cards.get(PRACTICE_CARD.run)!
  if (interrupted.kind !== "run-trace") throw Error("expected implementation run")
  await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...interrupted, payload: { ...interrupted.payload, input: { ...interrupted.payload.input, liveTutorialAppliedRun: undefined } } } }).isPersisted.promise
  const beforeCalls=t.calls.length
  t.live.resume()
  for(let i=0;i<30&&!t.store.session().guide?.completed?.includes("commits.made");i++)await new Promise(resolve=>setTimeout(resolve,10))
  expect(t.store.session().guide?.completed).toContain("commits.made")
  expect(t.calls.length).toBe(beforeCalls)
  await t.step(9);await t.finished.createChange([sha])
  t.live.resume()
  await new Promise(resolve=>setTimeout(resolve,30))
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("change")
  await createGuideController(t.ctx).guideAct("back")
  t.live.resume()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(t.store.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("commit-pick")
  expect(t.store.session().guide?.completed).toContain("change.opened")
  t.dispose()
  await t.store.dispose?.()
  const hydrated = await createAppStore({ kind: "localStorage", storage: t.storage })
  createLiveTutorialController({ ...t.ctx, store: hydrated }, hydrated.nextOrdinal).resume()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(hydrated.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("commit-pick")
  expect(hydrated.session().guide?.completed).toContain("change.opened")
  await createGuideController({ ...t.ctx, store: hydrated }).guideAct("next")
  expect(hydrated.collections.cards.get(PRACTICE_CARD.commits)?.kind).toBe("change")
  expect(t.calls.length).toBe(beforeCalls + 1)
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
  t.dispose()
})

for (const phase of ["completed", "failed"] as const) {
  test(`remote ${phase} settles the toast only after execution, not launch acknowledgement`, async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const t = await setup(async operation => {
      if (++calls === 1) return { ...complete(operation), phase: "running" }
      await gate
      return { ...complete(operation), phase, ...(phase === "failed" ? { error: "Research failed" } : {}) }
    })
    await t.step(4)
    await t.live.research()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect([...t.store.collections.toasts.values()][0]?.status).toBe("running")
    expect(t.store.session().guide?.completed).not.toContain("issue.researched")
    await t.live.research()
    expect(t.calls).toHaveLength(1)
    release()
    await Promise.all(t.background)
    expect([...t.store.collections.toasts.values()][0]?.status).toBe(phase === "completed" ? "ok" : "failed")
    expect(t.store.session().guide?.completed?.includes("issue.researched") ?? false).toBe(phase === "completed")
    t.dispose()
  })
}

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
