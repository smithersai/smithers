// What the issue pages render (src/features/issues/view.ts), the drafts a press takes (actions.ts), and keeping a
// write on the device (writes.ts): pure functions over rows, and one local collection.
import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { commentBodyOf, newIssueOf } from "./actions"
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "./contract"
import { Requested, type Sending } from "./schema"
import {
  embeddedIssues,
  commentOf,
  conversationProps,
  draftOf,
  issueOf,
  listProps,
  listFailureOf,
  type ListRow,
  mayManageTriage,
  mayManageTriageOnList,
  mayTriage,
  mayWrite,
  pageOf,
  reasonText,
  triageControlOf,
  triageSwitchOf,
} from "./view"
import { syncStatusOf } from "./store"
import { keep } from "./writes"

const synced: ListRow = {
  id: "github/octo/hello#3",
  number: 3,
  title: "Synced",
  state: "closed",
  author: "ben",
  comments: 2,
  updatedAt: "2026-10-20 10:00:00+00",
  triage: "accepted",
  pending: "",
  reason: "",
  local: 0,
}

const mine = (id: string, pending: string, reason: unknown = ""): ListRow => ({
  id,
  number: 0,
  title: `Mine ${id}`,
  state: "open",
  author: "",
  comments: 0,
  updatedAt: "",
  triage: "",
  pending,
  reason,
  local: 1,
})

describe("the list", () => {
  test("an unsynced second repository stays usable without a loading state or false empty counts", () => {
    for (const rows of [[], [mine("second-repo", "requested")]]) {
      const props = listProps(rows, undefined, { status: "allowed" })
      expect(props).toMatchObject({ unknown: true })
      expect(props).not.toHaveProperty("loading")
      expect(props.issues).toEqual(rows.map((row) => issueOf(row)))
    }
  })

  test("GitHub's rows as they are; this device's own as #– with their chip; Not sent ones with why", () => {
    expect(listProps([mine("a", "not_sent", "conflict"), mine("b", "requested"), synced], { syncedAt: "x" })).toEqual({
      issues: [
        { id: "a", number: null, title: "Mine a", state: "open", pending: "not_sent" },
        { id: "b", number: null, title: "Mine b", state: "open", pending: "requested" },
        {
          id: synced.id,
          number: 3,
          title: "Synced",
          state: "closed",
          author: "ben",
          comments: 2,
          updatedAt: synced.updatedAt,
          triage: "accepted",
        },
      ],
      unknown: false,
      notSent: [{ id: "a", title: "Mine a", reason: "Conflict" }],
    })
    // GitHub no longer has the author's account.
    expect(issueOf({ ...synced, author: "", state: "open" })).toMatchObject({ author: undefined, state: "open" })
  })

  test("unknown until the first complete sync, unless GitHub's rows are here already; never 'No issues' before", () => {
    expect(listProps([], undefined).unknown).toBe(true)
    expect(listProps([mine("a", "requested")], undefined).unknown).toBe(true)
    expect(listProps([synced], undefined).unknown).toBe(false)
    expect(listProps([], { syncedAt: null }).unknown).toBe(false)
  })

  test("a reason's words, and none for what isn't a reason", () => {
    expect(reasonText("forbidden")).toBe("Not allowed")
    expect(reasonText("unavailable")).toBe("GitHub unavailable")
    for (const reason of ["", null, undefined, "pending", 3]) expect(reasonText(reason)).toBeUndefined()
  })
})

describe("a repository's issues view in a conversation", () => {
  test("lists that repository's synced issues, with its sync once a walk completed", () => {
    const issue = (repoId: string, number: number) => ({
      id: `${repoId}#${number}`,
      repoId,
      number,
      title: `Issue ${number}`,
      state: "open",
      author: "octocat",
      comments: 0,
      updatedAt: "2026-10-25T00:00:00Z",
      triage: "",
      commitment: "",
      pending: "",
      reason: "",
      local: 0,
    })
    const rows = [issue("github/a/b", 2), issue("github/c/d", 9), issue("github/a/b", 1)]
    const synced = [{ repoId: "github/c/d", syncedAt: "t1" }, { repoId: "github/a/b", syncedAt: "t2" }]
    expect(embeddedIssues(rows, synced, "github/a/b")).toEqual({
      rows: [rows[0], rows[2]],
      synced: { repoId: "github/a/b", syncedAt: "t2" },
    })
    const none = embeddedIssues(rows, [], "github/e/f")
    expect(none).toEqual({ rows: [], synced: undefined })
    // Nothing known of it yet: neither a spinner nor "No issues".
    expect(listProps(none.rows, none.synced).unknown).toBe(true)
  })
})

