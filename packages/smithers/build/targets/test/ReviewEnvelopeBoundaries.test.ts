import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Review from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-envelope-boundary-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const request = { engine: "claude" as const, model: "fixture", prompt: "Return findings." }
const program = async (envelope: object): Promise<string> => {
  const executable = Path.join(root, "reviewer.mjs")
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(envelope))})\n`
  )
  await Fs.chmod(executable, 0o755)
  return executable
}

describe("model CLI completion metadata", () => {
  it.each([
    { terminal_reason: "failed" },
    { api_error_status: 400 },
    { errors: ["provider failure"] }
  ])("refuses a failure envelope even when it contains answer text: %j", async (metadata) => {
    const executable = await program({ result: "[]", ...metadata })
    const failure = await Effect.runPromise(
      Effect.flip(Review.promptEngine({ workspaceRoot: root, executable }, request))
    )
    expect(failure).toMatchObject({ phase: "parse" })
    expect(failure.message).toContain("claude did not complete successfully")
  })

  it("accepts successful metadata and a nonerror API status", async () => {
    const executable = await program({
      result: "[]",
      terminal_reason: "completed",
      api_error_status: 399,
      errors: [],
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false
    })
    expect(await Effect.runPromise(Review.promptEngine({ workspaceRoot: root, executable }, request))).toBe("[]")
  })

  it("names the type of a nonnumeric timeout before invoking a model CLI", async () => {
    const executable = await program({ result: "[]" })
    const failure = await Effect.runPromise(Effect.flip(Review.promptEngine({
      workspaceRoot: root,
      executable,
      timeoutMs: "soon" as never
    }, request)))
    expect(failure).toMatchObject({ phase: "review" })
    expect(failure.message).toContain("received string")
  })
})
