import { describe, expect, test } from "vitest"
import { pageOf } from "../issues/view"
import {
  checkRows,
  checksSummaryOf,
  conversationProps,
  fileStatusOf,
  isoOf,
  listPageOf,
  listProps,
  mayMerge,
  mergeBoxOf,
  mergeNoticeOf,
  pullAccessOf,
  type MergeView,
  type Pull,
  runStateOf,
  statusOf,
  unifiedOf,
} from "./view"

// The pull request pages' framework-free logic (src/features/pulls/view.ts, docs/features/pulls.md#the-browser): what
// the list, the page, its checks and files, and its merge box show, from the queries' rows.

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 2,
  title: "T1: Add a line",
  body: "Add it.",
  state: "open",
  author: "smithers[bot]",
  createdAt: "2026-10-20T10:00:00Z",
  synced: 2,
  headRef: "smithers/t1-add",
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  defaultBranch: "main",
  draft: false,
  merged: false,
  mergedBy: "",
  mergeSha: "",
  mergeableState: "clean",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commitCount: 1,
  ...overrides,
})

const signedIn = { status: "signed_in" as const }
/** ChatApi's answer on the deployment's own repository, the one merging acts on: a Maintainer there. */
const maintainer = { role: "maintainer" as const, own: true }

describe("the list", () => {
  test("each state's word and icon: Open, Draft, Merged, Closed", () => {
    expect(statusOf({ state: "open", draft: false, merged: false })).toEqual({ kind: "open", label: "Open" })
    expect(statusOf({ state: "open", draft: true, merged: false })).toEqual({ kind: "open", label: "Draft" })
    expect(statusOf({ state: "closed", draft: false, merged: true })).toEqual({ kind: "merged", label: "Merged" })
    expect(statusOf({ state: "closed", draft: false, merged: false })).toEqual({ kind: "closed", label: "Closed" })
  })

  test("rows link to their pages, in GitHub's Open or Closed list", () => {
    const rows = listProps([
      { id: "a", number: 3, title: "T", state: "closed", author: "maya", comments: 1, updatedAt: "u", draft: false, merged: true, headRef: "x" },
      { id: "b", number: 4, title: "U", state: "open", author: "ben", comments: 0, updatedAt: "v", draft: true, merged: false, headRef: "y" },
    ], "octo", "hello")
    expect(rows.slice(1).map(({ state, status, href }) => ({ state, status, href }))).toEqual([
      { state: "open", status: { kind: "open", label: "Draft" }, href: "/octo/hello/pull/4" },
    ])
    expect(rows.slice(0, 1)).toEqual([{
      id: "a",
      number: 3,
      title: "T",
      state: "closed",
      status: { kind: "merged", label: "Merged" },
      author: "maya",
      comments: 1,
      updatedAt: "u",
      href: "/octo/hello/pull/3",
    }])
  })
})

