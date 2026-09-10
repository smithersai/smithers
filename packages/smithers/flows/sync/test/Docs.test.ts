import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")

/** Prose paragraphs with fenced code removed and line wrapping collapsed. */
const paragraphs = (markdown: string): ReadonlyArray<string> =>
  markdown.replace(/^```[\s\S]*?^```/gm, "").split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim())

/** Level-two headings, in order, outside fenced code. */
const sections = (markdown: string): ReadonlyArray<string> =>
  Array.from(markdown.replace(/^```[\s\S]*?^```/gm, "").matchAll(/^## (.+)$/gm), ([, title]) => title!)

/** GitHub and Starlight anchor slug of a heading. */
const slug = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-")

/** Barrel-exported modules whose source calls a journal write method. */
const journalWriters = Array.from(
  read("src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g),
  ([, name]) => name!
).filter((name) => /\.(?:emitLossy|emitDurable|emitDurableUnfenced|checkpoint|compact)\(/.test(read(`src/${name}.ts`)))

describe("README layout", () => {
  it("keeps License as the closing section", () => {
    expect(sections(read("README.md")).at(-1)).toBe("License")
  })

  it("states the rewind contract next to the other contracts, before the API table", () => {
    const titles = sections(read("README.md"))
    expect(titles).toContain("Rewinds and cursor generations")
    expect(titles.indexOf("Rewinds and cursor generations")).toBeLessThan(titles.indexOf("Public API"))
  })
})

describe("read-only claim", () => {
  it("finds the journal writers the overviews must name", () => {
    expect(journalWriters).not.toHaveLength(0)
  })

  it.each(["README.md", "docs/README.md"])("%s scopes it to the sync read surface and names every writer", (page) => {
    const claims = paragraphs(read(page)).filter((paragraph) => paragraph.includes("cannot corrupt"))
    expect(claims).toHaveLength(1)
    const claim = claims[0]!
    expect(claim).not.toMatch(/nothing in this package|outside this package/i)
    for (const surface of ["SyncRpcs", "SyncClient", ...journalWriters]) expect(claim).toContain(`\`${surface}\``)
  })
})

describe("scopes and cursors", () => {
  const page = read("docs/concepts/scopes-and-cursors.md")

  it("defines RunCursor with its generation", () => {
    const definition = paragraphs(page).find((paragraph) => paragraph.startsWith("`RunCursor` is"))
    expect(definition).toContain("generation")
  })

  it("links the rewind contract to a heading the API reference carries", () => {
    const anchors = Array.from(page.matchAll(/\]\(\.\.\/api\.md#([a-z0-9-]+)\)/g), ([, anchor]) => anchor!)
    expect(anchors).toContain("rewind-generations")
    const headings = Array.from(read("docs/api.md").matchAll(/^#{2,6} (.+)$/gm), ([, heading]) => slug(heading!))
    for (const anchor of anchors) expect(headings).toContain(anchor)
  })
})
