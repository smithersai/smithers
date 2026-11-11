import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { inspect } from "node:util"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"
import { Canonical, CanonicalError, canonicalize } from "../src/index.vibe"

const guide = readFileSync(new URL("../docs/guides/use-the-schema.md", import.meta.url), "utf8")

// Execute the published reporting helper, so copying the guide has the same
// privacy contract as the assertions below.
const reportingExample = (name: string): (cause: unknown) => unknown => {
  const fence = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .find((code) => code.includes(`const ${name} =`))
  if (fence === undefined) throw new Error(`Missing documentation example: ${name}`)
  const { outputText } = ts.transpileModule(fence.replace(/^import .*$/gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  })
  return new Function("CanonicalError", `${outputText}\nreturn ${name}`)(CanonicalError)
}

const failure = (value: unknown): CanonicalError => {
  try {
    canonicalize(value)
  } catch (error) {
    if (error instanceof CanonicalError) return error
    throw error
  }
  throw new Error("Expected canonicalization to fail")
}

const secretKey = "SYNTHETIC_SECRET_KEY"
const secretText = "SYNTHETIC_SECRET_VALUE"
const keyedInput = { records: { [secretKey]: { value: NaN } } }
const throwingInput = {
  toJSON() {
    throw new Error(secretText)
  }
}

describe("documented diagnostic boundaries", () => {
  it.each([
    ["record member names", keyedInput],
    ["callback exception text", throwingInput],
    ["getter exception text", {
      get value() {
        throw new Error(secretText)
      }
    }]
  ])("reports only the stable code by default for %s", (_label, input) => {
    const error = failure(input)
    expect(reportingExample("issueOf")(error)).toBe(error.code)
  })

  it("allowlists complete public paths and redacts dynamic keys and exception text", () => {
    const report = reportingExample("detailedIssueOf")
    for (const key of [secretKey, "fake@example.test", "tags.SYNTHETIC_SECRET_KEY"]) {
      const error = failure({
        input: {
          [key]: {
            toJSON() {
              throw new Error(secretText)
            }
          }
        }
      })
      expect(report(error)).toEqual({
        code: "canonical_tojson_threw",
        path: "$[redacted]",
        message: "[redacted]",
        cause: "[redacted]"
      })
    }
    expect(report(failure({ input: { tags: new Set() } }))).toEqual({
      code: "canonical_unsupported_value",
      path: "$.input.tags",
      message: "[redacted]",
      cause: "[redacted]"
    })
    expect(report(new Error(secretText))).toEqual({ code: "canonicalization_failed" })
    expect(reportingExample("issueOf")(new Error(secretText))).toBe("canonicalization_failed")
  })

  it("retains the rejected input on the issue only when reportInput is true, and prints it in neither case", () => {
    const input = { [secretKey]: secretText, value: NaN }
    const failed = (options: { readonly reportInput?: boolean }): Schema.SchemaError =>
      Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Canonical)(input, options)))
    const retained = (options: { readonly reportInput?: boolean }): string => JSON.stringify(failed(options).issue)
    expect(retained({})).not.toContain(secretText)
    expect(retained({ reportInput: false })).not.toContain(secretText)
    expect(retained({ reportInput: true })).toContain(secretText)
    // Effect 4.0.4 gave `SchemaError` a `toJSON`, which rc.115 lacked: the
    // error now prints its tag and message, whatever its issue retains.
    for (const options of [{}, { reportInput: false }, { reportInput: true }]) {
      const error = failed(options)
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        _tag: "SchemaError",
        message: "canonical_nan: NaN at $.value"
      })
      expect(inspect(error, { depth: null })).not.toContain(secretText)
    }
  })

  it("demonstrates that reportInput false does not redact paths or custom messages", () => {
    expect(failure(keyedInput).path).toBe(`$.records.${secretKey}.value`)
    expect(failure(throwingInput).cause).toEqual(new Error(secretText))
    for (const [input, secret] of [[keyedInput, secretKey], [throwingInput, secretText]] as const) {
      const error = Effect.runSync(Effect.flip(
        Schema.decodeUnknownEffect(Canonical)(input, { reportInput: false })
      ))
      expect(error.message).toContain(secret)
    }
  })
})
