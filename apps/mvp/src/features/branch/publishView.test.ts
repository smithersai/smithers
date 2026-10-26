// What the branch page shows of Publish, Update branch, Resync and Compare (src/features/branch/publishView.ts,
// docs/features/branch-publish.md#the-branch-page): every state's words and what shows, for each kind of person.
import { describe, expect, test } from "vitest"
import type { FilesRow } from "../pulls/schema"
import type { PublicationRow, PublishPress } from "./publishSchema"
import {
  type BranchWrite,
  compareCommitsOf,
  compareOf,
  comparesOf,
  conflictOf,
  latestOf,
  type PublishBar,
  publishBarOf,
} from "./publishView"

const BRANCH = "6b9f3e2a-1c4d-4e5f-8a7b-9c0d1e2f3a4b"
const BASE = "b".repeat(40)
const HEAD = "a".repeat(40)

const publication = (fields: Partial<PublicationRow> = {}): PublicationRow => ({
  branchId: BRANCH,
  repoId: "repo",
  githubRef: "try-1-0123456789ab",
  baseRef: "main",
  baseSha: BASE,
  headSha: HEAD,
  prNumber: 7,
  updateState: null,
  syncedSha: HEAD,
  syncState: "synced",
  syncConflicts: null,
  updatedAt: "2026-10-25 10:00:00+00",
  ...fields,
})

const press = (fields: Partial<PublishPress> = {}): PublishPress => ({
  branchId: BRANCH,
  form: false,
  publishing: false,
  publishWriteId: null,
  publishRefused: null,
  updating: false,
  updateWriteId: null,
  updateRefused: null,
  resyncing: false,
  resyncWriteId: null,
  resyncRefused: null,
  ...fields,
})

let second = 0
const write = (op: BranchWrite["op"], status: BranchWrite["status"], failure: BranchWrite["failure"] = null, id = crypto.randomUUID()): BranchWrite => ({
  id,
  op,
  status,
  failure,
  createdAt: `2026-10-25 10:00:${String(++second).padStart(2, "0")}+00`,
})

type Input = Parameters<typeof publishBarOf>[0]
const bar = (fields: Partial<Input> = {}): PublishBar =>
  publishBarOf({
    access: "owner",
    mode: "open",
    name: "try-1",
    publication: undefined,
    pullTitle: undefined,
    press: undefined,
    writes: [],
    ...fields,
  })

/** The header as a person reads it: the buttons, the link, the words, the form and the tab, in that order. */
const reads = (shown: PublishBar): ReadonlyArray<string> => [
  ...(shown.pull === undefined ? [] : [`#${shown.pull}`]),
  ...(shown.publishStatus === undefined ? [] : [shown.publishStatus]),
  ...(shown.publish ? [shown.publishBusy ? "[Publish]" : "Publish"] : []),
  ...(shown.updateStatus === undefined ? [] : [shown.updateStatus]),
  ...(shown.update ? [shown.updateBusy ? "[Update branch]" : "Update branch"] : []),
  ...(shown.resyncStatus === undefined ? [] : [shown.resyncStatus]),
  ...(shown.resync ? [shown.resyncBusy ? "[Resync]" : "Resync"] : []),
  ...(shown.form ? [`form: ${shown.formTitle}${shown.formDescription ? " + description" : ""}`] : []),
  ...(shown.compare ? ["Compare"] : []),
]

