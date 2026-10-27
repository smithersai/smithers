// The issues contract's helpers (src/features/issues/contract.ts): the routes, ids, keys and words the browser, ChatApi
// and the GitHub flows share.
import { describe, expect, test } from "vitest"
import {
  ITEM_SUMMARY_COLUMNS,
  agentAttribution,
  applyExecutionId,
  commentDraftKey,
  commentId,
  githubIssueUrl,
  issueNumberOf,
  issuePath,
  issuesChannel,
  issuesPath,
  itemId,
  MAX_ISSUE_NUMBER,
  newDraftKey,
  newIssuePath,
  NOT_SENT_COPY,
  NOT_SENT_REASONS,
  ACCEPTED_LABEL,
  labelOf,
  NOT_ACCEPTED_LABEL,
  reconcileBucketStart,
  reconcileExecutionId,
  refusalOf,
  rejectionComment,
  SYNC_STALE_MS,
  TRIAGE_REASON_COPY,
  TRIAGE_REASONS,
  triageOf,
  triageRunExecutionId,
  writeExecutionId,
  writesRoute,
} from "./contract"

describe("routes and paths", () => {
  test("the writes route escapes its owner and name; the app's issue paths are GitHub's", () => {
    expect(writesRoute("octo", "hello")).toBe("/api/repos/octo/hello/writes")
    expect(writesRoute("a b", "c/d")).toBe("/api/repos/a%20b/c%2Fd/writes")
    expect(issuesPath("octo", "hello")).toBe("/octo/hello/issues")
    expect(newIssuePath("octo", "hello")).toBe("/octo/hello/issues/new")
    expect(issuePath("octo", "hello", 12)).toBe("/octo/hello/issues/12")
    expect(githubIssueUrl("octo", "hello", 12)).toBe("https://github.com/octo/hello/issues/12")
  })

  test("an issue route's number is 1 to the largest integer Postgres keeps, written plainly", () => {
    expect(issueNumberOf("1")).toBe(1)
    expect(issueNumberOf("12")).toBe(12)
    expect(issueNumberOf(String(MAX_ISSUE_NUMBER))).toBe(MAX_ISSUE_NUMBER)
    for (const text of ["", "0", "012", "-1", "1.5", "1e3", "abc", "new", String(MAX_ISSUE_NUMBER + 1), "99999999999"]) {
      expect([text, issueNumberOf(text)]).toEqual([text, undefined])
    }
  })
})

describe("ids and keys", () => {
  test("rows, runs, drafts and the engine channel are named from what both sides know", () => {
    expect(itemId("github/octo/hello", 12)).toBe("github/octo/hello#12")
    expect(commentId("github/octo/hello", 501)).toBe("github/octo/hello/comment/501")
    expect(writeExecutionId("w")).toBe("github-write:w")
    expect(applyExecutionId("d")).toBe("github-apply:d")
    expect(newDraftKey("github/octo/hello")).toBe("new:github/octo/hello")
    expect(commentDraftKey("github/octo/hello", 7)).toBe("comment:github/octo/hello#7")
    expect(issuesChannel("smithers")).toBe("smithers/issues")
    expect(agentAttribution("maya")).toBe("Smithers for @maya")
    expect(agentAttribution(null)).toBe("Smithers")
  })

  test("a stale read's reconcile run is one per repository and 5-minute bucket", () => {
    const start = 10 * SYNC_STALE_MS
    expect(reconcileExecutionId("r", start)).toBe(reconcileExecutionId("r", start + SYNC_STALE_MS - 1))
    expect(reconcileExecutionId("r", start)).not.toBe(reconcileExecutionId("r", start + SYNC_STALE_MS))
    expect(reconcileExecutionId("r", start)).toBe("github-reconcile:r:10")
    expect(reconcileBucketStart(start + SYNC_STALE_MS - 1)).toBe(start)
    expect(reconcileBucketStart(start + SYNC_STALE_MS)).toBe(start + SYNC_STALE_MS)
  })
})

