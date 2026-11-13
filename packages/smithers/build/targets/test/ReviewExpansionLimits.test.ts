import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Review from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-expansion-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload: Review.Payload = {
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Report defects",
  engine: "claude",
  model: "fixture",
  batchSize: 1,
  failOn: "error"
}

describe("review encoding expansion bounds", () => {
  it("bounds the rendered prompt after JSON escaping expands otherwise valid context", async () => {
    let calls = 0
    const error = await Effect.runPromise(Effect.flip(Review.review({
      workspaceRoot: root,
      snapshot: [
        { path: "src/a.ts", contents: "export const a = 1\n", changed: true },
        { path: "docs/a.txt", contents: "\u0001".repeat(1024 * 1024), changed: false },
        { path: "docs/b.txt", contents: "\u0001".repeat(1024 * 1024), changed: false }
      ],
      transport: () => {
        calls++
        return Effect.fail(new Error("inference must not run"))
      }
    }, { ...payload, context: [Input.glob("docs/**")] })))
    expect(calls).toBe(0)
    expect(error).toMatchObject({ phase: "review" })
    expect(error.message).toBe("LLM review prompt exceeds 8388608 bytes")
  })

  it("bounds findings after credential masking expands a valid model response", async () => {
    const executable = Path.join(root, "reviewer.mjs")
    const findings = Array.from({ length: 1000 }, () => ({
      file: "src/a.ts",
      line: 1,
      severity: "warning",
      message: "live".repeat(500)
    }))
    const answer = JSON.stringify(findings)
    expect(Buffer.byteLength(answer)).toBeLessThan(4 * 1024 * 1024)
    await Fs.writeFile(
      executable,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end",()=>process.stdout.write(${JSON.stringify(JSON.stringify({ result: answer }))}));
`
    )
    await Fs.chmod(executable, 0o755)
    const error = await Effect.runPromise(Effect.flip(Review.review({
      workspaceRoot: root,
      executable,
      snapshot: [{ path: "src/a.ts", contents: "const PASSWORD = \"live\"\n", changed: true }]
    }, payload)))
    expect(error).toMatchObject({ phase: "parse" })
    expect(error.message).toBe(`model findings exceed ${Review.maximumFindingBytes} bytes`)
    expect(error.message).not.toContain("live")
  })
})
