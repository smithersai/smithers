/**
 * The presence wire protocol: frames round-trip, limits are UTF-8 bytes, and
 * a decoder answers `undefined` for anything the protocol does not define.
 */
import { describe, expect, it } from "@effect/vitest"
import * as PresenceProtocol from "../src/PresenceProtocol.vibe"

const participant = (id: string, state: string | null = null): PresenceProtocol.Participant => ({
  id,
  principal: `github:${id}`,
  name: `login-${id}`,
  access: "write",
  state
})

describe("PresenceProtocol", () => {
  it("round-trips a page's state frame, null included", () => {
    for (const state of ["{\"path\":\"src/a.ts\",\"line\":3}", null, ""]) {
      const text = PresenceProtocol.encodeClientFrame({ type: "state", state })
      expect(PresenceProtocol.decodeClientFrame(text)).toEqual({ type: "state", state })
    }
  })

  it("encodes the frames as the wire's literal JSON", () => {
    expect(PresenceProtocol.encodeClientFrame({ type: "state", state: "x" })).toBe(
      "{\"type\":\"state\",\"state\":\"x\"}"
    )
    const extra = { ...participant("a"), secret: "host-only" } as PresenceProtocol.Participant
    expect(PresenceProtocol.encodeServerFrame({ type: "roster", self: "a", participants: [extra] })).toBe(
      "{\"type\":\"roster\",\"self\":\"a\",\"participants\":[{\"id\":\"a\",\"principal\":\"github:a\",\"name\":\"login-a\",\"access\":\"write\",\"state\":null}]}"
    )
  })

  it("round-trips a roster in order, with self", () => {
    const frame: PresenceProtocol.ServerFrame = {
      type: "roster",
      self: "b",
      participants: [participant("a", "here"), { ...participant("b"), access: "read" }]
    }
    expect(PresenceProtocol.decodeServerFrame(PresenceProtocol.encodeServerFrame(frame))).toEqual(frame)
  })

  it("caps a state at 1024 bytes of UTF-8, not 1024 characters", () => {
    const encode = (state: string) => PresenceProtocol.encodeClientFrame({ type: "state", state })
    expect(PresenceProtocol.decodeClientFrame(encode("x".repeat(1024)))?.state).toHaveLength(1024)
    expect(PresenceProtocol.decodeClientFrame(encode("x".repeat(1025)))).toBeUndefined()
    // 341 three-byte characters are 1023 bytes; one more is 1026.
    expect(PresenceProtocol.decodeClientFrame(encode("€".repeat(341)))).toBeDefined()
    expect(PresenceProtocol.decodeClientFrame(encode("€".repeat(342)))).toBeUndefined()
  })

  it("refuses a frame over 2048 bytes of UTF-8 before parsing it", () => {
    const padded = (pad: string) => `{"type":"state","state":null,"pad":"${pad}"}`
    const base = padded("").length
    expect(PresenceProtocol.decodeClientFrame(padded("x".repeat(2048 - base)))).toEqual({ type: "state", state: null })
    expect(PresenceProtocol.decodeClientFrame(padded("x".repeat(2049 - base)))).toBeUndefined()
    // Under 2048 characters, over 2048 bytes.
    expect(PresenceProtocol.decodeClientFrame(padded("é".repeat(1100)))).toBeUndefined()
  })

  it.each([
    ["malformed JSON", "{\"type\":\"state\""],
    ["not an object", "\"state\""],
    ["another type", "{\"type\":\"roster\",\"state\":null}"],
    ["a missing state", "{\"type\":\"state\"}"],
    ["a non-string state", "{\"type\":\"state\",\"state\":3}"]
  ])("refuses a page's frame with %s", (_, text) => {
    expect(PresenceProtocol.decodeClientFrame(text)).toBeUndefined()
  })

  it("refuses a roster that is malformed, too long, or carries an oversized state or unknown access", () => {
    const encode = (participants: ReadonlyArray<PresenceProtocol.Participant>) =>
      PresenceProtocol.encodeServerFrame({ type: "roster", self: "a", participants })
    const full = Array.from({ length: PresenceProtocol.maxParticipants }, (_, index) => participant(`p${index}`))
    expect(PresenceProtocol.decodeServerFrame(encode(full))?.participants).toHaveLength(256)
    expect(PresenceProtocol.decodeServerFrame(encode([...full, participant("extra")]))).toBeUndefined()
    expect(PresenceProtocol.decodeServerFrame(encode([participant("a", "x".repeat(1025))]))).toBeUndefined()
    expect(
      PresenceProtocol.decodeServerFrame(encode([{ ...participant("a"), access: "admin" as PresenceProtocol.Access }]))
    ).toBeUndefined()
    expect(PresenceProtocol.decodeServerFrame("{\"type\":\"roster\",\"self\":\"a\"}")).toBeUndefined()
    expect(PresenceProtocol.decodeServerFrame("not json")).toBeUndefined()
    expect(PresenceProtocol.decodeServerFrame(PresenceProtocol.encodeClientFrame({ type: "state", state: null })))
      .toBeUndefined()
  })

  it("says which closes are final", () => {
    const { CloseCode, isFinal } = PresenceProtocol
    expect([CloseCode.left, CloseCode.unsupported, CloseCode.noAccess, CloseCode.tooBig].map(isFinal)).toEqual([
      true,
      true,
      true,
      true
    ])
    expect([CloseCode.changed, CloseCode.full, 1006, 1011].map(isFinal)).toEqual([false, false, false, false])
  })

  it("backs off from 1 s, doubling to 30 s, for ten attempts", () => {
    expect(Array.from({ length: 12 }, (_, index) => PresenceProtocol.reconnectDelay(index))).toEqual([
      undefined,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000,
      30_000,
      30_000,
      undefined
    ])
  })
})