describe("before the branch is published", () => {
  test("its owner and an editor see Publish; a viewer, no access, and a locked branch see nothing", () => {
    expect(reads(bar())).toEqual(["Publish"])
    expect(reads(bar({ access: "edit" }))).toEqual(["Publish"])
    expect(reads(bar({ access: "view" }))).toEqual([])
    expect(reads(bar({ access: "none" }))).toEqual([])
    expect(reads(bar({ access: undefined, mode: null }))).toEqual([])
    expect(reads(bar({ mode: "locked" }))).toEqual([])
    expect(reads(bar({ mode: "restricted" }))).toEqual(["Publish"])
  })

  test("Publish opens the form in its place: the branch's name to start, with a description", () => {
    expect(reads(bar({ press: press({ form: true }) }))).toEqual(["form: try-1 + description"])
    // A viewer's stale form never shows.
    expect(reads(bar({ access: "view", press: press({ form: true }) }))).toEqual([])
  })

  test("Publishing… while the flow runs, until the write it answered syncs, and while it is pending; Publish waits", () => {
    expect(reads(bar({ press: press({ publishing: true, form: true }) }))).toEqual(["Publishing…", "[Publish]"])
    const sent = crypto.randomUUID()
    expect(reads(bar({ press: press({ publishWriteId: sent }) }))).toEqual(["Publishing…", "[Publish]"])
    expect(reads(bar({ press: press({ publishWriteId: sent }), writes: [write("branch/publish", "pending", null, sent)] })))
      .toEqual(["Publishing…", "[Publish]"])
    // Another device's or the agent's Publish of the person's.
    expect(reads(bar({ writes: [write("branch/publish", "pending")] }))).toEqual(["Publishing…", "[Publish]"])
    // Done, and the publication on its way.
    expect(reads(bar({ press: press({ publishWriteId: sent }), writes: [write("branch/publish", "done", null, sent)] })))
      .toEqual(["Publishing…", "[Publish]"])
  })

  test.each([
    ["empty_change", "No changes"],
    ["too_large", "Too large"],
    ["base_missing", "Base isn't on GitHub"],
    ["conflict", "Conflict"],
    ["merged", "Merged"],
    ["closed", "Closed"],
    ["not_allowed", "Not allowed"],
    ["sign_in_required", "Sign in"],
    ["not_found", "Couldn't publish"],
    ["unavailable", "Couldn't publish"],
    ["app_not_installed", "Couldn't publish"],
    ["invalid", "Couldn't publish"],
  ] as const)("a write refused or failed %s says %s, with Publish available again", (failure, words) => {
    expect(reads(bar({ writes: [write("branch/publish", "refused", failure)] }))).toEqual([words, "Publish"])
    expect(reads(bar({ writes: [write("branch/publish", "failed", failure)] }))).toEqual([words, "Publish"])
  })

  test.each([
    ["sign_in", "Sign in"],
    ["forbidden", "Not allowed"],
    ["not_found", "Couldn't publish"],
    ["invalid", "Couldn't publish"],
    ["not_configured", "Couldn't publish"],
    ["unavailable", "Couldn't publish"],
  ] as const)("a press its flow refused %s says %s, with Publish available again", (reason, words) => {
    expect(reads(bar({ press: press({ publishRefused: reason }) }))).toEqual([words, "Publish"])
  })

  test("a press refused because a Publish is already on its way defers to the writes: on its way, landed, or refused", () => {
    expect(reads(bar({ press: press({ publishRefused: "exists" }) }))).toEqual(["Publish"])
    expect(reads(bar({ press: press({ publishRefused: "exists" }), writes: [write("branch/publish", "done")] })))
      .toEqual(["Publishing…", "[Publish]"])
    expect(reads(bar({ press: press({ publishRefused: "exists" }), publication: publication(), writes: [write("branch/publish", "done")] })))
      .toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ press: press({ publishRefused: "exists" }), writes: [write("branch/publish", "refused", "too_large")] })))
      .toEqual(["Too large", "Publish"])
  })

  test("the latest write speaks: a refusal after an older failure, and this tab's refusal over an earlier write's", () => {
    const older = write("branch/publish", "failed", "unavailable")
    const newer = write("branch/publish", "refused", "empty_change")
    expect(reads(bar({ writes: [newer, older] }))).toEqual(["No changes", "Publish"])
    expect(reads(bar({ press: press({ publishRefused: "forbidden" }), writes: [newer] }))).toEqual(["Not allowed", "Publish"])
    // A pending write outranks this tab's refusal: the Publish is on its way.
    expect(reads(bar({ press: press({ publishRefused: "exists" }), writes: [write("branch/publish", "pending")] })))
      .toEqual(["Publishing…", "[Publish]"])
    // An Update's write says nothing about Publish.
    expect(reads(bar({ writes: [write("branch/update", "refused", "not_published")] }))).toEqual(["Publish"])
  })
})

