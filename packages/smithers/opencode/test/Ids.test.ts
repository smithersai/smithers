import { describe, expect, it } from "vitest"
import * as Ids from "../src/Ids.ts"

describe("Ids", () => {
  it("mints ids with OpenCode's prefixes and a 26-character body", () => {
    for (const kind of ["session", "message", "part", "permission", "event"] as const) {
      const id = Ids.make(kind)
      expect(id.startsWith(`${Ids.prefixes[kind]}_`)).toBe(true)
      expect(id.length).toBe(Ids.prefixes[kind].length + 1 + 26)
      expect(Ids.isKind(kind, id)).toBe(true)
    }
    expect(Ids.isKind("session", Ids.make("message"))).toBe(false)
  })

  it("sorts ascending kinds in creation order, including within one millisecond", () => {
    const a = Ids.make("message", 1000)
    const b = Ids.make("message", 1000)
    const c = Ids.make("message", 1001)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it("sorts sessions newest first", () => {
    const older = Ids.make("session", 5000)
    const newer = Ids.make("session", 6000)
    expect(newer < older).toBe(true)
  })

  it("encodes the head like OpenCode: timestamp times 4096 plus the counter", () => {
    expect(Ids.head(1, false, 1)).toBe("000000001001")
    expect(Ids.head(1, true, 1)).toBe("ffffffffeffe")
  })

  it("derives part ids from the message and the key, sorted by frame, slot and ordinal", () => {
    const message = Ids.make("message", 7000)
    const first = Ids.part(message, { frame: 0, slot: 0, ordinal: 0 })
    const call = Ids.part(message, { frame: 0, slot: 0x10, ordinal: 2 })
    const later = Ids.part(message, { frame: 1, slot: 0, ordinal: 0 })
    expect(first).toBe(Ids.part(message, { frame: 0, slot: 0, ordinal: 0 }))
    expect(first < call && call < later).toBe(true)
    expect(first.length).toBe("prt_".length + 26)
    expect(first.startsWith("prt_")).toBe(true)
    const next = Ids.make("message", 8000)
    expect(later < Ids.part(next, { frame: 0, slot: 0, ordinal: 0 })).toBe(true)
  })

  it("pads a short message body so the key still sorts", () => {
    expect(Ids.part("msg_ab", { frame: 0, slot: 0, ordinal: 0 })).toBe(`prt_ab${"0".repeat(24)}`)
  })

  it("derives the answer's id from the prompt's, right after it", () => {
    const user = "msg_0000000000010000000000000u"
    const answer = Ids.reply(user)
    expect(answer).toBe("msg_0000000000010000000000000v")
    expect(answer > user).toBe(true)
    expect(Ids.reply(user)).toBe(answer)
    // The two share a time head, so the part id carries the tail too.
    const key = { frame: 0, slot: 0, ordinal: 0 }
    expect(Ids.part(user, key)).not.toBe(Ids.part(answer, key))
    expect(Ids.part(user, key)).toBe("prt_0000000000010000000000000u")
    expect(Ids.part(answer, key)).toBe("prt_0000000000010000000000000v")
    // A full tail carries; a tail with nothing left to add falls back to a fresh id.
    expect(Ids.reply("msg_000000000001000000000000zz")).toBe("msg_00000000000100000000000100")
    const fresh = Ids.reply("msg_000000000001zzzzzzzzzzzzzz")
    expect(Ids.isKind("message", fresh)).toBe(true)
    expect(fresh).not.toBe("msg_000000000001zzzzzzzzzzzzzz")
  })

  it("puts a steered prompt between the turn's prompt and the answer it is steered into", () => {
    const user = "msg_0000000000010000000000000u"
    const answer = Ids.reply(user)
    const first = Ids.steer(user, answer, 9000)
    const second = Ids.steer(user, answer, 9001)
    // A fresh id would sort after the answer, which was minted when the turn
    // opened; these sort between the prompt and the answer, in the order they
    // were sent.
    expect(Ids.make("message", 9000) > answer).toBe(true)
    expect(user < first).toBe(true)
    expect(first < second).toBe(true)
    expect(second < answer).toBe(true)
    expect(Ids.isKind("message", first)).toBe(true)
    // Two steers inside one millisecond still sort in order.
    expect(Ids.steer(user, answer, 9002) < Ids.steer(user, answer, 9002)).toBe(true)
  })

  it("falls back to a fresh id when nothing can be derived below the answer", () => {
    // A turn re-driven at boot whose assistant header names no prompt is
    // opened against a prompt id minted now, which is above the answer it
    // belongs to. Nothing derived from that prompt sorts below the answer, so
    // the steer takes a fresh id rather than one that sorts wrong.
    const user = "msg_0000000000090000000000000u"
    const answer = "msg_0000000000010000000000000v"
    const steered = Ids.steer(user, answer, 9100)
    expect(steered.startsWith(`msg_${user.slice("msg_".length)}`)).toBe(false)
    expect(Ids.isKind("message", steered)).toBe(true)
    expect(steered.length).toBe("msg_".length + 26)
  })
})
