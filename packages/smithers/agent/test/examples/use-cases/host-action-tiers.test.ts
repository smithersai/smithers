import { describe, expect, it } from "@effect/vitest"
import { TestCommit } from "../../../examples/use-cases/bisect-guide.ts"
import { Execute } from "../../../examples/use-cases/branch-doctor.ts"
import { BuildTarget } from "../../../examples/use-cases/defending-code.ts"
import { Verify } from "../../../examples/use-cases/dependency-update.ts"
import { OpenPullRequest as DocSyncPullRequest } from "../../../examples/use-cases/doc-sync.ts"
import { OpenPullRequest as FixupPullRequest } from "../../../examples/use-cases/docs-fixup-bot.ts"
import { CreatePullRequest } from "../../../examples/use-cases/docs-patcher.ts"
import { RunCommand } from "../../../examples/use-cases/fail-only-report.ts"
import { RunTest } from "../../../examples/use-cases/failing-test-author.ts"
import { WriteBead, WriteConvoy, WriteMergeRequest } from "../../../examples/use-cases/gastown.ts"
import { ProposeRule, RatifyRule, RecordLessons } from "../../../examples/use-cases/incident-runbook-memory.ts"

// Issue #4947: these host actions change the workspace or the world, and an
// undeclared tier defaults to `sealed`, which lets the engine retry them as
// pure replays. People copy these declarations, so each one is pinned here.

/** The key a declaration derives for `payload`, whatever form it was declared in. */
const keyOf = (action: { readonly idempotencyKey?: unknown }, payload: unknown) =>
  typeof action.idempotencyKey === "function"
    ? (action.idempotencyKey as (payload: unknown) => unknown)(payload)
    : action.idempotencyKey

describe("use-case host action tiers", () => {
  it.each(
    [
      ["bisect-guide TestCommit", TestCommit],
      ["branch-doctor Execute", Execute],
      ["defending-code BuildTarget", BuildTarget],
      ["dependency-update Verify", Verify],
      ["fail-only-report RunCommand", RunCommand],
      ["failing-test-author RunTest", RunTest]
    ] as const
  )("%s changes the workspace, so it is compensable", (_, action) => {
    expect(action.tier).toBe("compensable")
  })

  it.each(
    [
      ["doc-sync OpenPullRequest", DocSyncPullRequest],
      ["docs-fixup-bot OpenPullRequest", FixupPullRequest],
      ["docs-patcher CreatePullRequest", CreatePullRequest],
      ["incident-runbook-memory RecordLessons", RecordLessons],
      ["incident-runbook-memory ProposeRule", ProposeRule]
    ] as const
  )("%s creates something new on every run, so it runs at most once", (_, action) => {
    expect(action.tier).toBe("irreversible")
    expect(action.idempotencyKey).toBeUndefined()
  })

  it("keys each tracker write by the row and the state it records", () => {
    for (const action of [WriteConvoy, WriteBead, WriteMergeRequest]) expect(action.tier).toBe("irreversible")
    expect(keyOf(WriteConvoy, { id: "hq-cv-1", status: "open" })).toEqual({ convoy: "hq-cv-1", status: "open" })
    expect(keyOf(WriteConvoy, { id: "hq-cv-1", status: "closed" })).toEqual({ convoy: "hq-cv-1", status: "closed" })
    expect(keyOf(WriteBead, { id: "gt-1", status: "hooked" })).toEqual({ bead: "gt-1", status: "hooked" })
    expect(keyOf(WriteMergeRequest, { id: "mr-1", phase: "merged" })).toEqual({ mergeRequest: "mr-1", phase: "merged" })
  })

  it("keys a ratification by the note it ratifies", () => {
    expect(RatifyRule.tier).toBe("irreversible")
    expect(keyOf(RatifyRule, { ruleNoteId: "note-7" })).toEqual({ ratify: "note-7" })
  })
})
