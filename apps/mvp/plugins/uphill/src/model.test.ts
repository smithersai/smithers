import { Uphill } from "@smthrs/rpc"
import { describe, expect, test } from "vitest"
import { extractUphill, extractUphillIndexRefs, type FeedDocument, stepCategory } from "./model"

const SAMPLE_REPORT = {
  categories: [
    { name: "footprint", title: "Footprint", score: 70, metrics: [] },
    { name: "speed", title: "Speed", score: 94, metrics: [] },
  ],
  opportunities: [
    { category: "footprint", metric: "bundle", value: 8_000, target: 5_000, gain: 10 },
  ],
}

/** Community PR 2 snapshot shape: 6 Lighthouse category IDs averaging 82, commit 1dd29e1c, gate false. */
const PR2_COMMUNITY_ENVELOPE = {
  commit: "1dd29e1c4a0f8b2d",
  branch: "pr-2-community",
  updatedAt: "2026-11-27T18:00:00Z",
  provenance: {
    trust: "untrusted_contributor",
    gateEligible: false,
    cacheWriteAllowed: false,
    actor: "roninjin10",
    runner: "Community runner (roninjin10)",
  },
  report: {
    categories: [
      { id: "correctness", title: "Correctness", score: 90, metrics: [] },
      { id: "security", title: "Security", score: 84, metrics: [] },
      { id: "performance", title: "Performance", score: 80, metrics: [] },
      { id: "reliability", title: "Reliability", score: 82, metrics: [] },
      { id: "maintainability", title: "Maintainability", score: 78, metrics: [] },
      { id: "observability", title: "Observability", score: 78, metrics: [] },
    ],
    opportunities: [],
  },
}

