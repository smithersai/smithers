import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { SessionShell } from "./SessionShell"
import { WORDMARK } from "./Wordmark"

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  // React's scheduler finishes a commit in tasks of its own; unregistering the
  // DOM before they run takes `window` away mid-flight (ConnectorsEmpty's
  // three-tick drain, the pattern that covers it).
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

const mount = (children: React.ReactNode): void => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(children))
}

describe("the session shell", () => {
  test("paints the entrance without a runtime or loading message", () => {
    mount(<SessionShell />)
    expect(document.querySelector(".session-shell")?.textContent).not.toContain("starting your session")
    expect(document.querySelector(".guide-wordmark pre")?.textContent).toBe(`${WORDMARK.join("\n")}\n`)
    expect(document.querySelectorAll(".guide-wordmark").length).toBe(1)
  })
})
