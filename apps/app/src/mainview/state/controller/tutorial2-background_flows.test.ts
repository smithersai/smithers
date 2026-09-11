import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide, type Card } from "../AppState"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"
import { createLibrarianRunsController, LIBRARIAN_SIGNAL, type LibrarianRunHost } from "./librarianRuns"

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
    workflowTargetRepo: () => ({ repo }), provisionWorkspace: async () => true,
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
    expect(f.store.session().guide?.notice).toBe("Create Mythical history didn't start: The gateway refused the launch.")
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
