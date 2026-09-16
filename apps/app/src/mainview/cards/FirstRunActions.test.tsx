import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "../ControllerContext"
import { createAppController, type AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { FirstRunActions,FirstRunActionsCard,firstRunGroups } from "./FirstRunActions"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const commands = [{ name: "wiki", summary: "Wiki" }, { name: "auth.sign-in", summary: "Sign in" }, { name: "issues.list", summary: "List a repository's issues" }, { name: "auth.sign-out", summary: "Sign out", requires: ["signed-in"] }, { name: "system.recommend", summary: "Refresh suggestions" }, { name: "card.close", summary: "Close", hidden: true }]
const state = { surface: "chat" as const, typing: false, signedOut: true, hasConnectors: false, admin: false }

test("only offerable catalog flows are grouped, with recommendations first", () => {
  const groups = firstRunGroups(commands, state)
  expect(groups[0]?.namespace).toBe("auth")
  expect(groups.flatMap(group => group.flows.map(flow => flow.name)).sort()).toEqual(["auth.sign-in", "issues.list", "wiki"])
})


test("labels use summaries and human namespace titles, with recommended emphasis", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  flushSync(() => root.render(<FirstRunActionsCard commands={commands} state={state} onRunCommand={() => {}} onDismiss={() => {}} />))
  expect([...host.querySelectorAll("h3")].map(heading => heading.textContent)).toEqual(["Account", "Issues", "Wiki"])
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("section > button[data-flow]")]
  expect(buttons.map(button => button.textContent)).toEqual(["Sign in", "List a repository's issues", "Wiki"])
  expect(buttons.every(button => !button.hasAttribute("title"))).toBe(true)
  expect(buttons[0]?.classList.contains("emphasis")).toBe(true)
  expect(buttons[1]?.classList.contains("emphasis")).toBe(false)
  expect(host.textContent).not.toContain("issues.list")
  expect(host.querySelector('[data-flow="auth.sign-out"]')).toBeNull()
  flushSync(() => root.unmount())
})

test("sign-in and repository requirements follow the registry predicates", () => {
  const flows = [...commands, { name: "repo.files", summary: "Browse files", requires: ["repo-source"] }]
  const names = (overrides: Partial<typeof state> & { publicRepo?: boolean } = {}) =>
    firstRunGroups(flows, { ...state, ...overrides }).flatMap(group => group.flows.map(flow => flow.name))
  expect(names()).not.toContain("auth.sign-out")
  expect(names()).not.toContain("repo.files")
  expect(names({ signedOut: false })).toContain("auth.sign-out")
  expect(names({ publicRepo: true })).toContain("repo.files")
})

test("unmapped namespaces use a capitalized heading", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  flushSync(() => root.render(<FirstRunActionsCard commands={[{ name: "appearance.theme", summary: "Choose a theme" }]} state={state} onRunCommand={() => {}} onDismiss={() => {}} />))
  expect(host.querySelector("h3")?.textContent).toBe("Appearance")
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
  expect(buttons.length).toBe(3)
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="issues.list"]')!.click())
  await store.settled?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  render()
  expect(calls).toEqual([["issues.list", undefined]])
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
    expect(names()).toContain("auth.sign-in")
    expect(names()).not.toContain("repo.open")
    expect(names()).not.toContain("files.list")
    expect(names()).toContain("prs.list")
    expect(names()).not.toContain("admin.health")
    expect(names().some(name => name.startsWith("system."))).toBe(false)
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "admin", allowlisted: true, admin: true, scopesPlain: null })
    expect(firstRunGroups(controller.commands.all(), { ...state, signedOut: false, admin: true }).flatMap(group => group.flows.map(flow => flow.name))).toContain("admin.health")
  } finally {
    await controller.dispose()
    await store.dispose?.()
  }
})
