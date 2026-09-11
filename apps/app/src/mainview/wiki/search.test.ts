import { describe, expect, test } from "bun:test"
import { clampLimit, searchDocuments, tokensOf } from "./search"

/*
 * The scorer the chain's recall entry used to hold inline (Worldview.ts),
 * now shared with the wiki flows. These cases are the Worldview cases
 * restated against the pure function: same ranking, same snippet, same
 * honest empty answer.
 */

const note = (path: string, title: string, body: string, extra: Partial<{ tags: string[]; confidence: number; updatedAt: number }> = {}) => ({
  path,
  title,
  body,
  tags: extra.tags ?? [],
  confidence: extra.confidence ?? 0.6,
  updatedAt: extra.updatedAt ?? 1
})

describe("tokensOf", () => {
  test("keeps discriminating tokens and lowercases them", () => {
    expect(tokensOf("Deploy Cadence, on Tuesdays")).toEqual(["deploy", "cadence", "tuesdays"])
  })

  test("a query of only short tokens searches with what it has", () => {
    expect(tokensOf("jj ci")).toEqual(["jj", "ci"])
  })
})

describe("searchDocuments", () => {
  test("ranks title hits above body hits and answers with confidence and freshness", () => {
    const hits = searchDocuments(
      [
        note("Meeting notes.md", "Meeting notes", "Talked about deploy risks at length.", { updatedAt: 7 }),
        note("Deploy cadence.md", "Deploy cadence", "We ship weekly.", { confidence: 0.9, updatedAt: 5 })
      ],
      "deploy"
    )
    expect(hits.map((hit) => hit.title)).toEqual(["Deploy cadence", "Meeting notes"])
    expect(hits[0]).toMatchObject({ path: "Deploy cadence.md", confidence: 0.9, updatedAt: 5, score: 3 })
    expect(hits[1]?.snippet).toBe("Talked about deploy risks at length.")
  })

  test("tags count between title and body, and an equal score breaks on freshness", () => {
    const hits = searchDocuments(
      [
        note("a.md", "Alpha", "release", { tags: ["release"], updatedAt: 1 }),
        note("b.md", "Beta", "release release", { updatedAt: 2 }),
        note("c.md", "Gamma", "release release", { updatedAt: 9 })
      ],
      "release"
    )
    // a: tag 2 + body 1 = 3; b: body 2; c: body 2. The tie goes to the fresher note.
    expect(hits.map((hit) => hit.path)).toEqual(["a.md", "c.md", "b.md"])
  })

  test("answers no hits honestly for an unknown word and for a blank query", () => {
    const documents = [note("World.md", "World", "# World\n\nSmithers keeps what it learns here.")]
    expect(searchDocuments(documents, "xylophone")).toEqual([])
    expect(searchDocuments(documents, "   ")).toEqual([])
  })

  test("respects the limit", () => {
    const documents = Array.from({ length: 8 }, (_row, index) => note(`n${index}.md`, `Note ${index}`, "smithers"))
    expect(searchDocuments(documents, "smithers", 3)).toHaveLength(3)
    expect(searchDocuments(documents, "smithers")).toHaveLength(5)
  })

  test("clampLimit keeps a caller inside [1, 10] and defaults everything else", () => {
    expect(clampLimit(3)).toBe(3)
    expect(clampLimit(50)).toBe(10)
    expect(clampLimit(0)).toBe(5)
    expect(clampLimit("7")).toBe(5)
  })
})
