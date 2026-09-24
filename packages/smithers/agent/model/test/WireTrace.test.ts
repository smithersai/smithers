/**
 * The opt-in wire trace: what one prepared request reports, the common input
 * prefix it measures against the previous request on the same key, and the
 * environment switch that turns it on.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as WireTrace from "../src/internal/WireTrace.ts"

const prepared = (body: Record<string, unknown>, key?: string) => ({
  routeId: "openai-chatgpt",
  protocolId: "openai-responses-chatgpt",
  publicHeaders: key === undefined ? {} : { "session-id": key },
  bodyText: JSON.stringify({ ...body, ...(key === undefined ? {} : { prompt_cache_key: key }) })
})

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] })

describe("WireTrace.line", () => {
  it("reports the cache identity and the input prefix shared with the previous request", () => {
    const history = new Map<string, ReadonlyArray<string>>()
    const first = WireTrace.line(prepared({ instructions: "teach", input: [user("begin"), user("panel 0")] }, "k"), history)
    const second = WireTrace.line(
      prepared({
        instructions: "teach",
        input: [user("begin"), { type: "reasoning", encrypted_content: "secret-state" }, user("panel 1")]
      }, "k"),
      history
    )
    expect(first).toMatchObject({ cacheKey: "k", sessionIdHeader: "k", commonPrefixItems: 0, previousItems: 0 })
    expect(second).toMatchObject({ commonPrefixItems: 1, previousItems: 2, kinds: ["user", "reasoning", "user"] })
    expect(JSON.stringify(second)).not.toContain("secret-state")
  })

  it("reads a Chat Completions body's messages and keys a request with no cache key by its route", () => {
    const history = new Map<string, ReadonlyArray<string>>()
    WireTrace.line(prepared({ messages: [user("a")] }), history)
    const line = WireTrace.line(prepared({ messages: [user("a"), null] }), history)
    expect(line).toMatchObject({
      cacheKey: null,
      sessionIdHeader: null,
      instructions: null,
      kinds: ["user", "undefined"],
      commonPrefixItems: 1
    })
    expect(WireTrace.line(prepared({}), history)).toMatchObject({ items: [], commonPrefixItems: 0 })
  })
})

describe("WireTrace.record", () => {

  it("appends one line to the file SMITHERS_WIRE_TRACE names", () => {
    const file = join(mkdtempSync(join(tmpdir(), "wire-trace-")), "trace.jsonl")
    const node = { env: { SMITHERS_WIRE_TRACE: file }, getBuiltinModule: process.getBuiltinModule } as never
    WireTrace.record(prepared({ input: [user("a")] }, "record-k"), node)
    WireTrace.record(prepared({ input: [user("a"), user("b")] }, "record-k"), node)
    const lines = readFileSync(file, "utf8").trim().split("\n").map((text) => JSON.parse(text))
    expect(lines.map((line) => line.commonPrefixItems)).toEqual([0, 1])
  })

  it("records nothing when the variable is unset or empty, or when there is no process", () => {
    let writes = 0
    const counting = { appendFileSync: () => void writes++ }
    WireTrace.record(prepared({}), { env: {}, getBuiltinModule: () => counting })
    WireTrace.record(prepared({}), { env: { SMITHERS_WIRE_TRACE: "" }, getBuiltinModule: () => counting })
    WireTrace.record(prepared({}), undefined)
    expect(writes).toBe(0)
    expect(() => WireTrace.record(prepared({}))).not.toThrow()
  })

  it("never fails the call when the trace file cannot be written", () => {
    const failing = { appendFileSync: () => { throw new Error("read-only") } }
    expect(() => WireTrace.record(prepared({}), { env: { SMITHERS_WIRE_TRACE: "/x" }, getBuiltinModule: () => failing }))
      .not.toThrow()
  })
})
