import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup } from "@smthrs/rpc/RepositorySetup"
import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { resolveSteps, SETUP_STEPS, SetupChecklist, SetupChecklistCard } from "./SetupChecklist"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const commands = [
  { name: "auth.sign-in", summary: "Sign in with GitHub" },
  { name: "repos.import", summary: "Import a GitHub repository into Smithers Cloud" },
  { name: "repo.open", summary: "Open a local repository" },
  { name: "issues.setup", summary: "Handle issues" },
  { name: "debug.snapshot", summary: "Snapshot", hidden: true },
]
const empty = { signedIn: false, hasRepo: false, hasSetup: false }
const done = { signedIn: true, hasRepo: true, hasSetup: true }

test("each step names the first flow this host registered, and completion follows state", () => {
  const steps = resolveSteps(commands, empty)
  expect(steps.map(step => [step.id, step.flow, step.complete])).toEqual([
    ["connect-github", "auth.sign-in", false],
    ["add-repository", "repos.import", false],
    ["set-up-job", "issues.setup", false],
  ])
  expect(resolveSteps(commands, done).every(step => step.complete)).toBe(true)
  expect(resolveSteps(commands.filter(command => command.name !== "repos.import"), empty)[1]?.flow).toBe("repo.open")
  expect(resolveSteps(commands.filter(command => command.name !== "auth.sign-in"), empty)[0]?.flow).toBeUndefined()
})

test("the step count matches the list the pattern promises", () => {
  expect(SETUP_STEPS.map(step => step.id)).toEqual(["connect-github", "add-repository", "set-up-job"])
})

test("incomplete steps are flow buttons; completed steps are not interactive", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: Array<[string, string | undefined]> = []
  try {
    const steps = resolveSteps(commands, { ...empty, signedIn: true }, "requested/repo")
    flushSync(() => root.render(<SetupChecklistCard steps={steps} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
    expect(host.querySelector("header")?.textContent).toContain("1 of 3")
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("1")
    const items = [...host.querySelectorAll<HTMLLIElement>("li")]
    expect(items[0]?.dataset.complete).toBe("true")
    expect(items[0]?.querySelector("button")).toBeNull()
    const buttons = items.flatMap(item => [...item.querySelectorAll<HTMLButtonElement>("button")])
    expect(buttons.map(button => [button.dataset.flow, button.textContent])).toEqual([
      ["repos.import", "Add a repository"],
      ["issues.setup", "Set up a job"],
    ])
    expect(buttons.every(button => button.type === "button" && !button.disabled && button.tabIndex === 0)).toBe(true)
    buttons[1]!.click()
    expect(calls).toEqual([["issues.setup", "requested/repo"]])
  } finally { flushSync(() => root.unmount()) }
})

test("signing in checks the first step off live, and a finished list unmounts itself", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let store = await createAppStore({ kind: "localStorage", storage })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
  const calls: unknown[][] = []
  const host = document.createElement("div")
  document.body.append(host)
  let root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, commands: { all: () => commands }, runCommand: (...args: unknown[]) => { calls.push(args) } } as unknown as AppController}><SetupChecklist /></ControllerContext>))
  try {
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelectorAll("li button").length).toBe(3)
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-flow="auth.sign-in"]')!.click())
    expect(calls).toEqual([["auth.sign-in", undefined]])
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-flow="auth.sign-in"]')).toBeNull()
    expect(host.querySelector("header")?.textContent).toContain("1 of 3")
    store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/demo", org: "will", ownerKind: "user", name: "demo", head: null }] })
    store.dispatch({ type: "card.upsert", actor: "system", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload: initialSetup("will/demo", "issues", "will") } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
    flushSync(() => root.unmount())
    await store.dispose?.()
    store = await createAppStore({ kind: "localStorage", storage })
    root = createRoot(host)
    render()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(host.querySelector('[data-testid="setup-checklist"]')).toBeNull()
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    await store.dispose?.()
  }
})
