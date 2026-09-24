import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { LocalAuthPanel } from "./LocalAuthPanel"
import type { LocalAuthController, LocalAuthSnapshot } from "./state/LocalAuth"

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

test("owner setup hands credentials off without retaining either secret", async () => {
  const submitted: Array<{ username: string; password: string; bootstrapToken?: string }> = []
  const snapshot: LocalAuthSnapshot = {
    open: true,
    pending: false,
    status: { enabled: true, initialized: false },
    error: null
  }
  const auth: LocalAuthController = {
    requiresBootstrapTokenInput: true,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    open: () => {},
    close: () => {},
    submit: async (input) => { submitted.push(input) },
    dispose: () => {}
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))

  const username = host.querySelector<HTMLInputElement>('input[name="username"]')!
  const password = host.querySelector<HTMLInputElement>('input[name="password"]')!
  const bootstrap = host.querySelector<HTMLInputElement>('input[name="bootstrapToken"]')!
  username.value = "owner"
  password.value = "strong password"
  bootstrap.value = "bootstrap secret"
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })

  expect(submitted).toEqual([{
    username: "owner",
    password: "strong password",
    bootstrapToken: "bootstrap secret"
  }])
  expect(password.value).toBe("")
  expect(bootstrap.value).toBe("")
})

test("native owner setup does not ask for the handed-off bootstrap token", () => {
  const snapshot: LocalAuthSnapshot = {
    open: true,
    pending: false,
    status: { enabled: true, initialized: false },
    error: null
  }
  const auth: LocalAuthController = {
    requiresBootstrapTokenInput: false,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    open: () => {},
    close: () => {},
    submit: async () => {},
    dispose: () => {}
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))
  expect(host.querySelector('input[name="bootstrapToken"]')).toBeNull()
})

test("Escape closes owner sign-in and restores the sign-in door", () => {
  let closed = 0
  const trigger = document.createElement("button")
  trigger.dataset.testid = "chrome-sign-in"
  document.body.append(trigger)
  const snapshot: LocalAuthSnapshot = {
    open: true,
    pending: true,
    status: { enabled: true, initialized: true },
    error: null
  }
  const auth: LocalAuthController = {
    requiresBootstrapTokenInput: true,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    open: () => {},
    close: () => { closed += 1 },
    submit: async () => {},
    dispose: () => {}
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))

  host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true
  }))

  expect(closed).toBe(1)
  expect(document.activeElement).toBe(trigger)
})

test("sign-in traps Tab in both directions, including while all inputs are disabled", () => {
  for (const pending of [false, true]) {
    const snapshot: LocalAuthSnapshot = { open: true, pending, status: { enabled: true, initialized: true }, error: null }
    const auth: LocalAuthController = { requiresBootstrapTokenInput: false, subscribe: () => () => {}, snapshot: () => snapshot, open: () => {}, close: () => {}, submit: async () => {}, dispose: () => {} }
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.add(root)
    flushSync(() => root.render(<><button>Outside</button><LocalAuthPanel auth={auth} /></>))
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!
    const controls = [...dialog.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")]
    const first = controls[0] ?? dialog, last = controls.at(-1) ?? dialog
    for (const [from, to, shiftKey] of [[first, last, true], [last, first, false]] as const) {
      from.focus()
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(to)
    }
  }
})
