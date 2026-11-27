import { describe, expect, test } from "vitest"
import { extractUphill, type FeedDocument, stepCategory } from "./model"

const SAMPLE_REPORT = {
  categories: [
    {
      name: "footprint",
      title: "Footprint",
      score: 70,
      metrics: [
        { name: "bundle", title: "Bundle", kind: "size", unit: "B", value: 12_000, score: 70, target: 5_000 },
      ],
    },
    {
      name: "speed",
      title: "Speed",
      score: 94,
      metrics: [
        { name: "parse", title: "Parse", kind: "time", unit: "ns", value: 450, score: 94, target: 500 },
      ],
    },
  ],
  opportunities: [
    { category: "footprint", metric: "bundle", value: 12_000, target: 5_000, gain: 18 },
  ],
}

describe("uphill plugin model", () => {
  test("extracts bare report and separate uphill/history feed", () => {
    const docs: ReadonlyArray<FeedDocument> = [
      { id: "1", repo: "acme/app", name: "uphill", body: SAMPLE_REPORT, updatedAt: "2026-11-26T18:00:00Z" },
      {
        id: "2",
        repo: "acme/app",
        name: "uphill/history",
        body: {
          history: [
            { commit: "aaa1111", overall: 75, scores: { footprint: 60, speed: 90 } },
            { commit: "bbb2222", overall: 82, scores: { footprint: 70, speed: 94 } },
          ],
        },
        updatedAt: "2026-11-26T18:00:00Z",
      },
    ]
    const extracted = extractUphill(docs)
    expect(extracted.hasFeed).toBe(true)
    expect(extracted.overall).toBe(82)
    expect(extracted.band).toBe("warn")
    expect(extracted.history).toHaveLength(2)
    expect(extracted.updatedAt).toBe("2026-11-26T18:00:00Z")
  })

  test("returns empty state when no valid uphill feed exists", () => {
    const extracted = extractUphill([
      { id: "1", repo: "acme/app", name: "wiki", body: { notes: [] }, updatedAt: "2026-11-26T18:00:00Z" },
    ])
    expect(extracted.hasFeed).toBe(false)
    expect(extracted.overall).toBeNull()
    expect(extracted.band).toBe("none")
  })

  test("steps selected category cyclically through all + categories", () => {
    const cats = ["footprint", "speed"]
    expect(stepCategory(cats, null, 1)).toBe("footprint")
    expect(stepCategory(cats, "footprint", 1)).toBe("speed")
    expect(stepCategory(cats, "speed", 1)).toBeNull()
    expect(stepCategory(cats, null, -1)).toBe("speed")
    expect(stepCategory([], null, 1)).toBeNull()
  })
})
