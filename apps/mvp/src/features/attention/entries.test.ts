// The feed as a person sees it (src/features/attention/entries.ts, decision 0009 §4): pure, so every rule is a case
// here: which rows toast and when they hide, which stay in the list, how this device's acts read before they sync,
// what each toast says, and the order.
import { describe, expect, test } from "vitest"
import { HOME_HREF, LISTED_FOR_MS } from "./contract"
import { feedOf, follows, landed, newestNeed, timeOf, withPending, wordsOf } from "./entries"
import type { Notice, Pending } from "./schema"

const T0 = Date.parse("2026-10-20T12:00:00.000Z")
/** `ms` after T0, as Electric sends a timestamptz. */
const at = (ms: number) => new Date(T0 + ms).toISOString().replace("T", " ").replace("Z", "000+00")

const notice = (overrides: Partial<Notice> = {}): Notice => ({
  recipient: "person-ann",
  subject: "run:r1",
  kind: "run",
  state: "working",
  mine: true,
  quiet: false,
  runId: "r1",
  repoId: "github/acme/widgets",
  conversationId: "c-home",
  actor: "ann",
  title: "Deploy the docs preview",
  ref: null,
  href: HOME_HREF,
  version: 1,
  readVersion: 0,
  dismissedVersion: 0,
  hiddenVersion: 0,
  occurredAt: at(0),
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

const pending = (subject: string, act: Pending["act"], version: number): Pending => ({
  id: `${subject}:${act}`,
  subject,
  act,
  version,
})

const one = (row: Notice, nowMs = T0 + 100, place: string | null = null, acts: ReadonlyArray<Pending> = []) =>
  feedOf([row], acts, nowMs, place).entries[0]

describe("timeOf", () => {
  test("reads Electric's timestamptz and ISO, to the millisecond, and nothing else", () => {
    expect(timeOf("2026-10-20 12:00:00.123456+00")).toBe(Date.parse("2026-10-20T12:00:00.123Z"))
    expect(timeOf("2026-10-20 12:00:00+00")).toBe(Date.parse("2026-10-20T12:00:00Z"))
    expect(timeOf("2026-10-20T12:00:00.5Z")).toBe(Date.parse("2026-10-20T12:00:00.500Z"))
    expect(timeOf("2026-10-20 17:30:00+05:30")).toBe(Date.parse("2026-10-20T12:00:00Z"))
    expect(timeOf("2026-10-20 17:30:00+0530")).toBe(Date.parse("2026-10-20T12:00:00Z"))
    expect(timeOf("2026-10-20 12:00:00")).toBe(Date.parse("2026-10-20T12:00:00Z"))
    expect(timeOf("yesterday")).toBeNaN()
  })
})

describe("feedOf", () => {
  test("a live run toasts on a page; over its own conversation it shows there instead, and stays listed", () => {
    expect(one(notice())).toMatchObject({
      id: "run:r1",
      stack: true,
      stackHere: false,
      here: true,
      listed: true,
      action: "open",
      word: null,
      detail: "Deploy the docs preview",
      unread: true,
      settled: false,
    })
    // Over another conversation, it toasts there too.
    expect(one(notice(), T0, "c-other")).toMatchObject({ here: false, stackHere: true })
    expect(one(notice({ href: "/acme/widgets/tree/feature", conversationId: "c-1" }), T0, "c-1")).toMatchObject({
      here: true,
      stackHere: false,
    })
  })

  test("the person's own question toasts everywhere, with Answer", () => {
    expect(one(notice({ state: "needs_you", title: "Which branch?" }))).toMatchObject({
      stack: true,
      stackHere: true,
      action: "answer",
      detail: "Which branch?",
    })
  })

  test("someone else's run is quiet: a toast naming them while it lives, never an entry, gone 4 s after it settles", () => {
    const theirs = notice({ mine: false, quiet: true, state: "waiting" })
    expect(one(theirs)).toMatchObject({ stack: true, listed: false, unread: false, detail: "ann · Deploy the docs preview" })
    for (const state of ["done", "failed"] as const) {
      const settled = notice({ mine: false, quiet: true, state, updatedAt: at(0) })
      expect(feedOf([settled], [], T0 + 3_999, null)).toMatchObject({ nextAt: T0 + 4_000 })
      expect(one(settled, T0 + 3_999)).toMatchObject({ stack: true, listed: false })
      expect(feedOf([settled], [], T0 + 4_000, null).entries).toEqual([])
    }
    expect(one(notice({ mine: false, quiet: true, actor: null }))!.detail).toBe("Deploy the docs preview")
  })

  test("a finished or failed run toasts for 4 s; a finished one stays listed for 7 days, a failed one until dismissed", () => {
    const done = notice({ state: "done", version: 2 })
    expect(feedOf([done], [], T0 + 10, null)).toMatchObject({ nextAt: T0 + 4_000 })
    expect(one(done, T0 + 4_000)).toMatchObject({ stack: false, listed: true, settled: true })
    expect(feedOf([done], [], T0 + 4_000, null)).toMatchObject({ nextAt: T0 + LISTED_FOR_MS })
    expect(feedOf([done], [], T0 + LISTED_FOR_MS, null)).toEqual({ entries: [], nextAt: undefined })
    const failed = notice({ state: "failed" })
    expect(one(failed, T0 + 3_999)).toMatchObject({ stack: true, listed: true, settled: true })
    expect(one(failed, T0 + LISTED_FOR_MS * 2)).toMatchObject({ stack: false, listed: true, settled: true })
    expect(feedOf([failed], [], T0, null).nextAt).toBe(T0 + 4_000)
    expect(feedOf([failed], [], T0 + 4_000, null).nextAt).toBeUndefined()
  })

  test("Hide keeps the entry; Dismiss closes it; Read marks it read; a new version shows again", () => {
    expect(one(notice({ hiddenVersion: 1 }))).toMatchObject({ stack: false, listed: true })
    expect(one(notice({ dismissedVersion: 1 }))).toBeUndefined()
    expect(one(notice({ readVersion: 1 }))).toMatchObject({ unread: false })
    expect(one(notice({ version: 2, hiddenVersion: 1, readVersion: 1, dismissedVersion: 1 }))).toMatchObject({
      stack: true,
      listed: true,
      unread: true,
    })
  })

  test("this device's acts read at once, before the row syncs them", () => {
    const row = notice({ state: "failed", version: 3 })
    expect(one(row, T0, null, [pending("run:r1", "hide", 3)])).toMatchObject({ stack: false, listed: true })
    expect(one(row, T0, null, [pending("run:r1", "read", 3)])).toMatchObject({ unread: false })
    expect(one(row, T0, null, [pending("run:r1", "dismiss", 3)])).toBeUndefined()
    // Another subject's act changes nothing; an act for an older version doesn't hide a newer one.
    expect(one(row, T0, null, [pending("run:r2", "hide", 3), pending("run:r1", "hide", 2)])).toMatchObject({ stack: true })
    expect(withPending(row, [pending("run:r1", "read", 9)])).toMatchObject({ readVersion: 3 })
  })

  test("a repository's updates say main and its commit, or Release and its name", () => {
    const main = notice({
      subject: "main:github/acme/widgets",
      kind: "main",
      state: "update",
      runId: null,
      mine: false,
      ref: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      title: "Fix the parser",
      href: "/acme/widgets",
    })
    expect(one(main)).toMatchObject({ word: "main", detail: "a1b2c3d Fix the parser", action: "open", here: false, stackHere: true })
    expect(wordsOf({ ...main, ref: null, title: null })).toEqual({ word: "main", detail: null })
    const release = { ...main, subject: "release:github/acme/widgets:v1", kind: "release" as const, ref: "v1" }
    expect(wordsOf({ ...release, title: "Widgets v1" })).toEqual({ word: "Release", detail: "Widgets v1" })
    expect(wordsOf({ ...release, title: null })).toEqual({ word: "Release", detail: "v1" })
    expect(one(main, T0 + 4_000)).toMatchObject({ stack: false, listed: true })
  })

  test("orders needs you, failed, live, done, updates, the newest first within each", () => {
    const rows = [
      notice({ subject: "u", kind: "main", state: "update", runId: null, updatedAt: at(50) }),
      notice({ subject: "d", state: "done", updatedAt: at(50) }),
      notice({ subject: "w-old", state: "working", updatedAt: at(10) }),
      notice({ subject: "w-new", state: "waiting", updatedAt: at(20) }),
      notice({ subject: "f", state: "failed", updatedAt: at(5) }),
      notice({ subject: "n", state: "needs_you", updatedAt: at(1) }),
      notice({ subject: "bad", state: "working", updatedAt: "not a time" }),
    ]
    expect(feedOf(rows, [], T0 + 100, null).entries.map((entry) => entry.id)).toEqual([
      "n",
      "f",
      "w-new",
      "w-old",
      "bad",
      "d",
      "u",
    ])
  })

  test("the panel's fields: when it happened, as GitHub or the latest report says; who; and the run's conversation", () => {
    expect(one(notice({ occurredAt: at(5_000), updatedAt: at(9_000) }), T0 + 10_000)).toMatchObject({
      atMs: T0 + 5_000,
      actor: "ann",
      conversationId: "c-home",
    })
    // A time that doesn't read falls back to the row's last change.
    expect(one(notice({ occurredAt: "soon", updatedAt: at(9_000) }), T0 + 10_000)!.atMs).toBe(T0 + 9_000)
    expect(one(notice({ kind: "main", state: "update", runId: null, conversationId: null, actor: null }))).toMatchObject({
      actor: null,
      conversationId: null,
    })
  })
})

describe("newestNeed", () => {
  test("the newest of the person's own listed runs that need them; none, null", () => {
    const entry = (subject: string, ms: number, overrides: Partial<Notice> = {}) =>
      one(notice({ subject, state: "needs_you", occurredAt: at(ms), updatedAt: at(ms), ...overrides }), T0 + 10_000)!
    const older = entry("run:a", 1_000)
    const newer = entry("run:b", 2_000)
    expect(newestNeed([older, newer])).toBe("run:b")
    expect(newestNeed([newer, older])).toBe("run:b")
    // Someone else's, a quiet one (never listed), or one that no longer needs them, doesn't count.
    expect(newestNeed([older, { ...newer, mine: false }])).toBe("run:a")
    expect(newestNeed([older, { ...newer, listed: false }])).toBe("run:a")
    expect(newestNeed([older, { ...newer, state: "working" }])).toBe("run:a")
    expect(newestNeed([{ ...older, state: "done" }])).toBeNull()
    expect(newestNeed([])).toBeNull()
  })
})

describe("landed", () => {
  test("forgets acts the rows show, and keeps the rest, those whose row hasn't loaded included", () => {
    const rows = [notice({ subject: "a", version: 2, readVersion: 2 }), notice({ subject: "b", version: 2 })]
    expect(landed(rows, [pending("a", "read", 2), pending("b", "hide", 2), pending("unloaded", "dismiss", 1)])).toEqual([
      "a:read",
    ])
    expect(landed([], [pending("a", "read", 2)])).toEqual([])
  })
})

describe("follows", () => {
  test("a Member or above follows, and anyone while sign-in can't say; signed out, loading or a Guest, nobody", () => {
    expect(follows({ status: "signed_in", role: "member" })).toBe(true)
    expect(follows({ status: "signed_in", role: "guest" })).toBe(false)
    expect(follows({ status: "signed_in", role: null })).toBe(false)
    expect(follows({ status: "unreachable", role: null })).toBe(true)
    expect(follows({ status: "signed_out", role: null })).toBe(false)
    expect(follows({ status: "loading", role: null })).toBe(false)
  })
})

describe("a clone's entry", () => {
  const clone = (overrides: Partial<Notice> = {}) =>
    notice({
      subject: "clone:github/acme/widgets",
      kind: "clone",
      runId: null,
      conversationId: null,
      actor: null,
      title: "acme/widgets",
      ref: "requested",
      href: "/acme/widgets",
      ...overrides,
    })

  test("says Clone, the repository, and how far it came or why it stopped", () => {
    expect(wordsOf(clone())).toEqual({ word: "Clone", detail: "acme/widgets · Requested" })
    expect(wordsOf(clone({ ref: `fetching:${1536}` }))).toEqual({ word: "Clone", detail: "acme/widgets · Fetching 1.5 KB" })
    expect(wordsOf(clone({ ref: "indexing" }))).toEqual({ word: "Clone", detail: "acme/widgets · Indexing" })
    expect(wordsOf(clone({ state: "done", ref: "ready" }))).toEqual({ word: "Clone", detail: "acme/widgets" })
    expect(wordsOf(clone({ state: "failed", ref: "failed:timed_out" }))).toEqual({
      word: "Clone",
      detail: "acme/widgets · Clone timed out",
    })
  })

  test("a live clone toasts on a page and over a conversation, and opens its repository", () => {
    const live = one(clone(), T0 + 100, "c-home")!
    expect(live).toMatchObject({ kind: "clone", stack: true, stackHere: true, here: false, listed: true, action: "open" })
  })

  test("the person's failed clone offers Try again; someone else's, or one done, opens", () => {
    expect(one(clone({ state: "failed", ref: "failed:not_found" }))).toMatchObject({ action: "retry", settled: true })
    expect(one(clone({ state: "failed", ref: "failed:not_found", mine: false }))).toMatchObject({ action: "open" })
    expect(one(clone({ state: "done", ref: "ready" }))).toMatchObject({ action: "open" })
  })
})

describe("a spend alert", () => {
  // An Admin's sandbox spend alert (docs/features/sandbox-budgets.md#the-spend-alert): in the bell only.
  const spend = notice({
    subject: "sandbox-spend:2026-10:100",
    kind: "spend",
    state: "update",
    mine: false,
    runId: null,
    repoId: null,
    conversationId: null,
    actor: null,
    title: "$104.20 this month · alert at $100",
    href: "/app/settings",
  })

  test("says what the month's sandboxes cost and the alert it reached", () => {
    expect(wordsOf(spend)).toEqual({ word: "Sandbox spend", detail: "$104.20 this month · alert at $100" })
  })

  test("is listed and unread in the bell, opening Settings, and never shows as a toast", () => {
    expect(one(spend)).toMatchObject({
      kind: "spend",
      word: "Sandbox spend",
      action: "open",
      href: "/app/settings",
      listed: true,
      unread: true,
      stack: false,
      stackHere: false,
    })
  })
})

describe("a bug report", () => {
  // A bug report to an Admin (docs/features/bugs.md#the-admins-hear): in the bell only, opening the inbox.
  const bug = notice({
    subject: "bug:8d0f6c1e-2b7a-4c55-9f0e-0123456789ab",
    kind: "bug",
    state: "update",
    mine: false,
    runId: null,
    repoId: null,
    conversationId: null,
    actor: null,
    title: "@codeplanesmithers · /octocat/Spoon-Knife/issues",
    href: "/app/bugs",
  })

  test("says who reported it and on which page", () => {
    expect(wordsOf(bug)).toEqual({ word: "Bug report", detail: "@codeplanesmithers · /octocat/Spoon-Knife/issues" })
  })

  test("is listed and unread in the bell, opening the inbox, and never shows as a toast", () => {
    expect(one(bug)).toMatchObject({
      kind: "bug",
      word: "Bug report",
      action: "open",
      href: "/app/bugs",
      listed: true,
      unread: true,
      stack: false,
      stackHere: false,
    })
  })
})
