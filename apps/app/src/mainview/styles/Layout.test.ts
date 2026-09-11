import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * Source-level pins for layout defects, in the Contrast.test idiom (the
 * unit lane has no layout engine):
 *
 *  - base.css: a fixed 100vh shell with hidden overflow strands the composer
 *    under mobile browser chrome; dvh must follow the vh fallback.
 *  - cards.css: opacity-zero message actions stayed hit-testable — a touch
 *    tap in the corner landed on an invisible button. pointer-events tracks
 *    the visibility, and hover:none devices get a deliberate visible
 *    affordance.
 *  - chat.css: the 21rem nonshrinking devtools panel exceeds the 320px
 *    minimum shell width; below the panes' own 900px breakpoint it stacks.
 */

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")

const base = read("base.css")
const cards = read("cards.css")
const chat = read("chat.css")
const chrome = read("chrome.css")

describe("the shell tracks the dynamic viewport, not the chrome-inflated one", () => {
  test("body and #root declare 100dvh after the 100vh fallback", () => {
    expect(base).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/)
    expect(base).toMatch(/height:\s*100vh;\s*height:\s*100dvh;/)
  })
})

describe("hidden message actions are not a touch trap", () => {
  test("opacity-zero actions take no pointer events", () => {
    const block = /\.message-actions\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(block).toContain("opacity: 0;")
    expect(block).toContain("pointer-events: none;")
  })

  test("hover and focus restore both visibility and hit-testing", () => {
    const block =
      /\.smithers-chat-message:hover \.message-actions,\s*\.message-actions:focus-within\s*\{[^}]*\}/.exec(cards)
        ?.[0] ?? ""
    expect(block).toContain("opacity: 1;")
    expect(block).toContain("pointer-events: auto;")
  })

  test("hover:none devices get the actions as a deliberate affordance", () => {
    expect(cards).toMatch(
      /@media \(hover: none\)\s*\{\s*\.message-actions\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/
    )
  })
})

describe("the devtools panel fits the 320px minimum shell", () => {
  test("the panel stacks under the chat column at the panes' 900px breakpoint", () => {
    expect(chat).toContain("@media (max-width: 900px)")
    expect(chat).toContain(".chat-frame:has(> .devtools-panel)")
    expect(chat).toMatch(/@media \(max-width: 900px\)[\s\S]*\.devtools-panel\s*\{[^}]*width:\s*100%;/)
  })
  test("suggestion pills wrap beside an open pane instead of scrolling out of view", () => {
    expect(chat).toMatch(/\.app-shell \.smithers-suggestions\s*\{[^}]*flex-wrap:\s*wrap;/)
  })
})

describe("the slash menu overlays instead of displacing the transcript", () => {
  test("the composer anchors an absolutely positioned menu above its box", () => {
    const composer = /\.composer-wrap\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(composer).toContain("position: relative;")

    const slashMenu = /\.composer-wrap\s*>\s*\.slash-menu\s*\{[^}]*\}/.exec(chat)?.[0] ?? ""
    expect(slashMenu).toContain("position: absolute;")
    expect(slashMenu).toMatch(/z-index:\s*\d+;/)
  })
})

/*
 * will, 2026-09-02, asks 6, 7 and 8: a file card must open in a panel with a
 * reasonable max height and scroll inside it; a maximized card must start to
 * the RIGHT of the left sidebar (its left edge was under the sidebar and
 * unreadable); and the maximized header — which carries Restore — must stay
 * visible while the body scrolls.
 */
describe("a file opens in a panel with a cap it scrolls inside (ask 6)", () => {
  test("the file panel caps at 60vh and scrolls itself", () => {
    const block = /\.world-card-panel\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(block).toContain("max-height: 60vh;")
    expect(block).toContain("overflow: auto;")
  })

  test("the panel is the one scroller: a fenced body inside it has no second cap", () => {
    expect(cards).toMatch(/\.world-card-panel pre\s*\{[^}]*max-height: none;/)
  })

  test("maximized lifts the cap, because the card is the viewport then", () => {
    expect(cards).toMatch(
      /\.smithers-card\[data-maximized="true"\] \.world-card-panel\s*\{[^}]*max-height: none;/
    )
  })
})

describe("a maximized card starts to the right of the sidebar (ask 7)", () => {
  test("the sidebar's width is a variable the shell owns", () => {
    expect(chat).toMatch(/\.app-shell\s*\{[^}]*--chrome-bar-width:\s*200px;/)
    expect(chrome).toMatch(/\.chrome-bar\s*\{[^}]*width:\s*var\(--chrome-bar-width, 200px\);/)
  })

  test("the card and its backdrop both start past that width", () => {
    const card = /\.smithers-card\[data-maximized="true"\]\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(card).toContain("inset: 1.5rem 1.5rem 8.5rem;")
    expect(card).toContain("left: calc(var(--chrome-bar-width, 200px) + 1.5rem);")
    const backdrop = /\.card-maximize-backdrop\s*\{[^}]*\}/.exec(cards)?.[0] ?? ""
    expect(backdrop).toContain("left: var(--chrome-bar-width, 200px);")
  })
})

describe("the maximized card keeps Restore reachable (ask 8)", () => {
  test("the header sticks to the top of the scrolling card", () => {
    expect(cards).toMatch(
      /\.smithers-card\[data-maximized="true"\] \.smithers-card-header\s*\{[^}]*position: sticky;[^}]*top: 0;/
    )
  })
})
