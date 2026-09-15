import { describe, expect, test, spyOn } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide, type Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createGuideController } from "./guide"
import type { WorkflowController } from "./workflows"
import { createLibrarianRunsController, LIBRARIAN_SIGNAL, librarianLaunchTiming, type LibrarianRunHost } from "./librarianRuns"
import { guideActionState } from "../../onboarding/actionState"
import { LIBRARIAN_UNCONFIRMED } from "../LibrarianLaunch"
import { lessonMessage } from "../../onboarding/lessons"
import { DurableStorageConflictError } from "../../chain/DurableCollection"

const fixture = async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 12 } }).isPersisted.promise
  let repo = "will/demo", next = 0, refused = false
  let launchStore = store
  const disposals: Array<() => void> = []
  const ctx = { store, commandActor: "user", onDispose: (dispose: () => void) => { disposals.push(dispose) } } as unknown as ControllerContext
  const launches: string[] = []
  const runs = {
    workflowIdentityGuard: () => undefined, workflowBalanceGuard: () => undefined,
    workflowTargetRepo: () => ({ repo }), provisionWorkspace: async (): Promise<true | string> => true,
    launchWorkflow: async (args: Parameters<WorkflowController["launchWorkflow"]>[0]) => {
      if (refused) return { message: "The gateway refused the launch." }
      const runId = `receipt-${++next}`
      launches.push(runId)
      const card: Card = { id: `flow-run-${runId}`, kind: "run-trace", title: args.title, status: "active", createdAt: Date.now(), ordinal: next,
        payload: { repo: args.repo, runId, workflow: args.workflow, input: args.input, phase: "running", steps: [], result: null, lastSeq: 0 } }
      await launchStore.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
      return { runId }
    }
  } satisfies LibrarianRunHost
  return { store, storage, launches, ctx, runs, dispose: () => disposals.splice(0).forEach(dispose => dispose()), controller: createLibrarianRunsController(ctx, runs),
    rebind: (nextStore: typeof store) => { launchStore = nextStore; return createLibrarianRunsController({ ...ctx, store: nextStore }, runs) },
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
    expect(f.store.session().guide?.notice).toBe(failedLine)
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
  test("a run that fails after launching stays inspectable with its error", async () => {
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

const rawFailure = "failed — Error: Error: git exited 1"
const failedLine = "Create Mythical history didn't start: Something on Smithers' side failed. Not your fault, and nothing your request could have changed."
const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const changePhase = async (f: Awaited<ReturnType<typeof fixture>>, index: number, phase: "failed" | "launching" | "running" | "completed") => {
  const id = `flow-run-${f.launches[index]}`
  const card = f.store.collections.cards.get(id)!
  if (card.kind !== "run-trace") throw new Error("missing run")
  await f.store.dispatch({ type: "card.updated", actor: "system", id,
    patch: { payload: { ...card.payload, phase, ...(phase === "failed" ? { error: rawFailure } : {}) } } }).isPersisted.promise
  await settle()
}

test("a receipt still launching does not complete until both cards are running or completed", async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  await changePhase(f, 0, "launching")
  await f.controller.bootstrapHistory("will/demo")
  expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  await changePhase(f, 0, "completed")
  expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
})

test("failure before launch acknowledgement blocks completion and Retry launches a fresh run", async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  const launch = f.runs.launchWorkflow
  f.runs.launchWorkflow = async args => {
    const receipt = await launch(args)
    await changePhase(f, 1, "failed")
    return receipt
  }
  await f.controller.bootstrapHistory("will/demo")
  expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  expect(f.store.session().guide?.notice).toBe(failedLine)
  expect(f.store.session().guide?.noticeDetail).toBe(rawFailure)
  expect(guideActionState({ label: "Create Mythical history", key: "y", flow: "history.bootstrap", args: "will/demo" }, [], f.store.session().guide!))
    .toMatchObject({ label: "Retry Mythical history", flow: "history.bootstrap" })
  f.runs.launchWorkflow = launch
  await f.controller.bootstrapHistory("will/demo")
  expect(f.launches).toHaveLength(3)
  expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
  expect(f.store.session().guide?.notice).toBeUndefined()
  // Updates to the old failed attempt cannot poison the successful retry.
  await changePhase(f, 1, "failed")
  expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
})

test("failure during the beat's success pause retracts completion and restores the Retry pill", async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  await f.controller.bootstrapHistory("will/demo")
  expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
  await changePhase(f, 1, "failed")
  expect(f.store.session().guide?.step).toBe(12)
  expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  expect(f.store.session().guide?.notice).toBe(failedLine)
  expect([...f.store.collections.toasts.values()]).toHaveLength(0)
})