describe("the list page", () => {
  const row = { id: "a", number: 3, title: "T", state: "open", author: "maya", comments: 0, updatedAt: "u", draft: false, merged: false, headRef: "x" }
  const repository = { owner: "octo", name: "hello" }

  test("an unsynced empty repository has unknown counts instead of a lasting loading state", () => {
    expect(listPageOf([], repository, undefined, undefined)).toEqual({ refused: undefined, pulls: [], loading: false, unknown: true })
    expect(listPageOf([], repository, { complete: true }, undefined)).toMatchObject({ loading: false, unknown: false })
    expect(listPageOf([row], repository, undefined, { status: "allowed" })).toMatchObject({ loading: false, unknown: false, refused: undefined })
    expect(listPageOf([row], repository, undefined, undefined).pulls.map((pull) => pull.href)).toEqual(["/octo/hello/pull/3"])
  })

  test("a completed GitHub sync keeps unknown counts until device hydration", () => {
    const synced = { syncedAt: "now" }
    expect(listPageOf([], repository, synced, { status: "allowed" }, false)).toMatchObject({ loading: false, unknown: true })
    expect(listPageOf([row], repository, synced, { status: "allowed" }, false).loading).toBe(false)
    for (const status of ["sign_in", "forbidden"]) {
      expect(listPageOf([], repository, synced, { status }, false)).toMatchObject({ refused: status, loading: false, unknown: false })
    }
    expect(listPageOf([], repository, synced, { status: "allowed" }, true)).toMatchObject({ loading: false, unknown: false })
  })

  test("a person the shape refused signs in, or is not allowed: no rows, never loading", () => {
    expect(listPageOf([], repository, undefined, { status: "sign_in" })).toMatchObject({ refused: "sign_in", loading: false })
    expect(listPageOf([], repository, undefined, { status: "forbidden" })).toMatchObject({ refused: "forbidden", loading: false })
  })

  test("the pull shape's current refusal hides cached rows while the issue shape still says allowed", () => {
    const cached = { status: "allowed" }
    for (const [pullStatus, detail] of [["sign_in", "sign_in"], ["forbidden", "missing"]] as const) {
      const access = pullAccessOf(cached, { pullStatus })
      expect(listPageOf([row], repository, { syncedAt: "now" }, access)).toMatchObject({ refused: pullStatus, pulls: [] })
      expect(pageOf({ number: 3 }, { syncedAt: "now" }, true, true, access)).toBe(detail)
    }
    expect(pullAccessOf(cached, { pullStatus: "allowed" })).toBe(cached)
    expect(pullAccessOf({ status: "forbidden" }, { pullStatus: "unavailable", installed: false })).toEqual({ status: "forbidden" })
    expect(pageOf(undefined, undefined, false, false, pullAccessOf(cached, { pullStatus: "unavailable", installed: false }))).toBe("unknown")
    expect(pageOf(undefined, undefined, false, false,
      pullAccessOf({ status: "allowed", installed: false }, { pullStatus: "unavailable", installed: true }))).toBe("loading")
    expect(pageOf(undefined, { syncedAt: "now" }, true, true,
      pullAccessOf({ status: "allowed", installed: true }, { pullStatus: "unavailable", installed: true }))).toBe("missing")
  })
})

describe("merge", () => {
  test("a Maintainer or an Admin of the repository sees Merge on an open pull request whose head the device has", () => {
    expect(mayMerge(signedIn, maintainer, pull())).toBe(true)
    expect(mayMerge(signedIn, { role: "admin", own: true }, pull())).toBe(true)
    expect(mayMerge(signedIn, { role: "member", own: true }, pull())).toBe(false)
    expect(mayMerge(signedIn, undefined, pull())).toBe(false)
    expect(mayMerge({ status: "signed_out" }, maintainer, pull())).toBe(false)
    // Merging acts on the deployment's own repository until decision 0079's slice 2.
    expect(mayMerge(signedIn, { role: "maintainer", own: false }, pull())).toBe(false)
    for (const changed of [{ draft: true }, { merged: true }, { state: "closed" }, { synced: 0 }, { headSha: "" }]) {
      expect(mayMerge(signedIn, maintainer, pull(changed))).toBe(false)
    }
  })

  test("what the merge box says: Merged, Merging, the route's refusal, or the write's", () => {
    const view: MergeView = { mergeStatus: "", mergeFailure: "", mergeRefused: null, merging: false }
    expect(mergeNoticeOf(view, pull({ merged: true }))).toBe("Merged")
    expect(mergeNoticeOf(undefined, pull())).toBeUndefined()
    expect(mergeNoticeOf(view, pull())).toBeUndefined()
    expect(mergeNoticeOf({ ...view, merging: true }, pull())).toBe("Merging")
    expect(mergeNoticeOf({ ...view, mergeStatus: "pending" }, pull())).toBe("Merging")
    expect(mergeNoticeOf({ ...view, mergeStatus: "done" }, pull())).toBe("Merging")
    expect(mergeNoticeOf({ ...view, mergeRefused: "forbidden" }, pull())).toBe("Not allowed")
    expect(mergeNoticeOf({ ...view, mergeRefused: "sign_in" }, pull())).toBe("Sign in")
    expect(mergeNoticeOf({ ...view, mergeRefused: "unavailable" }, pull())).toBe("Couldn't merge")
    expect(mergeNoticeOf({ ...view, mergeStatus: "refused", mergeFailure: "head_moved" }, pull())).toBe("New commits")
    // A moved base names the pull request's base branch, never a fixed one.
    expect(mergeNoticeOf({ ...view, mergeStatus: "refused", mergeFailure: "base_moved" }, pull({ baseRef: "trunk" })))
      .toBe("trunk moved")
    // The writes' shared failures say what an issue write says.
    expect(mergeNoticeOf({ ...view, mergeStatus: "refused", mergeFailure: "sign_in_required" }, pull())).toBe("Sign in")
    expect(mergeNoticeOf({ ...view, mergeStatus: "refused", mergeFailure: "not_allowed" }, pull())).toBe("Not allowed")
    expect(mergeNoticeOf({ ...view, mergeStatus: "failed", mergeFailure: "unavailable" }, pull())).toBe("GitHub unavailable")
    expect(mergeNoticeOf({ ...view, mergeStatus: "failed", mergeFailure: "odd" }, pull())).toBe("Couldn't merge")
  })
})

