import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { ControlDefect, defectMessage } from "../src/ControlRpcs.ts"

test("API guide describes sanitized request-decoding defects", () => {
  const guide = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")
  expect(Schema.encodeUnknownSync(Schema.toCodecJson(ControlDefect))("request decoder details"))
    .toEqual({ name: "Error", message: defectMessage })
  expect(guide).toContain("including string defects and request-decoding failures")
  expect(guide).not.toContain("request\ndecoder's own sentence")
})
