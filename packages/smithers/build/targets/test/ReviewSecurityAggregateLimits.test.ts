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
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "security-aggregate-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

interface RecordedCall {
  readonly file: string
  readonly engine: "claude" | "codex"
  readonly purpose: "review" | "verify"
  readonly findings: number
  readonly outputBytes: number
  readonly normalizedBytes: number
  readonly prompt: string
}

const fixture = async (limit: "count" | "bytes") => {
  const executable = Path.join(root, "security-reviewer.mjs")
  const record = Path.join(root, "security-calls.jsonl")
  await Fs.writeFile(
    executable,
    String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs"
let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
const file = /--- CHANGED FILE: "([^"]+)"/.exec(prompt)[1]
const engine = process.argv.includes("exec") ? "codex" : "claude"
const purpose = prompt.includes("Verify this candidate against the supplied source.") ? "verify" : "review"
const token = /<credential:[^>]+>/.exec(prompt)?.[0]
const limit = ${JSON.stringify(limit)}
const security = {
  checkId: "general",
  impact: "low",
  verification: "confirmed",
  releaseRecommendation: "review",
  attackerPreconditions: "Attacker controls the input.",
  evidence: "The changed operation accepts input.",
  nextConfirmationStep: "Inspect input validation."
}
const seed = { file, line: 1, severity: "info", message: "seed " + file, security }
const normalized = (finding) => ({
  ...finding, severity: "warning", security: { ...finding.security, verification: "suspected" }
})
const size = (finding) => Buffer.byteLength(JSON.stringify(normalized(finding)))
let findings = [seed]
if (purpose === "verify") {
  findings = Array.from({ length: limit === "count" ? 6000 : 2000 }, (_, index) => ({
    file, line: 1, severity: "info",
    message: "finding " + index + " " + (limit === "bytes" ? token.repeat(70) : ""),
    security
  }))
  if (limit === "bytes") {
    if (!token) throw new Error("The source credential was not masked")
    // Normalize info -> warning adds three bytes per finding. Keep the
    // independent attempt-receipt budget below its bound while findings
    // cross their aggregate bound after both completed batches.
    const target = ${Review.maximumFindingBytes} / 2 + 1024
    const current = size(seed) + findings.reduce((sum, finding) => sum + size(finding), 0)
    const extra = target - current
    if (extra < 0) throw new Error("Fixture starts beyond its target")
    const each = Math.floor(extra / findings.length)
    const remainder = extra % findings.length
    findings = findings.map((finding, index) => ({
      ...finding, message: finding.message + "x".repeat(each + (index < remainder ? 1 : 0))
    }))
  }
}
const normalizedBytes = purpose === "verify"
  ? size(seed) + findings.reduce((sum, finding) => sum + size(finding), 0)
  : size(seed)
const completion = {
  status: "completed",
  coverage: [{ checkId: "general", status: "completed", evidence: "Inspected the changed input boundary." }],
  missingContext: [],
  findings: findings.map((finding) => ({
    ...finding,
    message: token ? finding.message.split(token).join("live") : finding.message
  }))
}
const answer = JSON.stringify(completion)
const output = engine === "claude"
  ? JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: answer })
  : [
    { type: "thread.started", thread_id: "fixture" },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: answer } },
    { type: "turn.completed" }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n"
appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  file, engine, purpose, findings: findings.length,
  outputBytes: Buffer.byteLength(output), normalizedBytes, prompt
}) + "\n")
process.stdout.write(output)
`,
    { mode: 0o755 }
  )
  return {
    executable,
    calls: async (): Promise<Array<RecordedCall>> =>
      (await Fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RecordedCall)
  }
}

describe("security review aggregate limits", () => {
  it.each(["count", "bytes"] as const)(
    "retains completed attempts when individually valid batches exceed aggregate %s",
    async (limit) => {
      const cli = await fixture(limit)
      let launches = 0
      const failure = await Effect.runPromise(Effect.flip(
        Review.review({
          workspaceRoot: root,
          executable: cli.executable,
          snapshot: ["src/a.ts", "src/z.ts"].map((path) => ({
            path,
            contents: "const PASSWORD = \"live\"\n",
            changed: true
          }))
        }, {
          base: "HEAD",
          include: [Input.glob("src/**")],
          context: [],
          prompt: "Review",
          rubric: "Inspect the general security check.",
          engine: "claude",
          model: "fixture-primary",
          alternateModel: "fixture-alternate",
          batchSize: 1,
          failOn: "error",
          securityChecks: ["general"]
        }).pipe(Effect.provideService(Process, {
          spawn: (options) => {
            launches++
            return ScopedProcess.spawn(options)
          },
          status: ScopedProcess.status
        }))
      ))
      expect(failure).toMatchObject({
        _tag: "smithers-build/LlmReviewError",
        phase: "parse",
        message: limit === "count"
          ? `model returned more than ${Review.maximumFindings} findings`
          : `model findings exceed ${Review.maximumFindingBytes} bytes`
      })
      const attempts = (failure as Review.LlmReviewError).attempts!
      expect(Object.hasOwn(failure, "attempts")).toBe(true)
      expect(attempts).toHaveLength(8)
      expect(attempts.map(({ batch, pass, purpose, engine, status }) => ({ batch, pass, purpose, engine, status })))
        .toEqual([0, 1].flatMap((batch) => [
          { batch, pass: 1, purpose: "review", engine: "claude", status: "completed" },
          { batch, pass: 2, purpose: "review", engine: "codex", status: "completed" },
          { batch, pass: 3, purpose: "review", engine: "claude", status: "completed" },
          { batch, pass: 2, purpose: "verify", engine: "codex", status: "completed" }
        ]))
      expect(Buffer.byteLength(JSON.stringify(attempts))).toBeLessThan(Review.maximumFindingBytes)
      const calls = await cli.calls()
      expect(calls).toHaveLength(8)
      expect(launches).toBe(8)
      expect(calls.map(({ file }) => file)).toEqual([
        ...Array<string>(4).fill("src/a.ts"),
        ...Array<string>(4).fill("src/z.ts")
      ])
      expect(calls.map(({ engine }) => engine)).toEqual([
        "claude",
        "codex",
        "claude",
        "codex",
        "claude",
        "codex",
        "claude",
        "codex"
      ])
      for (const call of calls) {
        expect(call.outputBytes).toBeLessThan(Review.maximumModelOutputBytes)
        expect(call.findings).toBeLessThan(Review.maximumFindings)
        expect(call.normalizedBytes).toBeLessThan(Review.maximumFindingBytes)
        expect(call.prompt).not.toContain("\"live\"")
      }
      const verified = calls.filter(({ purpose }) => purpose === "verify")
      expect(verified).toHaveLength(2)
      if (limit === "count") {
        expect(verified.reduce((sum, call) => sum + call.findings + 1, 0)).toBeGreaterThan(Review.maximumFindings)
      } else {
        expect(verified.reduce((sum, call) => sum + call.normalizedBytes, 0))
          .toBeGreaterThan(Review.maximumFindingBytes)
      }
    }
  )
})