for (const step of [13, 14]) test(`failure at beat ${step} posts one typed Retry toast and retracts the terminal promise, including after reload`, async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  await f.controller.bootstrapHistory("will/demo")
  await f.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...f.store.session().guide!, step, finished: step === 14 } }).isPersisted.promise
  await changePhase(f, 1, "failed")
  const toasts = [...f.store.collections.toasts.values()]
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatchObject({ status: "failed", title: failedLine,
    action: { label: "Retry Mythical history", flow: "history.bootstrap", args: "will/demo" } })
  expect(toasts[0]?.detail).not.toContain("git exited")
  expect(lessonMessage(14, f.store.session().guide!)).not.toContain("land soon")
  await changePhase(f, 1, "failed")
  expect([...f.store.collections.toasts.values()][0]?.updatedAt).toBe(toasts[0]?.updatedAt)
  f.dispose()
  await f.store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  const resumed = f.rebind(reloaded)
  await resumed.recoverLaunches()
  expect(lessonMessage(14, reloaded.session().guide!)).not.toContain("land soon")
  expect([...reloaded.collections.toasts.values()]).toHaveLength(1)
  await resumed.bootstrapHistory("will/demo")
  expect(f.launches).toHaveLength(3)
  expect([...reloaded.collections.toasts.values()]).toHaveLength(0)
  f.dispose()
  await reloaded.dispose?.()
})

test("returning to beat 12 after a background failure restores its inline explanation", async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  await f.controller.bootstrapHistory("will/demo")
  await f.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...f.store.session().guide!, step: 13 } }).isPersisted.promise
  await changePhase(f, 1, "failed")
  await f.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...f.store.session().guide!, step: 12, notice: undefined } }).isPersisted.promise
  await settle()
  expect(f.store.session().guide?.step).toBe(12)
  expect(f.store.session().guide?.notice).toBe(failedLine)
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
    expect(f.store.session().guide?.notice).toContain("Create Wiki didn't start:")
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    ready(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.launches).toEqual([])
    const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
    expect(reloaded.session().guide?.noticeDetail).toContain("3 minutes")
  } finally { librarianLaunchTiming.deadlineMs = previous }
})
test("preparation's deadline includes saving the visible launch intent", async () => {
  const f = await fixture()
  let release!: () => void
  const saving = new Promise<void>(resolve => { release = resolve })
  const store = { ...f.store, dispatch: (transition: Parameters<typeof f.store.dispatch>[0]) => {
    const transaction = f.store.dispatch(transition)
    if (transition.type !== "guide.changed" || transition.guide.librarianLaunches?.at(-1)?.phase !== "preparing") return transaction
    return new Proxy(transaction, { get(target, key, receiver) {
      if (key === "isPersisted") return { ...target.isPersisted, promise: target.isPersisted.promise.then(() => saving) }
      return Reflect.get(target, key, receiver)
    } })
  } }
  let provisions = 0
  const host = { ...f.runs, provisionWorkspace: async () => { provisions++; return true as const } }
  const startedAt = Date.now()
  const now = spyOn(Date, "now").mockReturnValue(startedAt)
  try {
    const controller = createLibrarianRunsController({ ...f.ctx, store }, host)
    const result = controller.createWiki("will/demo")
    expect(store.session().guide?.notice).toContain("Preparing your")
    now.mockReturnValue(startedAt + librarianLaunchTiming.deadlineMs + 1)
    release()
    expect(await result).toContain("Workspace preparation took longer than 3 minutes. Try again.")
    expect(provisions).toBe(0)
    expect(f.launches).toEqual([])
    const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
    expect(reloaded.session().guide?.noticeDetail).toContain("3 minutes")
  } finally { release(); now.mockRestore(); f.dispose() }
})
test("reload during preparation reports the interrupted launch instead of losing it", async () => {
  const f = await fixture()
  let ready!: (value: true) => void
  const host = { ...f.runs, provisionWorkspace: () => new Promise<true>(resolve => { ready = resolve }) }
  const controller = createLibrarianRunsController(f.ctx, host)
  const running = controller.createWiki("will/demo")
  // This fixture deliberately leaves the old realm alive while opening the
  // replacement. A late old writer must be fenced before launching work.
  const staleOutcome = running.then(() => undefined, error => error)
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.store.session().guide?.notice).toContain("Preparing your will/demo workspace…")
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  const resumed = createLibrarianRunsController({ ...f.ctx, store: reloaded }, host)
  await resumed.recoverLaunches()
  expect(reloaded.session().guide?.noticeDetail).toBe("Workspace preparation was interrupted by a reload. Try again.")
  expect(f.launches).toEqual([])
  ready(true)
  expect(await staleOutcome).toBeInstanceOf(DurableStorageConflictError)
  expect(f.launches).toEqual([])
  await reloaded.dispose?.()
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
  f.dispose()
  await f.store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage: f.storage })
  const resumed = f.rebind(reloaded)
  await resumed.recoverLaunches()
  expect(reloaded.session().guide?.notice).toContain("may have started. Check Runs before retrying")
  expect(reloaded.session().guide?.librarianLaunches?.[0]?.phase).toBe("failed")
  expect(f.launches).toHaveLength(1)
})