describe("once the branch is published", () => {
  test("anyone who may view it gets the pull request's link and Compare; an editor also Publish and Update branch", () => {
    expect(reads(bar({ publication: publication() }))).toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ access: "edit", publication: publication() }))).toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ access: "view", publication: publication() }))).toEqual(["#7", "Compare"])
    expect(reads(bar({ mode: "locked", publication: publication() }))).toEqual(["#7", "Compare"])
    expect(reads(bar({ access: "none", publication: publication() }))).toEqual([])
    expect(reads(bar({ access: undefined, publication: publication() }))).toEqual([])
  })

  test("Publish again asks only for the commit's title: the pull request's, else the branch's name", () => {
    expect(reads(bar({ publication: publication(), pullTitle: "Add a line", press: press({ form: true }) })))
      .toEqual(["#7", "Update branch", "Resync", "form: Add a line", "Compare"])
    expect(reads(bar({ publication: publication(), press: press({ form: true }) })))
      .toEqual(["#7", "Update branch", "Resync", "form: try-1", "Compare"])
  })

  test("the first Publish done says nothing more; a later one on its way, or refused, says so", () => {
    const first = write("branch/publish", "done")
    expect(reads(bar({ publication: publication(), writes: [first] }))).toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ publication: publication(), writes: [first, write("branch/publish", "pending")] })))
      .toEqual(["#7", "Publishing…", "[Publish]", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ publication: publication(), writes: [first, write("branch/publish", "refused", "conflict")] })))
      .toEqual(["#7", "Conflict", "Publish", "Update branch", "Resync", "Compare"])
  })

  test("Updating… while the flow runs, until its write syncs, and while it is pending; Update branch waits", () => {
    const shown = publication()
    expect(reads(bar({ publication: shown, press: press({ updating: true }) })))
      .toEqual(["#7", "Publish", "Updating…", "[Update branch]", "Resync", "Compare"])
    const sent = crypto.randomUUID()
    expect(reads(bar({ publication: shown, press: press({ updateWriteId: sent }) })))
      .toEqual(["#7", "Publish", "Updating…", "[Update branch]", "Resync", "Compare"])
    expect(reads(bar({ publication: shown, writes: [write("branch/update", "pending")] })))
      .toEqual(["#7", "Publish", "Updating…", "[Update branch]", "Resync", "Compare"])
  })

  test("then how the last Update branch ended, by anyone: Up to date, Updated, Conflict, or nothing yet", () => {
    const done = write("branch/update", "done")
    expect(reads(bar({ publication: publication({ updateState: "up_to_date" }), writes: [done] })))
      .toEqual(["#7", "Publish", "Up to date", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ publication: publication({ updateState: "updated" }) })))
      .toEqual(["#7", "Publish", "Updated", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ publication: publication({ updateState: "conflict" }) })))
      .toEqual(["#7", "Publish", "Conflict", "Update branch", "Resync", "Compare"])
    // A viewer reads none of it.
    expect(reads(bar({ access: "view", publication: publication({ updateState: "conflict" }) }))).toEqual(["#7", "Compare"])
  })

  test.each([
    ["conflict", "Conflict"],
    ["merged", "Merged"],
    ["closed", "Closed"],
    ["not_allowed", "Not allowed"],
    ["sign_in_required", "Sign in"],
    ["head_moved", "Couldn't update"],
    ["not_mergeable", "Couldn't update"],
    ["unavailable", "Couldn't update"],
  ] as const)("an Update refused or failed %s says %s", (failure, words) => {
    expect(reads(bar({ publication: publication(), writes: [write("branch/update", "refused", failure)] })))
      .toEqual(["#7", "Publish", words, "Update branch", "Resync", "Compare"])
  })

  test.each([
    ["sign_in", "Sign in"],
    ["forbidden", "Not allowed"],
    ["not_found", "Couldn't update"],
    ["unavailable", "Couldn't update"],
  ] as const)("an Update press its flow refused %s says %s", (reason, words) => {
    expect(reads(bar({ publication: publication({ updateState: "updated" }), press: press({ updateRefused: reason }) })))
      .toEqual(["#7", "Publish", words, "Update branch", "Resync", "Compare"])
  })
})

