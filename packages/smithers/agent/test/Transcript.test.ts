/** Transcript events: what a runner may send of an agent's session, scrubbed and bounded before it leaves. */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as AgentRunner from "../src/AgentRunner.ts"
import * as Transcript from "../src/Transcript.ts"

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const shapes = () => Transcript.scrubber()

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
