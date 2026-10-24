import * as Model from "@smthrs/model/Model"
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
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-review-failures-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload: Review.Payload = {
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review the source.",
  rubric: "Report defects.",
  engine: "claude",
  model: "claude-opus-5-5",
  batchSize: 1,
  failOn: "error",
  scope: "all"
}
const snapshot = [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }]
const fault: Review.ReviewTransport = () => Effect.fail(new Error("seat unavailable"))

it.each([
  { snapshot: [...snapshot, ...snapshot], message: "duplicate paths" },
  { snapshot: [{ ...snapshot[0]!, path: "../escape.ts" }], message: "escapes" },
  { snapshot: [{ ...snapshot[0]!, contents: "\ud800" }], message: "usable text" },
  {
    snapshot: Array.from(
      { length: Review.maximumReviewFiles + Review.maximumContextFiles + 1 },
      (_, i) => ({ path: "src/" + i + ".ts", contents: "", changed: true })
    ),
    message: "too many files"
  }
])("refuses an invalid immutable snapshot", async (probe) => {
  const failure = await Effect.runPromise(
    Effect.flip(Review.review({ workspaceRoot: root, snapshot: probe.snapshot, transport: fault }, payload))
  )
  expect(failure).toMatchObject({ phase: "read" })
  expect(failure.message.toLowerCase()).toContain(probe.message.toLowerCase())
})

it("requires declared context to exist in the snapshot", async () => {
  const failure = await Effect.runPromise(Effect.flip(Review.review(
    { workspaceRoot: root, snapshot, transport: fault },
    { ...payload, context: [Input.glob("docs/**")] }
  )))
  expect(failure).toMatchObject({ phase: "read", message: "Review context matched no snapshot files" })
})

it("selects changed snapshot files before asking an unavailable seat", async () => {
  const failure = await Effect.runPromise(Effect.flip(Review.review(
    { workspaceRoot: root, snapshot, transport: fault },
    { ...payload, scope: "changed" }
  )))
  expect(failure.message).toContain("seat unavailable")
})

it("does not select unchanged snapshot files for a required changed-only review", async () => {
  const failure = await Effect.runPromise(Effect.flip(Review.review(
    { workspaceRoot: root, snapshot: [{ ...snapshot[0]!, changed: false }], transport: fault },
    { ...payload, scope: "changed", required: true }
  )))
  expect(failure.message).toContain("selected no files")
})

it("removes private attempt messages and completion evidence from public failures", () => {
  const attempt = {
    batch: 0,
    pass: 1,
    purpose: "review" as const,
    engine: "claude" as const,
    model: "x",
    attempt: 1,
    status: "failed" as const,
    message: "private evidence"
  }
  const error = new Review.LlmReviewError({ phase: "parse", message: "private response", attempts: [attempt as never] })
  const publicError = Review.publicError(error)
  expect(JSON.stringify(publicError)).not.toContain("private response")
  expect(JSON.stringify(publicError)).not.toContain("private evidence")
  expect(JSON.stringify(publicError)).not.toContain("completion")
  expect(Review.publicAttempts(undefined)).toBeUndefined()
  const missing = new Review.ModelCliMissing({ engine: "claude", message: "missing", executable: "claude" } as never)
  expect(Review.publicError(missing)).toBe(missing)
})

it("bounds a model service that never settles without exposing its transport details", async () => {
  const transport: Review.ReviewTransport = () =>
    Effect.succeed({
      modelId: "non-settling-service",
      model: Model.make({ stream: () => Stream.never })
    })
  const error = await Effect.runPromise(Effect.flip(Review.review(
    { workspaceRoot: root, snapshot, transport, timeoutMs: 1 },
    payload
  )))
  expect(error).toMatchObject({ phase: "review" })
  expect(error.message).toContain("Review inference failed")
  expect(error.message).not.toContain("non-settling-service")
})

it("retains a safe non-parse diagnostic in the public error shape", () => {
  const error = new Review.LlmReviewError({ phase: "read", message: "the input could not be read" })
  expect(Review.publicError(error)).toMatchObject({ phase: "read", message: "the input could not be read" })
})

it("refuses excess credential discoveries before obtaining a model seat", async () => {
  let requests = 0
  const contents = Array.from({ length: 10_002 }, (_, i) => `API_KEY_${i} = "synthetic-value-${i}-long-enough"`).join(
    "\n"
  )
  const error = await Effect.runPromise(Effect.flip(Review.review(
    {
      workspaceRoot: root,
      snapshot: [{ path: "src/secrets.ts", contents, changed: true }],
      transport: () => {
        requests++
        return Effect.fail(new Error("seat unavailable"))
      }
    },
    payload
  )))
  expect(error.message).toContain("Too many credential discoveries")
  expect(requests).toBe(0)
})

it.each(["API_KEY = \"unfinished", "API_KEY = \"unfinished\n", "API_KEY = \"unfinished\r", "API_KEY = \"unfinished\\"])(
  "does not mistake an unterminated literal for a complete credential",
  (source) => {
    expect(Review.redactCredentials(source)).toBe(source)
  }
)

it("attributes a real failing default model invocation to review", async () => {
  const error = await Effect.runPromise(Effect.flip(Review.review(
    { workspaceRoot: root, snapshot, executable: process.execPath, timeoutMs: 1000 },
    payload
  )))
  expect(error).toMatchObject({ phase: "review" })
})
it("reports a non-executable model entrypoint after computing its identity", async () => {
  const executable = join(root, "broken-model.mjs")
  await Fs.writeFile(executable, "throw new Error('deliberately broken model entrypoint')\n")
  const error = await Effect.runPromise(Effect.flip(Review.review(
    { workspaceRoot: root, snapshot, executable, timeoutMs: 1000 },
    payload
  )))
  expect(error).toMatchObject({ phase: "review" })
})
it("rejects oversized executable text before invoking a child", async () => {
  const error = await Effect.runPromise(Effect.flip(Review.promptEngine(
    { workspaceRoot: root, executable: "x".repeat(17000) },
    { engine: "claude", model: "test", prompt: "inspect" }
  )))
  expect(error.message).toContain("exceeds")
})

it("returns empty security attempts when an optional changed-only review selects nothing", async () => {
  const result = await Effect.runPromise(Review.review(
    { workspaceRoot: root, snapshot: [{ ...snapshot[0]!, changed: false }], transport: fault },
    { ...payload, scope: "changed", securityChecks: ["general"] }
  ))
  expect(result).toMatchObject({ files: [], findings: [], attempts: [] })
})