describe("Resync, once the branch is published", () => {
  test("an editor sees Resync, nothing beside it while the working copy is at GitHub's head; a viewer sees neither", () => {
    expect(reads(bar({ publication: publication() }))).toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ access: "view", publication: publication() }))).toEqual(["#7", "Compare"])
    expect(reads(bar({ mode: "locked", publication: publication({ syncState: "conflict", syncConflicts: ["a"] }) })))
      .toEqual(["#7", "Compare"])
  })

  test("Behind while GitHub's head is one the working copy hasn't reached, a resync not run yet included", () => {
    expect(reads(bar({ publication: publication({ syncedSha: BASE }) })))
      .toEqual(["#7", "Publish", "Update branch", "Behind", "Resync", "Compare"])
    expect(reads(bar({ publication: publication({ syncedSha: null, syncState: null }) })))
      .toEqual(["#7", "Publish", "Update branch", "Behind", "Resync", "Compare"])
  })

  test("Resyncing… while the flow runs, until its write syncs, and while it is pending; Resync waits", () => {
    const shown = publication({ syncedSha: BASE })
    expect(reads(bar({ publication: shown, press: press({ resyncing: true }) })))
      .toEqual(["#7", "Publish", "Update branch", "Resyncing…", "[Resync]", "Compare"])
    const sent = crypto.randomUUID()
    expect(reads(bar({ publication: shown, press: press({ resyncWriteId: sent }) })))
      .toEqual(["#7", "Publish", "Update branch", "Resyncing…", "[Resync]", "Compare"])
    expect(reads(bar({ publication: shown, writes: [write("branch/resync", "pending")] })))
      .toEqual(["#7", "Publish", "Update branch", "Resyncing…", "[Resync]", "Compare"])
    // Settled: the publication says where the working copy is.
    expect(reads(bar({ publication: publication(), press: press({ resyncWriteId: sent }), writes: [write("branch/resync", "done", null, sent)] })))
      .toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
  })

  test("a conflict lists its files, after an Update branch's resync too, whoever pressed; it outranks Behind", () => {
    const conflicted = (paths: ReadonlyArray<string>) =>
      reads(bar({ publication: publication({ syncedSha: BASE, syncState: "conflict", syncConflicts: paths }) }))
    expect(conflicted(["README.md"])).toEqual(["#7", "Publish", "Update branch", "Conflict · README.md", "Resync", "Compare"])
    expect(conflicted(["a", "b", "c", "d", "e"])).toEqual(["#7", "Publish", "Update branch", "Conflict · a, b, c +2", "Resync", "Compare"])
    expect(conflicted([])).toEqual(["#7", "Publish", "Update branch", "Conflict", "Resync", "Compare"])
    expect(reads(bar({ publication: publication({ syncState: "conflict", syncConflicts: null }) })))
      .toEqual(["#7", "Publish", "Update branch", "Conflict", "Resync", "Compare"])
    expect(conflictOf(["a", "b", "c"])).toBe("Conflict · a, b, c")
  })

  test.each([
    ["sign_in", "Sign in"],
    ["forbidden", "Not allowed"],
    ["exists", "Couldn't resync"],
    ["unavailable", "Couldn't resync"],
  ] as const)("a Resync press its flow refused %s says %s", (reason, words) => {
    expect(reads(bar({ publication: publication(), press: press({ resyncRefused: reason }) })))
      .toEqual(["#7", "Publish", "Update branch", words, "Resync", "Compare"])
  })

  test("a Resync write refused says why until the publication moves; one refused for a conflict says nothing once synced", () => {
    const refused = { ...write("branch/resync", "refused", "not_found"), createdAt: "2026-10-25 11:00:00+00" }
    expect(reads(bar({ publication: publication(), writes: [refused] })))
      .toEqual(["#7", "Publish", "Update branch", "Couldn't resync", "Resync", "Compare"])
    expect(reads(bar({ publication: publication(), writes: [{ ...refused, failure: "sign_in_required" }] })))
      .toEqual(["#7", "Publish", "Update branch", "Sign in", "Resync", "Compare"])
    expect(reads(bar({ publication: publication(), writes: [{ ...refused, failure: "not_allowed" }] })))
      .toEqual(["#7", "Publish", "Update branch", "Not allowed", "Resync", "Compare"])
    // A resync since, after a Publish or an Update branch, moved the publication on.
    expect(reads(bar({ publication: publication({ updatedAt: "2026-10-25 12:00:00+00" }), writes: [refused] })))
      .toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
    expect(reads(bar({ publication: publication(), writes: [{ ...refused, failure: "conflict" }] })))
      .toEqual(["#7", "Publish", "Update branch", "Resync", "Compare"])
  })
})