describe("an issue's page", () => {
  test("the issue with its link out, GitHub's comments, then this device's own with their chip; Not sent ones editable", () => {
    const shown = conversationProps(
      {
        number: 7,
        title: "Crash",
        body: "Body",
        state: "open",
        author: null,
        createdAt: "2026-10-20 10:00:00+00",
      },
      [
        { id: "c1", author: "ben", createdAt: "2026-10-20 11:00:00+00", body: "Hi", pending: "", reason: "", local: 0 },
        { id: "c2", author: "", createdAt: "", body: "Mine", pending: "requested", reason: "", local: 1 },
        { id: "c3", author: "", createdAt: "", body: "Refused", pending: "not_sent", reason: "too_large", local: 1 },
      ],
      { owner: "octo", name: "hello" },
    )
    expect(shown).toEqual({
      title: "Crash",
      number: 7,
      state: "open",
      author: undefined,
      createdAt: "2026-10-20 10:00:00+00",
      body: "Body",
      externalHref: "https://github.com/octo/hello/issues/7",
      comments: [
        {
          id: "c1",
          author: "ben",
          createdAt: "2026-10-20 11:00:00+00",
          body: "Hi",
          pending: undefined,
          reason: undefined,
          editable: false,
        },
        { id: "c2", author: undefined, createdAt: undefined, body: "Mine", pending: "requested", reason: undefined, editable: false },
        { id: "c3", author: undefined, createdAt: undefined, body: "Refused", pending: "not_sent", reason: "Too long", editable: true },
      ],
    })
    expect(commentOf({ id: "c", author: null, createdAt: "t", body: "", pending: "", reason: null, local: 0 }).author)
      .toBeUndefined()
    expect(conversationProps({ ...shownItem, state: "closed" }, [], { owner: "o", name: "n" }).state).toBe("closed")
  })

  test("loading until the first complete sync; then an issue the device doesn't have is missing", () => {
    expect(pageOf(undefined, undefined, false, false)).toBe("loading")
    expect(pageOf(undefined, { syncedAt: "x" }, true, true)).toBe("loading")
    expect(pageOf(undefined, { syncedAt: "x" }, true, true, { status: "allowed", installed: true })).toBe("missing")
    expect(pageOf(shownItem, undefined, true, true)).toBe("shown")
  })
})

const shownItem = { number: 1, title: "t", body: "", state: "open", author: "a", createdAt: "c" }

describe("forms", () => {
  test("a draft's text, empty without one, and Too long over GitHub's limits", () => {
    expect(draftOf(undefined)).toEqual({ title: "", body: "", error: undefined })
    expect(draftOf({ title: undefined, body: undefined })).toEqual({ title: "", body: "", error: undefined })
    expect(draftOf({ title: "t", body: "b" })).toEqual({ title: "t", body: "b", error: undefined })
    expect(draftOf({ title: "x".repeat(MAX_TITLE_LENGTH + 1), body: "" }).error).toBe("Too long")
    expect(draftOf({ title: "", body: "x".repeat(MAX_BODY_LENGTH + 1) }).error).toBe("Too long")
  })

  test("a new issue takes a title that isn't blank, trimmed, and both within the limits", () => {
    expect(newIssueOf(undefined)).toBeUndefined()
    expect(newIssueOf({ id: "d", title: "  ", body: "b" })).toBeUndefined()
    expect(newIssueOf({ id: "d", title: "x".repeat(MAX_TITLE_LENGTH + 1), body: "" })).toBeUndefined()
    expect(newIssueOf({ id: "d", title: "t", body: "x".repeat(MAX_BODY_LENGTH + 1) })).toBeUndefined()
    expect(newIssueOf({ id: "d", title: "  Fix it ", body: "Body" })).toEqual({ title: "Fix it", body: "Body" })
  })

  test("a comment takes a body that isn't blank, within the limit", () => {
    expect(commentBodyOf(undefined)).toBeUndefined()
    expect(commentBodyOf({ id: "d", title: "", body: " \n " })).toBeUndefined()
    expect(commentBodyOf({ id: "d", title: "", body: "x".repeat(MAX_BODY_LENGTH + 1) })).toBeUndefined()
    expect(commentBodyOf({ id: "d", title: "", body: " Looks good " })).toBe(" Looks good ")
  })

  test("who may write: signed in with a role on the repository the page names, once ChatApi answered for it (decision 0079)", () => {
    const own = { role: "guest", own: true } as const
    expect(mayWrite({ status: "signed_in", role: null }, undefined, own)).toBe(true)
    // A role on the deployment's own repository counts for nothing on another: ChatApi's answer for it decides.
    expect(mayWrite({ status: "signed_in", role: "admin" }, undefined, { role: null, own: false })).toBe(false)
    expect(mayWrite({ status: "signed_in", role: "guest" }, undefined, { role: "guest", own: false })).toBe(true)
    // Before ChatApi answers for the repository, nothing shows.
    expect(mayWrite({ status: "signed_in", role: "admin" }, undefined, undefined)).toBe(false)
    expect(mayWrite({ status: "signed_out", role: null }, { role: "member" }, own)).toBe(false)
    // Offline after an answer, the session this device confirmed is still signed in.
    expect(mayWrite({ status: "unreachable", role: null }, { role: "member" }, own)).toBe(true)
    expect(mayWrite({ status: "loading", role: null }, undefined, own)).toBe(false)
  })
})

