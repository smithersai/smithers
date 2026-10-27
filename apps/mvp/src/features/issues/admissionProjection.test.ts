import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Schema } from "effect"
import { expect, test, vi } from "vitest"
import { conversationQuery, listQuery, triagePendingQuery } from "./queries"
import { Comment, IssueView, ItemSummary, Requested, Sending, VIEW, WriteRow } from "./schema"

const local = <A extends { readonly id: string }>(schema: Schema.Codec<A>, initialData: ReadonlyArray<A> = []) =>
  Collection.local<A, string>({ id: crypto.randomUUID(), schema, getKey: row => row.id, initialData })
const repo = "github/octo/hello"

for (const op of ["issue/create", "issue/comment", "issue/triage"] as const) test(`${op}: a restored outbox receipt overrides only its stale pre-admission row`, () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const id = crypto.randomUUID()
    const row: Sending = { id, repo: "octo/hello", repoId: repo, op, title: "Title", body: "Body", number: op === "issue/create" ? 0 : 7, decision: "accept", queuedAt: 1, v: 3 }
    const view = yield* local(IssueView, [{ id: VIEW, owner: "octo", name: "hello", repoId: repo, number: op === "issue/create" ? null : 7, draftKey: "draft", submitting: false }])
    const requested = yield* local(Requested, [{ ...row, status: "not_sent", reason: null }])
    const sending = yield* local(Sending)
    const items = yield* local(ItemSummary)
    const comments = yield* local(Comment)
    const writes = yield* local(WriteRow)
    const query = op === "issue/create" ? yield* listQuery(view, items, requested, sending, writes)
      : op === "issue/comment" ? yield* conversationQuery(view, items, comments, requested, sending, writes)
      : yield* triagePendingQuery(view, requested, sending, writes)
    yield* query.preload
    const shows = (pending: string) => Effect.promise(() => vi.waitFor(() => {
      const mine = query.tanstack.toArray.filter(value => value.id === id)
      expect(mine).toHaveLength(1)
      expect(mine[0]!.pending).toBe(pending)
    }, { timeout: 1_000 }))
    yield* shows("not_sent")
    yield* sending.insert(row)
    yield* shows("requested")
    yield* requested.update(id, value => { value.reason = "forbidden" })
    yield* shows("not_sent")
    yield* requested.update(id, value => { value.status = "requested"; value.reason = null })
    yield* shows("requested")
    yield* writes.insert({ id, repoId: repo, op, status: "failed", failure: null, itemNumber: null, createdAt: "2026-10-27", settledAt: null, branchId: null })
    yield* shows("not_sent")
    yield* writes.delete(id)
    yield* requested.update(id, value => { value.status = "not_sent" })
    yield* sending.delete(id)
    yield* shows("not_sent")
  }))),
)