describe("the merge box and the deploy warning (ruling GH-9)", () => {
  const idle: MergeView = { mergeStatus: "", mergeFailure: "", mergeRefused: null, merging: false }

  test("beside Merge into the default branch, it says merging deploys it, naming the branch", () => {
    expect(mergeBoxOf(signedIn, maintainer, pull(), idle)).toEqual({
      notice: undefined,
      merge: true,
      warning: "Merging into main deploys it.",
    })
    expect(mergeBoxOf(signedIn, maintainer, pull({ baseRef: "trunk", defaultBranch: "trunk" }), undefined).warning)
      .toBe("Merging into trunk deploys it.")
    // After a refusal Merge shows again, and so does the warning.
    const refused = { ...idle, mergeStatus: "refused", mergeFailure: "head_moved" }
    expect(mergeBoxOf(signedIn, maintainer, pull(), refused)).toEqual({
      notice: "New commits",
      merge: true,
      warning: "Merging into main deploys it.",
    })
  })

  test("no warning into any other branch, or while the device doesn't know the default branch", () => {
    expect(mergeBoxOf(signedIn, maintainer, pull({ baseRef: "release" }), idle)).toEqual({
      notice: undefined,
      merge: true,
      warning: undefined,
    })
    expect(mergeBoxOf(signedIn, maintainer, pull({ defaultBranch: "" }), idle).warning).toBeUndefined()
  })

  test("no warning where the person can't merge: no Merge, no warning", () => {
    const cases: ReadonlyArray<Parameters<typeof mergeBoxOf>> = [
      [signedIn, { role: "member", own: true }, pull(), idle],
      [{ status: "signed_out" }, maintainer, pull(), idle],
      [undefined, maintainer, pull(), idle],
      [signedIn, { role: "guest", own: true }, pull(), idle],
      [signedIn, maintainer, pull({ draft: true }), idle],
      [signedIn, maintainer, pull({ state: "closed" }), idle],
      [signedIn, maintainer, pull({ merged: true }), idle],
      [signedIn, maintainer, pull(), { ...idle, merging: true }],
      [signedIn, maintainer, pull(), { ...idle, mergeStatus: "done" }],
    ]
    for (const args of cases) {
      const box = mergeBoxOf(...args)
      expect([box.merge, box.warning]).toEqual([false, undefined])
    }
  })
})

describe("the conversation", () => {
  test("the body, comments and reviews with findings in time order; a review without text is an event", () => {
    const props = conversationProps(
      pull({ author: null }),
      [
        { id: "c1", author: "", createdAt: "2026-10-20T10:02:00Z", body: "Nice" },
        { id: "c2", author: "maya", createdAt: "2026-10-20T10:04:00Z", body: "Thanks" },
      ],
      [
        { id: "r1", author: "smithers[bot]", state: "COMMENTED", body: "- finding", submittedAt: "2026-10-20T10:01:00Z" },
        { id: "r2", author: "ben", state: "APPROVED", body: "", submittedAt: "2026-10-20T10:03:00Z" },
        { id: "r3", author: "", state: "OTHER", body: " ", submittedAt: "" },
        { id: "r4", author: "", state: "COMMENTED", body: "late", submittedAt: "" },
        { id: "r5", author: "", state: "COMMENTED", body: "later", submittedAt: "" },
      ],
      { owner: "octo", name: "hello" },
    )
    // Undated reviews first, in the order given; then everything in time order.
    expect(props.comments.map((comment) => comment.id)).toEqual(["r4", "r5", "r1", "c1", "c2"])
    expect(props.comments.find((comment) => comment.id === "c1")!.author).toBeUndefined()
    expect(props.comments.find((comment) => comment.id === "c2")!.author).toBe("maya")
    expect(props.events).toEqual([
      { id: "r2", kind: "merged", author: "ben", text: "approved", createdAt: "2026-10-20T10:03:00Z" },
      { id: "r3", kind: "open", text: "reviewed" },
    ])
    expect([props.author, props.state, props.status, props.externalHref]).toEqual([
      undefined,
      "open",
      { kind: "open", label: "Open" },
      "https://github.com/octo/hello/pull/2",
    ])
    expect(conversationProps(pull({ state: "closed" }), [], [], { owner: "o", name: "n" }).state).toBe("closed")
  })
})

