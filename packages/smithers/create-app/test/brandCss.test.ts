/**
 * What keeps `brandCss` the only owner of the brand-to-styleguide map.
 *
 * `test/vite.test.ts` covers what the function puts in the rule. Two halves of
 * the contract are not visible in its return value at all, and both are what a
 * second mapping used to break, so they are pinned here.
 *
 * The sheet has to win the cascade unaided. `virtual:smthrs-app/brand.css` is
 * a CSS import, so a bundler puts it in `<head>`, while `<SmithersUiStyles/>`
 * renders its `<style>` inside the React tree. The styleguide sheet is
 * therefore always later in document order and specificity is the only lever
 * left. Its most specific token rule is
 * `:root[data-palette='<key>'][data-theme='dark']`, (0,3,0), so the brand rule
 * has to rank above that.
 *
 * And nothing downstream may re-map the same names. The Aomi template used to
 * ship a `houseBridgeCss` that aliased every styleguide property to a
 * `var(--house-*)` reference unconditionally, which redefined properties whose
 * token the brand never declared: removing a token then resolved to an unset
 * variable instead of falling back to the styleguide default `docs/api.md`
 * promises.
 */
import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Brand } from "../src/app.ts"
import { brandCss } from "../src/vite.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const aomi = join(packageRoot, "template", "aomi")

/** The selector list the rule is opened with. */
const selectors = (css: string): ReadonlyArray<string> => {
  const opener = css.split("\n").find((line) => line.trimEnd().endsWith("{"))
  if (opener === undefined) throw new Error(`no rule in:\n${css}`)
  return opener.replace(/\s*\{$/, "").split(",").map((one) => one.trim())
}

/**
 * Specificity's middle number, for the grammar this rule is written in:
 * pseudo-classes and attribute selectors, no ids, classes, or element names.
 */
const rank = (selector: string): number => (selector.match(/:[a-z-]+|\[[^\]]+\]/g) ?? []).length

/** Every `.ts`, `.tsx`, and `.css` file the Aomi template ships. */
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full)
    return /\.(?:tsx?|css)$/.test(entry.name) ? [full] : []
  })

const minimal: Brand = { name: "test", tokens: { accent: "#5288c2", background: "#ffffff" } }

describe("brandCss cascade", () => {
  it("outranks every token rule the styleguide sheet can emit", () => {
    for (const selector of selectors(brandCss(minimal))) expect(rank(selector)).toBeGreaterThan(3)
  })

  it("spells its values rather than aliasing a house property", () => {
    expect(brandCss(minimal)).not.toContain("var(--house-")
  })

  it("leaves a styleguide property alone when the brand omits its token", () => {
    const css = brandCss({ name: "sparse", tokens: { accent: "#5288c2" } })
    expect(css).toContain("--brand: #5288c2;")
    expect(css).not.toContain("--bg")
    expect(css.split("\n").filter((line) => line.trim().startsWith("--"))).toHaveLength(2)
  })
})

describe("the aomi template", () => {
  it("re-maps no styleguide property onto a house property", () => {
    // A declaration whose property is a styleguide name and whose value is a
    // `var(--house-*)` reference is a second copy of the plugin's map. App CSS
    // reading the brand (`color: var(--house-foreground)`) is not: its property
    // is not a custom property.
    const alias = /--(?!house-)[a-z0-9-]+\s*:\s*var\(\s*--house-/
    const offenders = sources(join(aomi, "src"))
      .filter((file) => alias.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(aomi.length + 1))
    expect(offenders).toEqual([])
  })

  it("appends no extra sheet to the styleguide one", () => {
    const main = readFileSync(join(aomi, "src", "main.tsx"), "utf8")
    expect(main).toContain("<SmithersUiStyles withTheme />")
    expect(main).not.toContain("extra=")
  })
})
