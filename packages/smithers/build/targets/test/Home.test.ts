/**
 * `Smithers.Factory.Home` and its blocks.
 *
 * The properties that matter: every block is a declared value and a string
 * carrying HTML is refused where it is written and again when the projected
 * file is read back, and the rendered document round-trips. The target that
 * writes `.smithers/home.json` is `FactoryProjection`, tested in
 * `Factory.test.ts`.
 */
import * as Views from "@smthrs/views"
import { describe, expect, it } from "vitest"
import * as Home from "../src/Home.ts"
import { voltaireHome } from "./fixtures/VoltaireHome.ts"

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
    expect(Home.Prompt({ title: "What should we work on?", placeholder: "Ask Smithers…" })).toEqual({
      type: "prompt",
      title: "What should we work on?",
      placeholder: "Ask Smithers…"
    })
    const app = Home.App({ flow: "issue.implement", title: "Fix an issue", picture: "issue" })
    expect(app).toEqual({ type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" })
    expect(Object.isFrozen(app)).toBe(true)
    expect(Home.App({ flow: "pr-triage", title: "Review a PR", picture: "review" }).picture).toBe("review")
    expect(() => Home.App({ flow: "issue.implement", title: "Fix an issue", picture: "photo" } as never)).toThrow()
    expect(() => Home.App({ flow: "https://x", title: "Fix an issue", picture: "issue" })).toThrow()
    expect(() => Home.App({ flow: "review", title: "<b>Review</b>", picture: "review" })).toThrow(
      /must not contain HTML/
    )
    expect(() => Home.App({ flow: "review", picture: "review" } as never)).toThrow()
    expect(() => Home.App({ flow: "review", title: "Review", picture: "review", subtitle: "x" } as never)).toThrow(
      /unknown option "subtitle"/
    )
    expect(() => Home.Prompt({ flow: "https://example.com" })).toThrow()
    expect(Home.Markdown({ path: "docs/README.md" })).toEqual({ type: "markdown", path: "docs/README.md" })
    expect(Home.Stack()).toEqual({ type: "stack" })
    expect(Home.Stack({ title: "Stack" })).toEqual({ type: "stack", title: "Stack" })
    expect(() => Home.Stack({ title: "<b>x</b>" })).toThrow(/must not contain HTML/)
    expect(() => Home.Stack({ rows: [] } as never)).toThrow(/unknown option "rows"/)
    expect(Home.View({ flow: "triage" })).toEqual({ type: "view", flow: "triage" })
    expect(() => Home.View({ flow: "https://x" })).toThrow()
    expect(() => Home.View({ flow: "triage", blocks: [] } as never)).toThrow(/unknown option "blocks"/)
    expect(Home.Home({ blocks: [Home.View({ flow: "triage" })] }).blocks).toEqual([{ type: "view", flow: "triage" }])
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

  it("refuse empty strings, multi-line titles, and unsafe links", () => {
    expect(() => Home.Text({ text: "" })).toThrow()
    expect(() => Home.Text({ title: "two\nlines", text: "x" })).toThrow()
    expect(() => Home.Links({ links: [] })).toThrow()
    expect(() => Home.Links({ links: [{ label: "x", url: "javascript:alert(1)" }] })).toThrow()
    expect(() => Home.Links({ links: [{ label: "x", url: "//example.com/relative" }] })).toThrow()
    expect(() => Home.Text({ text: "x", html: "<div/>" } as never)).toThrow(/unknown option "html"/)
    expect(() => Home.Text(null as never)).toThrow(/plain object/)
    expect(Home.Text({ title: undefined, text: "x" })).toEqual({ type: "text", text: "x" })
    expect(() => Home.Text(Object.defineProperty({ text: "x" }, "title", { get: () => "T", enumerable: true })))
      .toThrow(/title must be an enumerable data property/)
    expect(() => Home.Home({ blocks: [7] as never })).toThrow(/block 0 must be a declared block.*not number/)
  })

  it("keeps HTTP(S) scheme casing through links and projected homes", () => {
    for (const scheme of ["HTTP", "HTTPS", "HtTp", "HtTpS"]) {
      const url = `${scheme}://example.com/guide`
      const link = { label: "Guide", url }
      expect(Home.Links({ links: [link] }).links[0]?.url).toBe(url)
      expect(Home.parse(JSON.stringify({ blocks: [{ type: "links", links: [link] }] }))).toEqual({
        blocks: [{ type: "links", links: [link] }]
      })
    }
    for (const url of ["ftp://example.com/guide", "file:///guide", "mailto:x@example.com", "javascript:alert(1)"]) {
      expect(() => Home.Links({ links: [{ label: "Guide", url }] })).toThrow()
      expect(typeof Home.parse(JSON.stringify({ blocks: [{ type: "links", links: [{ label: "Guide", url }] }] })))
        .toBe("string")
    }
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

  it("takes every block @smthrs/views reads, the landing page's and the live ones, and reads them back the same", () => {
    const landing = [
      { type: "hero", title: "tinyhttp", tagline: "A small HTTP server.", install: "npm i tinyhttp" },
      { type: "code", file: "main.ts", language: "ts", code: "const app: App<Request> = serve()" },
      { type: "action", flow: "branch.new", title: "New branch", key: "b" },
      { type: "issues" },
      { type: "runs" }
    ] as const
    const home = Home.Home({ blocks: [...blocks, ...landing] })
    expect(Home.parse(Home.render(home))).toEqual({ blocks: [...blocks, ...landing] })
    // The format has one copy: these are @smthrs/views' own schemas.
    expect(Home.Block).toBe(Views.Home.Block)
    expect(Home.PromptFlow).toBe(Views.Home.FlowName)
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

describe("Smithers.Factory.Home with sections", () => {
  const stack = Home.Stack()
  const readme = Home.Markdown({ path: "README.md" })

  it("declares a frozen, tagged sections declaration that keeps only what was written", () => {
    const home = Home.Home({
      docs: "https://example.com/llms.txt",
      contributors: "anyone",
      sections: [
        { title: "Today", audience: "maintainer", blocks: [stack] },
        { blocks: [readme] }
      ]
    })
    expect(home).toEqual({
      _tag: "HomeDeclaration",
      docs: "https://example.com/llms.txt",
      contributors: "anyone",
      sections: [{ title: "Today", audience: "maintainer", blocks: [stack] }, { blocks: [readme] }]
    })
    expect(Object.isFrozen(home)).toBe(true)
    expect(Object.isFrozen(home.sections[0])).toBe(true)
    expect(Home.isHomeDeclaration(home)).toBe(true)
    expect("audience" in home.sections[1]!).toBe(false)
    expect("title" in home.sections[1]!).toBe(false)
    expect("docs" in Home.Home({ sections: [{ blocks: [stack] }] })).toBe(false)
  })

  it("renders docs, contributors, then sections, and the app's reader reads the audiences back", () => {
    const home = Home.Home({
      sections: [{ audience: "contributor", blocks: [readme] }, { title: "All", blocks: [stack] }],
      contributors: "role",
      docs: "https://example.com/llms.txt"
    })
    const text = Home.render(home)
    expect(text).toBe(`${
      JSON.stringify(
        {
          docs: "https://example.com/llms.txt",
          contributors: "role",
          sections: [{ audience: "contributor", blocks: [readme] }, { title: "All", blocks: [stack] }]
        },
        null,
        2
      )
    }\n`)
    expect(Home.parse(text)).toEqual({
      docs: "https://example.com/llms.txt",
      contributors: "role",
      sections: [{ audience: "contributor", blocks: [readme] }, { title: "All", blocks: [stack] }]
    })
    expect(Views.Home.read(text)).toEqual({
      _tag: "Declared",
      docs: "https://example.com/llms.txt",
      contributors: "role",
      skipped: 0,
      sections: [
        { audience: "contributor", blocks: [readme] },
        { title: "All", audience: "everyone", blocks: [stack] }
      ]
    })
  })

  it("renders a checked-in sections home byte for byte from its declaration", () => {
    const parsed = JSON.parse(voltaireHome) as {
      readonly docs: string
      readonly sections: ReadonlyArray<Home.SectionOptions>
    }
    const home = Home.Home({ docs: parsed.docs, sections: parsed.sections })
    expect(Home.render(home)).toBe(voltaireHome)
    expect(Home.parse(voltaireHome)).toEqual(parsed)
    const read = Views.Home.read(voltaireHome)
    expect(read._tag === "Declared" && read.sections.map((section) => section.audience)).toEqual([
      "maintainer",
      "contributor",
      "everyone"
    ])
    expect(read._tag === "Declared" && read.docs).toBe("https://voltaire.tevm.sh/llms.txt")
  })

  it("refuses both shapes at once, too many sections or blocks, a bad docs URL, and stray options", () => {
    expect(() => Home.Home({ blocks: [stack], sections: [{ blocks: [stack] }] } as never)).toThrow(
      /blocks or sections, not both/
    )
    expect(() => Home.Home({ blocks: [stack], docs: "https://example.com/llms.txt" } as never)).toThrow(
      /docs and contributors need sections/
    )
    expect(() => Home.Home({ sections: Array.from({ length: Home.maximumSections + 1 }, () => ({ blocks: [stack] })) }))
      .toThrow(/declares 9 sections; a home declares at most 8/)
    expect(() =>
      Home.Home({
        sections: [
          { blocks: Array.from({ length: 20 }, () => stack) },
          { blocks: Array.from({ length: 13 }, () => stack) }
        ]
      })
    ).toThrow(/declares 33 blocks in all; a home declares at most 32/)
    expect(() => Home.Home({ docs: "http://example.com/llms.txt", sections: [{ blocks: [stack] }] })).toThrow(
      /Factory\.Home/
    )
    expect(() => Home.Home({ docs: "/llms.txt", sections: [{ blocks: [stack] }] })).toThrow(/Factory\.Home/)
    expect(() => Home.Home({ contributors: "everyone" as never, sections: [{ blocks: [stack] }] })).toThrow(
      /Factory\.Home/
    )
    expect(() => Home.Home({ sections: [{ audience: "admin" as never, blocks: [stack] }] })).toThrow(/Factory\.Home/)
    expect(() => Home.Home({ sections: [{ title: "<b>x</b>", blocks: [stack] }] })).toThrow(/must not contain HTML/)
    expect(() => Home.Home({ sections: [{ blocks: [stack], hidden: true } as never] })).toThrow(
      /section 0 received unknown option "hidden"/
    )
    expect(() => Home.Home({ sections: [{ blocks: [stack] }, { blocks: ["# Hi"] as never }] })).toThrow(
      /section 1 block 0 must be a declared block.*not a string/
    )
    expect(() => Home.Home({ sections: [{ blocks: [] }] })).toThrow(/Factory\.Home/)
    expect(() => Home.Home({ sections: [] })).toThrow(/Factory\.Home/)
    expect(() => Home.Home({ sections: "today" as never })).toThrow(/sections must be an array of sections/)
    expect(() => Home.Home({ sections: [{ blocks: "x" } as never] })).toThrow(/section 0 blocks must be an array/)
  })

  it("parses either shape back and refuses a document declaring both or breaking the bounds", () => {
    expect(Home.parse(JSON.stringify({ blocks: [stack], sections: [] }))).toMatch(/blocks and sections/)
    expect(Home.parse(JSON.stringify({ sections: Array.from({ length: 9 }, () => ({ blocks: [] })) }))).toMatch(
      /shape/
    )
    expect(Home.parse(JSON.stringify({ sections: [{ blocks: Array.from({ length: 33 }, () => stack) }] }))).toMatch(
      /at most 32 blocks in all/
    )
    expect(Home.parse(JSON.stringify({ docs: "ftp://x", sections: [] }))).toMatch(/shape/)
    expect(Home.parse(JSON.stringify({ sections: [{ audience: "maintainer", blocks: [] }] }))).toEqual({
      sections: [{ audience: "maintainer", blocks: [] }]
    })
    const rendered = Home.render(
      Home.Home({
        docs: "https://smithers.sh/docs",
        contributors: "role",
        sections: [{ title: "Start", audience: "maintainer", blocks: [stack] }]
      })
    )
    expect(JSON.parse(rendered)).toMatchObject({
      docs: "https://smithers.sh/docs",
      contributors: "role"
    })
    const minimal = Home.render(Home.Home({ sections: [{ blocks: [stack] }] }))
    expect(JSON.parse(minimal)).toEqual({ sections: [{ blocks: [stack] }] })
  })
})
