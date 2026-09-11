import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { PALETTES } from "../state/AppState"

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

const tokens = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8")
/** Comments carry braces and colour-looking text, so the block scan reads the code alone. */
const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "")

/*
 * The palette keys come from the one typed authority (state/AppState.ts's
 * PALETTE_METADATA): every palette the product offers must have its tokens.css
 * blocks contrast-checked here, and a second hand-copied list is exactly how a
 * palette would ship unchecked.
 */

/**
 * WCAG 1.4.3 for body-size text. The tokens under test are read at 9px–13px,
 * which is never "large text", so the 3:1 allowance never applies to them.
 */
const AA = 4.5

type Declarations = ReadonlyMap<string, string>

const declarationsIn = (selector: string): Declarations => {
  const found = new Map<string, string>()
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").trim() !== selector) continue
    for (const line of (match[2] ?? "").split(";")) {
      const [name, ...rest] = line.split(":")
      const key = (name ?? "").trim()
      if (key.startsWith("--")) found.set(key, rest.join(":").trim())
    }
  }
  return found
}

/** `:root` carries the base scale plus the default palette's light variant. */
const ROOT = declarationsIn(":root")

/**
 * The declarations in force for one palette/mode, later blocks winning: the
 * base `:root`, then the palette's light block, then its dark block.
 */
const variant = (palette: string, mode: "light" | "dark"): Declarations => {
  const merged = new Map(ROOT)
  const layers = palette === "night-owl"
    ? mode === "dark"
      ? [":root[data-theme=\"dark\"]"]
      : []
    : mode === "dark"
    ? [`:root[data-palette="${palette}"]`, `:root[data-palette="${palette}"][data-theme="dark"]`]
    : [`:root[data-palette="${palette}"]`]
  for (const selector of layers) {
    for (const [name, value] of declarationsIn(selector)) merged.set(name, value)
  }
  return merged
}

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Resolve a declaration to an opaque sRGB triple, following `var()` chains. */
const rgbOf = (declarations: Declarations, token: string, depth = 0): Rgb => {
  const raw = declarations.get(token)
  if (raw === undefined) throw new Error(`${token} is declared nowhere`)
  if (depth > 8) throw new Error(`${token} resolves through too many var() hops`)
  const alias = /^var\(\s*(--[a-z0-9-]+)/i.exec(raw)
  if (alias !== null) return rgbOf(declarations, alias[1] ?? "", depth + 1)
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)
  if (hex !== null) {
    const value = Number.parseInt(hex[1] ?? "", 16)
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
  }
  const triple = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)$/.exec(raw)
  if (triple !== null) {
    return { r: Number(triple[1]), g: Number(triple[2]), b: Number(triple[3]) }
  }
  throw new Error(`${token} is not an opaque colour this check can read: ${raw}`)
}

const channel = (value: number): number => {
  const srgb = value / 255
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

const luminance = (color: Rgb): number =>
  0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)

/** The WCAG contrast ratio, rounded to two places so a report reads cleanly. */
export const contrastRatio = (foreground: Rgb, background: Rgb): number => {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

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
          const ratio = contrastRatio(
            rgbOf(declarations, pair.text),
            rgbOf(declarations, pair.on)
          )
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
