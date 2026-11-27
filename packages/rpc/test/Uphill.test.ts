import { describe, expect, test } from "vitest"
import { Uphill } from "../src/index.ts"

const sampleReport = {
  categories: [
    {
      name: "footprint",
      title: "Footprint",
      subject: null,
      description: null,
      score: 75,
      rounds: 1,
      metrics: [
        {
          name: "bundle-size",
          title: "Bundle size",
          description: "Keep the bundle small.",
          kind: "size",
          unit: "B",
          value: 6900,
          item: null,
          score: 75,
          target: 5000,
          default: 5000,
          note: null,
          better: "lower",
          weight: 1,
          rollup: null,
          items: []
        }
      ]
    },
    {
      name: "speed",
      title: "Speed",
      subject: null,
      description: null,
      score: 95,
      rounds: 5,
      metrics: [
        {
          name: "parse-time",
          title: "Parse time",
          description: null,
          kind: "time",
          unit: "ns",
          value: 440,
          item: null,
          score: 95,
          target: 500,
          default: 500,
          note: null,
          better: "lower",
          weight: 1,
          rollup: null,
          items: []
        }
      ]
    }
  ],
  opportunities: [
    {
      category: "footprint",
      subject: null,
      metric: "bundle-size",
      item: null,
      items: 1,
      value: 6900,
      target: 5000,
      gain: 15
    }
  ],
  changes: [
    {
      category: "footprint",
      subject: null,
      metric: "bundle-size",
      item: null,
      change: "worse",
      before: 6500,
      after: 6900
    }
  ],
  comparison: {
    reference: "main (ac66366)",
    scores: [
      { category: "footprint", subject: null, score: 80, error: null },
      { category: "speed", subject: null, score: 95, error: null }
    ],
    changes: [],
    timings: [
      {
        category: "speed",
        subject: null,
        metric: "parse-time",
        item: null,
        change: "within noise",
        before: 430,
        after: 440,
        pairs: 8,
        agree: 5
      }
    ]
  }
} as const

describe("Uphill wire contracts", () => {
  test("decodes a bare report.json via decodeFeedBody", () => {
    const decoded = Uphill.decodeFeedBody(sampleReport)
    expect(decoded).toBeDefined()
    expect(decoded?.report.categories).toHaveLength(2)
    expect(decoded?.report.opportunities[0]?.gain).toBe(15)
    expect(Uphill.overallScore(decoded!.report)).toBe(85)
  })

  test("decodes an enriched feed envelope with history and commit metadata", () => {
    const decoded = Uphill.decodeFeedBody({
      report: sampleReport,
      commit: "ac66366",
      branch: "main",
      updatedAt: "2026-11-26T18:00:00Z",
      history: [
        { commit: "1111111", overall: 78, scores: { footprint: 65, speed: 91 } },
        { commit: "ac66366", overall: 85, scores: { footprint: 75, speed: 95 } }
      ],
      rules: "# Uphill rules"
    })
    expect(decoded?.commit).toBe("ac66366")
    expect(decoded?.history).toHaveLength(2)
    expect(decoded?.rules).toBe("# Uphill rules")
  })

  test("returns undefined for non-uphill payloads", () => {
    expect(Uphill.decodeFeedBody(null)).toBeUndefined()
    expect(Uphill.decodeFeedBody({ notes: [] })).toBeUndefined()
  })

  test("classifies Lighthouse score bands accurately", () => {
    expect(Uphill.scoreBand(90)).toBe("good")
    expect(Uphill.scoreBand(100)).toBe("good")
    expect(Uphill.scoreBand(89)).toBe("warn")
    expect(Uphill.scoreBand(50)).toBe("warn")
    expect(Uphill.scoreBand(49)).toBe("poor")
    expect(Uphill.scoreBand(0)).toBe("poor")
    expect(Uphill.scoreBand(null)).toBe("none")
    expect(Uphill.scoreBand(undefined)).toBe("none")
    expect(Uphill.scoreBand(95, true)).toBe("failed")
  })

  test("formats sizes, durations, counts, and checks", () => {
    expect(Uphill.formatBytes(512)).toBe("512 B")
    expect(Uphill.formatBytes(6900)).toBe("6.9 kB")
    expect(Uphill.formatBytes(1_500_000)).toBe("1.5 MB")
    expect(Uphill.formatBytes(2_500_000_000)).toBe("2.5 GB")
    expect(Uphill.formatDurationNs(440)).toBe("440 ns")
    expect(Uphill.formatDurationNs(12_500)).toBe("12.5 µs")
    expect(Uphill.formatDurationNs(2_340_000)).toBe("2.34 ms")
    expect(Uphill.formatDurationNs(1_250_000_000)).toBe("1.25 s")
    expect(Uphill.formatMetricValue(true, "check")).toBe("pass")
    expect(Uphill.formatMetricValue(false, "check")).toBe("fail")
    expect(Uphill.formatMetricValue(0.85, "check")).toBe("85%")
    expect(Uphill.formatMetricValue(42, "count")).toBe("42")
    expect(Uphill.formatMetricValue(null, "count")).toBe("–")
  })

  test("returns null overallScore when no category is scored", () => {
    const report = Uphill.ReportSchema.parse({
      categories: [{ name: "broken", title: "Broken", score: null, error: { message: "exit 1" } }]
    })
    expect(Uphill.overallScore(report)).toBeNull()
  })
})

describe("Uphill formatting edge cases", () => {
  test("handles negative values, decimals, custom units, and non-finite inputs", () => {
    expect(Uphill.formatBytes(-1500)).toBe("-1.5 kB")
    expect(Uphill.formatDurationNs(-500)).toBe("-500 ns")
    expect(Uphill.formatMetricValue(2048, "size")).toBe("2 kB")
    expect(Uphill.formatMetricValue(1000, "count", "B")).toBe("1 kB")
    expect(Uphill.formatMetricValue(5000, "time")).toBe("5 µs")
    expect(Uphill.formatMetricValue(5000, "count", "ns")).toBe("5 µs")
    expect(Uphill.formatMetricValue(3.14159, "count")).toBe("3.14")
    expect(Uphill.formatMetricValue(42, "count", "ops/s")).toBe("42 ops/s")
    expect(Uphill.formatMetricValue(Number.NaN, "count")).toBe("–")
    expect(Uphill.formatMetricValue(undefined, "count")).toBe("–")
  })
})
