import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createGitHubSeam, INSTALL_VERIFY_PATH } from "./GitHubSeam"
import type { SeamContext } from "./SeamContext"

/*
 * Onboarding SCRIPT v4 beat 11: the GitHub App's setup-URL return is verified
 * on the server, never trusted from the query, and only the lesson that waits
 * on the install finishes with it.
 */
const INSTALL_STEP = 11

const setup = async (answer: () => Response, step = INSTALL_STEP) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) }
  } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step } }).isPersisted.promise
  const requested: Array<string> = []
  const ctx: SeamContext = {
    store, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1,
    http: async (input: RequestInfo | URL) => { requested.push(String(input)); return answer() }
  } as unknown as SeamContext
  return { store, requested, seam: createGitHubSeam(ctx) }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

test("a verified install selects the most recently pushed repository and finishes the lesson", async () => {
  const { store, requested, seam } = await setup(() => Response.json({ repos: [
    { fullName: "acme/web", pushedAt: "2026-09-01T00:00:00Z" },
    { fullName: "acme/api", pushedAt: "2026-09-09T10:00:00Z" }
  ] }))
  expect(seam.handleInstallReturn("?installation_id=42&setup_action=install")).toBe(true)
  await settle()
  expect(requested).toEqual([`${INSTALL_VERIFY_PATH}/42`])
  const guide = store.session().guide
  expect(guide?.completed).toContain("github.app.installed")
  expect(guide?.repo).toBe("acme/api")
  expect(guide?.said?.["github.app.installed"]).toBe("I can see acme/api.")
  expect(store.collections.repositories.has("acme/api")).toBe(true)
  await store.dispose?.()
})

test("an unverifiable return says so under the lesson and selects nothing", async () => {
  const { store, seam } = await setup(() => new Response("not found", { status: 404 }))
  expect(seam.handleInstallReturn("?installation_id=42&setup_action=install")).toBe(true)
  await settle()
  const guide = store.session().guide
  expect(guide?.completed ?? []).not.toContain("github.app.installed")
  expect(guide?.notice).toContain("can't confirm installs yet")
  expect(guide?.repo).toBeUndefined()
  await store.dispose?.()
})

test("a return with no installation, or outside the lesson, never completes", async () => {
  const empty = await setup(() => Response.json({ repos: [] }))
  expect(empty.seam.handleInstallReturn("?setup_action=request")).toBe(true)
  await settle()
  expect(empty.requested).toEqual([])
  expect(empty.store.session().guide?.notice).toBe("Nothing came back from GitHub. Try again?")
  const elsewhere = await setup(() => Response.json({ repos: [{ fullName: "acme/api" }] }), 3)
  elsewhere.seam.handleInstallReturn("?installation_id=7&setup_action=install")
  await settle()
  expect(elsewhere.store.session().guide?.completed ?? []).not.toContain("github.app.installed")
  expect(empty.seam.handleInstallReturn("?repo=acme/api")).toBe(false)
})

/*
 * With AppController's settle subscription wired, a verified return completes the lesson once. This harness
 * persists instantly, so it does NOT reproduce the browser's adoption loop (a mutation check with the
 * single-flight guard removed still passes here); e2e/playwright/tutorial2-walk.spec.ts beat 11 is that reproduction.
 */
test("with the settle subscription wired, a verified return completes the lesson once", async () => {
  let loaded = 0
  const { store, seam } = await setup(() => Response.json({ repos: [{ fullName: "acme/api", pushedAt: "2026-09-09T10:00:00Z" }] }))
  // Exactly the wiring in AppController: every sessions or repositories change asks the lesson to settle.
  const settle = () => queueMicrotask(() => { void seam.settleInstallLesson() })
  const subscriptions = [store.collections.sessions.subscribeChanges(settle), store.collections.repositories.subscribeChanges(() => { loaded += 1; settle() })]
  seam.handleInstallReturn("?installation_id=42&setup_action=install")
  await new Promise(resolve => setTimeout(resolve, 50))
  for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 0))
  const guide = store.session().guide
  expect(guide?.completed).toContain("github.app.installed")
  expect(guide?.repo).toBe("acme/api")
  expect(loaded).toBeLessThan(4)
  for (const subscription of subscriptions) subscription.unsubscribe()
  await store.dispose?.()
})
