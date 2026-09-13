import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { appWordmark } from "./AppMount"
import { SessionNavigationFallback } from "./SessionNavigation"
import { SessionShell } from "./SessionShell"

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

const mount = (children: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(children))
  return host
}

describe("the mounted app's entrance mark", () => {
  test("is the single .guide-wordmark inside .session-navigation", () => {
    // The synchronous entrance AppRoot paints before the controller boots.
    const host = mount(<SessionShell navigation={<SessionNavigationFallback />} />)
    const mark = appWordmark(host)
    expect(mark).not.toBeNull()
    expect(mark?.closest(".session-navigation")).not.toBeNull()
    expect(host.querySelectorAll(".guide-wordmark").length).toBe(1)
    // The regression: the pre-refactor selector matches nothing, so the home
    // page's view transition had no new-state mark to morph onto.
    expect(host.querySelector(".session-shell > .guide-wordmark")).toBeNull()
  })
})
