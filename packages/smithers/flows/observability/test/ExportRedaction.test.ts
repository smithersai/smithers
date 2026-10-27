import { Redaction } from "@smthrs/journal"
import { expect, it } from "vitest"
import { redact } from "../src/internal/exportRedaction.ts"

const exported = (value: unknown): unknown =>
  JSON.parse(new TextDecoder().decode(redact(new TextEncoder().encode(JSON.stringify(value)))))

it("preserves OTLP types and keys while removing sensitive AnyValues recursively", () => {
  expect(exported({
    attributes: [
      { key: "PASSWORD", value: { intValue: 123 } },
      {
        key: "safe",
        value: {
          arrayValue: {
            values: [
              { boolValue: true },
              { doubleValue: 2.5 },
              { stringValue: "null" },
              { kvlistValue: { values: [{ key: "apiKey", value: { stringValue: "arbitrary-credential" } }] } }
            ]
          }
        }
      },
      { key: "nested", value: { stringValue: JSON.stringify({ items: [{ token: "nested-credential", safe: 1 }] }) } },
      { key: "empty", value: null }
    ]
  })).toEqual({
    attributes: [
      { key: "PASSWORD", value: { stringValue: "[REDACTED]" } },
      {
        key: "safe",
        value: {
          arrayValue: {
            values: [
              { boolValue: true },
              { doubleValue: 2.5 },
              { stringValue: "null" },
              { kvlistValue: { values: [{ key: "apiKey", value: { stringValue: "[REDACTED]" } }] } }
            ]
          }
        }
      },
      { key: "nested", value: { stringValue: JSON.stringify({ items: [{ token: "[REDACTED]", safe: 1 }] }) } },
      { key: "empty", value: null }
    ]
  })
})

it("bounds deeply nested encoded data without losing shallower fields", () => {
  let value: unknown = { key: "password", value: { stringValue: "deep-credential" } }
  for (let index = 0; index <= Redaction.maxDepth; index++) value = { nested: value }
  const result = JSON.stringify(exported({ safe: "kept", value }))
  expect(result).toContain("[Deep]")
  expect(result).toContain("kept")
  expect(result).not.toContain("deep-credential")
})

it("keeps journal token counts while redacting numeric credentials and invalid counts", () => {
  const preserved = [
    { key: "inputTokens", value: { intValue: 100 } },
    { key: "usage.output_tokens", value: { intValue: "20" } },
    { key: "maxTokens", value: { doubleValue: 4096 } },
    { key: "contextWindowTokens", value: { intValue: 0 } }
  ]
  const refused = [
    { key: "token", value: { intValue: 123 } },
    { key: "apiKey", value: { doubleValue: 123 } },
    { key: "inputTokens", value: { stringValue: "100" } },
    { key: "inputTokens", value: { intValue: -1 } },
    { key: "inputTokens", value: { doubleValue: 0.5 } },
    { key: "inputTokens", value: { intValue: "not-a-count" } },
    { key: "inputTokens", value: { intValue: "9007199254740993" } },
    { key: "inputTokens", value: { intValue: 1, stringValue: "credential" } },
    { key: "inputTokens", value: null },
    { key: "inputTokens", value: [] },
    { key: "inputTokens", value: 1 }
  ]
  expect(exported({ key: "inputTokens" })).toEqual({ key: "inputTokens" })
  expect(exported({ attributes: [...preserved, ...refused] })).toEqual({
    attributes: [...preserved, ...refused.map(({ key }) => ({ key, value: { stringValue: "[REDACTED]" } }))]
  })
})
