import { findPin } from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Exit, Schema } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { expect, test } from "vitest"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import * as PinsShard from "./PinsShard.vibe"

const SHARD = Schema.decodeUnknownSync(ShardProtocol.ShardId)("person:person-1")
const OTHER_SHARD = Schema.decodeUnknownSync(ShardProtocol.ShardId)("person:person-2")
const STREAM = Schema.decodeUnknownSync(ShardProtocol.StreamId)("person:person-1")
const OTHER_STREAM = Schema.decodeUnknownSync(ShardProtocol.StreamId)("person:person-2")
const C1 = "11111111-1111-4111-8111-111111111111"
const C2 = "22222222-2222-4222-8222-222222222222"
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const run = <A, E>(program: Effect.Effect<A, E, Reactivity.Reactivity>) => Effect.runPromise(program.pipe(Effect.provide(Reactivity.layer)))

const submitReq = (
  id: string,
  payload: Schema.Json,
  epoch = 1,
  opts: {
    readonly shard?: ShardProtocol.ShardId
    readonly stream?: ShardProtocol.StreamId
    readonly origin?: string
  } = {},
): ShardProtocol.SubmitRequest => ({
  version: ShardProtocol.protocolVersion,
  shard: opts.shard ?? SHARD,
  epoch,
  command: { key: [opts.origin ?? "person:person-1/device-a", id], stream: opts.stream ?? STREAM, payload },
})

test("PinsShard sequences person-private pins, enforces LWW + fences + clock skew, survives hibernation and compaction", async () => {
  const db = openStorage(":memory:")
  // Wrap storage on a prototype (like real workerd DurableObjectStorage) to prove prototype-safe forwarding.
  const protoStorage = Object.create({
    get sql() {
      return db.storage.sql
    },
    transactionSync: <T>(closure: () => T) => db.storage.transactionSync(closure),
  }) as typeof db.storage

  await run(Effect.scoped(Effect.gen(function*() {
    const hub = yield* PinsShard.make(protoStorage, SHARD, "person-1", { now: () => 5_000, maxClockSkewMs: 60_000 })
    const head0 = yield* hub.head

    const set1 = {
      _tag: "SetPin" as const,
      conversationId: C1,
      personId: "person-1",
      messageId: M1,
      changedAt: "2026-11-27T10:00:00.000Z",
      atMs: 1000,
    }
    const r1 = yield* hub.submit(submitReq("pin-1", set1, head0.epoch))
    expect(r1._tag).toBe("Accepted")

    // Bare owner origin (without /device) is also accepted.
    const bare = yield* hub.submit(submitReq("pin-bare", { ...set1, conversationId: C2, atMs: 1100 }, head0.epoch, { origin: "person:person-1" }))
    expect(bare._tag).toBe("Accepted")

    // Exact duplicate key returns Duplicate without growing state.
    const dup = yield* hub.submit(submitReq("pin-1", set1, head0.epoch))
    expect(dup._tag).toBe("Duplicate")

    // Older and equal timestamps are refused by the pure LWW reducer (first-arrival-wins on ties).
    const stale = yield* hub.submit(submitReq("pin-old", { ...set1, messageId: M2, atMs: 500 }, head0.epoch))
    expect(stale).toMatchObject({ _tag: "Refused", reason: "stale_pin" })
    const equalTie = yield* hub.submit(submitReq("pin-tie", { ...set1, messageId: M2, atMs: 1000 }, head0.epoch, { origin: "person:person-1/device-b" }))
    expect(equalTie).toMatchObject({ _tag: "Refused", reason: "stale_pin" })

    // Wrong shard, wrong stream, spoofed origin, cross-person, uppercase UUID, future clock, and invalid payloads are refused before journaling.
    for (
      const bad of [
        submitReq("ws", set1, head0.epoch, { shard: OTHER_SHARD }),
        submitReq("wst", set1, head0.epoch, { stream: OTHER_STREAM }),
        submitReq("wo", set1, head0.epoch, { origin: "person:person-2/device-a" }),
        submitReq("ed", set1, head0.epoch, { origin: "person:person-1/" }),
        submitReq("pin-other", { ...set1, personId: "person-2" }, head0.epoch),
        submitReq("pin-upper", { ...set1, messageId: M1.toUpperCase() }, head0.epoch),
        submitReq("pin-future", { ...set1, atMs: 100_000 }, head0.epoch),
        submitReq("pin-bad", { _tag: "Nope" }, head0.epoch),
      ]
    ) {
      const exit = yield* Effect.exit(hub.submit(bad))
      expect(Exit.isFailure(exit)).toBe(true)
    }

    // Clear pin with a newer timestamp.
    const cleared = yield* hub.submit(submitReq("pin-clear", { ...set1, messageId: null, changedAt: "2026-11-27T10:01:00.000Z", atMs: 2000 }, head0.epoch))
    expect(cleared._tag).toBe("Accepted")
    const beforeHibernate = yield* hub.state
    expect(findPin(beforeHibernate.pins, C1)).toMatchObject({ messageId: null, atMs: 2000 })

    // Reopen before compaction (replays Entries delivery) with default options.
    const replayed = yield* PinsShard.make(protoStorage, SHARD, "person-1")
    const afterReplay = yield* replayed.state
    expect(afterReplay.hash).toBe(beforeHibernate.hash)

    // Compact and reopen on the same SQLite storage (replays Reset snapshot + post-compaction Entries).
    yield* replayed.compact
    const reopened = yield* PinsShard.make(protoStorage, SHARD, "person-1", { now: () => 5_000 })
    const afterReopen = yield* reopened.state
    expect(afterReopen.hash).toBe(beforeHibernate.hash)

    // Write after compaction to prove headSeq and state advance cleanly.
    const r2 = yield* reopened.submit(submitReq("pin-2", { ...set1, conversationId: C2, messageId: M2, atMs: 3000 }, head0.epoch))
    expect(r2._tag).toBe("Accepted")
    const finalState = yield* reopened.state
    expect(findPin(finalState.pins, C2)).toMatchObject({ messageId: M2, atMs: 3000 })
  })))
})

