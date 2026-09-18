import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import { afterAll,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "../ControllerContext"
import { createAppController, type AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { FIRST_RUN_JOBS,FirstRunActions,FirstRunActionsCard,firstRunGroups } from "./FirstRunActions"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const jobTitles = ["Handle issues", "Review PRs", "Set up CI", "Build a feature", "Automate a chore"]
const commands = [...FIRST_RUN_JOBS.map((name, index) => ({ name, summary: jobTitles[index]! })),
  { name: "wiki", summary: "Wiki" }, { name: "auth.sign-in", summary: "Sign in" },
  { name: "issues.list", summary: "List issues" }, { name: "admin.health", summary: "Diagnostics" },
  { name: "chat.stop", summary: "Stop" }]
const state = { surface: "chat" as const, typing: false, signedOut: true, hasConnectors: false, admin: false }

test("first run projects five repository jobs without diagnostic or empty-context actions", () => {
  expect(firstRunGroups(commands, state).flatMap(group => group.flows.map(flow => flow.name))).toEqual([...FIRST_RUN_JOBS])
  expect(firstRunGroups(commands, { ...state, admin: true, signedOut: false }).flatMap(group => group.flows.map(flow => flow.name))).toEqual([...FIRST_RUN_JOBS])
})

test("missing or unavailable jobs are not invented; registry requirements still apply", () => {
  const flows = [{ name: "ci.setup", summary: "Set up CI", requires: ["signed-in"] },
    { name: "issues.setup", summary: "Handle issues", hidden: true },
    { name: "feature.setup", summary: "Build a feature", requires: ["repo-source"] }]
  expect(firstRunGroups(flows, state)).toEqual([])
  expect(firstRunGroups(flows, { ...state, signedOut: false, publicRepo: true }).flatMap(group => group.flows.map(flow => flow.name))).toEqual(["ci.setup", "feature.setup"])
})

test("job buttons use short registry labels and native keyboard semantics", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  flushSync(() => root.render(<FirstRunActionsCard commands={commands} state={state} onRunCommand={() => {}} onDismiss={() => {}} />))
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('section[aria-label="Repository jobs"] > button')]
  expect(buttons.map(button => button.textContent)).toEqual(jobTitles)
  expect(buttons.every(button => button.type === "button" && !button.disabled && button.tabIndex === 0)).toBe(true)
  expect(host.textContent).not.toContain("issues.setup")
  expect(host.querySelector('[data-flow="admin.health"]')).toBeNull()
  flushSync(() => root.unmount())
})

test("flow buttons dispatch once and dismissal survives the next render and reload", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let store = await createAppStore({ kind: "localStorage", storage })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
  const calls: unknown[][] = []
  const host = document.createElement("div")
  document.body.append(host)
  let root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => store.dispatch({ type: "first-run.dismissed", actor: "user" }), dismissHint: (id: string) => store.dispatch({ type: "hint.dismissed", actor: "user", id }), commands: { all: () => commands }, runCommand: (...args: unknown[]) => { calls.push(args) } } as unknown as AppController}><FirstRunActions /></ControllerContext>))
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  const buttons = host.querySelectorAll<HTMLButtonElement>("section > button[data-flow]")
  expect(buttons.length).toBe(5)
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="issues.setup"]')!.click())
  await store.settled?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  render()
  expect(calls).toEqual([["issues.setup", undefined]])
  expect(host.querySelector('[data-testid="first-run-actions"]')).not.toBeNull()
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="app.first-run.dismiss"]')!.click())
  await store.settled?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  render()
  expect(calls).toEqual([["issues.setup", undefined]])
  expect(host.querySelector('[data-testid="first-run-actions"]')).toBeNull()
  flushSync(() => root.unmount())
  await store.dispose?.()
  store = await createAppStore({ kind: "localStorage", storage })
  root = createRoot(host)
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(host.querySelector('[data-testid="first-run-actions"]')).toBeNull()
  flushSync(() => root.unmount())
  host.remove()
  await store.dispose?.()
})

test("the live card names the actions and adds no sentence about choosing one", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) },
  } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => {}, dismissHint: () => {}, commands: { all: () => commands }, runCommand: () => {} } as unknown as AppController}><FirstRunActions /></ControllerContext>))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.textContent).not.toContain("Choose an action to begin")
    expect(host.querySelector('[data-testid="first-run-actions"]')?.getAttribute("aria-label")).toBe("Recommended actions")
    expect([...host.querySelectorAll<HTMLButtonElement>('section[aria-label="Repository jobs"] > button')].map(button => button.textContent)).toEqual(jobTitles)
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    await store.dispose?.()
  }
})

