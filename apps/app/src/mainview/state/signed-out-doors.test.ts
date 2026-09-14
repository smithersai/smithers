import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settle, unavailableAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()
const setup = async (fetchImpl?: import("./AppController").AppServices["fetchImpl"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const redirects: string[] = []
  const requests: string[] = []
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    openExternal: async url => { redirects.push(url); return true },
    fetchImpl: async (input, init) => {
      requests.push(String(input))
      return fetchImpl ? fetchImpl(input, init) : Response.json({ message: "Unexpected request" }, { status: 404 })
    },
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  await settle()
  requests.length = 0
  return { store, controller, redirects, requests }
}

for (const [name, args] of [["flow.run", "review smithersai/smithers"], ["secrets.list", undefined], ["issues.link-linear", "3"]] as const) {
  test(`${name} signed out parks with the sign-in prompt and no OAuth or toast`, async () => {
    const { controller, store, requests, redirects } = await setup()
    controller.runCommand(name, args)
    await settle()
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in")).toHaveLength(1)
    expect(store.session().pendingCommand).toMatchObject({ name, args: args ?? null, requirement: "signed-in" })
    expect(requests).toEqual([])
    expect(redirects).toEqual([])
    expect([...store.collections.toasts.values()]).toEqual([])
  })
}

for (const source of ["issues", "github", "prs"] as const) {
  test(`${source} 401 renders a prompt, never an empty list or refusal toast`, async () => {
    const { controller, store, redirects } = await setup(async input => {
      if (source === "github" && !String(input).includes("github-repos")) return Response.json([])
      return Response.json({ message: "Sign in to read this repository" }, { status: 401 })
    })
    controller.runCommand(source === "prs" ? "prs.list" : "issues.list")
    await settle()
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in")).toHaveLength(1)
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list" || card.kind === "pr-list")).toEqual([])
    expect([...store.collections.toasts.values()]).toEqual([])
    expect(redirects).toEqual([])
  })
}
