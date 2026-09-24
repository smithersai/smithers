import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { createStartupErrorElement, StartupErrorPanel, webBackendSwitch } from "./StartupError"

import { WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "./state/StorageRecoveryContract"
import { BootstrapFailure } from "./runtime/Runtime"
import { PALETTES } from "./state/AppState"
import { contrastRatio, rgbOf, variant, type Declarations, type Rgb } from "./styles/paletteTokens"

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

const renderBootstrapFailure = (kind: "unreachable" | "missing" | "server" | "invalid"): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<StartupErrorPanel reason={new BootstrapFailure(kind, 404)} />))
  return host
}

const buttonLabels = (host: HTMLElement): Array<string | null> =>
  [...host.querySelectorAll("button")].map(button => button.textContent)

for (const kind of ["unreachable", "missing", "server", "invalid"] as const) {
  /*
   * The defect this pins: every hosted user saw a developer "Switch backend"
   * form during an outage, and nothing said the outage was not theirs.
   */
  test(`bootstrap ${kind} on the hosted web offers Retry and blames the backend`, () => {
    const host = renderBootstrapFailure(kind)
    expect(host.querySelector("h1")?.textContent).toBe("Backend unavailable")
    expect(host.textContent).not.toContain("404")
    expect(host.textContent).toContain("Not your fault.")
    expect(buttonLabels(host)).toEqual(["Retry"])
    expect(host.querySelector("form")).toBeNull()
  })

  test(`bootstrap ${kind} in the native shell keeps backend switching`, () => {
    window.__electrobun = {} as NonNullable<typeof window.__electrobun>
    try {
      const host = renderBootstrapFailure(kind)
      expect(host.textContent).toContain("Not your fault.")
      expect(buttonLabels(host)).toEqual(["Retry", "Switch backend"])
      flushSync(() => host.querySelector<HTMLButtonElement>("button:last-of-type")!.click())
      expect(host.querySelector('input[name="origin"]')).not.toBeNull()
      expect(host.querySelector('input[name="token"]')).not.toBeNull()
    } finally {
      delete window.__electrobun
    }
  })
}

/*
 * The defect this pins: any throw rendered "Invalid backend URL." and the
 * alert never cleared. The real web switch rejects each input with its own
 * reason, and each submit shows only the reason it produced.
 */
test("a failed backend switch reports its real error, fresh on every submit", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(
    <StartupErrorPanel reason={new BootstrapFailure("unreachable")} switchBackend={webBackendSwitch} />
  ))
  flushSync(() => host.querySelector<HTMLButtonElement>("button:last-of-type")!.click())
  const submit = async (origin: string, token: string): Promise<string | null | undefined> => {
    host.querySelector<HTMLInputElement>('input[name="origin"]')!.value = origin
    host.querySelector<HTMLInputElement>('input[name="token"]')!.value = token
    const before = host.querySelector('[role="alert"]')?.textContent
    const alert = () => host.querySelector('[role="alert"]')?.textContent
    flushSync(() => host.querySelector("form")!.requestSubmit())
    for (let turn = 0; turn < 50 && (alert() === undefined || alert() === before); turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return alert()
  }
  expect(await submit("https://backend.example/path", "")).toBe("Backend URL must be an http(s) origin.")
  expect(await submit("ftp://backend.example", "secret"))
    .toBe("Application API origin must use HTTP(S).")
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(host.textContent).not.toContain("Invalid backend URL")
})

/*
 * Every startup panel is legible in every theme the page can be in.
 *
 * The defect this pins: the panel painted `#1a1a1a` text and no background,
 * so in dark theme it sat on the page's `--bg` (#011627 in night-owl) at
 * 1.1:1 and "Smithers is open in another tab" was invisible. The pairs are
 * resolved from the panel's real declarations against tokens.css, and also
 * with no stylesheet at all, because the DOM path runs when the bundle (and
 * the CSS it imports) never loaded.
 */
describe("the startup panels are legible in every theme", () => {
  /** A theme is a palette and mode from tokens.css, or no stylesheet (the UA's white page). */
  const THEMES: ReadonlyArray<{ readonly name: string; readonly tokens: Declarations | undefined }> = [
    { name: "no stylesheet", tokens: undefined },
    ...PALETTES.flatMap((palette) =>
      (["light", "dark"] as const).map((mode) => ({ name: `${palette} ${mode}`, tokens: variant(palette, mode) }))
    )
  ]

  const hex = (value: string): Rgb => {
    const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
    if (match === null) throw new Error(`not a colour this check can read: ${value}`)
    const number = Number.parseInt(match[1] ?? "", 16)
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 }
  }

  /** What a declared value paints: a token when the sheet is loaded, its fallback when not. */
  const paint = (value: string, tokens: Declarations | undefined): Rgb => {
    const reference = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i.exec(value.trim())
    if (reference === null) return hex(value)
    if (tokens !== undefined) return rgbOf(tokens, reference[1] ?? "")
    if (reference[2] === undefined) throw new Error(`${value} paints nothing without the stylesheet`)
    return hex(reference[2])
  }

  /** An empty declaration paints nothing and inherits, or shows what is behind it. */
  const painted = (value: string, tokens: Declarations | undefined): Rgb | undefined =>
    value === "" ? undefined : paint(value, tokens)

  /** An unpainted panel shows the page behind it: body's `--bg`, or the UA's white. */
  const page = (tokens: Declarations | undefined): Rgb =>
    tokens === undefined ? { r: 255, g: 255, b: 255 } : rgbOf(tokens, "--bg")

  const renderPanel = (reason: unknown): HTMLElement => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.add(root)
    flushSync(() => root.render(<StartupErrorPanel reason={reason} />))
    const panel = host.querySelector("main")
    if (panel === null) throw new Error("the React panel rendered no <main>")
    return panel
  }

  test("every panel's text and detail clear 4.5:1 in all themes, on both paths", async () => {
    const fallback = createStartupErrorElement(document, "boot rejected")
    try {
      const panels = [
        { name: "DOM failed to start", element: fallback.element },
        { name: "failed to start", element: renderPanel(new Error("boot rejected")) },
        { name: "open in another tab", element: renderPanel(new WriterHeldByAnotherTabError()) },
        { name: "moved to another tab", element: renderPanel(new WriterMovedToAnotherTabError()) },
        { name: "backend unavailable", element: renderPanel(new BootstrapFailure("unreachable", 0)) }
      ]
      const failures: Array<string> = []
      let checked = 0
      for (const theme of THEMES) {
        for (const panel of panels) {
          const text = paint(panel.element.style.color, theme.tokens)
          const ground = painted(panel.element.style.background, theme.tokens) ?? page(theme.tokens)
          const pairs = [{ where: "panel", text, ground }]
          const detail = panel.element.querySelector("pre")
          if (detail !== null) {
            pairs.push({
              where: "detail",
              text: painted(detail.style.color, theme.tokens) ?? text,
              ground: painted(detail.style.background, theme.tokens) ?? ground
            })
          }
          for (const pair of pairs) {
            checked += 1
            const ratio = contrastRatio(pair.text, pair.ground)
            if (ratio < 4.5) failures.push(`${theme.name}: ${panel.name} ${pair.where} is ${ratio}:1`)
          }
        }
      }
      // 19 themes x (5 panels + 2 details): guards against passing on an empty sweep.
      expect(checked).toBe(THEMES.length * 7)
      expect(failures).toEqual([])
    } finally {
      await fallback.dispose()
    }
  })
})
