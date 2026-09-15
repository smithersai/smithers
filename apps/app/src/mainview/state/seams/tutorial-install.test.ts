import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createGitHubSeam, GITHUB_APP_INSTALL_URL, INSTALL_VERIFY_PATH } from "./GitHubSeam"
import type { SeamContext } from "./SeamContext"
import { guideActionState } from "../../onboarding/actionState"

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
  return { store, requested, ctx, seam: createGitHubSeam(ctx) }
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
  expect(store.collections.repositories.has("acme/web")).toBe(true)
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


test("the registered install page opens only after durable state has settled", async () => {
  const { store, ctx } = await setup(() => Response.json({ repos: [] }))
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ada", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const events: string[] = []
  const wrapped = { ...ctx, store: { ...store, settled: async () => { await store.settled?.(); events.push("persisted") } } }
  const seam = createGitHubSeam(wrapped, { openExternal: async url => { events.push(url); return true } })
  await seam.openInstall()
  expect(events).toEqual(["persisted", `${GITHUB_APP_INSTALL_URL}?state=onboarding%3A0`])
  expect(GITHUB_APP_INSTALL_URL).toBe("https://github.com/apps/smitherspreviewrelease/installations/new")
  await store.dispose?.()
})

test("a callback from an earlier playthrough never verifies or adopts a repository", async () => {
  const { store, seam, requested } = await setup(() => Response.json({ repos: [{ fullName: "acme/api" }] }))
  seam.handleInstallReturn("?installation_id=42&setup_action=install&state=onboarding%3A99")
  await settle()
  expect(requested).toEqual([])
  expect(store.session().guide?.completed).not.toContain("github.app.installed")
  expect(store.session().guide?.notice).toContain("earlier tutorial")
  await store.dispose?.()
})

test("returning with no imported repositories verifies a newly installed source repository", async () => {
  const { store, seam, requested } = await setup(() => Response.json({ repos: [{ fullName: "ada/new-repo", pushedAt: "2026-09-12T00:00:00Z" }] }))
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ada", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  expect(store.collections.repositories.size).toBe(0)
  await seam.settleInstallLesson()
  expect(requested).toEqual([INSTALL_VERIFY_PATH])
  expect(store.session().guide?.completed).toContain("github.app.installed")
  expect(store.session().guide?.repo).toBe("ada/new-repo")
  await store.dispose?.()
})

const signIn = async (store: Awaited<ReturnType<typeof createAppStore>>) => {
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ada", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
}
test("the install pill verifies first and never opens GitHub for an existing installation", async () => {
  const f = await setup(() => Response.json({ repos: [{ fullName: "ada/hello", installationId: 42 }] }))
  await signIn(f.store)
  const opened: string[] = []
  const seam = createGitHubSeam(f.ctx, { openExternal: async url => { opened.push(url); return true } })
  await seam.openInstall()
  expect(f.requested).toEqual([INSTALL_VERIFY_PATH])
  expect(opened).toEqual([])
  expect(f.store.session().guide?.said?.["github.app.installed"]).toBe("I can see ada/hello.")
})
test("several installations render a schema-derived chooser; selecting re-verifies that installation", async () => {
  const f = await setup(() => Response.json({ repos: [
    { fullName: "ada/hello", installationId: 42 }, { fullName: "acme/api", installationId: 99 }
  ] }))
  await signIn(f.store)
  await f.seam.settleInstallLesson()
  expect(f.store.session().guide?.completed).not.toContain("github.app.installed")
  const card = f.store.collections.cards.get("form-github.app.choose")
  expect(card).toMatchObject({ kind: "flow-form", payload: { flow: "github.app.choose", fields: [
    { name: "installationId", required: true, kind: "select", options: [
      { value: "42", label: "ada" }, { value: "99", label: "acme" }
    ] }
  ] } })
  Object.assign(f.ctx, { http: async (input: RequestInfo | URL) => { f.requested.push(String(input)); return Response.json({ repos: [{ fullName: "acme/api", installationId: 99 }] }) } })
  await f.seam.chooseInstallation("99")
  expect(f.requested.at(-1)).toBe(`${INSTALL_VERIFY_PATH}/99`)
  expect(f.store.session().guide?.repo).toBe("acme/api")
})
test("a typed verification failure keeps the lesson retryable and never opens GitHub", async () => {
  const f = await setup(() => Response.json({ code: "request_conflict", message: "Your GitHub credential cannot access this repository." }, { status: 409 }))
  await signIn(f.store)
  const opened: string[] = []
  await createGitHubSeam(f.ctx, { openExternal: async url => { opened.push(url); return true } }).openInstall()
  expect(opened).toEqual([])
  expect(f.store.session().guide?.notice).toBe("Your GitHub credential cannot access this repository.")
  expect(f.store.session().guide?.completed).not.toContain("github.app.installed")
})

test("malformed inventory is a verification failure, not permission to open GitHub", async () => {
  const f = await setup(() => Response.json({ repos: [{ fullName: "not-a-repo" }] }))
  await signIn(f.store)
  const opened: string[] = []
  await createGitHubSeam(f.ctx, { openExternal: async url => { opened.push(url); return true } }).openInstall()
  expect(opened).toEqual([])
  expect(f.store.session().guide?.notice).toContain("unreadable")
})