describe("checks and files", () => {
  test("each check as a run of RunList, and the summary", () => {
    const rows = [
      { id: "1", flow: "checks/readme", status: "done", createdAt: "2026-10-20 10:00:00+00", updatedAt: "2026-10-20 10:00:05+00" },
      { id: "2", flow: "checks/review", status: "working", createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:00Z" },
      { id: "3", flow: "checks/lint", status: "failed", createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:09Z" },
      { id: "4", flow: "checks/x", status: "waiting", createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:00Z" },
    ]
    expect(checkRows(rows)).toEqual([
      { id: "1", flow: "checks/readme", state: "completed", startedAtMs: Date.parse("2026-10-20T10:00:00Z"), finishedAtMs: Date.parse("2026-10-20T10:00:05Z"), href: "/app/runs/1" },
      { id: "2", flow: "checks/review", state: "running", startedAtMs: Date.parse("2026-10-20T10:00:00Z"), finishedAtMs: null, href: "/app/runs/2" },
      { id: "3", flow: "checks/lint", state: "failed", startedAtMs: Date.parse("2026-10-20T10:00:00Z"), finishedAtMs: Date.parse("2026-10-20T10:00:09Z"), href: "/app/runs/3" },
      { id: "4", flow: "checks/x", state: "suspended", startedAtMs: Date.parse("2026-10-20T10:00:00Z"), finishedAtMs: null, href: "/app/runs/4" },
    ])
    expect(checksSummaryOf(rows)).toEqual({
      total: 4,
      passed: 1,
      failed: 1,
      running: 2,
      words: ["Passed", "Running", "Failed", "Waiting"],
    })
    expect(checksSummaryOf([{ ...rows[0]!, status: "odd" }]).words).toEqual(["odd"])
    expect(runStateOf("needs_you")).toBe("suspended")
    expect(isoOf("2026-10-20 10:00:00-07")).toBe("2026-10-20T10:00:00-07:00")
  })

  test("a file's patch as a unified diff, and its status", () => {
    expect(unifiedOf({ filename: "a.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@" }))
      .toBe("--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@")
    expect(unifiedOf({ filename: "n.md", status: "added", additions: 1, deletions: 0 })).toBe("--- /dev/null\n+++ b/n.md\n")
    expect(unifiedOf({ filename: "g.md", status: "removed", additions: 0, deletions: 1, patch: "x" }))
      .toBe("--- a/g.md\n+++ /dev/null\nx")
    expect(unifiedOf({ filename: "b.md", status: "renamed", additions: 0, deletions: 0, previous_filename: "a.md" }))
      .toBe("--- a/a.md\n+++ b/b.md\n")
    expect(["added", "removed", "renamed", "modified", "changed"].map(fileStatusOf)).toEqual([
      "added",
      "deleted",
      "renamed",
      "modified",
      "modified",
    ])
  })
})


test("an applied empty pull list is known without a repository sync marker", () => {
  const repo = { owner: "octo", name: "hello" }
  expect(listPageOf([], repo, undefined, { status: "allowed", installed: true }, true).unknown).toBe(false)
  expect(listPageOf([], repo, undefined, { status: "allowed", installed: true }, false).unknown).toBe(true)
  expect(listPageOf([], repo, undefined, { status: "allowed", installed: false }, true).unknown).toBe(true)
})
