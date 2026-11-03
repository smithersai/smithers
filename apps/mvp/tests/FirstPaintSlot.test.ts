// @vitest-environment happy-dom
// The first paint in the app's real tree (src/firstPaint/shell.ts): React renders the slot and a real MutationObserver
// tells the shell, in StrictMode. The paint moves into the slot and covers nothing, React re-rendering leaves it there,
// React taking the slot away ends it, a route change with an unchanged slot ends it, and a revocation takes it out of
// wherever it sits.
import { act, createElement, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import { SETTLED, SLOT } from "../src/firstPaint/settled"
import { FIRST_PAINT_NODE, PLACED_ATTRIBUTE, type ShellHost, startShell } from "../src/firstPaint/shell"
import { WIPE } from "../src/wipe"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
const answer = { viewer: "p", expiresAt: Date.now() + 3_600_000, serverNow: Date.now(), issue: { number: 7, title: "Seven", state: "open", author: null } }

const paint = async () => {
  const location = { pathname: "/acme/app/issues/7", search: "" }
  let released = false
  const host: ShellHost = {
    window: { location, addEventListener: () => {}, removeEventListener: () => {}, setTimeout: (() => 0) as never, clearTimeout: () => {} },
    document,
    locks: { request: ((_name: string, _options: unknown, held: () => Promise<void>) => held().then(() => void (released = true))) as never },
    fetch: (async () => Response.json(answer)) as never,
    now: () => Date.now(),
    marks: { getItem: () => null },
    channel: () => ({ onmessage: null, close: () => {} }),
    observe: (callback) => {
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-first-paint"] })
      return observer
    },
    mark: () => {},
  }
  const shell = startShell(host)!
  await settle()
  await settle()
  return { shell, released: () => released, node: () => document.getElementById(FIRST_PAINT_NODE) }
}

const mount = () => {
  const host = Object.assign(document.createElement("div"), { id: "root" })
  document.body.append(host)
  const root = createRoot(host)
  const show = (content: Parameters<typeof createElement>[2]) =>
    act(async () => root.render(createElement(StrictMode, null, createElement("main", null, createElement("button", null, "Search"), content))))
  return { host, root, show }
}

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren()
})

test("React's slot takes the paint, re-rendering keeps it, and React taking the slot away ends it", async () => {
  const { host, root, show } = mount()
  roots.push(root)
  const { shell, node, released } = await paint()
  await show(createElement("div", { ...SLOT, key: "slot" }))
  await settle()
  expect(host.querySelector("[data-first-paint-slot]")!.contains(node())).toBe(true)
  expect(node()!.hasAttribute(PLACED_ATTRIBUTE)).toBe(true)
  await show(createElement("div", { ...SLOT, key: "slot", className: "again" }))
  await settle()
  expect(host.querySelector(".again")!.contains(node())).toBe(true)
  await show(createElement("ul", { key: "rows" }, createElement("li", null, "row")))
  await settle()
  expect([node(), shell.outcome(), released()]).toEqual([null, "handed_over", true])
})

test("a route change with the slot unchanged ends it, and a page that settles with the slot still up ends it", async () => {
  const first = mount()
  roots.push(first.root)
  const { shell, node } = await paint()
  await first.show(createElement("div", { ...SLOT, key: "slot" }))
  await settle()
  shell.routed("/acme/app/issues/8", "")
  expect([node(), shell.outcome()]).toEqual([null, "navigated"])
  // React's slot is still there, and rendering it again brings nothing back.
  await first.show(createElement("div", { ...SLOT, key: "slot" }))
  await settle()
  expect(node()).toBeNull()

  document.body.replaceChildren()
  const second = mount()
  roots.push(second.root)
  const painted = await paint()
  await second.show(createElement("div", { ...SLOT, key: "slot" }))
  await settle()
  await act(async () => second.root.render(createElement("main", SETTLED, createElement("div", { ...SLOT, key: "slot" }))))
  await settle()
  expect([painted.node(), painted.shell.outcome()]).toEqual([null, "handed_over"])
})

test("a revocation takes it out of the slot, and a slot unmounted with it leaves nothing behind", async () => {
  const { host, root, show } = mount()
  roots.push(root)
  const { shell, node } = await paint()
  await show(createElement("div", { ...SLOT, key: "slot" }))
  await settle()
  shell.revoke("wipe")
  expect([node(), host.querySelector("[data-first-paint-slot]")!.childElementCount, shell.outcome()]).toEqual([null, 0, "wipe"])
  expect(WIPE).toBe("smithers-wipe")
})