describe("keeping a write on the device", () => {
  test("inserted Requested, then its status replaced when a send replayed after a crash finds it", async () => {
    const write: Sending = {
      id: "w",
      repo: "octo/hello",
      repoId: "github/octo/hello",
      op: "issue/comment",
      title: "",
      number: 7,
      body: "Hi",
      queuedAt: 1,
      v: 3,
    }
    const rows = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const requested = yield* Collection.local<Requested, string>({
        id: `issue-requested-${crypto.randomUUID()}`,
        schema: Requested,
        getKey: (row) => row.id,
      })
      yield* keep(requested, write, "requested", null)
      const first = yield* requested.toArray
      yield* keep(requested, write, "not_sent", "conflict")
      return [first, yield* requested.toArray]
    })))
    const kept = { id: "w", repo: "octo/hello", repoId: "github/octo/hello", op: "issue/comment", title: "", number: 7, body: "Hi", queuedAt: 1 }
    expect(rows).toMatchObject([
      [{ ...kept, status: "requested", reason: null }],
      [{ ...kept, status: "not_sent", reason: "conflict" }],
    ])
    expect(rows.map((kept) => kept.length)).toEqual([1, 1])
  })
})

describe("a repository this person may not read", () => {
  test("a refused list never loads: it says why; an issue's page asks to sign in, or isn't there", () => {
    expect(listProps([], undefined, { status: "sign_in" })).toMatchObject({ refused: "sign_in", unknown: false })
    expect(listProps([], undefined, { status: "forbidden" })).toMatchObject({ refused: "forbidden", unknown: false })
    expect(listProps([], undefined, { status: "unknown" })).toMatchObject({ refused: undefined, unknown: true })
    expect(listProps([], undefined, { status: "allowed" })).toMatchObject({ refused: undefined, unknown: true })
    expect(pageOf(undefined, undefined, true, true, { status: "sign_in" })).toBe("sign_in")
    expect(pageOf(undefined, undefined, true, true, { status: "forbidden" })).toBe("missing")
    expect(pageOf(undefined, undefined, true, true, { status: "allowed" })).toBe("loading")
    expect(pageOf(undefined, undefined, true, true, { status: "allowed", installed: true })).toBe("unknown")
    expect(pageOf({ number: 1 }, undefined, true, true, { status: "sign_in" })).toBe("sign_in")
  })

  test("the items shape's answers: allowed, refused, or unavailable until its next success", () => {
    expect(syncStatusOf({ _tag: "Succeeded" })).toBe("allowed")
    expect(syncStatusOf({ _tag: "Stopped", error: new ElectricCollection.SyncFailed({ cause: null, status: 401 }) })).toBe("unavailable")
    expect(syncStatusOf({ _tag: "Stopped", error: new ElectricCollection.SyncFailed({ cause: null, status: 403 }) })).toBe(
      "unavailable",
    )
    expect(syncStatusOf({ _tag: "Stopped", error: new ElectricCollection.SyncFailed({ cause: null, status: 400 }) })).toBe("unavailable")
    expect(syncStatusOf({ _tag: "Failed", status: 503 })).toBe("unavailable")
    expect(syncStatusOf({ _tag: "Failed" })).toBe("unavailable")
    expect(syncStatusOf({ _tag: "Sent" })).toBeUndefined()
  })
})

