import { describe, expect, test } from "bun:test"
import { journalPayload, MAX_TRANSITION_PAYLOAD_BYTES } from "./TransitionDiagnostics"

const bytes = (value: string) => new TextEncoder().encode(value).byteLength

describe("bounded transition diagnostics", () => {
  test("small diagnostic fields remain byte-for-byte readable", () => {
    const payload = JSON.stringify({ key: "store.refused", title: "Saved state needs recovery", detail: "Unreadable event" })
    expect(journalPayload(payload)).toBe(payload)
  })

  test("large histories preserve short diagnostic fields and name omitted values", () => {
    const payload = JSON.stringify({ id: "run-1", patch: { status: "error", title: "Coding", payload: {
      message: "The run failed", text: "日本語🙂".repeat(1000), events: Array.from({ length: 600 }, (_, sequence) => ({ sequence }))
    } } })
    const bounded = journalPayload(payload)
    expect(bytes(bounded)).toBeLessThanOrEqual(MAX_TRANSITION_PAYLOAD_BYTES)
    expect(JSON.parse(bounded)).toEqual({ id: "run-1", patch: { status: "error", title: "Coding", payload: {
      message: "The run failed", text: { elidedBytes: bytes("日本語🙂".repeat(1000)) }, events: { elidedItems: 600 }
    } } })
  })

  test("the limit and omitted size count UTF-8 bytes, including wide scalar-only objects", () => {
    const payload = JSON.stringify(Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`field-${index}`, "日本語🙂"])))
    expect(payload.length).toBeLessThan(MAX_TRANSITION_PAYLOAD_BYTES)
    expect(bytes(payload)).toBeGreaterThan(MAX_TRANSITION_PAYLOAD_BYTES)
    expect(JSON.parse(journalPayload(payload))).toEqual({ elided: bytes(payload) })
    expect(bytes(journalPayload(JSON.stringify({ value: "x".repeat(MAX_TRANSITION_PAYLOAD_BYTES) })))).toBeLessThanOrEqual(MAX_TRANSITION_PAYLOAD_BYTES)
  })
})