test("returning focus after GitHub installation re-verifies and settles the same lesson", async () => {
  let installed = false
  const f = await setup(() => Response.json({ repos: installed ? [{ fullName: "ada/hello", installationId: 42 }] : [] }))
  await signIn(f.store)
  const original = Object.getOwnPropertyDescriptor(globalThis, "window")
  const focusTarget = new EventTarget()
  Object.defineProperty(globalThis, "window", { configurable: true, value: focusTarget })
  try {
    const seam = createGitHubSeam(f.ctx, { openExternal: async () => { installed = true; return true } })
    await seam.openInstall()
    expect(f.store.session().guide?.completed).not.toContain("github.app.installed")
    focusTarget.dispatchEvent(new Event("focus"))
    await settle()
    expect(f.requested).toEqual([INSTALL_VERIFY_PATH, INSTALL_VERIFY_PATH])
    expect(f.store.session().guide?.said?.["github.app.installed"]).toBe("I can see ada/hello.")
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("a chooser verification failure is returned to the form so submission remains retryable", async () => {
  const f = await setup(() => Response.json({ code: "request_conflict", message: "Your GitHub credential cannot access this repository." }, { status: 409 }))
  await signIn(f.store)
  expect(await f.seam.chooseInstallation("42")).toBe("Your GitHub credential cannot access this repository.")
  expect(f.store.session().guide?.completed).not.toContain("github.app.installed")
  await f.store.dispose?.()
})

test("returning to the install lesson re-verifies after an earlier empty check", async () => {
  let installed = false
  const f = await setup(() => Response.json({ repos: installed ? [{ fullName: "ada/hello", installationId: 42 }] : [] }))
  await signIn(f.store)
  await f.seam.settleInstallLesson()
  await f.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...f.store.session().guide!, step: 10 } }).isPersisted.promise
  await f.seam.settleInstallLesson()
  installed = true
  await f.store.dispatch({ type: "guide.changed", actor: "user", guide: { ...f.store.session().guide!, step: 11 } }).isPersisted.promise
  await f.seam.settleInstallLesson()
  expect(f.requested).toEqual([INSTALL_VERIFY_PATH, INSTALL_VERIFY_PATH])
  expect(f.store.session().guide?.said?.["github.app.installed"]).toBe("I can see ada/hello.")
  await f.store.dispose?.()
})

/*
 * Browsers only open a popup within the click's user activation (~5 s in
 * Chromium). Verifying pages the whole inventory first, so the install page
 * is reserved in the click and navigated once the check says to install.
 */
const slowInstall = async () => {
  const f = await setup(() => Response.json({ repos: [] }))
  await signIn(f.store)
  const answers: Array<(response: Response) => void> = []
  Object.assign(f.ctx, { http: (input: RequestInfo | URL) => { f.requested.push(String(input)); return new Promise<Response>(resolve => answers.push(resolve)) } })
  const popup = { opener: {} as unknown, closed: false, location: { href: "about:blank" }, close() { popup.closed = true } }
  const opened: Array<unknown[]> = []
  const original = Object.getOwnPropertyDescriptor(globalThis, "window")
  const target = Object.assign(new EventTarget(), { open: (...args: unknown[]) => { opened.push(args); return blocked ? null : popup } })
  let blocked = false
  Object.defineProperty(globalThis, "window", { configurable: true, value: target })
  const restore = () => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window") }
  return { ...f, answers, popup, opened, restore, block: () => { blocked = true } }
}

test("the install pill reserves GitHub's page within the click, shows the check, and checks once", async () => {
  const f = await slowInstall()
  try {
    const first = f.seam.openInstall()
    expect(f.opened).toEqual([["about:blank", "_blank"]])
    expect(f.popup.opener).toBeNull()
    await settle()
    const action = { label: "Install the GitHub App", key: "a", flow: "github.app.open" }
    expect(guideActionState(action, [], f.store.session().guide!)).toMatchObject({ label: "Checking GitHub…", disabled: true, busy: true })
    const second = f.seam.openInstall()
    await settle()
    expect(f.requested).toEqual([INSTALL_VERIFY_PATH])
    expect(f.opened).toHaveLength(1)
    f.answers[0]!(Response.json({ repos: [] }))
    await Promise.all([first, second])
    expect(f.popup.location.href).toBe(`${GITHUB_APP_INSTALL_URL}?state=onboarding%3A0`)
    expect(f.popup.closed).toBe(false)
    expect(guideActionState(action, [], f.store.session().guide!)).toEqual(action)
  } finally { f.restore(); await f.store.dispose?.() }
})

test("an existing installation closes the reserved page and finishes the lesson", async () => {
  const f = await slowInstall()
  try {
    const pending = f.seam.openInstall()
    await settle()
    f.answers[0]!(Response.json({ repos: [{ fullName: "ada/hello", installationId: 42 }] }))
    await pending
    expect(f.popup.closed).toBe(true)
    expect(f.popup.location.href).toBe("about:blank")
    expect(f.store.session().guide?.said?.["github.app.installed"]).toBe("I can see ada/hello.")
  } finally { f.restore(); await f.store.dispose?.() }
})

test("a blocked install page says so instead of doing nothing", async () => {
  const f = await slowInstall()
  f.block()
  try {
    const pending = f.seam.openInstall()
    await settle()
    f.answers[0]!(Response.json({ repos: [] }))
    expect(await pending).toContain("blocked the GitHub install page")
  } finally { f.restore(); await f.store.dispose?.() }
})