test("the live catalog keeps unavailable runtime and admin plugin flows out", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) },
  } })
  const controller = createAppController(store, {
    available: false,
    pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "Unavailable" }),
  }, {
    available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {},
  }, { bootstrap: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity"], authFlow: "redirect", sandbox: null,
  } })
  try {
    const names = () => firstRunGroups(controller.commands.all(), state).flatMap(group => group.flows.map(flow => flow.name))
    expect(names()).toEqual([...FIRST_RUN_JOBS])
    expect(names()).not.toContain("repo.open")
    expect(names()).not.toContain("files.list")
    expect(names()).not.toContain("prs.list")
    expect(names()).not.toContain("admin.health")
    expect(names().some(name => name.startsWith("system."))).toBe(false)
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "admin", allowlisted: true, admin: true, scopesPlain: null })
    expect(firstRunGroups(controller.commands.all(), { ...state, signedOut: false, admin: true }).flatMap(group => group.flows.map(flow => flow.name))).not.toContain("admin.health")
  } finally {
    await controller.dispose()
    await store.dispose?.()
  }
})

/** A repository whose first job exists: the state the canary walk lost the other four jobs in. */
const configuredHome = async (calls: Array<[string, string | undefined]>) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) },
  } })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "pending" } })
  store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "home", repo: "will/demo", phase: "ready" } })
  const card = (job: "issues" | "review", enabled?: boolean) => {
    const payload = initialSetup("will/demo", job, "will")
    return { id: `setup:will:will%2Fdemo:${job}`, kind: "repository-setup" as const, title: job, status: "active" as const, createdAt: 1, ordinal: 1,
      payload: enabled === undefined ? payload : { ...payload, active: { revision: payload.revision, digest: setupCandidate(payload), registrationId: "reg", sourceRevision: "f4d4814e", enabled } } }
  }
  store.dispatch({ type: "card.upsert", actor: "system", card: card("issues") })
  store.dispatch({ type: "card.upsert", actor: "system", card: card("review", false) })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, dismissFirstRun: () => store.dispatch({ type: "first-run.dismissed", actor: "user" }), dismissHint: () => {}, commands: { all: () => commands }, runCommand: (name: string, args?: string) => { calls.push([name, args]) } } as unknown as AppController}><FirstRunActions /></ControllerContext>))
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  return { store, host, root, render, jobs: () => [...host.querySelectorAll<HTMLButtonElement>('section[aria-label="Repository jobs"] > button')],
    settle: async () => { await store.settled?.(); await new Promise(resolve => setTimeout(resolve, 20)); render() },
    dispose: async () => { flushSync(() => root.unmount()); host.remove(); await store.dispose?.() } }
}

test("every job stays one button away after the first job exists; only the dismissal closes the card", async () => {
  const calls: Array<[string, string | undefined]> = []
  const home = await configuredHome(calls)
  try {
    home.jobs()[0]!.click()
    await home.settle()
    expect(calls).toEqual([["issues.setup", "will/demo"]])
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    home.jobs()[1]!.click()
    await home.settle()
    expect(calls[1]).toEqual(["review.setup", "will/demo"])
    expect(home.jobs().map(button => button.dataset.flow)).toEqual([...FIRST_RUN_JOBS])
    home.host.querySelector<HTMLButtonElement>('[aria-label="Dismiss recommended actions"]')!.click()
    await home.settle()
    expect(home.host.querySelector('[data-testid="first-run-actions"]')).toBeNull()
    expect(calls.length).toBe(2)
  } finally { await home.dispose() }
})

test("a configured job's button reads the state its card reads", async () => {
  const home = await configuredHome([])
  try {
    expect(home.jobs().map(button => button.textContent)).toEqual(["Handle issues · Off", "Review PRs · Paused", "Set up CI", "Build a feature", "Automate a chore"])
  } finally { await home.dispose() }
})

test("first arrival binds every setup action to the explicit repository before catalog inspection finishes", () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<FirstRunActionsCard commands={commands} state={state} repo="requested/repo"
      onRunCommand={(name, args) => { calls.push([name, args]) }} onDismiss={() => {}} />))
    for (const button of host.querySelectorAll<HTMLButtonElement>('section[aria-label="Repository jobs"] > button')) button.click()
    expect(calls).toEqual(FIRST_RUN_JOBS.map(name => [name, "requested/repo"]))
  } finally { flushSync(() => root.unmount()) }
})
