/**
 * Reading a repository's home: every kind of block and every bound, HTML
 * refused, a kind this reader doesn't know skipped, sections and their
 * audiences, who sees which, and this repository's own `.smithers/home.json`
 * read as it is checked in.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Home } from "../src/index.ts"

const home = (...blocks: ReadonlyArray<unknown>) => JSON.stringify({ blocks })
const declared = (...blocks: ReadonlyArray<unknown>) => Home.read(home(...blocks))
const invalid = (reason: Home.Invalid) => ({ _tag: "Invalid", reason })
/** A home of one section for everyone, as a file with bare `blocks` reads. */
const everyone = (blocks: ReadonlyArray<unknown>, skipped = 0) => ({
  _tag: "Declared",
  sections: [{ audience: "everyone", blocks }],
  contributors: "role",
  skipped
})

const every: ReadonlyArray<Home.Block> = [
  { type: "text", title: "About", text: "A small HTTP server.\nFast." },
  { type: "links", title: "Elsewhere", links: [{ label: "Docs", url: "https://example.com/docs" }] },
  { type: "flows", title: "Flows" },
  { type: "prompt", flow: "flow.new", title: "What should we work on?", placeholder: "Ask Smithers…" },
  { type: "markdown", path: "docs/intro.md", title: "Intro" },
  { type: "stack" },
  { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
  { type: "view", flow: "release-notes" },
  {
    type: "hero",
    title: "Effect",
    tagline: "Build production-ready applications in TypeScript.",
    text: "Typed errors, dependency injection and retries in one library.",
    install: "npm install effect",
    actions: [{ label: "Get started", url: "https://effect.website/docs" }],
    announcement: { label: "Effect 4.0 is here", url: "https://effect.website/blog" }
  },
  {
    type: "code",
    title: "Example",
    file: "fetch-user.ts",
    language: "ts",
    code: "const program: Effect.Effect<User, FetchError> = getUser(\"42\")\n// a < b"
  },
  {
    type: "cards",
    title: "Ecosystem",
    cards: [{
      title: "Core",
      text: "Effect, Layer and Schema.",
      label: "effect",
      url: "https://npmjs.com/package/effect"
    }],
    more: { label: "All packages", url: "https://github.com/Effect-TS/effect" }
  },
  { type: "stats", stats: [{ value: "MIT", label: "License" }] },
  {
    type: "releases",
    releases: [{ name: "effect@4.0.5", url: "https://github.com/Effect-TS/effect/releases", date: "2026-10-15" }],
    more: { label: "All releases", url: "https://github.com/Effect-TS/effect/releases" }
  },
  { type: "issues", title: "Triage" },
  { type: "runs" },
  { type: "action", flow: "branch.new", title: "New branch", key: "b" }
]

describe("Home.read", () => {
  it("reads every kind of block, in order, with nothing skipped", () => {
    expect(declared(...every)).toEqual(everyone(every))
    expect(new Set(every.map((block) => block.type))).toEqual(new Set(Home.kinds))
  })

  it("reads a home with no blocks, and a block's optional fields left out", () => {
    expect(declared()).toEqual(everyone([]))
    expect(declared({ type: "prompt" }, { type: "flows" }, { type: "cards", cards: [{ title: "Core" }] })).toEqual(
      everyone([{ type: "prompt" }, { type: "flows" }, { type: "cards", cards: [{ title: "Core" }] }])
    )
  })

  it("drops fields a block doesn't declare, and keys beside `blocks`", () => {
    expect(Home.read(JSON.stringify({ version: 2, blocks: [{ type: "text", text: "Hi", color: "red" }] }))).toEqual(
      everyone([{ type: "text", text: "Hi" }])
    )
  })

  it("skips a kind it doesn't know and counts it, keeping the rest", () => {
    expect(declared({ type: "chart", data: [1, 2] }, { type: "text", text: "Hi" }, { type: "board" })).toEqual(
      everyone([{ type: "text", text: "Hi" }], 2)
    )
  })

  it("refuses text that isn't JSON, or JSON that isn't a home", () => {
    expect(Home.read("{ blocks: [")).toEqual(invalid("json"))
    expect(Home.read("")).toEqual(invalid("json"))
    for (const text of ["null", "[]", "42", "\"home\"", "{}", "{\"blocks\":{}}", "{\"blocks\":null}"]) {
      expect([text, Home.read(text)]).toEqual([text, invalid("shape")])
    }
  })

  it("takes 32 blocks and refuses 33, unknown kinds counted", () => {
    const text = { type: "text", text: "Hi" }
    expect(declared(...Array.from({ length: Home.maximumBlocks }, () => text))).toMatchObject({ _tag: "Declared" })
    expect(declared(...Array.from({ length: Home.maximumBlocks }, () => text), { type: "chart" })).toEqual(
      invalid("blocks")
    )
  })

  it("refuses the whole home when a block of a known kind breaks its bounds", () => {
    const long = (length: number) => "a".repeat(length)
    const broken: ReadonlyArray<unknown> = [
      // A block that isn't one, or has no kind.
      "text",
      null,
      42,
      { text: "no type" },
      { type: 7, text: "a number for a type" },
      // Titles: empty, too long, two lines, HTML.
      { type: "text", title: "", text: "Hi" },
      { type: "text", title: long(Home.maximumTitleLength + 1), text: "Hi" },
      { type: "text", title: "One\nTwo", text: "Hi" },
      { type: "text", title: "<b>Bold</b>", text: "Hi" },
      // Text: missing, empty, too long, HTML of every shape.
      { type: "text" },
      { type: "text", text: "" },
      { type: "text", text: long(Home.maximumTextLength + 1) },
      { type: "text", text: "<script>alert(1)</script>" },
      { type: "text", text: "a </p> b" },
      { type: "text", text: "<!-- hidden -->" },
      { type: "text", text: "<?xml?>" },
      // Links: none, a scheme other than http(s), a protocol-relative URL, spaces, too long, an HTML label.
      { type: "links", links: [] },
      { type: "links", links: [{ label: "Run", url: "javascript:alert(1)" }] },
      { type: "links", links: [{ label: "Data", url: "data:text/html,hi" }] },
      { type: "links", links: [{ label: "Here", url: "//example.com/app" }] },
      { type: "links", links: [{ label: "Space", url: "https://exa mple.com" }] },
      { type: "links", links: [{ label: "Quote", url: "https://example.com/\"x" }] },
      { type: "links", links: [{ label: "Long", url: `https://example.com/${long(Home.maximumUrlLength)}` }] },
      { type: "links", links: [{ label: "<i>x</i>", url: "https://example.com" }] },
      // Markdown paths that leave the repository or aren't plain.
      { type: "markdown", path: "/etc/passwd" },
      { type: "markdown", path: "../secrets.md" },
      { type: "markdown", path: "docs/./a.md" },
      { type: "markdown", path: "docs//a.md" },
      { type: "markdown", path: "docs\\a.md" },
      { type: "markdown", path: "docs/a.md?x" },
      { type: "markdown", path: "a%2e%2e/b.md" },
      { type: "markdown", path: "c:/a.md" },
      { type: "markdown", path: "a\u0000.md" },
      { type: "markdown", path: long(1025) },
      { type: "markdown" },
      // Flow names, pictures, and a view with no flow.
      { type: "app", flow: "Issue.Implement", title: "Fix", picture: "issue" },
      { type: "app", flow: "issue..implement", title: "Fix", picture: "issue" },
      { type: "app", flow: "issue.implement", title: "Fix", picture: "rocket" },
      { type: "app", flow: "issue.implement", picture: "issue" },
      { type: "prompt", flow: "" },
      { type: "prompt", placeholder: "<em>Ask</em>" },
      { type: "view" },
      // A hero: no title, too many actions, a two-line or HTML tagline, a bad action or announcement.
      { type: "hero" },
      { type: "hero", title: "X", actions: [] },
      {
        type: "hero",
        title: "X",
        actions: Array.from({ length: Home.maximumActions + 1 }, () => ({ label: "a", url: "https://a.example" }))
      },
      { type: "hero", title: "X", tagline: "One\nTwo" },
      { type: "hero", title: "X", tagline: long(Home.maximumLineLength + 1) },
      { type: "hero", title: "X", text: "<b>x</b>" },
      { type: "hero", title: "X", install: "npm i <script>" },
      { type: "hero", title: "X", actions: [{ label: "Go", url: "javascript:x" }] },
      { type: "hero", title: "X", announcement: { label: "New" } },
      // Code: none, empty, too long, a NUL, a language that isn't a plain name.
      { type: "code" },
      { type: "code", code: "" },
      { type: "code", code: long(Home.maximumCodeLength + 1) },
      { type: "code", code: "a\u0000b" },
      { type: "code", code: "x", language: "TypeScript" },
      { type: "code", code: "x", language: "a b" },
      { type: "code", code: "x", file: "<i>a.ts</i>" },
      // Cards: none, too many, one without a title, a bad URL.
      { type: "cards", cards: [] },
      { type: "cards", cards: Array.from({ length: Home.maximumEntries + 1 }, () => ({ title: "a" })) },
      { type: "cards", cards: [{ text: "no title" }] },
      { type: "cards", cards: [{ title: "a", url: "//example.com/relative" }] },
      { type: "cards", cards: [{ title: "a" }], more: { label: "More", url: "ftp://x" } },
      // Stats: none, too many, a missing label.
      { type: "stats", stats: [] },
      { type: "stats", stats: Array.from({ length: Home.maximumStats + 1 }, () => ({ value: "1", label: "a" })) },
      { type: "stats", stats: [{ value: "1" }] },
      // Releases: none, too many, a date that isn't one, no URL.
      { type: "releases", releases: [] },
      {
        type: "releases",
        releases: Array.from(
          { length: Home.maximumEntries + 1 },
          () => ({ name: "v1", url: "https://a.example", date: "2026-01-01" })
        )
      },
      { type: "releases", releases: [{ name: "v1", url: "https://a.example", date: "2026-02-30" }] },
      { type: "releases", releases: [{ name: "v1", url: "https://a.example", date: "Oct 15" }] },
      { type: "releases", releases: [{ name: "v1", date: "2026-01-01" }] },
      // Live blocks carry a title at most.
      { type: "issues", title: "" },
      { type: "runs", title: "<b>Runs</b>" },
      // An action: a flow and a title, and a key that is one lowercase letter.
      { type: "action", title: "New branch" },
      { type: "action", flow: "branch.new" },
      { type: "action", flow: "branch.new", title: "New branch", key: "B" },
      { type: "action", flow: "branch.new", title: "New branch", key: "bb" },
      { type: "action", flow: "branch.new", title: "New branch", key: "1" }
    ]
    for (const block of broken) {
      expect([block, declared({ type: "text", text: "Before" }, block)]).toEqual([block, invalid("block")])
    }
  })

  it("keeps prose that mentions a comparison", () => {
    expect(declared({ type: "text", text: "Use a < b and b > a." })).toMatchObject({ _tag: "Declared" })
  })

  it("reads this repository's own home as it is checked in", () => {
    const file = fileURLToPath(new URL(`../../../../../${Home.path}`, import.meta.url))
    const read = Home.read(readFileSync(file, "utf8"))
    expect(read).toMatchObject({ _tag: "Declared", skipped: 0 })
    expect(read._tag === "Declared" && read.sections.flatMap((section) => section.blocks.map((block) => block.type)))
      .toContain("prompt")
  })
})

describe("Home.read, sections", () => {
  const text = (words: string) => ({ type: "text", text: words })

  it("reads each section's title, audience and blocks, in order, everyone's when it names none", () => {
    const read = Home.read(JSON.stringify({
      sections: [
        { title: "Today", audience: "maintainer", blocks: [{ type: "issues" }, { type: "runs" }] },
        { audience: "contributor", blocks: [{ type: "stack" }] },
        { blocks: [text("Hi")] }
      ]
    }))
    expect(read).toEqual({
      _tag: "Declared",
      sections: [
        { title: "Today", audience: "maintainer", blocks: [{ type: "issues" }, { type: "runs" }] },
        { audience: "contributor", blocks: [{ type: "stack" }] },
        { audience: "everyone", blocks: [text("Hi")] }
      ],
      contributors: "role",
      skipped: 0
    })
  })

  it("skips unknown kinds in every section and counts them all", () => {
    const read = Home.read(JSON.stringify({
      sections: [{ blocks: [{ type: "board" }, text("a")] }, { audience: "contributor", blocks: [{ type: "chart" }] }]
    }))
    expect(read).toEqual({
      _tag: "Declared",
      sections: [{ audience: "everyone", blocks: [text("a")] }, { audience: "contributor", blocks: [] }],
      contributors: "role",
      skipped: 2
    })
  })

  it("takes no sections at all", () => {
    expect(Home.read(JSON.stringify({ sections: [] }))).toEqual({
      _tag: "Declared",
      sections: [],
      contributors: "role",
      skipped: 0
    })
  })

  it("reads the docs a home declares: an https URL of its docs index; anything else is refused", () => {
    const docs = "https://vibelang.sh/llms.txt"
    expect(Home.read(JSON.stringify({ docs, sections: [] }))).toEqual({
      _tag: "Declared",
      sections: [],
      contributors: "role",
      docs,
      skipped: 0
    })
    expect(Home.read(JSON.stringify({ docs, blocks: [] }))).toMatchObject({ docs })
    expect(Home.read(JSON.stringify({ blocks: [] }))).not.toHaveProperty("docs")
    for (
      const bad of [
        "http://vibelang.sh/llms.txt",
        "javascript:alert(1)",
        "/llms.txt",
        "",
        `https://vibelang.sh/${"x".repeat(Home.maximumUrlLength)}`,
        "https://user:pass@vibelang.sh/llms.txt",
        null,
        1
      ]
    ) {
      expect([bad, Home.read(JSON.stringify({ docs: bad, sections: [] }))]).toEqual([bad, invalid("shape")])
    }
  })

  it("reads who counts as a contributor: `anyone` when the home says so, else `role`; anything else is refused", () => {
    expect(Home.read(JSON.stringify({ contributors: "anyone", sections: [] }))).toMatchObject({
      contributors: "anyone"
    })
    expect(Home.read(JSON.stringify({ contributors: "role", blocks: [] }))).toMatchObject({ contributors: "role" })
    for (const contributors of ["everyone", true, null, 1]) {
      expect([contributors, Home.read(JSON.stringify({ contributors, sections: [] }))]).toEqual([
        contributors,
        invalid("shape")
      ])
    }
  })

  it("refuses both `blocks` and `sections`, or `sections` that isn't an array", () => {
    for (
      const document of [{ blocks: [], sections: [] }, { sections: {} }, { sections: null }, {
        blocks: [],
        sections: null
      }]
    ) {
      expect([document, Home.read(JSON.stringify(document))]).toEqual([document, invalid("shape")])
    }
  })

  it("takes 8 sections and refuses 9", () => {
    const section = { blocks: [text("a")] }
    expect(Home.read(JSON.stringify({ sections: Array.from({ length: Home.maximumSections }, () => section) })))
      .toMatchObject({ _tag: "Declared" })
    expect(Home.read(JSON.stringify({ sections: Array.from({ length: Home.maximumSections + 1 }, () => section) })))
      .toEqual(invalid("sections"))
  })

  it("counts blocks across sections: 32 in all, and 33 refused", () => {
    const half = Array.from({ length: Home.maximumBlocks / 2 }, () => text("a"))
    expect(Home.read(JSON.stringify({ sections: [{ blocks: half }, { blocks: half }] }))).toMatchObject({
      _tag: "Declared"
    })
    expect(Home.read(JSON.stringify({ sections: [{ blocks: half }, { blocks: [...half, { type: "board" }] }] })))
      .toEqual(invalid("blocks"))
  })

  it("refuses a section that isn't one, or whose heading breaks its bounds", () => {
    const broken: ReadonlyArray<unknown> = [
      null,
      "section",
      [],
      {},
      { blocks: {} },
      { blocks: [], audience: "admin" },
      { blocks: [], audience: 1 },
      { blocks: [], title: "" },
      { blocks: [], title: "<b>Today</b>" },
      { blocks: [], title: "a".repeat(Home.maximumTitleLength + 1) }
    ]
    for (const section of broken) {
      expect([section, Home.read(JSON.stringify({ sections: [{ blocks: [] }, section] }))]).toEqual([
        section,
        invalid("section")
      ])
    }
  })

  it("refuses the home when a block in any section breaks its bounds", () => {
    expect(Home.read(JSON.stringify({ sections: [{ blocks: [text("a")] }, { blocks: [{ type: "text" }] }] })))
      .toEqual(invalid("block"))
  })
})

describe("Home.sees and Home.visible", () => {
  const sections: ReadonlyArray<Home.Section> = [
    { title: "Today", audience: "maintainer", blocks: [{ type: "issues" }] },
    { audience: "contributor", blocks: [{ type: "stack" }] },
    { audience: "everyone", blocks: [{ type: "text", text: "Hi" }] }
  ]

  it("lets each audience see its own sections and the wider ones, never a narrower one", () => {
    const table = Home.audiences.map((
      viewer
    ) => [viewer, Home.audiences.filter((section) => Home.sees(viewer, section))])
    expect(table).toEqual([
      ["everyone", ["everyone"]],
      ["contributor", ["everyone", "contributor"]],
      ["maintainer", ["everyone", "contributor", "maintainer"]]
    ])
  })

  it("keeps the sections a viewer may see, in order", () => {
    expect(Home.visible(sections, "everyone")).toEqual([sections[2]])
    expect(Home.visible(sections, "contributor")).toEqual([sections[1], sections[2]])
    expect(Home.visible(sections, "maintainer")).toEqual(sections)
    expect(Home.visible([], "maintainer")).toEqual([])
  })

  it("widens everyone to a contributor on a home open to anyone, and nothing else", () => {
    expect(Home.audiences.map((viewer) => [Home.widen(viewer, "anyone"), Home.widen(viewer, "role")])).toEqual([
      ["contributor", "everyone"],
      ["contributor", "contributor"],
      ["maintainer", "maintainer"]
    ])
  })

  it("names the live kinds, whose rows a page reads itself", () => {
    expect(Home.liveKinds).toEqual(["flows", "stack", "issues", "runs"])
    for (const kind of Home.liveKinds) expect(Home.kinds).toContain(kind)
  })
})
