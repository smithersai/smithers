/**
 * `Smithers.Factory.Home` and its blocks.
 *
 * The properties that matter: every block is a declared value and a string
 * carrying HTML is refused where it is written and again when the projected
 * file is read back, and the rendered document round-trips. The target that
 * writes `.smithers/home.json` is `FactoryProjection`, tested in
 * `Factory.test.ts`.
 */
import { describe, expect, it } from "vitest"
import * as Home from "../src/Home.ts"

describe("the home blocks", () => {
  it("declare frozen plain values that carry their type", () => {
    const text = Home.Text({ title: "About", text: "Smithers builds itself with Smithers." })
    expect(text).toEqual({ type: "text", title: "About", text: "Smithers builds itself with Smithers." })
    expect(Object.isFrozen(text)).toBe(true)
    expect("title" in Home.Text({ text: "No title." })).toBe(false)

    const links = Home.Links({ links: [{ label: "Source", url: "https://github.com/smithersai/smithers" }] })
    expect(links).toEqual({
      type: "links",
      links: [{ label: "Source", url: "https://github.com/smithersai/smithers" }]
    })
    expect(Object.isFrozen(links.links)).toBe(true)
    expect(Object.isFrozen(links.links[0])).toBe(true)

    expect(Home.Flows()).toEqual({ type: "flows" })
    expect(Home.Flows({ title: "Try first" })).toEqual({ type: "flows", title: "Try first" })
    expect(Home.Prompt({ placeholder: "Change Smithers…" })).toEqual({
      type: "prompt",
      placeholder: "Change Smithers…"
    })
    expect(Home.Prompt({ flow: "review" })).toEqual({ type: "prompt", flow: "review" })
    expect(() => Home.Prompt({ flow: "https://example.com" })).toThrow()
    expect(Home.Markdown({ path: "docs/README.md" })).toEqual({ type: "markdown", path: "docs/README.md" })
  })

  it("refuse raw HTML in text, titles, and labels, and keep plain comparisons", () => {
    expect(() => Home.Text({ text: "<b>bold</b>" })).toThrow(/must not contain HTML/)
    expect(() => Home.Text({ text: "note <!-- hidden -->" })).toThrow(/must not contain HTML/)
    expect(() => Home.Text({ title: "<h1>Title</h1>", text: "fine" })).toThrow(/must not contain HTML/)
    expect(() => Home.Links({ links: [{ label: "<a>x</a>", url: "https://example.com" }] })).toThrow(
      /must not contain HTML/
    )
    expect(() => Home.Flows({ title: "</script>" })).toThrow(/must not contain HTML/)
    expect(Home.Text({ text: "a < b and b > c" }).text).toBe("a < b and b > c")
  })

  it("refuse empty strings, multi-line titles, and non-http links", () => {
    expect(() => Home.Text({ text: "" })).toThrow()
    expect(() => Home.Text({ title: "two\nlines", text: "x" })).toThrow()
    expect(() => Home.Links({ links: [] })).toThrow()
    expect(() => Home.Links({ links: [{ label: "x", url: "javascript:alert(1)" }] })).toThrow()
    expect(() => Home.Links({ links: [{ label: "x", url: "/relative" }] })).toThrow()
    expect(() => Home.Text({ text: "x", html: "<div/>" } as never)).toThrow(/unknown option "html"/)
    expect(() => Home.Text(null as never)).toThrow(/plain object/)
  })

  it("keeps markdown paths inside the repository", () => {
    for (
      const path of [
        "",
        "/README.md",
        "../README.md",
        "docs/../README.md",
        "docs//README.md",
        "./README.md",
        "https://example.com/x",
        "C:\\README.md",
        "docs\\README.md",
        "README.md?raw=1",
        "%2e%2e/secret"
      ]
    ) {
      expect(() => Home.Markdown({ path })).toThrow()
    }
    expect("CiBenchmark" in Home).toBe(false)
  })
})

describe("Smithers.Factory.Home", () => {
  const blocks = [
    Home.Text({ text: "Smithers builds itself with Smithers." }),
    Home.Flows({ title: "Try first" }),
    Home.Markdown({ path: "README.md" })
  ]

  it("declares a frozen, tagged declaration over declared blocks", () => {
    const home = Home.Home({ blocks })
    expect(home).toEqual({ _tag: "HomeDeclaration", blocks })
    expect(Object.isFrozen(home)).toBe(true)
    expect(Home.isHomeDeclaration(home)).toBe(true)
    expect(Home.isHomeDeclaration({ blocks })).toBe(false)
  })

  it("refuses a raw string, markup, or an unknown block shape, naming the block", () => {
    expect(() => Home.Home({ blocks: ["<h1>Hello</h1>"] as never })).toThrow(
      /block 0 must be a declared block.*not a string/
    )
    expect(() => Home.Home({ blocks: [blocks[0]!, "# Hello"] as never })).toThrow(/block 1 must be a declared block/)
    expect(() => Home.Home({ blocks: [{ type: "html", html: "<div/>" }] as never })).toThrow(/Factory\.Home/)
    expect(() => Home.Home({ blocks: [{ type: "text", text: "<em>x</em>" }] })).toThrow(/must not contain HTML/)
    expect(() => Home.Home({ blocks: [] })).toThrow()
    expect(() => Home.Home({ blocks: "text" as never })).toThrow(/array of declared blocks/)
  })

  it("renders a stable two-space document that parses back, and refuses HTML on the way back in", () => {
    const home = Home.Home({ blocks })
    const text = Home.render(home)
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toBe(`${JSON.stringify({ blocks }, null, 2)}\n`)
    expect(Home.parse(text)).toEqual({ blocks })
    expect(Home.parse("{")).toMatch(/not JSON/)
    expect(Home.parse(JSON.stringify({ blocks: [{ type: "text", text: "<b>x</b>" }] }))).toMatch(
      /must not contain HTML/
    )
    expect(Home.parse(JSON.stringify({ blocks: [{ type: "prose", markdown: "x" }] }))).toMatch(/shape/)
  })
})
