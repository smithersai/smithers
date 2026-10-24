import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Review from "../src/LlmLint.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-review-limits-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload: Review.Payload = {
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Find defects.",
  engine: "claude",
  model: "claude-opus-5-5",
  batchSize: 1,
  failOn: "error",
  scope: "all"
}
const snapshot = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    path: "src/f" + i + ".ts",
    contents: "export const value = 1\n",
    changed: true
  }))
// Deliberately overproducing Effect model services exercise the production
// aggregation limits. No module or platform operation is mocked.
const transport = (response: (request: ModelRequest.ModelRequest) => string): Review.ReviewTransport => () =>
  Effect.succeed({
    modelId: "overproducing-test-service",
    model: Model.make({
      stream: (request) =>
        Stream.suspend(() =>
          Stream.make(
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text", text: response(request) }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          )
        )
    })
  })
const findings = (request: ModelRequest.ModelRequest, count: number, padding = "") => {
  const file = JSON.stringify(request).match(/src\/f\d+\.ts/)?.[0]
  if (file === undefined) throw new Error("the request omitted its review file")
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({ file, line: 1, severity: "info", message: "issue " + i + padding }))
  )
}

it("bounds the aggregate count across individually valid model batches", async () => {
  const error = await Effect.runPromise(Effect.flip(Review.review({
    workspaceRoot: root,
    snapshot: snapshot(3),
    transport: transport((request) => findings(request, 5000))
  }, payload)))
  expect(error).toMatchObject({ phase: "parse" })
  expect(error.message).toContain("more than 10000 findings")
}, 90_000)

it("bounds aggregate finding bytes across individually bounded model responses", async () => {
  const error = await Effect.runPromise(Effect.flip(Review.review({
    workspaceRoot: root,
    snapshot: snapshot(4),
    transport: transport((request) => findings(request, 600, "x".repeat(4096)))
  }, payload)))
  expect(error).toMatchObject({ phase: "parse" })
  expect(error.message).toContain("model findings exceed")
}, 90_000)

it.each(["claude", "codex"] as const)(
  "bounds cumulative security attempts across clean batches using %s",
  async (engine) => {
    let calls = 0
    const error = await Effect.runPromise(Effect.flip(Review.review({
      workspaceRoot: root,
      snapshot: snapshot(52),
      transport: transport((request) => {
        calls++
        return JSON.stringify({
          status: "completed",
          coverage: [{ checkId: "general", status: "completed", evidence: "Inspected the provided file." }],
          missingContext: [],
          findings: Array.from({ length: 2 }, (_, index) => ({
            file: JSON.stringify(request).match(/src\/f\d+\.ts/)![0],
            line: 1,
            severity: "info",
            message: "issue " + index,
            security: {
              checkId: "general",
              impact: "low",
              verification: "suspected",
              releaseRecommendation: "allow",
              attackerPreconditions: "A crafted input.",
              evidence: "The supplied source.",
              nextConfirmationStep: "Inspect the caller."
            }
          }))
        })
      })
    }, {
      ...payload,
      engine,
      model: engine === "claude" ? "claude-opus-5-5" : "gpt-6-sol",
      securityChecks: ["general"]
    })))
    expect(error).toMatchObject({ phase: "review" })
    expect(error.message).toContain("exceeds 256 model attempts")
    expect(calls).toBe(256)
  },
  90_000
)

it("bounds the union of independently produced security candidates", async () => {
  let pass = 0
  const error = await Effect.runPromise(Effect.flip(Review.review({
    workspaceRoot: root,
    snapshot: snapshot(1),
    transport: transport((request) => {
      const id = pass++
      return JSON.stringify({
        status: "completed",
        coverage: [{ checkId: "general", status: "completed", evidence: "Inspected the file." }],
        missingContext: [],
        findings: Array.from({ length: 4000 }, (_, i) => ({
          file: "src/f0.ts",
          line: 1,
          severity: "info",
          message: "candidate " + id + " " + i,
          security: {
            checkId: "general",
            impact: "low",
            verification: "suspected",
            releaseRecommendation: "allow",
            attackerPreconditions: "A crafted input.",
            evidence: "The supplied source.",
            nextConfirmationStep: "Inspect the caller."
          }
        }))
      })
    })
  }, { ...payload, securityChecks: ["general"] })))
  expect(error.message).toContain("candidate union exceeds")
  expect(pass).toBe(3)
}, 90_000)

it("bounds accumulated security completion receipts", async () => {
  const checks = ["general", ...Array.from({ length: 31 }, (_, i) => "check-" + i)]
  const error = await Effect.runPromise(Effect.flip(Review.review({
    workspaceRoot: root,
    snapshot: snapshot(12),
    transport: transport(() =>
      JSON.stringify({
        status: "completed",
        coverage: checks.map((checkId) => ({ checkId, status: "completed", evidence: "observed ".repeat(1700) })),
        missingContext: [],
        findings: []
      })
    )
  }, { ...payload, securityChecks: checks })))
  expect(error).toMatchObject({ phase: "review" })
  expect(error.message).toContain("attempt receipts exceed")
  if (!("attempts" in error)) throw new Error("expected attempt receipts")
  expect(error.attempts?.at(-1)?.status).toBe("failed")
}, 90_000)
