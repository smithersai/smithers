import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { canonicalHash, decidePin, emptyPins, evolvePin, findPin, PinCommand, type Pins } from "../src/index.ts"

const C1 = "11111111-1111-4111-8111-111111111111"
const C2 = "22222222-2222-4222-8222-222222222222"
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const apply = (state: Pins, cmd: PinCommand, seq: number, owner?: string) => {
  const decision = decidePin(state, cmd, owner)
  if (decision._tag === "Refused") return { state, decision }
  const next = decision.events.reduce((acc, ev) => evolvePin(acc, ev, seq), state)
  return { state: next, decision }
}

describe("Pins reducer (ADR 0170 person-private shard)", () => {
  it("pins, updates, unpins, and enforces LWW monotonic atMs", () => {
    const first: PinCommand = {
      _tag: "SetPin",
      conversationId: C1,
      personId: "person-1",
      messageId: M1,
      changedAt: "2026-11-27T10:00:00.000Z",
      atMs: 1000
    }
    const r1 = apply(emptyPins, first, 1, "person-1")
    expect(r1.decision._tag).toBe("Accepted")
    expect(findPin(r1.state, C1)).toEqual({
      conversationId: C1,
      personId: "person-1",
      messageId: M1,
      changedAt: "2026-11-27T10:00:00.000Z",
      atMs: 1000,
      hubSeq: 1
    })

    // Exact replay at same timestamp is an idempotent zero-event accept.
    const replay = decidePin(r1.state, first, "person-1")
    expect(replay).toEqual({ _tag: "Accepted", events: [] })

    // Older write is refused as stale_pin.
    expect(decidePin(r1.state, { ...first, messageId: M2, atMs: 999 }, "person-1")).toEqual({
      _tag: "Refused",
      reason: "stale_pin"
    })

    // Conflicting write at equal timestamp is refused as stale_pin.
    expect(decidePin(r1.state, { ...first, messageId: M2, atMs: 1000 }, "person-1")).toEqual({
      _tag: "Refused",
      reason: "stale_pin"
    })
    expect(decidePin(r1.state, { ...first, changedAt: "2026-11-27T10:00:00.001Z", atMs: 1000 }, "person-1")).toEqual({
      _tag: "Refused",
      reason: "stale_pin"
    })

    // Newer unpin (messageId: null) advances state.
    const unpin: PinCommand = {
      _tag: "SetPin",
      conversationId: C1,
      personId: "person-1",
      messageId: null,
      changedAt: "2026-11-27T10:00:05.000Z",
      atMs: 5000
    }
    const r2 = apply(r1.state, unpin, 2, "person-1")
    expect(findPin(r2.state, C1)?.messageId).toBeNull()
    expect(findPin(r2.state, C1)?.hubSeq).toBe(2)
  })

  it("refuses cross-person writes with wrong_person", () => {
    const cmd: PinCommand = {
      _tag: "SetPin",
      conversationId: C1,
      personId: "person-2",
      messageId: M1,
      changedAt: "2026-11-27T10:00:00.000Z",
      atMs: 1000
    }
    expect(decidePin(emptyPins, cmd, "person-1")).toEqual({ _tag: "Refused", reason: "wrong_person" })
    // Without expectedPersonId bound, pure reducer allows any valid command.
    expect(decidePin(emptyPins, cmd)._tag).toBe("Accepted")
  })

  it("keeps canonical ordering and identical canonicalHash regardless of insertion order", () => {
    const cmd1: PinCommand = {
      _tag: "SetPin",
      conversationId: C1,
      personId: "person-1",
      messageId: M1,
      changedAt: "2026-11-27T10:00:00.000Z",
      atMs: 1000
    }
    const cmd2: PinCommand = {
      _tag: "SetPin",
      conversationId: C2,
      personId: "person-1",
      messageId: M2,
      changedAt: "2026-11-27T10:00:01.000Z",
      atMs: 2000
    }
    const ab = apply(apply(emptyPins, cmd1, 1).state, cmd2, 1).state
    const ba = apply(apply(emptyPins, cmd2, 1).state, cmd1, 1).state
    expect(ab.entries.map((e) => e.conversationId)).toEqual([C1, C2])
    expect(ba.entries.map((e) => e.conversationId)).toEqual([C1, C2])
    expect(canonicalHash(ab)).toBe(canonicalHash(ba))
    expect(findPin(ab, "33333333-3333-4333-8333-333333333333")).toBeUndefined()
  })

  it("validates lowercase UUIDs and rejects uppercase or malformed UUIDs via PinCommand schema", () => {
    const decode = Schema.decodeUnknownOption(PinCommand)
    expect(
      decode({
        _tag: "SetPin",
        conversationId: C1,
        personId: "person-1",
        messageId: M1,
        changedAt: "2026-11-27T10:00:00.000Z",
        atMs: 1000
      })._tag
    ).toBe("Some")
    expect(
      decode({
        _tag: "SetPin",
        conversationId: M1.toUpperCase(),
        personId: "person-1",
        messageId: M1,
        changedAt: "2026-11-27T10:00:00.000Z",
        atMs: 1000
      })._tag
    ).toBe("None")
    expect(
      decode({
        _tag: "SetPin",
        conversationId: "not-a-uuid",
        personId: "person-1",
        messageId: null,
        changedAt: "2026-11-27T10:00:00.000Z",
        atMs: 1000
      })._tag
    ).toBe("None")
  })
})