describe("uphill plugin model", () => {
  test("extracts canonical uphill report and merges separate uphill/history feed", () => {
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
            { bad: true },
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
    expect(extracted.previewCount).toBe(0)
  })

  test("extracts array-bodied history, inline history precedence, and failed canonical categories", () => {
    const arrayHistory = extractUphill(
      [{ id: "1", repo: "acme/app", name: "uphill/latest", body: SAMPLE_REPORT, updatedAt: "2026-11-26T18:00:00Z" }],
      new Map([
        [
          "uphill/history",
          {
            id: "2",
            repo: "acme/app",
            name: "uphill/history",
            body: [{ commit: "ccc3333", overall: 88, scores: {} }],
            updatedAt: "2026-11-26T18:05:00Z",
          },
        ],
      ]),
    )
    expect(arrayHistory.history.map((h) => h.commit)).toEqual(["ccc3333"])

    const malformedHistory = extractUphill(
      [{
        id: "1",
        repo: "acme/app",
        name: "uphill",
        body: {
          report: { categories: [{ name: "broken", title: "Broken", score: null, error: { message: "boom" } }] },
          updatedAt: "2026-11-26T19:00:00Z",
          history: [],
        },
        updatedAt: "2026-11-26T18:00:00Z",
      }],
      new Map([
        ["uphill/history", { id: "2", repo: "acme/app", name: "uphill/history", body: "not-history", updatedAt: "2026-11-26T18:05:00Z" }],
      ]),
    )
    expect(malformedHistory.band).toBe("failed")
    expect(malformedHistory.updatedAt).toBe("2026-11-26T19:00:00Z")
    expect(malformedHistory.history).toEqual([])

    const inlineHistory = extractUphill([
      {
        id: "1",
        repo: "acme/app",
        name: "uphill",
        body: {
          report: SAMPLE_REPORT,
          history: [{ commit: "inline1", overall: 90, scores: {} }],
        },
        updatedAt: "2026-11-26T18:00:00Z",
      },
      {
        id: "2",
        repo: "acme/app",
        name: "uphill/history",
        body: [{ commit: "other2", overall: 50, scores: {} }],
        updatedAt: "2026-11-26T18:00:00Z",
      },
    ])
    expect(inlineHistory.history.map((h) => h.commit)).toEqual(["inline1"])
  })

  test("extracts and merges visibility-partitioned index refs without leaking malformed bodies", () => {
    const refs = extractUphillIndexRefs([
      { id: "0", repo: "acme/app", name: "lanes", body: {}, updatedAt: "2026-11-27T00:00:00Z" },
      { id: "1", repo: "acme/app", name: "uphill-index", body: { version: 99 }, updatedAt: "2026-11-27T00:00:00Z" },
      {
        id: "2",
        repo: "acme/app",
        name: Uphill.UPHILL_INDEX_PUBLIC,
        visibility: "public",
        body: {
          version: 1,
          previews: [
            { name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T02:00:00Z" },
            { name: "uphill/untrusted-shared", updatedAt: "2026-11-27T01:00:00Z" },
          ],
          history: { name: "uphill/history", updatedAt: "2026-11-27T01:00:00Z" },
        },
        updatedAt: "2026-11-27T02:00:00Z",
      },
      {
        id: "3",
        repo: "acme/app",
        name: Uphill.UPHILL_INDEX_MAINTAINERS,
        visibility: "maintainers",
        body: {
          version: 1,
          previews: [
            { name: "uphill/untrusted-shared", updatedAt: "2026-11-27T03:00:00Z" },
            { name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T01:00:00Z" },
            { name: "uphill/untrusted-alpha", updatedAt: null },
            { name: "uphill/untrusted-beta", updatedAt: null },
          ],
          history: { name: "uphill/history", updatedAt: "2026-11-27T04:00:00Z" },
        },
        updatedAt: "2026-11-27T04:00:00Z",
      },
    ])
    expect(refs.previews).toEqual([
      { name: "uphill/untrusted-shared", updatedAt: "2026-11-27T03:00:00Z" },
      { name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T02:00:00Z" },
      { name: "uphill/untrusted-alpha", updatedAt: null },
      { name: "uphill/untrusted-beta", updatedAt: null },
    ])
    expect(refs.history).toEqual({ name: "uphill/history", updatedAt: "2026-11-27T04:00:00Z" })
  })

  test("marks hasFeed from index before on-demand preview arrives and keeps preview separated from canonical baseline", () => {
    const indexOnly: ReadonlyArray<FeedDocument> = [
      {
        id: "smithersai/smithers-ci:uphill-index",
        repo: "smithersai/smithers-ci",
        name: Uphill.UPHILL_INDEX_PUBLIC,
        visibility: "public",
        body: {
          version: 1,
          previews: [{ name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T18:00:00Z" }],
          history: null,
        },
        updatedAt: "2026-11-27T18:00:00Z",
      },
    ]

    const pending = extractUphill(indexOnly)
    expect(pending.hasFeed).toBe(true)
    expect(pending.previewCount).toBe(1)
    expect(pending.envelope).toBeUndefined()
    expect(pending.overall).toBeNull()
    expect(pending.untrustedRuns).toEqual([])

    const loaded = extractUphill(
      indexOnly,
      new Map<string, FeedDocument>([
        [
          "uphill/untrusted-roninjin10",
          {
            id: "smithersai/smithers-ci:uphill/untrusted-roninjin10",
            repo: "smithersai/smithers-ci",
            name: "uphill/untrusted-roninjin10",
            visibility: "public",
            body: PR2_COMMUNITY_ENVELOPE,
            updatedAt: "2026-11-27T18:00:00Z",
          },
        ],
        [
          "uphill/untrusted-bare",
          {
            id: "smithersai/smithers-ci:uphill/untrusted-bare",
            repo: "smithersai/smithers-ci",
            name: "uphill/untrusted-bare",
            visibility: "public",
            body: { categories: [{ name: "broken", title: "Broken", score: null, error: { message: "err" } }] },
            updatedAt: "2026-11-27T17:00:00Z",
          },
        ],
        [
          "uphill/untrusted-alpha",
          {
            id: "smithersai/smithers-ci:uphill/untrusted-alpha",
            repo: "smithersai/smithers-ci",
            name: "uphill/untrusted-alpha",
            visibility: "public",
            body: { categories: [{ name: "ok", title: "Ok", score: 92 }] },
            updatedAt: "2026-11-27T17:00:00Z",
          },
        ],
        [
          "uphill/untrusted-invalid",
          {
            id: "smithersai/smithers-ci:uphill/untrusted-invalid",
            repo: "smithersai/smithers-ci",
            name: "uphill/untrusted-invalid",
            visibility: "public",
            body: { notAReport: true },
            updatedAt: "2026-11-27T16:00:00Z",
          },
        ],
      ]),
    )
    expect(loaded.hasFeed).toBe(true)
    expect(loaded.envelope).toBeUndefined()
    expect(loaded.overall).toBeNull()
    expect(loaded.band).toBe("none")
    expect(loaded.previewCount).toBe(3)
    expect(loaded.untrustedRuns.map((r) => ({ actor: r.actor, overall: r.overall, band: r.band, commit: r.envelope.commit }))).toEqual([
      { actor: "roninjin10", overall: 82, band: "warn", commit: "1dd29e1c4a0f8b2d" },
      { actor: "alpha", overall: 92, band: "good", commit: null },
      { actor: "bare", overall: null, band: "failed", commit: null },
    ])
    expect(loaded.untrustedRuns[0]!.envelope.provenance?.gateEligible).toBe(false)
  })

  test("returns empty state when no valid uphill feed exists", () => {
    const extracted = extractUphill([
      { id: "1", repo: "acme/app", name: "wiki", body: { notes: [] }, updatedAt: "2026-11-26T18:00:00Z" },
    ])
    expect(extracted.hasFeed).toBe(false)
    expect(extracted.overall).toBeNull()
    expect(extracted.band).toBe("none")
    expect(extracted.previewCount).toBe(0)
  })

  test("steps selected category cyclically through all + categories", () => {
    const cats = ["footprint", "speed"]
    expect(stepCategory(cats, null, 1)).toBe("footprint")
    expect(stepCategory(cats, "footprint", 1)).toBe("speed")
    expect(stepCategory(cats, "speed", 1)).toBeNull()
    expect(stepCategory(cats, null, -1)).toBe("speed")
    expect(stepCategory(cats, "unknown", 1)).toBe("footprint")
    expect(stepCategory([], null, 1)).toBeNull()
  })
})