describe("triage", () => {
  const proposed: ListRow = { ...synced, triage: "proposed" }

  test("a proposed issue shows no chip while the flow is off, and Proposed once it's on; any other state always shows", () => {
    expect(issueOf(proposed).triage).toBeUndefined()
    expect(issueOf(proposed, true).triage).toBe("proposed")
    for (const state of ["accepted", "not_accepted", "conflict"] as const) {
      expect(issueOf({ ...synced, triage: state }).triage).toBe(state)
      expect(issueOf({ ...synced, triage: state }, true).triage).toBe(state)
    }
    // A row with no state yet (this device's own new issue) never shows one.
    expect(issueOf(mine("x", "requested"), true).triage).toBeUndefined()
    expect(listProps([proposed], { syncedAt: "x" }, undefined, true).issues[0]!.triage).toBe("proposed")
  })

  test("the issue's control: buttons for a Member, Run triage again only while the flow is on, its latest write's chip", () => {
    const item = { number: 3, triage: "not_accepted" }
    expect(triageControlOf(item, [], { triage: false, flowOn: false })).toEqual({
      shown: true,
      state: "not_accepted",
      pending: undefined,
      accept: false,
      reject: false,
      runAgain: false,
      disabled: false,
    })
    expect(triageControlOf({ number: 3, triage: "proposed" }, [], { triage: false, flowOn: false }).shown).toBe(false)
    expect(triageControlOf({ number: 3, triage: "proposed" }, [], { triage: false, flowOn: true }).shown).toBe(true)
    expect(triageControlOf({ number: 3, triage: "bogus" }, [], { triage: true, flowOn: false })).toMatchObject({
      shown: true,
      state: "proposed",
      accept: true,
      reject: true,
      runAgain: false,
    })
    expect(triageControlOf(item, [], { triage: true, flowOn: true }).runAgain).toBe(true)
    const writes = [
      { id: "w3", op: "issue/triage", number: 3, pending: "requested" },
      { id: "w2", op: "triage/run", number: 3, pending: "not_sent" },
      { id: "w9", op: "issue/triage", number: 9, pending: "not_sent" },
      { id: "e", op: "triage/enable", number: 0, pending: "requested" },
    ]
    expect(triageControlOf(item, writes, { triage: true, flowOn: true })).toMatchObject({ pending: "requested", disabled: true })
    expect(triageControlOf(item, writes.slice(1), { triage: true, flowOn: true })).toMatchObject({
      pending: "not_sent",
      disabled: false,
    })
    expect(triageControlOf({ number: 5, triage: "accepted" }, writes, { triage: true, flowOn: true }).pending).toBeUndefined()
  })

  test("the list's switch: Enable while off or paused, Pause while on, disabled while one is on its way", () => {
    expect(triageSwitchOf(undefined, [])).toEqual({ action: "enable", disabled: false })
    expect(triageSwitchOf({ paused: true }, [])).toEqual({ action: "enable", disabled: false })
    expect(triageSwitchOf({ paused: false }, [])).toEqual({ action: "pause", disabled: false })
    const writes = [{ id: "a", op: "triage/pause", number: 0, pending: "requested" }]
    expect(triageSwitchOf({ paused: false }, writes)).toEqual({ action: "pause", disabled: true })
    expect(triageSwitchOf({ paused: false }, [{ ...writes[0]!, pending: "not_sent" }]).disabled).toBe(false)
    expect(triageSwitchOf(undefined, [{ id: "b", op: "issue/triage", number: 1, pending: "requested" }]).disabled).toBe(false)
  })

  test("who triages: a Member and above; who enables: a Maintainer and above; on the deployment's own repository alone", () => {
    const roles = ["admin", "maintainer", "member", "guest", null] as const
    const signedIn = { status: "signed_in" as const, role: null }
    const on = (role: (typeof roles)[number], own = true) => ({ role, own })
    expect(roles.map((role) => mayTriage(signedIn, undefined, on(role)))).toEqual([true, true, true, false, false])
    expect(roles.map((role) => mayManageTriage(signedIn, undefined, on(role)))).toEqual([true, true, false, false, false])
    // Triage acts on the deployment's own repository until decision 0079's slice 2: nowhere else, whatever the role.
    expect(mayTriage(signedIn, undefined, on("admin", false))).toBe(false)
    expect(mayManageTriage(signedIn, undefined, on("admin", false))).toBe(false)
    expect(mayTriage({ status: "signed_out", role: null }, { role: "admin" }, on("admin"))).toBe(false)
    expect(mayManageTriage({ status: "signed_out", role: null }, { role: "admin" }, on("admin"))).toBe(false)
    // Offline after an answer, the session this device confirmed is still signed in.
    expect(mayManageTriage({ status: "unreachable", role: null }, { role: "maintainer" }, on("maintainer"))).toBe(true)
  })

  test("an unsynced repository never offers the triage switch even to a Maintainer", () => {
    const signedIn = { status: "signed_in" as const, role: null }
    const maintainer = { role: "maintainer" as const, own: true }
    expect(mayManageTriageOnList(signedIn, undefined, maintainer, undefined)).toBe(false)
    expect(mayManageTriageOnList(signedIn, undefined, maintainer, { syncedAt: "2026-10-23" })).toBe(true)
    expect(mayManageTriageOnList(signedIn, undefined, { role: "member", own: true }, { syncedAt: "2026-10-23" })).toBe(false)
  })
})


