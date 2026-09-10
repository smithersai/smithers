import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaParser from "effect/SchemaParser"
import { describe, expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"
import { describeFailure } from "../src/Executor.ts"

/**
 * The shape `@smthrs/targets` fails a target with. It is a plain object, so the
 * failure renderer walks it; every field below is what an operator acts on.
 */
const execError = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  _tag: "smithers-build/ExecError",
  argv: ["bun", "test", "src"],
  code: "exit_status",
  cwd: "apps/ui",
  exitCode: 1,
  stderr: "3 fail\n  routes > agents > spawns a session",
  stdout: "",
  ...overrides
})

/** Every rendering has to name these three, whatever else the value carries. */
const namesTheRun = (rendered: string): void => {
  expect(rendered).not.toBe("target failed")
  expect(rendered).toContain("bun")
  expect(rendered).toContain("exitCode")
  expect(rendered).toContain("routes > agents > spawns a session")
}

describe("describeFailure", () => {
  it("renders a plain failure as JSON", () => {
    namesTheRun(describeFailure(execError()))
  })

  it.each([
    ["an undefined member", { signal: undefined }, "<undefined>"],
    ["a bigint member", { durationNs: 12345n }, "<bigint 12345>"],
    ["a symbol member", { token: Symbol("spawn") }, "<Symbol(spawn)>"],
    ["a function member", { kill: function killTree() {} }, "<function killTree>"],
    ["a NaN member", { durationMs: Number.NaN }, "<NaN>"],
    ["an Infinity member", { durationMs: Number.POSITIVE_INFINITY }, "<Infinity>"],
    ["a negative-zero member", { drift: -0 }, "<-0>"]
  ])("still names the run when the value carries %s", (_name, extra, marker) => {
    const rendered = describeFailure(execError(extra))
    namesTheRun(rendered)
    expect(rendered).toContain(marker)
  })

  it("still names the run when the value closes a cycle", () => {
    const value = execError()
    value["self"] = value
    const rendered = describeFailure(value)
    namesTheRun(rendered)
    expect(rendered).toContain("<circular>")
  })

  it("names the argv, the exit code and the stderr of a run that overruns the byte budget", () => {
    // Both tails are `Exec.stderrTailLimit` (64 KiB) wide, which is more than
    // one diagnostic may carry, so this is the ordinary size of a failing test
    // target rather than a pathological one.
    const tail = 64 * 1024
    const rendered = describeFailure(execError({
      stderr: `${"e".repeat(tail - 40)}\n3 fail\n  routes > agents > spawns a session`,
      stdout: "o".repeat(tail)
    }))
    namesTheRun(rendered)
    expect(rendered).toContain("apps/ui")
    expect(rendered).toContain("truncated")
    expect(rendered.length).toBeLessThanOrEqual(Diagnostic.maximumMessageCodeUnits)
  })

  it.each(["stderr", "stdout"] as const)("keeps the beginning and final runner summary of oversized %s", (stream) => {
    const start = "runner started: 日本語 🙂\n"
    const summary = "\n(fail) routes > agents > spawns a session\n2336 pass\n1 fail\n"
    // Multibyte characters straddle cuts; quotes, newlines and control bytes
    // expand again when the bounded diagnostic is encoded as JSON.
    const transcript = start + "(pass) 日本語🙂\\\"\u0001\n".repeat(5000) + summary
    const failure = execError({ stderr: "", stdout: "", [stream]: transcript })
    const rendered = describeFailure(failure)
    const decoded = JSON.parse(rendered)
    expect(decoded).toMatchObject({
      _tag: "smithers-build/ExecError",
      argv: ["bun", "test", "src"],
      code: "exit_status",
      cwd: "apps/ui",
      exitCode: 1
    })
    expect(decoded[stream].startsWith(start)).toBe(true)
    expect(decoded[stream].endsWith(summary)).toBe(true)
    expect(decoded[stream]).toContain("more bytes truncated")
    expect(decoded[stream].isWellFormed()).toBe(true)
    expect(rendered.length).toBeLessThanOrEqual(Diagnostic.maximumMessageCodeUnits)
    expect(failure[stream]).toBe(transcript)
  })

  it("does not invoke an accessor while rendering a failure", () => {
    let reads = 0
    const value = execError()
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get: () => {
        reads += 1
        return "leaked"
      }
    })
    const rendered = describeFailure(value)
    namesTheRun(rendered)
    expect(rendered).toContain("<accessor>")
    expect(reads).toBe(0)
  })

  it("leaves an Error to the message renderer rather than dumping its stack", () => {
    expect(describeFailure(new Error("the tool was terminated by SIGKILL"))).toBe(
      "the tool was terminated by SIGKILL"
    )
  })

  /**
   * A schema refusal reaches the renderer as the bare issue tree: it carries no
   * `message`, and the JSON walk would render its internals rather than the
   * reason. Effect's own formatter is what names the refused path.
   */
  it("renders a schema issue as the sentence naming the refused path", () => {
    const result = SchemaParser.decodeUnknownResult(Schema.Struct({ port: Schema.Number }))({ port: "8080" })
    if (!Result.isFailure(result)) throw new Error("the schema accepted a string port")
    const rendered = describeFailure(result.failure)
    expect(rendered).not.toBe("target failed")
    expect(rendered).toContain("Expected number")
    expect(rendered).toContain("[\"port\"]")
  })

  it("falls back for a value that carries nothing", () => {
    expect(describeFailure(undefined)).toBe("target failed")
    expect(describeFailure({})).toBe("target failed")
  })
})
