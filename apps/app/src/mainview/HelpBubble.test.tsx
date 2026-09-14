import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { GuidanceText } from "./GuidanceText"
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

test('an unfocused guided action glows without wearing a focus outline', async () => {
  const style = document.createElement('style')
  style.textContent = await Bun.file(new URL('./HelpBubble.css', import.meta.url)).text()
  document.head.append(style)
  cleanups.push(() => style.remove())
  const { target } = mount()
  const css = getComputedStyle(target)
  expect(css.outlineStyle).not.toBe('solid')
  expect(css.boxShadow).not.toBe('')
  expect(css.boxShadow).not.toBe('none')
})

test('coarse pointers hide tutorial and repository key chips at desktop width', async () => {
  const touch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
  cleanups.push(() => { if (touch) Object.defineProperty(navigator, 'maxTouchPoints', touch); else Reflect.deleteProperty(navigator, 'maxTouchPoints') })
  const style = document.createElement('style')
  style.textContent = await Bun.file(new URL('./onboarding/guide.css', import.meta.url)).text()
  document.head.append(style)
  cleanups.push(() => style.remove())
  const { GuideButton } = await import('./onboarding/GuideButton')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => root.render(<><footer className="app-chat-controls"><GuideButton shortcut="c">Chat</GuideButton></footer><div className="guide-shell"><GuideButton shortcut="m">Mode</GuideButton></div></>))
  expect(matchMedia('(pointer: coarse)').matches).toBe(true)
  const chips = host.querySelectorAll('kbd')
  expect(chips.length).toBe(2)
  for (const chip of chips) expect(getComputedStyle(chip).display).toBe('none')
})

for (const sentence of ["You can also talk to Smithers anytime by pressing C.", "Start with the practice repository’s issues. Click Show issues or press i."]) {
  test(`help retains the complete sentence: ${sentence}`, () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    flushSync(() => root.render(<HelpBubble id="typing-help" open content={<GuidanceText text={sentence} />} onDismiss={() => {}}><button>Action</button></HelpBubble>))
    expect(host.querySelector('.guidance-text-accessible')?.textContent).toBe(sentence)
    expect(host.querySelector('.guidance-text-visual')?.textContent).toBe(sentence)
    expect(host.querySelectorAll('.guidance-text-visual > span')).toHaveLength(Array.from(sentence).length)
    flushSync(() => root.unmount())
  })
}
