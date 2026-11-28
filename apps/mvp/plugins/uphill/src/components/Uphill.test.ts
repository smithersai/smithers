import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Uphill } from "@smthrs/rpc"
import type { UphillSummary } from "../model"
import type { RepoUphillState, UphillTab, Watched } from "../tab"
import { RepoTab } from "./RepoTab"
import { Uphill as UphillView } from "./Uphill"

const REPO = { owner: "smithersai", name: "smithers-ci" } as const

const watchedOf = <A,>(value: A): Watched<A> => ({
  current: () => value,
  subscribe: () => () => {},
})

const makeTab = (state: RepoUphillState, summary: UphillSummary): UphillTab => ({
  queries: {
    state: () => watchedOf(state),
    summary: () => watchedOf(summary),
  },
  actions: {
    href: (repo) => `/${repo.owner}/${repo.name}/-/uphill`,
    open: () => {},
    selectCategory: () => {},
    step: () => {},
  },
})

const PR2_ENVELOPE = Uphill.decodeFeedBody({
  commit: "1dd29e1c4a0f8b2d",
  branch: "pr-2",
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
})!

const BASE_STATE: RepoUphillState = {
  status: "ready",
  hasFeed: false,
  envelope: undefined,
  overall: null,
  band: "none",
  updatedAt: null,
  history: [],
  selectedCategory: null,
  untrustedRuns: [],
  pendingPreviews: [],
  failedPreviews: [],
  loadingHistory: false,
  historyFailed: false,
}

const BASE_SUMMARY: UphillSummary = {
  hasFeed: false,
  overall: null,
  band: "none",
  opportunities: 0,
  previewCount: 0,
}

describe("Uphill local React render", () => {
  test("renders safe progress while cold-loading index or pending community previews without claiming no report", () => {
    const loadingHtml = renderToStaticMarkup(
      createElement(UphillView, { tab: makeTab({ ...BASE_STATE, status: "loading" }, BASE_SUMMARY), repository: REPO }),
    )
    expect(loadingHtml).toContain("Loading backpressure audit")
    expect(loadingHtml).not.toContain("No backpressure audit published yet")

    const pendingPreviewTab = makeTab(
      { ...BASE_STATE, hasFeed: true, pendingPreviews: ["uphill/untrusted-roninjin10"] },
      { ...BASE_SUMMARY, hasFeed: true, previewCount: 1 },
    )
    const pendingHtml = renderToStaticMarkup(createElement(UphillView, { tab: pendingPreviewTab, repository: REPO }))
    expect(pendingHtml).toContain("No trusted baseline report yet")
    expect(pendingHtml).toContain("Community runs (untrusted)")
    expect(pendingHtml).toContain("Loading community audit runs")
    expect(pendingHtml).not.toContain("No backpressure audit published yet")

    const tabHtml = renderToStaticMarkup(createElement(RepoTab, { tab: pendingPreviewTab, repository: REPO }))
    expect(tabHtml).toContain("Uphill")
    expect(tabHtml).toContain("/smithersai/smithers-ci/-/uphill")
    expect(tabHtml).not.toContain("82")
  })

  test("renders existing community PR 2 snapshot (score 82, commit 1dd29e1c, gate false, baseline unchanged)", () => {
    const pr2Tab = makeTab(
      {
        ...BASE_STATE,
        hasFeed: true,
        untrustedRuns: [
          {
            id: "smithersai/smithers-ci:uphill/untrusted-roninjin10",
            name: "uphill/untrusted-roninjin10",
            actor: "roninjin10",
            overall: 82,
            band: "warn",
            updatedAt: "2026-11-27T18:00:00Z",
            envelope: PR2_ENVELOPE,
          },
        ],
      },
      { ...BASE_SUMMARY, hasFeed: true, previewCount: 1 },
    )
    const html = renderToStaticMarkup(createElement(UphillView, { tab: pr2Tab, repository: REPO }))
    expect(html).toContain("No trusted baseline report yet")
    expect(html).toContain("Community runs (untrusted)")
    expect(html).toContain("Informational only")
    expect(html).toContain("Cache isolated")
    expect(html).toContain("@roninjin10")
    expect(html).toContain("82/100")
    expect(html).toContain("1dd29e1c")
    expect(html).toContain("Correctness")
    expect(html).toContain("Observability")
    expect(html).not.toContain("No backpressure audit published yet")
  })

  test("renders failed on-demand preview/history notices, refused state, empty state, and trusted baseline tab badge", () => {
    const failedHtml = renderToStaticMarkup(
      createElement(UphillView, {
        tab: makeTab(
          {
            ...BASE_STATE,
            hasFeed: true,
            envelope: Uphill.decodeFeedBody({
              commit: "abcdef12",
              branch: "main",
              report: { categories: [{ name: "speed", title: "Speed", score: 94, metrics: [] }], opportunities: [] },
            })!,
            overall: 94,
            band: "good",
            failedPreviews: ["uphill/untrusted-alice", "uphill/untrusted-bob"],
            historyFailed: true,
          },
          { hasFeed: true, overall: 94, band: "good", opportunities: 0, previewCount: 2 },
        ),
        repository: REPO,
      }),
    )
    expect(failedHtml).toContain("2 community runs unavailable")
    expect(failedHtml).toContain("History unavailable")

    const singleFailedHtml = renderToStaticMarkup(
      createElement(UphillView, {
        tab: makeTab({ ...BASE_STATE, hasFeed: true, failedPreviews: ["uphill/untrusted-alice"] }, { ...BASE_SUMMARY, hasFeed: true, previewCount: 1 }),
        repository: REPO,
      }),
    )
    expect(singleFailedHtml).toContain("1 community run unavailable")

    const trustedTabHtml = renderToStaticMarkup(
      createElement(RepoTab, {
        tab: makeTab(BASE_STATE, { hasFeed: true, overall: 94, band: "good", opportunities: 0, previewCount: 0 }),
        repository: REPO,
      }),
    )
    expect(trustedTabHtml).toContain("Uphill")
    expect(trustedTabHtml).toContain("94")

    const emptyHtml = renderToStaticMarkup(
      createElement(UphillView, { tab: makeTab(BASE_STATE, BASE_SUMMARY), repository: REPO }),
    )
    expect(emptyHtml).toContain("No backpressure audit published yet")

    const refusedHtml = renderToStaticMarkup(
      createElement(UphillView, { tab: makeTab({ ...BASE_STATE, status: "refused" }, BASE_SUMMARY), repository: REPO }),
    )
    expect(refusedHtml).toContain("Backpressure audit report not available")
  })
})
