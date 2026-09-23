import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { createStartupErrorElement, StartupErrorPanel } from "./StartupError"

import { WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "./state/StorageRecoveryContract"
import { BootstrapFailure } from "./runtime/Runtime"

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  // React's scheduler finishes a commit in a task of its own; unregistering the
  // DOM before it runs takes `window` away mid-flight.
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

/** Every declaration an element carries, keyed by property so order cannot matter. */
const declarations = (element: HTMLElement): Record<string, string> => {
  const style = element.style
  const entries: Array<readonly [string, string]> = []
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index)
    entries.push([property, style.getPropertyValue(property)])
  }
  return Object.fromEntries(entries)
}

const detailOf = (panel: HTMLElement): HTMLElement => {
  const detail = panel.querySelector("pre")
  if (detail === null) throw new Error("the panel rendered no <pre>")
  return detail
}

const renderReactPanel = (message: string): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<StartupErrorPanel message={message} />))
  const panel = host.querySelector("main")
  if (panel === null) throw new Error("the React panel rendered no <main>")
  return panel
}

describe("the startup error panel", () => {
  /*
   * The defect this pins: the DOM builder carried its own cssText copy of the
   * React panel's inline styles, so a cosmetic edit to one representation left
   * the other behind. Editing either declaration alone now reddens this test.
   */
  test("styles the panel and its detail identically from React and from the DOM builder", async () => {
    const fallback = createStartupErrorElement(document, "create app store: opfs unavailable")
    try {
      const react = renderReactPanel("create app store: opfs unavailable")
      const panelStyle = declarations(fallback.element)
      const detailStyle = declarations(detailOf(fallback.element))
      // Guards the comparisons below against passing on two empty declaration sets.
      expect(panelStyle["max-width"]).toBe("44rem")
      expect(detailStyle["white-space"]).toBe("pre-wrap")
      expect(panelStyle).toEqual(declarations(react))
      expect(detailStyle).toEqual(declarations(detailOf(react)))
    } finally {
      await fallback.dispose()
    }
  })

  test("shows the message, the heading and the hint on both paths", async () => {
    const fallback = createStartupErrorElement(document, "boot rejected")
    try {
      const react = renderReactPanel("boot rejected")
      for (const panel of [fallback.element, react]) {
        expect(panel.textContent).toContain("Smithers failed to start")
        expect(panel.textContent).toContain("Reload to try again")
        expect(detailOf(panel).textContent).toBe("boot rejected")
      }
    } finally {
      await fallback.dispose()
    }
  })
})

for (const [reason, heading, buttons] of [
  [new WriterHeldByAnotherTabError(), "Smithers is open in another tab", ["Use Smithers here", "Reload"]],
  [new WriterMovedToAnotherTabError(), "Smithers moved to another tab", ["Use Smithers here"]]
] as const) {
  test(heading, () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.add(root)
    flushSync(() => root.render(<StartupErrorPanel reason={reason} />))
    expect(host.querySelector("h1")?.textContent).toBe(heading)
    expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual([...buttons])
    expect(host.querySelector("pre")).toBeNull()
    expect(host.textContent).not.toContain("recovery")
    expect(host.textContent).not.toContain("Reset")
  })
}

for (const kind of ["unreachable", "missing", "server", "invalid"] as const) {
  test(`bootstrap ${kind} shows a typed recovery on web and native`, () => {
    for (const native of [false, true]) {
      if (native) window.__electrobun = {} as NonNullable<typeof window.__electrobun>
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      roots.add(root)
      flushSync(() => root.render(<StartupErrorPanel reason={new BootstrapFailure(kind, 404)} />))
      expect(host.querySelector("h1")?.textContent).toBe("Backend unavailable")
      expect(host.textContent).not.toContain("404")
      expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Retry", "Switch backend"])
      flushSync(() => host.querySelector<HTMLButtonElement>("button:last-of-type")!.click())
      expect(host.querySelector('input[name="origin"]')).not.toBeNull()
      expect(host.querySelector('input[name="token"]')).not.toBeNull()
      delete window.__electrobun
    }
  })
}