test("commitment chips reflect GitHub labels and preserve a conflict", () => {
  for (const [commitment, word] of [["now", "Now"], ["next", "Next"], ["later", "Later"], ["none", "Unscheduled"], ["conflict", "Commitment conflict"]]) {
    expect(issueOf({ ...synced, commitment }).labels).toEqual([word])
  }
  for (const commitment of [null, undefined, "wrong"]) expect(issueOf({ ...synced, commitment }).labels).toBeUndefined()
})


test("an item outside this deployment's sync settles without inventing absence", () => {
  for (const itemReady of [false, true]) {
    for (const syncedReady of [false, true]) {
      expect(pageOf(undefined, undefined, itemReady, syncedReady, { status: "elsewhere" })).toBe("unknown")
      expect(pageOf({ number: 1 }, undefined, itemReady, syncedReady, { status: "elsewhere" })).toBe("shown")
    }
  }
})


test("unavailable item transport settles or retains only a completely installed source", () => {
  for (const installed of [undefined, false, true]) {
    const access = installed === undefined ? { status: "unavailable" } : { status: "unavailable", installed }
    expect(pageOf(undefined, undefined, true, true, access)).toBe("unknown")
    expect(pageOf(undefined, { syncedAt: "x" }, true, true, access)).toBe(installed === true ? "missing" : "unknown")
  }
})


test("an applied empty summary is known even without a server sync marker", () => {
  expect(listProps([], undefined, { status: "allowed", installed: false }).unknown).toBe(true)
  expect(listProps([], undefined, { status: "allowed", installed: true }).unknown).toBe(false)
})


test("list availability explains a GitHub limit or a failed shape without claiming synchronization", () => {
  expect(listFailureOf(undefined)).toBeUndefined()
  expect(listFailureOf({ status: "allowed" })).toBeUndefined()
  expect(listFailureOf({ status: "unavailable" })).toBe("Issues unavailable")
  expect(listFailureOf({ status: "allowed" }, "unavailable")).toBe("Issues unavailable")
  expect(listFailureOf({ status: "unavailable" }, "rate_limited")).toBe("GitHub limit reached")
  expect(listFailureOf({ status: "allowed" }, undefined, { state: "failed", message: "GitHub limit reached" })).toBe("GitHub limit reached")
  expect(listFailureOf({ status: "allowed" }, undefined, { state: "failed", message: "Couldn't load" })).toBe("Issues unavailable")
  expect(listFailureOf({ status: "allowed" }, undefined, { state: "ready", message: null })).toBeUndefined()
  expect(listFailureOf({ status: "allowed" }, undefined, null)).toBeUndefined()
})
