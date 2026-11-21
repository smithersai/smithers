import { describe, expect, test } from "vitest"
import { clampIndex, extractWikilinks, filterNotes, groupNotes, hasWikiFeed, parseFrontmatter, wikiNotesOf } from "./model"

describe("parseFrontmatter and extractWikilinks", () => {
  test("parses optional YAML title and tags while leaving plain markdown untouched", () => {
    expect(parseFrontmatter("# Hello")).toEqual({ tags: [], body: "# Hello" })
    expect(parseFrontmatter("---\nunterminated")).toEqual({ tags: [], body: "---\nunterminated" })
    expect(parseFrontmatter("---\ntitle: \"\"\nother: x\n---\nPlain")).toEqual({ title: undefined, tags: [], body: "Plain" })
    expect(parseFrontmatter("---\ntitle: \"Design\"\ntags: [arch, \"v2\", ]\n---\nBody")).toEqual({
      title: "Design",
      tags: ["arch", "v2"],
      body: "Body",
    })
  })

  test("extracts unique wikilinks while ignoring fenced code blocks", () => {
    const md = [
      "See [[Overview]] and [[Decisions#v1|Decision Log]] and [[Overview]].",
      "```md",
      "[[IgnoredInFence]]",
      "```",
      "Also [[guide/Setup.md]]",
    ].join("\n")
    expect(extractWikilinks(md)).toEqual(["Overview", "Decisions", "guide/Setup.md"])
  })
})

describe("wikiNotesOf, filterNotes, groupNotes, clampIndex", () => {
  test("falls back to starter notes when no feed documents contain wiki notes", () => {
    const empty = wikiNotesOf("acme/widgets", [
      { id: "1", repo: "acme/widgets", name: "other", body: { foo: 1 }, updatedAt: "" },
    ])
    expect(empty.fromFeed).toBe(false)
    expect(hasWikiFeed([])).toBe(false)
    const decisions = empty.notes.find((n) => n.path === "Decisions.md")!
    expect(decisions.backlinks).toEqual(["Architecture.md", "Overview.md"])
    expect(decisions.linksOut).toEqual(["Overview.md"])
  })

  test("extracts notes from wiki index arrays, string feeds, and single-document objects, computing backlinks", () => {
    const docs = [
      {
        id: "w1",
        repo: "acme/widgets",
        name: "wiki",
        updatedAt: "2026-11-20T00:00:00Z",
        body: {
          notes: [
            { path: "Index", title: "Home", markdown: "Link to [[Specs/Auth]] and [[Notes]]", tags: ["hub"] },
            { path: "Specs/Auth.md", content: "---\ntags: [security]\n---\nBack to [[Index]]" },
            { path: "Bad", markdown: undefined },
            "not-an-object",
            { path: "", markdown: "skip" },
            { path: "Extra", body: "Uses [[Index.md]]", updatedAt: "2026-11-21T00:00:00Z" },
            { path: "Guides/Start.md", markdown: "Start" },
            { path: "ADR/001.md", markdown: "Decision" },
          ],
        },
      },
      { id: "w2", repo: "acme/widgets", name: "Notes", updatedAt: "2026-11-20T01:00:00Z", body: "Plain [[Index]]" },
      { id: "w3", repo: "acme/widgets", name: "RFC", updatedAt: "2026-11-20T02:00:00Z", body: { title: "RFC 1", content: "See [[Missing]]" } },
      { id: "w4", repo: "acme/widgets", name: "Guide", updatedAt: "2026-11-20T02:00:00Z", body: { markdown: "Guide body" } },
      { id: "w5", repo: "acme/widgets", name: "Blank", updatedAt: "", body: null },
    ]
    expect(hasWikiFeed(docs)).toBe(true)
    const { fromFeed, notes } = wikiNotesOf("acme/widgets", docs)
    expect(fromFeed).toBe(true)
    const index = notes.find((n) => n.path === "Index.md")!
    expect(index.title).toBe("Home")
    expect(index.linksOut).toEqual(["Specs/Auth.md", "Notes.md"])
    expect(index.backlinks).toEqual(["Extra.md", "Notes.md", "Specs/Auth.md"])

    expect(filterNotes(notes, "")).toHaveLength(notes.length)
    expect(filterNotes(notes, "security").map((n) => n.path)).toEqual(["Specs/Auth.md"])
    expect(filterNotes(notes, "Guide body").map((n) => n.path)).toEqual(["Guide.md"])

    const groups = groupNotes([...notes].reverse())
    expect(groups[0]?.folder).toBe("Root")
    expect(groups.some((g) => g.folder === "Specs")).toBe(true)
    expect(clampIndex(-1, 3)).toBe(0)
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(1, 0)).toBe(0)
  })
})
