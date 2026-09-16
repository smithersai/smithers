import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { FirstSightHint } from "./FirstSightHint"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

test("one hint opens in DOM order, dismissal and actions persist across remount and reload", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  let store = await createAppStore({ kind: "localStorage", storage })
  const host = document.createElement("div")
  document.body.append(host)
  let root = createRoot(host)
  const render = () => flushSync(() => root.render(<ControllerContext value={{ store } as AppController}>
    <FirstSightHint id="first" content="First hint."><button id="first-control">First</button></FirstSightHint>
    <FirstSightHint id="second" content="Second hint."><button id="second-control">Second</button></FirstSightHint>
  </ControllerContext>))
  render()
  const control = host.querySelector<HTMLButtonElement>("#first-control")!
  control.focus()
  await tick()
  expect(host.querySelectorAll('[role="note"]').length).toBe(1)
  expect(host.querySelector('[role="note"]')?.textContent).toContain("First hint.")
  expect(document.activeElement).toBe(control)
  flushSync(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss help"]')!.click())
  await store.settled?.(); await tick()
  expect(host.querySelectorAll('[role="note"]').length).toBe(1)
  expect(host.querySelector('[role="note"]')?.textContent).toContain("Second hint.")
  flushSync(() => host.querySelector<HTMLButtonElement>('#second-control')!.click())
  await store.settled?.(); await tick()
  expect(host.querySelector('[role="note"]')).toBeNull()
  flushSync(() => root.unmount())
  await store.dispose?.()
  store = await createAppStore({ kind: "localStorage", storage })
  root = createRoot(host)
  render(); await tick()
  expect(host.querySelector('[role="note"]')).toBeNull()
  expect(store.session().hintsSeen).toEqual(["first", "second"])
  flushSync(() => root.unmount())
  host.remove()
  await store.dispose?.()
})
