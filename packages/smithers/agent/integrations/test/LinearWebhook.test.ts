import type { RawInbound } from "@smthrs/control/Channels"
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { computeHmacSha256Hex } from "../src/core/Signature.ts"
import * as Payload from "../src/linear/Payload.ts"
import {
  type ChannelOptions,
  correlations,
  decode,
  DEFAULT_TIMESTAMP_SKEW_MS,
  idempotencyKey,
  MAX_TIMESTAMP_SKEW_MS,
  names,
  timestampMs,
  verify
} from "../src/linear/Webhook.ts"

const SECRET = "linear-webhook-secret"
const NOW = 1_700_000_000_000

const raw = (body: unknown, headers: Record<string, string | undefined> = {}): RawInbound => {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return {
    body: new TextEncoder().encode(text),
    headers: { "linear-signature": computeHmacSha256Hex(text, SECRET), ...headers },
    idempotencyKey: "delivery-1"
  }
}

const issueUpdate = {
  action: "update",
  type: "Issue",
  data: { id: "issue-uuid", identifier: "ENG-123", team: { id: "team-eng-id", key: "ENG" } },
  webhookId: "hook-1",
  webhookTimestamp: NOW
}

describe("timestampMs", () => {
  it("reads milliseconds and promotes seconds", () => {
    expect(timestampMs(NOW)).toBe(NOW)
    expect(timestampMs(1_700_000_000)).toBe(1_700_000_000_000)
  })

  it("returns null for anything that is not a finite number", () => {
    expect(timestampMs("1700000000000")).toBeNull()
    expect(timestampMs(undefined)).toBeNull()
    expect(timestampMs(Number.NaN)).toBeNull()
  })
})

describe("verify", () => {
  it("accepts a fresh delivery signed with the right secret", () => {
    expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW })).toBe(true)
  })

  it("rejects a wrong secret, a stale timestamp, and a missing timestamp", () => {
    expect(verify(raw(issueUpdate), "other", { nowMs: NOW })).toBe(false)
    expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW + 120_000 })).toBe(false)
    expect(verify(raw({ ...issueUpdate, webhookTimestamp: undefined }), SECRET, { nowMs: NOW })).toBe(false)
  })

  it("accepts a delivery from the near future inside the window", () => {
    expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW - 30_000 })).toBe(true)
  })

  it("rejects a signed body that is not JSON", () => {
    expect(verify(raw("not json"), SECRET, { nowMs: NOW })).toBe(false)
  })
})

describe("names", () => {
  it("lowercases the entity and action, most specific first", () => {
    expect(names(issueUpdate)).toEqual(["integration:linear:issue.update", "integration:linear:issue"])
  })

  it("falls back to unknown for a delivery missing either field", () => {
    expect(names({})).toEqual(["integration:linear:unknown.unknown", "integration:linear:unknown"])
  })
})

describe("correlations", () => {
  it("orders identifier, team key, then null", () => {
    expect(correlations(issueUpdate)).toEqual(["ENG-123", "ENG", null])
  })

  it("reads a comment delivery's issue one level down", () => {
    expect(correlations({
      type: "Comment",
      data: { id: "c", issue: { identifier: "ENG-9", team: { key: "ENG" } } }
    })).toEqual(["ENG-9", "ENG", null])
  })

  it("drops duplicates and falls back to null", () => {
    expect(correlations({ data: { identifier: "ENG", team: { key: "ENG" } } })).toEqual(["ENG", null])
    expect(correlations({ data: {} })).toEqual([null])
  })
})

describe("decode", () => {
  it("names, correlates, and dedupes on the delivery header when present", () => {
    const event = decode(raw(issueUpdate, { "linear-delivery": "d-9" }), issueUpdate, "linear", NOW)
    expect(event).toEqual({
      source: "linear",
      eventName: "integration:linear:issue.update",
      correlationId: "ENG-123",
      payload: issueUpdate,
      dedupeKey: "d-9#integration:linear:issue.update#ENG-123",
      receivedAtMs: NOW
    })
  })

  it("falls back to a composite delivery identity", () => {
    const event = decode(raw(issueUpdate), issueUpdate, "linear", NOW)
    expect(event.dedupeKey).toBe(
      `hook-1:issue:update:issue-uuid:${NOW}#integration:linear:issue.update#ENG-123`
    )
  })

  it("marks an uncorrelated delivery with an empty subject", () => {
    const minimal = { action: "create", type: "Reaction", data: { id: "r" } }
    expect(decode(raw(minimal), minimal, "linear", NOW).dedupeKey)
      .toBe("-:reaction:create:r:-#integration:linear:reaction.create#")
  })

  it("takes the source id the channel was named with", () => {
    expect(decode(raw(issueUpdate), issueUpdate, "linear-secondary", NOW).source).toBe("linear-secondary")
  })
})

