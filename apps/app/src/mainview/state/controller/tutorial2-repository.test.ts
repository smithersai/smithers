import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createTutorialRepositoryController, type RepositoryChoicePayload } from "./tutorialRepository"
import type { ControllerContext } from "./context"
test("choice persists active repository before real signal and survives store reload", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 2 } }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  let payload: RepositoryChoicePayload | undefined
  const ctx = { store, commandActor: "user", accountEpoch: 0, baseUrl: "", boundedFetch: async (url: string) => Response.json(url.includes("commits") ? [] : [{ full_name: "org/repo" }]) } as unknown as ControllerContext
  const controller = createTutorialRepositoryController(ctx, { publish: async p => { payload = p }, localHandoff: async () => {} })
  await controller.chooseTutorialRepository()
  expect(payload?.selected).toBe("org/repo")
  expect(store.session().guide?.completed).not.toContain("repository.ready")
  await controller.chooseTutorialRepository("org/repo")
  expect(store.session().activeRepoKey).toBe("org/repo")
  expect(store.session().guide?.completed).toContain("repository.ready")
  await store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().activeRepoKey).toBe("org/repo")
  expect(reloaded.session().guide?.completed).toContain("repository.ready")
  await reloaded.dispose?.()
})

test("stale ranking never selects or signals, and cloud creation uses the local handoff", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) }, removeItem: k => { data.delete(k) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 2 } }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  let published = false, handedOff = false
  const ctx = { store, services: {}, commandActor: "user", accountEpoch: 0, baseUrl: "", boundedFetch: async () => {
    ctx.accountEpoch++
    return Response.json([])
  } } as unknown as ControllerContext
  const controller = createTutorialRepositoryController(ctx, { publish: async () => { published = true }, localHandoff: async () => { handedOff = true } })
  expect(await controller.chooseTutorialRepository()).toContain("changed")
  expect(published).toBe(false)
  await controller.createTutorialRepository("smithers-playground")
  expect(handedOff).toBe(true)
  expect(store.session().guide?.completed).not.toContain("repository.ready")
  await store.dispose?.()
})

test("a created directory is not completion when adoption fails", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) }, removeItem: k => { data.delete(k) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 2 } }).isPersisted.promise
  let published = false
  const ctx = { store, commandActor: "user", accountEpoch: 0, baseUrl: "", services: { bootstrap: { capabilities: ["local.repositories"] } },
    openRepo: async () => "The grant expired.", boundedFetch: async () => Response.json({ status: "connected", repository: { root: "/tmp/tutorial2-repository-test", name: "test", authorizationId: "grant", head: null, branch: "main", remoteUrl: null } })
  } as unknown as ControllerContext
  const controller = createTutorialRepositoryController(ctx, { publish: async () => { published = true }, localHandoff: async () => {} })
  expect(await controller.createTutorialRepository("test")).toBe("The grant expired.")
  expect(published).toBe(false)
  expect(store.session().guide?.completed).not.toContain("repository.ready")
  await store.dispose?.()
})
