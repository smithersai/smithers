import { CODING_PLAN } from "../../cards/fixtures/CodingPlan"
import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createRunsController } from "./runs"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"

test("user and agent select the same persisted payload and emit trace.opened only after real scoped inspection", async () => {
  for (const actor of ["user", "smithers"] as const) {
    const data = new Map<string, string>()
    const store = await createAppStore({ kind: "localStorage", storage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
      removeItem: key => { data.delete(key) }
    } })
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "owner/repo", org: "owner", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
    await store.dispatch({ type: "repo.selected", actor: "user", id: "owner/repo" }).isPersisted.promise
    await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 8, completed: ["change.committed"], playthrough: 2 } }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "flow-run-change", kind: "run-trace", title: "Change", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "owner/repo", runId: "change", workflow: "tutorial-change", kind: "change", input: { plan: CODING_PLAN, tutorialScope: { repoKey: "owner/repo", playthrough: 2 }, tutorialReceipt: { runId: "change", repo: "owner/repo", base: "a".repeat(40), parent: "a".repeat(40), sha: "e".repeat(40), subject: "Recorded change", files: ["src/index.ts"] } }, phase: "completed", steps: [], result: null, lastSeq: 3, events: [
        { sequence: 1, kind: "control.agent.turn-opened", payload: {} },
        { sequence: 2, kind: "control.agent.cell-produced", payload: { text: "await ctx.call('files.read')" } },
        { sequence: 3, kind: "control.agent.cell-call-started", payload: { flowName: "files.read" } }
      ] }
    } }).isPersisted.promise
    const ctx = { store, gateway: {}, commandActor: actor, accountEpoch: 1 } as unknown as ControllerContext
    const controller = createRunsController(ctx, () => 1, {} as WorkflowController)
    await controller.traceSelect("change", "invented")
    expect(store.session().guide?.completed).not.toContain("trace.opened")
    await controller.traceSelect("change", "frame-1")
    expect(store.session().guide?.completed).toContain("trace.opened")
    const card = store.collections.cards.get("flow-run-change")
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ selection: "frame-1", facet: "steps", liveTail: false, cursorSeq: 3 })
    expect([...store.collections.transitions.values()].filter(row => row.type === "guide.changed").at(-1)?.actor).toBe(actor)
    await store.dispose?.()
  }
})
