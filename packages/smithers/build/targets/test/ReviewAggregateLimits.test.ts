import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Review from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-aggregate-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("generic review aggregate finding bounds", () => {
  it.each(["count", "bytes"] as const)("bounds %s across individually valid model batches", async (limit) => {
    const executable = Path.join(root, "reviewer.mjs")
    await Fs.writeFile(
      executable,
      `#!/usr/bin/env node
let prompt="";
for await (const chunk of process.stdin) prompt+=chunk;
const file=prompt.match(/--- CHANGED FILE: "([^"]+)"/)[1];
const findings=Array.from({length:${limit === "count" ? 6000 : 1000}},(_,i)=>({
 file,line:1,severity:"warning",message:${limit === "count" ? "\"finding \"+i" : "\"live\".repeat(250)"}
}));
process.stdout.write(JSON.stringify({result:JSON.stringify(findings)}));
`
    )
    await Fs.chmod(executable, 0o755)
    const error = await Effect.runPromise(Effect.flip(Review.review({
      workspaceRoot: root,
      executable,
      snapshot: [
        { path: "src/z.ts", contents: "const PASSWORD = \"live\"\n", changed: true },
        { path: "src/a.ts", contents: "const PASSWORD = \"live\"\n", changed: true }
      ]
    }, {
      base: "HEAD",
      include: [Input.glob("src/**")],
      context: [],
      prompt: "Review",
      rubric: "Report defects",
      engine: "claude",
      model: "fixture",
      batchSize: 1,
      failOn: "error"
    })))
    expect(error).toMatchObject({
      phase: "parse",
      message: limit === "count" ?
        `model returned more than ${Review.maximumFindings} findings` :
        `model findings exceed ${Review.maximumFindingBytes} bytes`
    })
    expect(Object.hasOwn(error, "attempts")).toBe(false)
  })
})

it("preserves escaped backslashes in a valid finding message", async () => {
  const executable = Path.join(root, "reviewer.mjs")
  const finding = { file: "src/a.ts", line: 1, severity: "warning", message: String.raw`Check C:\data\file` }
  await Fs.writeFile(
    executable,
    `#!/usr/bin/env node
process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(${
      JSON.stringify(JSON.stringify({ result: JSON.stringify([finding]) }))
    }));
`
  )
  await Fs.chmod(executable, 0o755)
  const report = await Effect.runPromise(Review.review({
    workspaceRoot: root,
    executable,
    snapshot: [{ path: "src/a.ts", contents: "export const a = 1", changed: true }]
  }, {
    base: "HEAD",
    include: [Input.glob("src/**")],
    context: [],
    prompt: "Review",
    rubric: "Report defects",
    engine: "claude",
    model: "fixture",
    batchSize: 1,
    failOn: "error"
  }))
  expect(report.findings).toEqual([finding])
})

it("preserves cancellation while delivering private credential discoveries", async () => {
  let calls = 0
  const exit = await Effect.runPromiseExit(Review.review({
    workspaceRoot: root,
    snapshot: [{ path: "src/a.ts", contents: "const PASSWORD = \"live\"\n", changed: true }],
    onCredentials: () => Effect.interrupt,
    transport: () => {
      calls++
      return Effect.fail(new Error("inference must not run"))
    }
  }, {
    base: "HEAD",
    include: [Input.glob("src/**")],
    context: [],
    prompt: "Review",
    rubric: "Report defects",
    engine: "claude",
    model: "fixture",
    batchSize: 1,
    failOn: "error"
  }))
  expect(calls).toBe(0)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
})
