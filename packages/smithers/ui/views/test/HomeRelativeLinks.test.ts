/** Safe Home navigation uses the same schema in readers and factory declarations. */
import { Smithers } from "@smthrs/targets"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Home } from "../src/index.ts"

const relative = [
  "/",
  "/app",
  "/owner/repo/tree/main/README.md",
  "/docs?language=ts#intro",
  "/search?q=hello%20world",
  "/docs//intro",
  "/%2F%2Fexample.com",
  "/@contributor"
]
const absolute = ["https://example.com", "http://localhost:3000/docs", "HTTPS://example.com/docs?x=1#intro"]
const unsafe = [
  "",
  "docs/intro",
  "./docs",
  "../docs",
  "#intro",
  "?page=docs",
  "//example.com",
  "///example.com",
  "/\\example.com",
  "\\\\example.com",
  "/docs\\intro",
  "/\t/example.com",
  "/\n/example.com",
  "/\r/example.com",
  "/\u0000/docs",
  "/\u001f/docs",
  "/\u007f/docs",
  " /docs",
  "/docs ",
  "/docs\n",
  "/docs/<script>",
  "/docs/\"quoted\"",
  "/docs/'quoted'",
  "/docs/%",
  "/docs/%2",
  "/docs/%GG",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,hello",
  "file:///etc/passwd",
  "https://",
  "https:///example.com",
  "https://?page=docs",
  "https://#intro",
  "https://[broken",
  "https://example.com:invalid/docs",
  "https://example.com:65536/docs",
  "https://exa mple.com",
  "https://example.com/\\evil",
  "https://example.com/\u0000docs",
  "https://example.com/docs/%GG"
]

const targets = (url: string): ReadonlyArray<Home.Block> => [
  { type: "links", links: [{ label: "Docs", url }] },
  { type: "hero", title: "Project", actions: [{ label: "Docs", url }] },
  { type: "hero", title: "Project", announcement: { label: "News", url } },
  { type: "cards", cards: [{ title: "Docs", url }] },
  { type: "cards", cards: [{ title: "Docs" }], more: { label: "More", url } },
  { type: "releases", releases: [{ name: "v1", date: "2026-11-04", url }] },
  {
    type: "releases",
    releases: [{ name: "v1", date: "2026-11-04", url: "https://example.com/v1" }],
    more: { label: "More", url }
  }
]

const read = (blocks: ReadonlyArray<Home.Block>, docs?: string) => Home.read(JSON.stringify({ blocks, docs }))
const declared = (blocks: ReadonlyArray<Home.Block>) => ({
  _tag: "Declared",
  sections: [{ audience: "everyone", blocks }],
  contributors: "role",
  skipped: 0
})

describe("Home relative links", () => {
  it.each([...relative, ...absolute])("keeps the safe target %j in every link-bearing block", (url) => {
    expect(Schema.decodeUnknownSync(Home.Url)(url)).toBe(url)
    if (url.startsWith("/")) expect(new URL(url, "https://home.test/owner/repo").origin).toBe("https://home.test")
    const blocks = targets(url)
    expect(read(blocks)).toEqual(declared(blocks))
  })

  it.each(unsafe)("refuses the unsafe target %j in every link-bearing block", (url) => {
    expect(Schema.is(Home.Url)(url)).toBe(false)
    for (const block of targets(url)) {
      expect(read([{ type: "text", text: "Before" }, block])).toEqual({ _tag: "Invalid", reason: "block" })
    }
  })

  it("retains the URL length bound for relative and absolute targets", () => {
    for (const prefix of ["/", "https://example.com/"]) {
      const url = prefix + "a".repeat(Home.maximumUrlLength - prefix.length)
      expect(read(targets(url))).toEqual(declared(targets(url)))
      expect(Schema.is(Home.Url)(url + "a")).toBe(false)
      expect(read(targets(url + "a"))).toEqual({ _tag: "Invalid", reason: "block" })
    }
  })

  it("keeps repository file paths separate from navigation targets", () => {
    const block: Home.Block = { type: "markdown", path: "docs/intro.md" }
    expect(read([block])).toEqual(declared([block]))
    for (
      const path of [
        ...relative,
        "../docs",
        "docs/./intro.md",
        "docs//intro.md",
        "docs\\intro.md",
        "docs/a%20b.md",
        "docs/a\u0000.md"
      ]
    ) {
      expect(read([{ type: "markdown", path }])).toEqual({ _tag: "Invalid", reason: "block" })
    }
  })

  it("refuses invalid release dates even when a relative release link is safe", () => {
    for (const date of ["today", "2026-02-30", "2026-13-01", "2026-01-32"]) {
      expect(read([{ type: "releases", releases: [{ name: "v1", date, url: "/releases/v1" }] }])).toEqual({
        _tag: "Invalid",
        reason: "block"
      })
    }
  })

  it("keeps DocsUrl restricted to absolute HTTPS URLs without credentials", () => {
    const docs = "https://example.com/llms.txt"
    expect(Schema.is(Home.DocsUrl)(docs)).toBe(true)
    expect(read([], docs)).toEqual({ ...declared([]), docs })
    for (
      const url of [...relative, ...unsafe, "http://example.com/llms.txt", "https://user:password@example.com/llms.txt"]
    ) {
      expect(Schema.is(Home.DocsUrl)(url)).toBe(false)
      expect(read([], url)).toEqual({ _tag: "Invalid", reason: "shape" })
    }
  })

  it.each([...relative, ...absolute])("uses the shared schema when targets authors %j", (url) => {
    const block = Smithers.Home.Links({ links: [{ label: "Docs", url }] })
    const home = Smithers.Factory.Home({ blocks: [block] })
    expect(read(home.blocks)).toEqual(declared([{ type: "links", links: [{ label: "Docs", url }] }]))
  })

  it.each(unsafe)("refuses %j when targets authors a link", (url) => {
    expect(() => Smithers.Home.Links({ links: [{ label: "Docs", url }] })).toThrow()
  })
})
