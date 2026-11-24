/** Transcript events: what a runner may send of an agent's session, scrubbed and bounded before it leaves. */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as AgentRunner from "../src/AgentRunner.ts"
import * as Transcript from "../src/Transcript.ts"

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const shapes = () => Transcript.scrubber()
/** Whether `text` has no lone surrogate: UTF-8 encoding it loses nothing. */
const wellFormed = (text: string) => !/\p{Surrogate}/u.test(text)

describe("Transcript", () => {
  it("scrubs known values longest first, then credential shapes", () => {
    const scrub = Transcript.scrubber(["abc", "secret-value", "secret-value-long"])
    expect(scrub("x secret-value-long y secret-value abc")).toBe(
      `x ${Transcript.REDACTED} y ${Transcript.REDACTED} abc`
    )
    for (
      const shape of [
        "sk-abcdefgh1234",
        "sess-abcdefgh1234",
        "Bearer abc.def",
        "Basic dXNlcjpwYXNzd29yZA==",
        "ghp_abcdefgh1234",
        "gho_abcdefgh1234",
        "ghu_abcdefgh1234",
        "ghs_abcdefgh1234",
        "ghr_abcdefgh1234",
        "github_pat_abcdefgh1234",
        "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
        "a.person@example.org"
      ]
    ) {
      expect(scrub(`before ${shape} after`)).toBe(`before ${Transcript.REDACTED} after`)
    }
  })

  it("scrubs every string of an update at any depth, and leaves the rest", () => {
    const [event] = Transcript.prepare("tool_call", {
      sessionUpdate: "tool_call",
      title: "curl -H 'Bearer abc.def'",
      rawInput: { command: ["echo", "me@example.org"], timeout: 30, ok: true, none: null }
    }, Transcript.scrubber(["hunter22"]))
    expect(event).toEqual({
      kind: "tool_call",
      update: {
        sessionUpdate: "tool_call",
        title: `curl -H '${Transcript.REDACTED}'`,
        rawInput: { command: ["echo", Transcript.REDACTED], timeout: 30, ok: true, none: null }
      }
    })
  })

  it("drops an agent's slash commands and configuration options", () => {
    expect(Transcript.prepare("available_commands_update", { availableCommands: [] }, shapes())).toEqual([])
    expect(Transcript.prepare("config_option_update", { configOptions: [] }, shapes())).toEqual([])
  })

  it("splits a long message into chunks of the same message, each within the bound", () => {
    const text = "é".repeat(40_000)
    const events = Transcript.prepare("agent_message_chunk", {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text }
    }, shapes())
    expect(events.length).toBeGreaterThan(1)
    for (const event of events) {
      expect(size(event.update)).toBeLessThanOrEqual(Transcript.MAX_EVENT_BYTES)
      expect(event.update.messageId).toBe("m1")
    }
    expect(events.map((event) => (event.update.content as { text: string }).text).join("")).toBe(text)
  })

  it.each(["😀", "\u{10000}", "\u{10ffff}"])("keeps %s whole when splitting a message", (character) => {
    const text = "a" + character.repeat(5000)
    const events = Transcript.prepare("agent_message_chunk", {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text }
    }, shapes())
    expect(events.length).toBeGreaterThan(1)
    const chunks = events.map((event) => (event.update.content as { text: string }).text)
    for (const chunk of chunks) expect(wellFormed(chunk)).toBe(true)
    for (const event of events) expect(size(event.update)).toBeLessThanOrEqual(Transcript.MAX_EVENT_BYTES)
    expect(chunks.join("")).toBe(text)
    expect(chunks.map((chunk) => new TextDecoder().decode(new TextEncoder().encode(chunk))).join("")).toBe(text)
  })

  it("cuts the long strings of any other update to fit, marking each cut", () => {
    const [event] = Transcript.prepare("tool_call_update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      rawOutput: { stdout: "x".repeat(100_000), stderr: "short" }
    }, shapes())
    expect(size(event!.update)).toBeLessThanOrEqual(Transcript.MAX_EVENT_BYTES)
    const output = event!.update.rawOutput as { stdout: string; stderr: string }
    expect(output.stdout.endsWith(Transcript.CUT)).toBe(true)
    expect(output.stderr).toBe("short")
    expect(event!.update.toolCallId).toBe("t1")
  })

  it.each(["😀", "\u{10000}", "\u{10ffff}"])("keeps %s whole when cutting a string", (character) => {
    const text = "a" + character.repeat(20_000)
    const [event] = Transcript.prepare("tool_call_update", {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      rawOutput: { stdout: text }
    }, shapes())
    expect(size(event!.update)).toBeLessThanOrEqual(Transcript.MAX_EVENT_BYTES)
    const { stdout } = event!.update.rawOutput as { stdout: string }
    expect(stdout.endsWith(Transcript.CUT)).toBe(true)
    expect(wellFormed(stdout)).toBe(true)
    expect(stdout.length).toBeGreaterThan(Transcript.CUT.length)
    expect(text.startsWith(stdout.slice(0, -Transcript.CUT.length))).toBe(true)
  })

  it("replaces an update that no cut can bound with a marker", () => {
    const wide = Object.fromEntries(Array.from({ length: 3000 }, (_, n) => [`field${n}`, "value"]))
    expect(Transcript.prepare("plan", wide, shapes())).toEqual([{ kind: "plan", update: { cut: true } }])
  })

  it("a long message whose other fields are already large is cut instead of split", () => {
    const [event, more] = Transcript.prepare("agent_message_chunk", {
      sessionUpdate: "agent_message_chunk",
      _meta: { note: "m".repeat(9000) },
      content: { type: "text", text: "t".repeat(20_000) }
    }, shapes())
    expect(more).toBeUndefined()
    expect(size(event!.update)).toBeLessThanOrEqual(Transcript.MAX_EVENT_BYTES)
  })

  describe("regression R1-Fable-D2-045: a secret written across chunks", () => {
    const chunk = (text: string, messageId = "m1") => ({
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text }
    })
    const textsOf = (events: ReadonlyArray<{ readonly update: Record<string, unknown> }>) =>
      events.map((event) => (event.update.content as { text: string }).text)
    /** `text` as two chunks parted at `at`, then the end of the turn: the message as it left. */
    const parted = (text: string, at: number, secrets: ReadonlyArray<string> = []) => {
      const scrub = Transcript.streamScrubber(secrets)
      const events = [
        ...Transcript.prepare("agent_message_chunk", chunk(text.slice(0, at)), scrub),
        ...Transcript.prepare("agent_message_chunk", chunk(text.slice(at)), scrub),
        ...Transcript.prepare(Transcript.KINDS.turn, { stopReason: "end_turn" }, scrub)
      ]
      expect(events.at(-1)).toEqual({ kind: Transcript.KINDS.turn, update: { stopReason: "end_turn" } })
      return textsOf(events.slice(0, -1)).join("")
    }

    it.each(["hunter2-token-value", "pass word 12", "a b"])(
      "scrubs the known value %j parted at every offset",
      (secret) => {
        const text = `before ${secret} after`
        const expected = secret.length >= 4 ? `before ${Transcript.REDACTED} after` : text
        for (let at = 0; at <= text.length; at++) expect(parted(text, at, [secret, "pass phrase"])).toBe(expected)
      }
    )

    it.each([
      "sk-abcdefgh1234",
      "sess-abcdefgh1234",
      "Bearer abc.def",
      "Basic dXNlcjpwYXNzd29yZA==",
      "ghp_abcdefgh1234",
      "github_pat_abcdefgh1234",
      "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      "a.person@example.org"
    ])("scrubs the credential shape %j parted at every offset", (shape) => {
      const text = `before ${shape} after`
      for (let at = 0; at <= text.length; at++) expect(parted(text, at)).toBe(`before ${Transcript.REDACTED} after`)
    })

    it("holds an open ending for the next chunk, and sends it before the next message or update", () => {
      const scrub = Transcript.streamScrubber()
      // Nothing may leave yet: the whole chunk could be the start of a credential.
      expect(Transcript.prepare("agent_message_chunk", chunk("hello"), scrub)).toEqual([])
      expect(Transcript.prepare("agent_message_chunk", chunk(" wor"), scrub)).toEqual([
        { kind: "agent_message_chunk", update: chunk("hello ") }
      ])
      // A dropped kind is not the session's work and ends nothing.
      expect(Transcript.prepare("available_commands_update", { availableCommands: [] }, scrub)).toEqual([])
      // Another message: the first one's held ending leaves first, as a chunk of the first.
      expect(Transcript.prepare("agent_message_chunk", chunk("next. ", "m2"), scrub)).toEqual([
        { kind: "agent_message_chunk", update: chunk("wor") },
        { kind: "agent_message_chunk", update: chunk("next. ", "m2") }
      ])
      // Nothing is held now, so an update that is no chunk is sent alone.
      expect(Transcript.prepare("plan", { entries: [] }, scrub)).toEqual([{ kind: "plan", update: { entries: [] } }])
      // A chunk with no message id is told apart by its kind; an image is no text chunk and ends the message.
      const thought = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "sk-abcdefgh" } }
      expect(Transcript.prepare("agent_thought_chunk", thought, scrub)).toEqual([])
      expect(Transcript.prepare("agent_message_chunk", { content: { type: "image", data: "" } }, scrub)).toEqual([
        { kind: "agent_thought_chunk", update: { ...thought, content: { type: "text", text: Transcript.REDACTED } } },
        { kind: "agent_message_chunk", update: { content: { type: "image", data: "" } } }
      ])
      expect(Transcript.prepare("agent_message_chunk", { content: null }, scrub)).toEqual([
        { kind: "agent_message_chunk", update: { content: null } }
      ])
      // Called as a function it scrubs one whole string, holding nothing.
      expect(scrub("a sk-abcdefgh1234 b")).toBe(`a ${Transcript.REDACTED} b`)
      expect(scrub.end()).toEqual([])
    })

    it("drops the rest of a credential longer than it holds, and keeps a long word that is none", () => {
      const send = (texts: ReadonlyArray<string>) => {
        const scrub = Transcript.streamScrubber()
        return textsOf([
          ...texts.flatMap((text) => Transcript.prepare("agent_message_chunk", chunk(text), scrub)),
          ...Transcript.prepare(Transcript.KINDS.turn, {}, scrub).slice(0, -1)
        ]).join("")
      }
      const long = "a".repeat(3000)
      expect(send([`key sk-${long}`, long, long, `${long} done`])).toBe(`key ${Transcript.REDACTED} done`)
      expect(send([`word ${long}`, long, long, `${long} done`])).toBe(`word ${long.repeat(4)} done`)
      expect(Transcript.MAX_HELD).toBe(4096)
    })

    it("cuts a long string before scrubbing it, dropping an ending a secret could be open in", () => {
      // 3 + 13 * 1260 = 16383 characters, so the bound falls inside the next value: after `pass wo`.
      const stdout = "ab;" + "pass word 12;".repeat(1300)
      for (const scrub of [Transcript.scrubber(["pass word 12"]), Transcript.streamScrubber(["pass word 12"])]) {
        const [event] = Transcript.prepare("tool_call_update", { rawOutput: { stdout } }, scrub)
        expect((event!.update.rawOutput as { stdout: string }).stdout).toBe(
          `ab;${`${Transcript.REDACTED};`.repeat(1260)}${Transcript.CUT}`
        )
      }
      // A scrubber that is only a function can't say where its own values open: the last credential run goes.
      const [plain] = Transcript.prepare(
        "tool_call_update",
        { title: `${"é".repeat(16_380)}sk-abcdefgh` },
        (text) => text.replaceAll("é", "")
      )
      expect(plain!.update.title).toBe(Transcript.CUT)
      // The fields around a message's text are bounded the same way; its text is split, never cut.
      const [first, ...more] = Transcript.prepare("agent_message_chunk", {
        _meta: { note: `${"é".repeat(16_380)}sk-abcdefgh` },
        content: { type: "text", text: "hi there " }
      }, (text) => text.replaceAll("é", ""))
      expect(more).toEqual([])
      expect(first!.update).toEqual({ _meta: { note: Transcript.CUT }, content: { type: "text", text: "hi there " } })
    })

    it("reads a long dotted string with no address in it once", () => {
      const dotted = "a.".repeat(1_000_000)
      expect(Transcript.scrubber()(dotted)).toBe(dotted)
      expect(Transcript.scrubber()(`..a.person@example.org ${dotted}`)).toBe(`${Transcript.REDACTED} ${dotted}`)
    })
  })

  it("numbers events from 0, names kinds plainly, and answers the next seq the host lacks", () => {
    const is = (schema: Schema.Top) => Schema.is(schema as never) as (value: unknown) => boolean
    const event = { seq: 0, at: 1, kind: "agent_message_chunk", update: { sessionUpdate: "agent_message_chunk" } }
    expect(is(Transcript.Event)(event)).toBe(true)
    expect(is(Transcript.Event)({ ...event, kind: Transcript.KINDS.turn })).toBe(true)
    expect(is(Transcript.Event)({ ...event, seq: -1 })).toBe(false)
    expect(is(Transcript.Event)({ ...event, kind: "has space" })).toBe(false)
    expect(is(Transcript.Event)({ ...event, update: "text" })).toBe(false)
    expect(is(Transcript.EventsRequest)({ key: "o#g1", claim: "c", events: [event] })).toBe(true)
    expect(is(Transcript.EventsRequest)({ key: "", claim: "c", events: [] })).toBe(false)
    expect(is(Transcript.EventsResponse)({ next: 3 })).toBe(true)
    expect(is(Transcript.EventsResponse)({ next: -1 })).toBe(false)
    expect(AgentRunner.ROUTES.events).toBe("/api/runners/events")
  })
})
