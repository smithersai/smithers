import { ShapeSource } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Option } from "effect"
import { expect, test } from "vitest"
import { PULL_RECEIPT_HEADER } from "./contract"
import { refreshingSource } from "./refresh"
import { PullsView, VIEW } from "./schema"

// Faulty sources probe corrupt/misdirected/late server receipts. The happy path uses ChatApi and Electric in PullsApi.test.
test("a bad or late per-PR receipt cannot change the routed absence state", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const view = yield* Collection.local({ id: "pull-receipt-faults", schema: PullsView, getKey: (row) => row.id,
    initialData: [{ id: VIEW, owner: "acme", name: "widgets", repoId: "repo", number: 42, tab: "conversation" as const,
      merging: false, mergeWriteId: null, mergeRefused: null, reviewing: false, reviewNotice: null, installed: true, pullStatus: "allowed" as const }],
  })
  const value = JSON.stringify({ number: 42, checkedAt: 100, missing: true })
  for (const [status, header, move] of [
    [503, value, ""], [200, "bad-json", ""], [200, JSON.stringify({ number: 9, checkedAt: 100, missing: true }), ""],
    [200, value, "repo"], [200, value, "number"], [200, value, "time"],
  ] as const) {
    yield* view.update(VIEW, (row) => { row.repoId = "repo"; row.number = 42; row.pullAbsent = false; row.pullCheckedAt = 0 })
    const source: ShapeSource.Source = { request: () => Effect.gen(function* () {
      yield* view.update(VIEW, (row) => {
        if (move === "repo") row.repoId = "other"
        if (move === "number") row.number = 9
        if (move === "time") row.pullCheckedAt = 101
      }).pipe(Effect.orDie)
      return new Response(null, { status, headers: { [PULL_RECEIPT_HEADER]: header } })
    }) }
    yield* refreshingSource(source, view, "repo").request("http://app.test/api/shapes/reviews", {})
    expect(Option.getOrThrow(yield* view.get(VIEW)).pullAbsent).toBe(false)
  }
}))))
