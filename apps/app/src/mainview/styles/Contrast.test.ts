import { describe, expect, test } from "bun:test"
import { PALETTES } from "../state/AppState"
import { ratioOf, variant } from "./paletteTokens"

/*
 * §20.6 — every palette's text tokens clear WCAG AA where they are read.
 *
 * The axe sweep on canary found the card byline (`.smithers-card-meta`, the
 * smallest text the product paints at 9px) at 3.75:1 in night-owl dark, and
 * the same token short of the floor in most of the other palettes. The colour
 * is not hardcoded anywhere — it is `--text-faint`, so the defect belongs to
 * the palette table, and fixing it in one card's CSS would leave the other
 * eight palettes and every other consumer of the token wrong.
 *
 * The floor is checked here rather than in the browser because tokens.css IS
 * the source of the values: a ratio computed from the declarations cannot pass
 * while the painted pixels fail, and this runs on every `bun test` instead of
 * only when a machine has Chrome. The a11y e2e suite still walks the rendered
 * tree; this stops a palette from ever being ADDED below the floor.
 */

/**
 * WCAG 1.4.3 for body-size text. The tokens under test are read at 9px-13px,
 * which is never "large text", so the 3:1 allowance never applies to them.
 */
const AA = 4.5

/**
 * Every (text token, background token) pair the product actually paints small
 * text with. `--text-faint` is the card byline and the composer hints;
 * `--text-muted` is every card subtitle and list secondary line; both land on
 * the page background and on card surfaces.
 */
const PAIRS = [
  { text: "--text", on: "--bg" },
  { text: "--text", on: "--surface" },
  { text: "--text-muted", on: "--bg" },
  { text: "--text-muted", on: "--surface" },
  { text: "--text-faint", on: "--bg" },
  { text: "--text-faint", on: "--surface" },
  { text: "--text-placeholder", on: "--bg" },
  { text: "--text-placeholder", on: "--surface" }
] as const

describe("every palette clears WCAG AA for the small text it paints", () => {
  test("no text/background pair in any palette or mode falls below 4.5:1", () => {
    const failures: string[] = []
    for (const palette of PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        const declarations = variant(palette, mode)
        for (const pair of PAIRS) {
          const ratio = ratioOf(declarations, pair.text, pair.on)
          if (ratio < AA) {
            failures.push(`${palette} ${mode}: ${pair.text} on ${pair.on} is ${ratio}:1`)
          }
        }
      }
    }
    // Reported all at once: one palette's miss is usually a family of them,
    // and fixing one failure per run is how a sweep gets abandoned halfway.
    expect(failures).toEqual([])
  })
})
