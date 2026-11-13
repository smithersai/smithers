import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import { Process } from "../src/internal/Process.ts"
import * as Review from "../src/LlmLint.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-related-presence-")))
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
  batchSize: 2,
  failOn: "error"
}

const write = async (relative: string, contents: string): Promise<void> => {
  await Fs.mkdir(Path.dirname(Path.join(root, relative)), { recursive: true })
  await Fs.writeFile(Path.join(root, relative), contents)
}

const recorder = async () => {
  const executable = Path.join(root, "reviewer.mjs")
  const record = Path.join(root, "review-prompts.jsonl")
  await Fs.writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from \"node:fs\"",
      "let prompt = \"\"",
      "for await (const chunk of process.stdin) prompt += chunk",
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify(prompt) + "\\n")`,
      "process.stdout.write(JSON.stringify({ result: \"[]\" }))"
    ].join("\n") + "\n",
    { mode: 0o755 }
  )
  return {
    executable,
    prompts: async (): Promise<Array<string>> =>
      (await Fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string)
  }
}

describe("review related-file presence", () => {
  it("includes a present unchanged snapshot dependency in the reviewed prompt", async () => {
    await write("src/a.ts", "import { helper } from \"./helper.ts\"\nexport const a = helper()\n")
    await write("src/helper.ts", "export const helper = () => \"snapshot dependency\"\n")
    const cli = await recorder()
    const snapshot = await Promise.all(["src/a.ts", "src/helper.ts"].map(async (path) => ({
      path,
      contents: await Fs.readFile(Path.join(root, path), "utf8"),
      changed: path === "src/a.ts"
    })))
    const report = await Effect.runPromise(Review.review({
      workspaceRoot: root,
      executable: cli.executable,
      snapshot
    }, payload))
    expect(report.files).toEqual(["src/a.ts"])
    expect(report.findings).toEqual([])
    const prompts = await cli.prompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("--- CHANGED FILE: \"src/a.ts\"")
    expect(prompts[0]).toContain("--- RELATED FILE: \"src/helper.ts\"")
    expect(prompts[0]).toContain("snapshot dependency")
    expect(prompts[0]).not.toContain("--- CHANGED FILE: \"src/helper.ts\"")
  })

  it("skips a tracked related path that disappeared before its real filesystem read", async () => {
    await write("src/main.go", "package main\nfunc main() {}\n")
    const cli = await recorder()
    const protocol = Path.join(root, "git-presence-protocol.mjs")
    const calls = Path.join(root, "git-calls.jsonl")
    await Fs.writeFile(
      protocol,
      [
        "import { appendFileSync } from \"node:fs\"",
        "const args = process.argv.slice(2)",
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")`,
        "let output = \"\"",
        "if (args.includes(\"rev-parse\")) output = \"a\".repeat(40) + \"\\n\" + \"b\".repeat(40) + \"\\n\"",
        "else if (args.includes(\"diff\")) output = \"src/main.go\\0\"",
        "else if (args.includes(\"ls-files\") && args.includes(\"--cached\")) output = \"src/disappeared.go\\0\"",
        "process.stdout.write(output)"
      ].join("\n") + "\n"
    )
    const report = await Effect.runPromise(
      Review.review({
        workspaceRoot: root,
        executable: cli.executable
      }, payload).pipe(Effect.provideService(Process, {
        spawn: (options) =>
          options.command === "git"
            ? ScopedProcess.spawn({
              ...options,
              command: process.execPath,
              args: [protocol, ...options.args ?? []]
            })
            : ScopedProcess.spawn(options),
        status: ScopedProcess.status
      }))
    )
    expect(report.files).toEqual(["src/main.go"])
    expect(report.findings).toEqual([])
    await expect(Fs.lstat(Path.join(root, "src/disappeared.go"))).rejects.toMatchObject({ code: "ENOENT" })
    const gitCalls = (await Fs.readFile(calls, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Array<string>)
    expect(
      gitCalls.some((args) =>
        args.includes("ls-files") && args.includes("--cached") && args.includes(":(glob)src/*.go")
      )
    ).toBe(true)
    const prompts = await cli.prompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("--- CHANGED FILE: \"src/main.go\"")
    expect(prompts[0]).toContain("func main()")
    expect(prompts[0]).not.toContain("--- RELATED FILE: \"src/disappeared.go\"")
    expect(prompts[0]).not.toContain("Related files omitted by the token budget")
  })
})
