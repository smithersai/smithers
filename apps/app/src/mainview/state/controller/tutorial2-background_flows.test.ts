import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide, type Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createGuideController } from "./guide"
import type { WorkflowController } from "./workflows"
import { createLibrarianRunsController, LIBRARIAN_SIGNAL, librarianLaunchTiming, type LibrarianRunHost } from "./librarianRuns"

const fixture = async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 12 } }).isPersisted.promise
  let repo = "will/demo", next = 0, refused = false
  const ctx = { store, commandActor: "user" } as ControllerContext
  const launches: string[] = []
  const runs = {
    workflowIdentityGuard: () => undefined, workflowBalanceGuard: () => undefined,
    workflowTargetRepo: () => ({ repo }), provisionWorkspace: async (): Promise<true | string> => true,
    launchWorkflow: async (args: Parameters<WorkflowController["launchWorkflow"]>[0]) => {
      if (refused) return { message: "The gateway refused the launch." }
      const runId = `receipt-${++next}`
      launches.push(runId)
      const card: Card = { id: `flow-run-${runId}`, kind: "run-trace", title: args.title, status: "active", createdAt: 1, ordinal: next,
        payload: { repo: args.repo, runId, workflow: args.workflow, input: args.input, phase: "running", steps: [], result: null, lastSeq: 0 } }
      await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
      return { runId }
    }
  } satisfies LibrarianRunHost
  return { store, storage, launches, ctx, runs, controller: createLibrarianRunsController(ctx, runs),
    select: (value: string) => { repo = value }, refuse: () => { refused = true } }
}

describe("Librarian background runs (onboarding beat 12)", () => {
  test("launching both distinct runs completes without opening either; a new controller dedupes", async () => {
    const f = await fixture()
    await f.controller.createWiki("will/demo")
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    await f.controller.bootstrapHistory("will/demo")
    expect(f.launches).toHaveLength(2)
    expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
    const reattached = createLibrarianRunsController(f.ctx, f.runs)
    expect(await reattached.createWiki("will/demo")).toMatchObject({ value: expect.stringContaining("already recorded") })
    expect(f.launches).toHaveLength(2)
    const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
    expect(reloaded.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
    expect([...reloaded.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(2)
  })
  test("concurrent launch clicks deduplicate and a refusal never produces a receipt", async () => {
    const f = await fixture()
    await Promise.all([f.controller.createWiki("will/demo"), f.controller.createWiki("will/demo")])
    expect(f.launches).toHaveLength(1)
    f.refuse()
    expect(await f.controller.bootstrapHistory("will/demo")).toContain("refused")
    // Beat 12 degrades honestly: the reason is written under the lesson, not only into a chat line the guide never shows.
    expect(f.store.session().guide?.notice).toBe("Mythical history couldn't start. Retry Mythical history, or choose Do this later to keep going.")
    expect(f.store.session().guide?.noticeDetail).toBe("The gateway refused the launch.")
    await f.controller.inspectLibrarianRun(f.launches[0]!)
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  })
  test("launches outside the lesson, or split across repositories, do not complete", async () => {
    const f = await fixture()
    await f.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 11 } }).isPersisted.promise
    await f.controller.createWiki("will/demo")
    await f.controller.bootstrapHistory("will/demo")
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    const g = await fixture()
    await g.controller.createWiki("will/demo")
    g.select("other/repo")
    await g.controller.bootstrapHistory("other/repo")
    expect(g.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  })
  test("a run that fails after launching still counted, and stays inspectable with its error", async () => {
    const f = await fixture()
    await f.controller.createWiki("will/demo")
    await f.controller.bootstrapHistory("will/demo")
    expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
    const id = `flow-run-${f.launches[1]}`
    const card = f.store.collections.cards.get(id)!
    if (card.kind !== "run-trace") throw new Error("missing run")
    await f.store.dispatch({ type: "card.updated", actor: "system", id,
      patch: { payload: { ...card.payload, phase: "failed", error: "Git refused the update." } } }).isPersisted.promise
    for (const runId of f.launches) await f.controller.inspectLibrarianRun(runId)
    expect(f.store.collections.cards.get(id)).toMatchObject({ payload: { phase: "failed", error: "Git refused the update." } })
  })
})

test("preparation has a deadline, persists its failure, and ignores a late ready answer", async () => {
  const f = await fixture()
  let ready!: (value: true) => void
  const host = { ...f.runs, provisionWorkspace: () => new Promise<true>(resolve => { ready = resolve }) }
  const previous = librarianLaunchTiming.deadlineMs
  librarianLaunchTiming.deadlineMs = 25
  try {
    const controller = createLibrarianRunsController(f.ctx, host)
    const result = await controller.createWiki("will/demo")
    expect(result).toContain("3 minutes")
    expect(f.store.session().guide?.notice).toContain("Retry Wiki")
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    ready(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.launches).toEqual([])
    const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
    expect(reloaded.session().guide?.noticeDetail).toContain("3 minutes")
  } finally { librarianLaunchTiming.deadlineMs = previous }
})
test("reload during preparation reports the interrupted launch instead of losing it", async () => {
  const f = await fixture()
  let ready!: (value: true) => void
  const host = { ...f.runs, provisionWorkspace: () => new Promise<true>(resolve => { ready = resolve }) }
  const controller = createLibrarianRunsController(f.ctx, host)
  const running = controller.createWiki("will/demo")
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.store.session().guide?.notice).toContain("Preparing your will/demo workspace…")
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  const resumed = createLibrarianRunsController({ ...f.ctx, store: reloaded }, host)
  await resumed.recoverLaunches()
  expect(reloaded.session().guide?.noticeDetail).toBe("Workspace preparation was interrupted by a reload. Try again.")
  expect(f.launches).toEqual([])
  ready(true)
  await running
})
test("a thrown provision failure is visible and a retry can launch", async () => {
  const f = await fixture()
  const host = { ...f.runs, provisionWorkspace: async () => { throw new Error("Smithers Cloud is unavailable.") } }
  await createLibrarianRunsController(f.ctx, host).createWiki("will/demo")
  expect(f.store.session().guide?.noticeDetail).toBe("Smithers Cloud is unavailable.")
  await f.controller.createWiki("will/demo")
  expect(f.launches).toHaveLength(1)
  expect(f.store.session().guide?.notice ?? "").not.toContain("didn't start")
})