test("PinsShard backfill keys by id@atMs so newer retries win LWW, settles stale/conflicting rows as kept, and tracks checked", async () => {
  const db = openStorage(":memory:")
  await run(Effect.scoped(Effect.gen(function*() {
    const hub = yield* PinsShard.make(db.storage, SHARD, "person-1", { now: () => 10_000 })
    expect(yield* hub.backfill.checked).toBe(false)

    // Newer pin already written live.
    const head0 = yield* hub.head
    yield* hub.submit(submitReq("live-1", {
      _tag: "SetPin",
      conversationId: C1,
      personId: "person-1",
      messageId: M2,
      changedAt: "2026-11-27T12:00:00.000Z",
      atMs: 5000,
    }, head0.epoch))

    // Backfill batch:
    // 1) fresh C2 at 4000 -> applied
    // 2) stale C1 at 1000 -> kept (stale_pin)
    // 3) newer C2 at 4500 with SAME command.id -> gets distinct key bf-c2@4500 -> applied (wins LWW, not lost!)
    // 4) conflicting C2 at SAME 4500 with different messageId -> IdempotencyConflict -> kept
    const firstBatch = yield* hub.backfill.batch([
      {
        id: "bf-c2",
        payload: { _tag: "SetPin", conversationId: C2, personId: "person-1", messageId: M1, changedAt: "2026-11-27T11:00:00.000Z", atMs: 4000 },
      },
      {
        id: "bf-c1-old",
        payload: { _tag: "SetPin", conversationId: C1, personId: "person-1", messageId: M1, changedAt: "2026-11-27T10:00:00.000Z", atMs: 1000 },
      },
      {
        id: "bf-c2",
        payload: { _tag: "SetPin", conversationId: C2, personId: "person-1", messageId: M2, changedAt: "2026-11-27T11:30:00.000Z", atMs: 4500 },
      },
      {
        id: "bf-c2",
        payload: { _tag: "SetPin", conversationId: C2, personId: "person-1", messageId: M1, changedAt: "2026-11-27T11:30:00.000Z", atMs: 4500 },
      },
    ], false)
    expect(firstBatch).toEqual({ applied: 2, kept: 2, checked: false })
    expect(findPin((yield* hub.state).pins, C2)).toMatchObject({ messageId: M2, atMs: 4500 })

    // Invalid and wrong_person commands abort the batch with rejected metadata without marking checked.
    const badInvalid = yield* hub.backfill.batch([{ id: "bad-1", payload: { _tag: "Bad" } }], true)
    expect(badInvalid).toEqual({ applied: 0, kept: 0, checked: false, rejected: { index: 0, code: "invalid" } })

    const badPerson = yield* hub.backfill.batch([{
      id: "bad-2",
      payload: { _tag: "SetPin", conversationId: C2, personId: "person-2", messageId: M1, changedAt: "2026-11-27T11:00:00.000Z", atMs: 4000 },
    }], true)
    expect(badPerson).toEqual({ applied: 0, kept: 0, checked: false, rejected: { index: 0, code: "wrong_person" } })

    // Replaying an identical batch with done=true is idempotent and marks checked=true.
    const doneBatch = yield* hub.backfill.batch([{
      id: "bf-c2",
      payload: { _tag: "SetPin", conversationId: C2, personId: "person-1", messageId: M2, changedAt: "2026-11-27T11:30:00.000Z", atMs: 4500 },
    }], true)
    expect(doneBatch).toEqual({ applied: 1, kept: 0, checked: true })
    expect(yield* hub.backfill.checked).toBe(true)

    // Direct check() is idempotent.
    yield* hub.backfill.check
    expect(yield* hub.backfill.checked).toBe(true)
  })))
})

test("PinsShard.apply resets to emptyPins on null snapshot", () => {
  const result = PinsShard.apply(
    { entries: [] },
    {
      _tag: "Reset",
      snapshot: {
        position: { shard: SHARD, epoch: 1, seq: 0 },
        state: null,
      },
    },
  )
  expect(result).toEqual({ entries: [] })
})