describe("Not sent", () => {
  test("the route's refusals by status; anything else is sent again", () => {
    expect([400, 401, 403, 404, 409, 413].map((status) => refusalOf(status))).toEqual([
      "invalid",
      "authentication",
      "forbidden",
      "not_found",
      "conflict",
      "too_large",
    ])
    for (const status of [undefined, 200, 202, 408, 429, 500, 502, 503]) expect(refusalOf(status)).toBeUndefined()
  })

  test("a 404's code tells the App not installed from a repository not found (decision 0065 §7)", () => {
    expect(refusalOf(404, "app_not_installed")).toBe("app_not_installed")
    expect(NOT_SENT_COPY[refusalOf(404, "app_not_installed")!]).toBe("App not installed")
    expect(refusalOf(404, "not_found")).toBe("not_found")
    expect(refusalOf(404)).toBe("not_found")
    // Rate limited and GitHub down are sent again, whatever their code says.
    expect([refusalOf(429, "rate_limited"), refusalOf(503, "github_unavailable"), refusalOf(403, "app_not_installed")]).toEqual([
      undefined,
      undefined,
      "forbidden",
    ])
  })

  test("every reason has its words", () => {
    expect(Object.keys(NOT_SENT_COPY).sort()).toEqual([...NOT_SENT_REASONS].sort())
    for (const words of Object.values(NOT_SENT_COPY)) expect(words.length).toBeGreaterThan(0)
  })
})

describe("triage", () => {
  /** Every subset of `items`. */
  const subsets = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
    items.reduce<ReadonlyArray<ReadonlyArray<A>>>((all, item) => [...all, ...all.map((set) => [...set, item])], [[]])

  test("the label table, over every combination of the triage labels, their cases and other labels", () => {
    const spellings = {
      accepted: [ACCEPTED_LABEL, ACCEPTED_LABEL.toUpperCase(), "Smithers:Accepted"],
      rejected: [NOT_ACCEPTED_LABEL, "SMITHERS:NOT-ACCEPTED"],
      // A repository's own labels never count: only the `smithers:` ones do.
      other: ["accepted", "not accepted", "smithers:proposed", "bug"],
    }
    let checked = 0
    for (const accepted of [undefined, ...spellings.accepted]) {
      for (const rejected of [undefined, ...spellings.rejected]) {
        for (const other of subsets(spellings.other)) {
          const labels = [...other, ...(accepted === undefined ? [] : [accepted]), ...(rejected === undefined ? [] : [rejected])]
          for (const order of [labels, [...labels].reverse()]) {
            const expected = accepted !== undefined && rejected !== undefined
              ? "conflict"
              : accepted !== undefined
              ? "accepted"
              : rejected !== undefined
              ? "not_accepted"
              : "proposed"
            expect([order, triageOf(order)]).toEqual([order, expected])
            checked += 1
          }
        }
      }
    }
    expect(checked).toBe(4 * 3 * 16 * 2)
  })

  test("a decision's label; the App's comment names its reason and the enabler, and nothing else", () => {
    expect(labelOf("accept")).toBe(ACCEPTED_LABEL)
    expect(labelOf("reject")).toBe(NOT_ACCEPTED_LABEL)
    for (const reason of TRIAGE_REASONS) {
      const comment = rejectionComment(reason, "sam")
      expect(comment).toBe(`Not accepted: ${TRIAGE_REASON_COPY[reason]}\n\nTriaged by Smithers for @sam (triage).`)
      expect(comment.length).toBeLessThanOrEqual(300)
      expect(comment).not.toMatch(/https?:/)
    }
    expect(triageRunExecutionId("d-1")).toBe("triage-run:d-1")
  })
})


test("list summaries include their creation date for chronological sorting", () => {
  expect(ITEM_SUMMARY_COLUMNS).toContain("created_at")
  expect(ITEM_SUMMARY_COLUMNS).not.toContain("body")
})
