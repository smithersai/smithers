import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import { HOME_MEASURES, HomeDocumentSchema, parseHomeDocument } from "../src/HomePane.ts"

/*
 * The reading side of the home pane. The repository's own projected
 * .smithers/home.json (written by `//:factoryProjection` from
 * .smithers/FACTORY.ts) has to parse here, block for block, so the declaring
 * schema in @smthrs/targets and this wire schema never drift apart on a real
 * file; a string carrying HTML is refused wherever it sits; and the card that
 * carries the pane parses.
 */

const repositoryHome = NodePath.resolve(import.meta.dirname, "../../../.smithers/home.json")

describe("the projected .smithers/home.json of this repository", () => {
  test("parses block for block, and names what the smithersai/smithers home shows", () => {
    const parsed = parseHomeDocument(Fs.readFileSync(repositoryHome, "utf8"))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const types = parsed.document.blocks.map((block) => block.type)
    expect(types).not.toContain("text")
    expect(types).toContain("flows")
    expect(types).toContain("ci-benchmark")
    const benchmark = parsed.document.blocks.find((block) => block.type === "ci-benchmark")
    expect(benchmark?.type === "ci-benchmark" ? benchmark.measures : []).toEqual([...HOME_MEASURES])
  })
})

describe("the home document", () => {
  const document = {
    blocks: [
      { type: "text", title: "About", text: "Builds itself." },
      { type: "links", links: [{ label: "Source", url: "https://github.com/smithersai/smithers" }] },
      { type: "flows", title: "Try first" },
      { type: "ci-benchmark", measures: ["cold"] }
    ]
  }

  test("accepts every declared block shape", () => {
    expect(HomeDocumentSchema.safeParse(document).success).toBe(true)
    expect(parseHomeDocument(JSON.stringify(document))).toEqual({ ok: true, document })
  })

  test("refuses raw HTML in text, titles, and labels, naming the block", () => {
    const html = parseHomeDocument(JSON.stringify({ blocks: [{ type: "text", text: "<b>bold</b>" }] }))
    expect(html).toEqual({
      ok: false,
      reason:
        ".smithers/home.json is not a home pane at blocks.0.text: must not contain HTML; blocks are declared values, never markup"
    })
    expect(HomeDocumentSchema.safeParse({ blocks: [{ type: "flows", title: "<!-- x -->" }] }).success).toBe(false)
    expect(
      HomeDocumentSchema.safeParse({ blocks: [{ type: "links", links: [{ label: "</a>", url: "https://x.test" }] }] })
        .success
    )
      .toBe(false)
    expect(HomeDocumentSchema.safeParse({ blocks: [{ type: "text", text: "a < b and b > c" }] }).success).toBe(true)
  })

  test("refuses an unknown block, an empty pane, a non-http link, and a measure it does not know", () => {
    expect(HomeDocumentSchema.safeParse({ blocks: [{ type: "html", html: "<div/>" }] }).success).toBe(false)
    expect(HomeDocumentSchema.safeParse({ blocks: [] }).success).toBe(false)
    expect(
      HomeDocumentSchema.safeParse({ blocks: [{ type: "links", links: [{ label: "x", url: "javascript:alert(1)" }] }] })
        .success
    )
      .toBe(false)
    expect(HomeDocumentSchema.safeParse({ blocks: [{ type: "ci-benchmark", measures: ["p99"] }] }).success).toBe(false)
    expect(parseHomeDocument("{").ok).toBe(false)
  })
})

describe("the repo-home card", () => {
  const base = { id: "repo-home-o/r", title: "Home · o/r", status: "active", createdAt: 0, ordinal: 0 }

  test("carries the blocks verbatim and the catalog's featured rows or the reason they are absent", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "repo-home",
      payload: {
        repo: "o/r",
        path: ".smithers/home.json",
        blocks: [{ type: "flows" }],
        featuredFlows: [{ id: "review", summary: "Review the change." }, { id: "lint", summary: null }]
      }
    })
    if (card.kind !== "repo-home") return
    expect(card.payload.featuredFlows).toHaveLength(2)
    const absent = CardSchema.parse({
      ...base,
      kind: "repo-home",
      payload: {
        repo: "o/r",
        path: ".smithers/home.json",
        blocks: [{ type: "flows" }],
        featuredFlows: null,
        featuredReason: "o/r has no .smithers/factory.json."
      }
    })
    if (absent.kind !== "repo-home") return
    expect(absent.payload.featuredFlows).toBeNull()
  })

  test("refuses a block carrying HTML on the card too", () => {
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "repo-home",
        payload: {
          repo: "o/r",
          path: ".smithers/home.json",
          blocks: [{ type: "text", text: "<script>x</script>" }],
          featuredFlows: null
        }
      }).success
    ).toBe(false)
  })
})
