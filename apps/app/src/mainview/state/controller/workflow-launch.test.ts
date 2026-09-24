import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, unavailableAgent, unavailableRepositories } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createWorkflowLaunchController } from "./workflow-launch"

/*
 * Equivalent requests are admitted one at a time: a second press waits for
 * the first request to be saved. Sign-out while it waits forgets every card,
 * so neither press may save or acknowledge a request for the account that
 * ended.
 */
test("requests waiting on admission when the account ends save nothing and acknowledge nothing", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, { fetchImpl: () => new Promise<Response>(() => {}) })
  const prepared: string[] = []
  const launch = createWorkflowLaunchController(ctx, () => 1, () => new Promise(() => {}), (repo) => {
    prepared.push(repo)
    return new Promise(() => {})
  })
  const args = { repo: "owner/private", binding: {}, workflow: "review", input: { args: "secret" }, actor: "user" as const }
  try {
    const first = launch.start(args)
    const second = launch.start(args)
    store.dispatch({ type: "identity.session.cleared", actor: "user" })
    const answers = await Promise.all([first, second])
    await settle()
    expect(answers).toEqual(["The account changed before the run was requested.", "The account changed before the run was requested."])
    expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace")).toEqual([])
    expect(prepared).toEqual([])
  } finally { await ctx.dispose(); await store.dispose?.() }
})
