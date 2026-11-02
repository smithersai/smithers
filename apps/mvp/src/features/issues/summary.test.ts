import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Schema } from "effect"
import { expect, test, vi } from "vitest"
import { summaryQuery } from "./queries"
import { IssueView, ItemSummary, VIEW } from "./schema"

const local = <A extends { readonly id: string }>(schema: Schema.Codec<A>, initialData: ReadonlyArray<A> = []) =>
  Collection.local<A, string>({ id: crypto.randomUUID(), schema, getKey: (row) => row.id, initialData })
const repo = "github/octo/hello"

const summary = (number: number, title: string, kind: "issue" | "pull" = "issue"): ItemSummary => ({
  id: `${repo}#${number}`,
  repoId: repo,
  number,
  kind,
  title,
  state: "open",
  authorLogin: "maya",
  comments: 0,
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
  deletedAt: null,
  writeId: null,
  triage: "proposed",
  commitment: null,
})

// A cold issue page (e2e/issue-waterfall.spec.ts) waited for the issue's own shape, new to Electric for each issue, for
// its heading. The repository's summaries shape is warm and holds the title: the heading reads it with no body.
test("the routed issue's heading comes from the repository's summaries, before its own shape answers", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const view = yield* local(IssueView, [{ id: VIEW, owner: "octo", name: "hello", repoId: repo, number: 7, draftKey: "draft", submitting: false }])
    const items = yield* local(ItemSummary, [summary(6, "Another issue"), summary(7, "A pull request", "pull")])
    const query = yield* summaryQuery(view, items)
    yield* query.preload
    // Issue #7 isn't in the summaries yet; a pull request numbered 7 is no issue.
    expect(query.tanstack.toArray).toEqual([])
    yield* items.delete(`${repo}#7`)
    yield* items.insert(summary(7, "The routed issue"))
    yield* Effect.promise(() =>
      vi.waitFor(() =>
        expect(query.tanstack.toArray).toMatchObject([
          { number: 7, title: "The routed issue", state: "open", author: "maya", createdAt: "2026-10-20T10:00:00Z" },
        ]), { timeout: 1_000 })
    )
  }))))
