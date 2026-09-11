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
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 6 } }).isPersisted.promise
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

describe("Librarian run monitoring", () => {
  test("only inspecting both distinct persisted launch receipts completes; a new controller reattaches", async () => {
    const f = await fixture()
    await Promise.all([f.controller.createWiki("will/demo"), f.controller.bootstrapHistory("will/demo")])
    expect(f.launches).toHaveLength(2)
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    await f.controller.inspectLibrarianRun(f.launches[0]!)
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    const reattached = createLibrarianRunsController(f.ctx, f.runs)
    await reattached.createWiki("will/demo")
    expect(f.launches).toHaveLength(2)
    await reattached.inspectLibrarianRun(f.launches[1]!)
    expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
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
    await f.controller.inspectLibrarianRun(f.launches[0]!)
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  })
  test("unrelated repo and stale playthrough cannot complete", async () => {
    const f = await fixture()
    await f.controller.createWiki("will/demo")
    await f.controller.bootstrapHistory("will/demo")
    f.select("other/repo")
    for (const id of f.launches) await f.controller.inspectLibrarianRun(id)
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
    f.select("will/demo")
    await f.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 6, playthrough: 1 } }).isPersisted.promise
    for (const id of f.launches) await f.controller.inspectLibrarianRun(id)
    expect(f.store.session().guide?.completed).not.toContain(LIBRARIAN_SIGNAL)
  })
  test("failed runs remain inspectable with their error and still count as launched", async () => {
    const f = await fixture()
    await f.controller.createWiki("will/demo")
    await f.controller.bootstrapHistory("will/demo")
    const id = `flow-run-${f.launches[1]}`
    const card = f.store.collections.cards.get(id)!
    if (card.kind !== "run-trace") throw new Error("missing run")
    await f.store.dispatch({ type: "card.updated", actor: "system", id,
      patch: { payload: { ...card.payload, phase: "failed", error: "Git refused the update." } } }).isPersisted.promise
    for (const runId of f.launches) await f.controller.inspectLibrarianRun(runId)
    expect(f.store.session().guide?.completed).toContain(LIBRARIAN_SIGNAL)
    expect(f.store.collections.cards.get(id)).toMatchObject({ payload: { phase: "failed", error: "Git refused the update." } })
  })
})
