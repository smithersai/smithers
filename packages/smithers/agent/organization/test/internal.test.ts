import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Frontmatter from "../src/internal/frontmatter.ts"
import * as Issues from "../src/internal/issues.ts"

describe("internal frontmatter", () => {
  it("splits a fenced document and leaves an unfenced one whole", () => {
    expect(Frontmatter.split("---\na: 1\n---\n\nBody\n")).toEqual({ frontmatter: "a: 1\n", body: "\nBody\n" })
    expect(Frontmatter.split("﻿---\na: 1\n---")).toEqual({ frontmatter: "a: 1\n", body: "" })
    expect(Frontmatter.split("---\na: 1\n")).toEqual({ frontmatter: undefined, body: "---\na: 1\n" })
    expect(Frontmatter.split("Body")).toEqual({ frontmatter: undefined, body: "Body" })
  })

  it("parses mappings with the chosen scalar schema", () => {
    expect(Frontmatter.parse("a: 1\nb: true", "core")).toEqual({ ok: true, value: { a: 1, b: true } })
    expect(Frontmatter.parse("a: 1\nb: true", "failsafe")).toEqual({ ok: true, value: { a: "1", b: "true" } })
  })

  it("refuses duplicates, non-mappings, and aliases without echoing source", () => {
    const secret = "xoxb-222-secret"
    const duplicate = Frontmatter.parse(`a: ${secret}\na: ${secret}`, "core")
    expect(duplicate.ok).toBe(false)
    expect(JSON.stringify(duplicate)).not.toContain(secret)
    expect(JSON.stringify(duplicate)).toMatch(/at line \d+, column \d+/)
    expect(Frontmatter.parse("- a\n- b", "core")).toEqual({ ok: false, error: "frontmatter must be a YAML mapping" })
    expect(Frontmatter.parse(`a: &x ${secret}\nb: *x`, "core")).toEqual({
      ok: false,
      error: "frontmatter could not be converted from YAML"
    })
  })
})

describe("internal issues", () => {
  const failure = (schema: Schema.Top, input: unknown) =>
    Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>)(input)))

  it("stops at the limit", () => {
    const struct = Schema.Struct({ a: Schema.String, b: Schema.String, c: Schema.String })
    const error = Effect.runSync(
      Effect.flip(Schema.decodeUnknownEffect(struct, { errors: "all" })({}))
    )
    expect(Issues.problems(error)).toHaveLength(3)
    expect(Issues.problems(error, 1)).toEqual([{ field: "a", problem: "is required" }])
  })

  it("falls back when a filter's annotations carry no expectation", () => {
    const titled = Schema.String.check(Schema.makeFilter(() => false, { title: "titled" }))
    expect(Issues.problems(failure(titled, "x"))).toEqual([{ field: "", problem: "is invalid" }])
  })
})