describe("payload schemas", () => {
  const decodeWith = <A>(schema: Schema.Schema<A>, value: unknown) =>
    Effect.runPromise(
      Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>)
    )

  it("passes unmodelled fields through", async () => {
    const exit = await decodeWith(Payload.IssueDelivery, { ...issueUpdate, brandNew: { field: 1 } })
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : undefined).toHaveProperty("brandNew")
  })

  it("accepts a comment delivery and any delivery", async () => {
    const comment = {
      action: "create",
      type: "Comment",
      data: { id: "c", body: "hi", issue: { id: "i", identifier: "ENG-1" } }
    }
    expect((await decodeWith(Payload.CommentDelivery, comment))._tag).toBe("Success")
    expect((await decodeWith(Payload.Delivery, comment))._tag).toBe("Success")
  })

  it("still rejects a modelled field of the wrong type", async () => {
    expect((await decodeWith(Payload.IssueDelivery, { ...issueUpdate, data: { id: 7 } }))._tag).toBe("Failure")
  })
})

describe("the replay window cannot be turned off by configuration", () => {
  // An unbounded skew disables exactly the check the module exists for, so it
  // is refused rather than honored: verification fails closed.
  it("refuses a skew that is not a usable window", () => {
    for (
      const maxTimestampSkewMs of [
        Number.POSITIVE_INFINITY,
        Number.NaN,
        -1,
        MAX_TIMESTAMP_SKEW_MS + 1
      ]
    ) {
      expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW, maxTimestampSkewMs })).toBe(false)
    }
    expect(verify(raw(issueUpdate), SECRET, { nowMs: Number.NaN })).toBe(false)
  })

  // The option documents a finite integer of milliseconds. A fractional window
  // is a configuration mistake, and honoring it would leave the doc and the
  // guard disagreeing about what the package accepts.
  it("refuses a fractional window, which the option's own type forbids", () => {
    for (const maxTimestampSkewMs of [0.5, 1.5, 59_999.5]) {
      expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW, maxTimestampSkewMs })).toBe(false)
    }
    expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW, maxTimestampSkewMs: 0 })).toBe(true)
  })

  it("still honors a window inside the bound", () => {
    expect(verify(raw(issueUpdate), SECRET, { nowMs: NOW + 120_000, maxTimestampSkewMs: 300_000 })).toBe(true)
  })

  // A caller that passes no clock gets the wall clock, which is the spelling
  // every production ingress uses: `nowMs` exists for the tests.
  it("reads the wall clock when the caller supplies no nowMs", () => {
    const now = Date.now()
    expect(verify(raw({ ...issueUpdate, webhookTimestamp: now }), SECRET)).toBe(true)
    expect(verify(raw({ ...issueUpdate, webhookTimestamp: now - DEFAULT_TIMESTAMP_SKEW_MS * 10 }), SECRET)).toBe(false)
  })

  it("derives the same delivery identity with and without the header", () => {
    const payload = issueUpdate
    const withoutHeader = { headers: {} }
    expect(idempotencyKey(withoutHeader, payload)).toBe(idempotencyKey(withoutHeader, payload))
    // The webhook id, type, action, entity, and timestamp are all in it.
    expect(idempotencyKey(withoutHeader, { ...payload, webhookId: "other" }))
      .not.toBe(idempotencyKey(withoutHeader, payload))
    expect(idempotencyKey(withoutHeader, {})).toBe("linear:-:unknown:unknown:-:-")
  })
})

// A fixed `nowMs` on a long-lived channel froze the replay-window clock, so
// every real delivery an hour later failed verification.
describe("channel options", () => {
  it("do not accept a frozen clock", () => {
    expectTypeOf<ChannelOptions>().not.toHaveProperty("nowMs")
    expectTypeOf<ChannelOptions>().toHaveProperty("maxTimestampSkewMs")
  })
})
