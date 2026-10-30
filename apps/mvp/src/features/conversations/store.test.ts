import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { Listed } from "./schema"
import { listQuery } from "./store"

const row = (conversationId: string, openedAt: string): Listed => ({
  conversationId, openedAt, repo: "octo/hello", branch: conversationId, archived: false,
})

const read = (rows: ReadonlyArray<Listed>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const list = yield* Collection.local({ id: "conversation-sort", schema: Listed, getKey: row => row.conversationId })
  for (const row of rows) yield* list.insert(row)
  const query = yield* listQuery(list)
  yield* query.preload
  return (yield* query.toArray).map(row => row.conversationId)
})))

test.each([false, true])("newer fractions precede whole seconds in either insertion order (%s)", async reverse => {
  const rows = [
    row("whole", "2026-01-01 00:00:00+00"),
    row("fraction", "2026-01-01 00:00:00.267+00"),
    row("next", "2026-01-01 00:00:01+00"),
  ]
  expect(await read(reverse ? rows.reverse() : rows)).toEqual(["next", "fraction", "whole"])
})

test("equal timestamps retain the conversation-id tie break", async () => {
  expect(await read([row("b", "2026-01-01 00:00:00+00"), row("a", "2026-01-01 00:00:00+00")])).toEqual(["a", "b"])
})