test("sign-out clears a preparing launch and a late answer cannot restore it", async () => {
  const f = await fixture()
  await f.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  let ready!: (value: true) => void
  const host = { ...f.runs, provisionWorkspace: () => new Promise<true>(resolve => { ready = resolve }) }
  const running = createLibrarianRunsController(f.ctx, host).createWiki("will/demo")
  await new Promise(resolve => setTimeout(resolve, 10))
  await f.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  expect(f.store.session().guide?.librarianLaunches ?? []).toEqual([])
  expect(f.store.session().guide?.notice).toBeUndefined()
  expect(f.store.session().guide?.noticeDetail).toBeUndefined()
  ready(true)
  await running
  expect(f.store.session().guide?.librarianLaunches ?? []).toEqual([])
  expect(f.launches).toEqual([])
})

test("preparation is visible before a receipt, failure survives reload, and retry launches once", async () => {
  const f = await fixture()
  let release!: (value: true | string) => void
  let provisions = 0
  f.runs.provisionWorkspace = () => { provisions++; return new Promise<true | string>(resolve => { release = resolve }) }
  const first = f.controller.createWiki("will/demo")
  const duplicate = f.controller.createWiki("will/demo")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(provisions).toBe(1)
  expect(f.store.session().guide?.librarianLaunches?.find(entry => entry.kind === "wiki")?.phase).toBe("preparing")
  expect(f.launches).toHaveLength(0)
  release('{"status":502,"message":"upstream failed"}')
  await Promise.all([first, duplicate])
  expect(f.store.session().guide?.librarianLaunches?.find(entry => entry.kind === "wiki")?.phase).toBe("failed")
  expect(f.store.session().guide?.notice).not.toContain("502")
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  expect(reloaded.session().guide?.librarianLaunches?.find(entry => entry.kind === "wiki")?.phase).toBe("failed")
  expect(reloaded.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  f.runs.provisionWorkspace = async () => true
  await f.controller.createWiki("will/demo")
  expect(f.store.session().guide?.librarianLaunches?.find(entry => entry.kind === "wiki")?.phase).toBe("started")
  expect(f.store.session().guide?.notice).toBeUndefined()
  expect(f.launches).toHaveLength(1)
})

test("deferring background setup does not block later launches from the normal product", async () => {
  const f = await fixture()
  await f.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 14, finished: true, declined: ["background"] } }).isPersisted.promise
  await f.controller.createWiki("will/demo")
  await f.controller.bootstrapHistory("will/demo")
  expect(f.launches).toHaveLength(2)
  expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
})


test("Do this later persists across reload without inventing started runs", async () => {
  const f = await fixture()
  const guide = createGuideController(f.ctx)
  await guide.guideAct("decline", "background")
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  expect(reloaded.session().guide?.step).toBe(13)
  expect(reloaded.session().guide?.declined).toContain("background")
  expect(reloaded.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  expect([...reloaded.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(0)
})


test("reload before launch acknowledgement preserves the instruction to check Runs", async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  const guide = f.store.session().guide!
  const entry = guide.librarianLaunches![0]!
  await f.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...guide,
    librarianLaunches: [{ ...entry, kind: "history", phase: "launching" }] } }).isPersisted.promise
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  await createLibrarianRunsController({ ...f.ctx, store: reloaded }, f.runs).recoverLaunches()
  expect(reloaded.session().guide?.notice).toContain("may have started. Check Runs before retrying")
  expect(reloaded.session().guide?.librarianLaunches?.[0]?.phase).toBe("failed")
  expect(f.launches).toHaveLength(1)
})
