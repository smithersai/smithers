import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { FirstRunActions, firstRunGroups } from "./FirstRunActions"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const commands = [{ name: "wiki", summary: "Wiki" }, { name: "auth.sign-in", summary: "Sign in" }, { name: "issues.list", summary: "Issues" }, { name: "card.close", summary: "Close", hidden: true }]
const state = { surface: "chat" as const, typing: false, signedOut: true, hasConnectors: false, admin: false }

test("every visible catalog flow is grouped, with recommendations first", () => {
  const groups = firstRunGroups(commands, state)
  expect(groups[0]?.namespace).toBe("auth")
  expect(groups.flatMap(group => group.flows.map(flow => flow.name)).sort()).toEqual(["auth.sign-in", "issues.list", "wiki"])
})

test("flow buttons dispatch once and dismissal survives the next render and reload", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let store = await createAppStore({ kind: "localStorage", storage })
  const calls: unknown[][] = []
  const host = document.createElement("div")
  document.body.append(host)
  let root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store, commands: { all: () => commands }, runCommand: (...args: unknown[]) => { calls.push(args) } } as unknown as AppController}><FirstRunActions /></ControllerContext>))
  render()
  await new Promise(resolve => setTimeout(resolve, 20))
  const buttons = host.querySelectorAll<HTMLButtonElement>("[data-flow]")
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
