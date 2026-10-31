import { describe, expect, test } from "vitest"
import { Schema } from "effect"
import { cleanSummary } from "./steps"
import { Summarize, SummaryFailed, SummaryPayload } from "./flow"
import { revisionOf } from "./store"

describe("timeline summary contract", () => {
  test("accepts only short plain navigation summaries", () => {
    expect(cleanSummary("  Inspect both retry attempts  ")).toBe("Inspect both retry attempts")
    expect(cleanSummary("README.md updated")).toBe("README.md updated")
    expect(cleanSummary("README.md")).toBe("README.md")
    expect(cleanSummary("Use API_TOKEN=example-secret")).not.toContain("example-secret")
    for (const text of ["Waiting to send", "Waiting for reply", "Not sent", "Done", "Failed", "Queued"]) expect(cleanSummary(text)).toBeUndefined()
    for (const text of ["", "Reply sent", "Run completed", "Working", "one <two> three", "one `two` three", "a "+"b".repeat(98)+" c"]) expect(cleanSummary(text)).toBeUndefined()
  })
  test("a wordy reply still names the message: its first line, first eight words, no wrappers", () => {
    expect(cleanSummary("one two three four five six seven eight nine")).toBe("one two three four five six seven eight")
    expect(cleanSummary('"Cause found in redirect.ts."\nSecond line')).toBe("Cause found in redirect.ts")
    expect(cleanSummary("**Tests passed**")).toBe("Tests passed")
  })
  test("keys every content change, even beyond the model excerpt, independently of streaming metadata", () => {
    const row = { id: "a", role: "user" as const, text: "Find help commands" }
    expect(revisionOf(row)).toBe(revisionOf({ ...row }))
    for (const changed of [{ ...row, id: "b" }, { ...row, role: "assistant" as const }, { ...row, text: "Find other commands" }]) expect(revisionOf(changed)).not.toBe(revisionOf(row))
    expect(revisionOf({ ...row, text: "a".repeat(8000)+"b" })).not.toBe(revisionOf({ ...row, text: "a".repeat(8000)+"c" }))
  })
  test("bounds model payloads and carries only safe failure codes", () => {
    const decode = Schema.decodeUnknownSync(Schema.Struct(SummaryPayload))
    expect(decode({ id: "a", revision: "r", role: "user", text: "x" }).text).toBe("x")
    expect(() => decode({ id: "a", revision: "r", role: "user", text: "x".repeat(8001) })).toThrow()
    expect(Summarize._tag).toBe("timeline/summarize")
    expect(new SummaryFailed({ code: "invalid" }).code).toBe("invalid")
    expect(decode({ id: "a", revision: "r", role: "assistant", text: "x", question: "q", reason: "multiline_answer" })).toMatchObject({ question: "q", reason: "multiline_answer" })
    expect(() => decode({ id: "a", revision: "r", role: "assistant", text: "x", question: "q".repeat(2001) })).toThrow()
    expect(() => decode({ id: "a", revision: "r", role: "assistant", text: "x", reason: "words" })).toThrow()
  })
})