test("both failed launches retain their own explanation under the lesson", async () => {
  const f = await fixture()
  const controller = createLibrarianRunsController(f.ctx, { ...f.runs,
    launchWorkflow: async args => ({ message: args.workflow.endsWith("wiki") ? "Wiki source is unavailable." : "History source is unavailable." }) })
  await Promise.all([controller.createWiki("will/demo"), controller.bootstrapHistory("will/demo")])
  const notice = f.store.session().guide?.notice
  expect(notice).toContain("Create Wiki didn't start:")
  expect(f.store.session().guide?.noticeDetail).toContain("Wiki source is unavailable.")
  expect(notice).toContain("Create Mythical history didn't start:")
  expect(f.store.session().guide?.noticeDetail).toContain("History source is unavailable.")
  expect(notice?.split("\n")).toHaveLength(2)
})

for (const mode of ["reload", "live"] as const) for (const phase of ["launching", "running", "completed", "failed"] as const) {
  for (const hasRunId of [false, true]) test(`${mode}: ${phase} card repairs an unconfirmed intent ${hasRunId ? "with" : "without"} a run id`, async () => {
    const f = await fixture()
    await f.controller.createWiki("will/demo")
    f.dispose()
    const original = f.store.collections.cards.get(`flow-run-${f.launches[0]}`)!
    if (original.kind !== "run-trace") throw Error("missing run")
    const card = { ...original, payload: { ...original.payload, phase, error: phase === "failed" ? rawFailure : undefined } }
    const entry = f.store.session().guide!.librarianLaunches![0]!
    await f.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...f.store.session().guide!,
      notice: "Wiki may have started. Check Runs before retrying, or choose Do this later.", noticeDetail: LIBRARIAN_UNCONFIRMED,
      librarianLaunches: [{ ...entry, phase: "failed", reason: LIBRARIAN_UNCONFIRMED, runId: hasRunId ? entry.runId : undefined }] } }).isPersisted.promise
    if (mode === "reload") await f.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const store = mode === "reload" ? await createAppStore({ kind: "localStorage", storage: f.storage }) : f.store
    const controller = createLibrarianRunsController({ ...f.ctx, store }, f.runs)
    if (mode === "reload") await controller.recoverLaunches()
    else await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await settle()
    expect(store.session().guide?.librarianLaunches?.[0]).toMatchObject({ runId: card.payload.runId, phase: phase === "failed" ? "failed" : "started" })
    if (phase === "failed") {
      expect(store.session().guide?.notice).toContain("Create Wiki didn't start:")
      expect(store.session().guide?.noticeDetail).toBe(rawFailure)
    } else {
      expect(store.session().guide?.notice).toBeUndefined()
      expect(store.session().guide?.noticeDetail).toBeUndefined()
    }
    const action = guideActionState({ label: "Create Wiki", key: "u", flow: "wiki.create" }, [...store.collections.cards.values()], store.session().guide!)
    expect(action.label).toBe(phase === "failed" ? "Retry Wiki" : phase === "completed" ? "Wiki ready" : phase === "launching" ? "Preparing Wiki…" : "Wiki started")
    expect(action.disabled === true).toBe(phase !== "failed")
    f.dispose()
  })
}

test("completed Wiki and failed history name only history; a completed retry finishes the lesson", async () => {
  const f = await fixture()
  await f.controller.createWiki("will/demo")
  await changePhase(f, 0, "completed")
  const launch = f.runs.launchWorkflow
  f.runs.launchWorkflow = async args => {
    const result = await launch(args)
    await changePhase(f, 1, "failed")
    return result
  }
  await f.controller.bootstrapHistory("will/demo")
  expect(f.store.session().guide?.notice).toBe(failedLine)
  expect(f.store.session().guide?.noticeDetail).toBe(rawFailure)
  f.runs.launchWorkflow = async args => {
    const result = await launch(args)
    await changePhase(f, 2, "completed")
    return result
  }
  await f.controller.bootstrapHistory("will/demo")
  expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
  expect(f.store.session().guide?.notice).toBeUndefined()
  expect(f.store.session().guide?.noticeDetail).toBeUndefined()
  f.dispose()
})
