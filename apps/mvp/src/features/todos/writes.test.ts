// A stack change's send keeps the route's answer on the device before it settles (src/features/todos/writes.ts): when
// the device can't store that record, the send is not settled, and the outbox sends it again, so a reload never finds a
// change that was taken or refused with no record of it. The store's failure is an injected faulty one: a SQLite file
// whose writes of rows fail, as a full disk fails them; everything else is real.
import { Collection, Outbox } from "@smthrs/effect-tanstack-db"
import { Cause, Effect, Exit, Layer } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { deviceRegistry } from "../../device/registry"
import { faultyPersistenceOn } from "../../test/deviceFixture"
import { type Requested, Requested as RequestedRow, type Sending } from "./schema"
import { keep } from "./writes"

const row: Sending = {
  id: "0b6e2c4f-7a1d-4e38-9c52-1f0d3a8b6e74",
  repo: "octo/hello",
  repoId: "github/octo/hello",
  op: "commit",
  title: "Add a line",
  prompt: "Add a line.",
  acceptance: [],
  number: 0,
  queuedAt: 1,
  v: 2,
}

/** Keeps `row` as Requested on a device whose store fails its writes when `failing`; answers how the send settles. */
const keepOn = (failing: boolean) => {
  const store = faultyPersistenceOn(join(tmpdir(), `mvp-todo-keep-${crypto.randomUUID()}.sqlite`), deviceRegistry)
  return Effect.runPromise(
    Effect.gen(function* () {
      const requested = yield* Collection.persisted<Requested, string>({
        id: "todo-requested",
        schema: RequestedRow,
        getKey: (kept) => kept.id,
        schemaVersion: 4,
      })
      yield* requested.preload
      if (failing) store.failWrites()
      return yield* Effect.exit(keep(requested, row, "requested", null, 4))
    }).pipe(Effect.provide(Layer.fresh(store.layer)), Effect.scoped),
  )
}

describe("a stack change's send", () => {
  test("settles once the device stored what the route answered", async () => {
    expect(Exit.isSuccess(await keepOn(false))).toBe(true)
  })

  test("is sent again when the device can't store it, rather than settling with no record", async () => {
    const exit = await keepOn(true)
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(Outbox.Retry)
  })
})
