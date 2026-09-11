import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"
import { createTutorialChangeController } from "./tutorialChange"
import { CODING_PLAN } from "../../cards/fixtures/CodingPlan"
const plan = { ...CODING_PLAN, changes: [CODING_PLAN.changes[0]!] }
for (const mode of ["valid", "stale", "wrong-parent", "failed", "account-changed"] as const) test(`completion requires persisted verified receipt: ${mode}`, async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) }, removeItem: k => { data.delete(k) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 6, playthrough: mode === "stale" ? 2 : 1 } }).isPersisted.promise
  const receipt = { runId: "run", repo: "owner/repo", base: plan.base.commitId, parent: mode === "wrong-parent" ? "f".repeat(40) : plan.base.commitId, sha: "e".repeat(40), subject: "Commit", files: ["src/memory.ts"] }
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "run", kind: "run-trace", title: "Change", status: "acted", createdAt: 0, ordinal: 1,
    payload: { repo: "owner/repo", runId: "run", workflow: "tutorial-change", kind: "change", phase: mode === "failed" ? "failed" : "completed", steps: [], result: null, lastSeq: 1,
      input: { plan, tutorialScope: { repoKey: store.session().activeRepoKey, playthrough: 1, accountEpoch: 0, accountLogin: store.collections.identitySessions.get("identity")?.login } } } } }).isPersisted.promise
  const ctx = { store, accountEpoch: mode === "account-changed" ? 1 : 0, commandActor: "user", baseUrl: "", boundedFetch: async () => Response.json(receipt) } as unknown as ControllerContext
  const controller = createTutorialChangeController(ctx, {} as WorkflowController, () => 1, () => undefined)
  await controller.finishTutorialChange("run")
  expect(store.session().guide?.completed?.includes("commits.made") ?? false).toBe(mode === "valid")
  const card = store.collections.cards.get("run")
  if (mode === "valid") expect(card?.kind === "run-trace" && card.payload.input?.tutorialReceipt).toEqual(receipt)
  await store.dispose?.()
})
