import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { TextsClient } from "./features/coedit/api.vibe"
import { TEXT_UPDATE, TextWrites } from "./features/coedit/writes.vibe"
import { IssuesClient } from "./features/issues/api.vibe"
import { ISSUE_WRITE, IssueWrites } from "./features/issues/writes.vibe"
import { StackClient } from "./features/todos/api.vibe"
import { StackWrites, TODO_OP } from "./features/todos/writes.vibe"
import { OutboxWrites } from "./outbox"

// How features hand their writes to the device's one outbox (src/outbox.ts): a second feature adds its own to the
// writes a layer below handed over, and the first feature's names stay as they were. The outbox sending them is tested
// through each feature's real writes (src/features/issues, src/features/todos).

const mutation = () => Effect.void as never

describe("OutboxWrites.adding", () => {
  test("with nothing below, the writes are the feature's own", () => {
    const writes = { collections: {}, mutations: { mine: mutation } }
    expect(Effect.runSync(OutboxWrites.adding(writes)).mutations).toEqual({ mine: mutation })
  })

  test("adds to the writes below, which keep their names", () => {
    const below = OutboxWrites.of({ collections: {}, mutations: { first: mutation, shared: mutation } })
    const theirs = () => Effect.never as never
    const added = Effect.runSync(
      OutboxWrites.adding({ collections: {}, mutations: { second: mutation, shared: theirs } }).pipe(
        Effect.provideService(OutboxWrites, below),
      ),
    )
    expect(Object.keys(added.mutations).sort()).toEqual(["first", "second", "shared"])
    expect(added.mutations.shared).toBe(mutation)
  })
})

describe("the device's writes", () => {
  // As src/boot.ts stacks them below chat's store: co-editing's, then the issues', then the TODOs'. A feature that hands
  // over its writes in place of the ones below drops theirs, and the outbox then fails every stored write of theirs as
  // an unknown mutation (2026-10-20: the issues' writes dropped co-editing's `text-update`).
  test("every feature's mutation reaches the one outbox, whatever its place in the stack", async () => {
    const clients = { origin: "http://localhost", within: "1 second" } as const
    const writes = StackWrites.layer.pipe(
      Layer.provideMerge(IssueWrites.layer),
      Layer.provideMerge(TextWrites.layer),
      Layer.provide(
        Layer.mergeAll(TextsClient.layer(clients), IssuesClient.layer(clients), StackClient.layer(clients)).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Layer.provide(Persistence.memory),
    )
    const mutations = await Effect.runPromise(
      Effect.gen(function* () {
        const handed = yield* OutboxWrites
        return Object.keys(handed.mutations)
      }).pipe(Effect.provide(writes)),
    )
    expect(mutations.sort()).toEqual([ISSUE_WRITE, TEXT_UPDATE, TODO_OP].sort())
  })
})
