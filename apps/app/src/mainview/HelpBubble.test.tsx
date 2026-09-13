import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { HelpBubble } from "./HelpBubble"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let activations = 0
  function Example() {
    const [open, setOpen] = useState(true)
    return <HelpBubble id="example-help" open={open} content="Choose this action." onDismiss={() => setOpen(false)}>
      <button aria-describedby={open ? "example-help" : undefined} onClick={() => activations++}>Action</button>
    </HelpBubble>
  }
  flushSync(() => root.render(<Example />))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return { host, activations: () => activations, target: host.querySelector<HTMLButtonElement>(".help-anchor-target button")! }
}

test("guidance does not steal focus, trap Tab, or activate its target", () => {
  const previous = document.createElement("button")
  document.body.append(previous)
  previous.focus()
  const { host, target, activations } = mount()
  expect(document.activeElement).toBe(previous)
  target.focus()
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
  target.dispatchEvent(tab)
  expect(tab.defaultPrevented).toBe(false)
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(activations()).toBe(0)
  previous.remove()
})

test("dismissing from the help returns focus to the same mounted target", () => {
  const { host, target, activations } = mount()
  const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="Dismiss help"]')!
  dismiss.focus()
  flushSync(() => dismiss.click())
  expect(host.querySelector('[role="note"]')).toBeNull()
  expect(host.querySelector(".help-anchor-target button")).toBe(target)
  expect(document.activeElement).toBe(target)
  expect(target.hasAttribute("aria-describedby")).toBe(false)
  expect(activations()).toBe(0)
})

test("Escape dismisses help from its target without triggering an outer action", () => {
  const { host, target, activations } = mount()
  let outerEscapes = 0
  const escaped = () => outerEscapes++
  document.addEventListener("keydown", escaped)
  cleanups.push(() => document.removeEventListener("keydown", escaped))
  target.focus()
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
  expect(host.querySelector('[role="note"]')).toBeNull()
  expect(document.activeElement).toBe(target)
  expect(outerEscapes).toBe(0)
  expect(activations()).toBe(0)
})