describe("latestOf", () => {
  test("the newest write of the operation; the id breaks a tie; none when there is none", () => {
    const a = { ...write("branch/update", "done"), createdAt: "2026-10-25 10:00:00+00", id: "a" }
    const b = { ...a, id: "b" }
    const c = { ...write("branch/update", "done"), createdAt: "2026-10-25 09:00:00+00" }
    expect(latestOf([a, b, c], "branch/update")).toBe(b)
    expect(latestOf([b, a], "branch/update")).toBe(b)
    expect(latestOf([c, a], "branch/update")).toBe(a)
    expect(latestOf([a], "branch/publish")).toBeUndefined()
  })
})

describe("Compare", () => {
  const key = `${BASE}...${HEAD}`
  const row = (fields: Partial<FilesRow>): FilesRow => ({
    id: key,
    status: "ready",
    files: [],
    truncated: false,
    commits: [],
    commitsTruncated: false,
    ...fields,
  })
  const file = { filename: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }
  const commit = { sha: "c".repeat(40), headline: "Add a line", authorLogin: "maya", authoredAt: null }

  test("the tab shows to anyone who may view a published branch", () => {
    expect([comparesOf("owner", publication()), comparesOf("view", publication())]).toEqual([true, true])
    expect([comparesOf("none", publication()), comparesOf(undefined, publication()), comparesOf("owner", undefined)])
      .toEqual([false, false, false])
  })

  test("loading until the publication's base and head are read; another pair's comparison isn't this one", () => {
    expect(compareOf(undefined, [row({})])).toEqual({ kind: "loading" })
    expect(compareOf(publication(), [])).toEqual({ kind: "loading" })
    expect(compareOf(publication(), [row({ status: "loading" })])).toEqual({ kind: "loading" })
    expect(compareOf(publication({ headSha: "d".repeat(40) }), [row({ files: [file] })])).toEqual({ kind: "loading" })
  })

  test("Couldn't load when the read failed; No changes when they don't differ", () => {
    expect(compareOf(publication(), [row({ status: "failed" })])).toEqual({ kind: "failed", title: "Couldn't load" })
    expect(compareOf(publication(), [row({})])).toEqual({ kind: "empty", title: "No changes" })
  })

  test("the commits, each with its headline and author, then the files", () => {
    expect(compareOf(publication(), [row({ files: [file], commits: [commit, { ...commit, sha: "e".repeat(40), authorLogin: null }] })]))
      .toEqual({
        kind: "ready",
        commits: [
          { sha: "c".repeat(40), headline: "Add a line", author: "maya" },
          { sha: "e".repeat(40), headline: "Add a line", author: "" },
        ],
        files: [file],
      })
    // Files with no commits of their own still show.
    expect(compareOf(publication(), [row({ files: [file] })])).toEqual({ kind: "ready", commits: [], files: [file] })
    expect(compareCommitsOf([])).toEqual([])
  })
})
