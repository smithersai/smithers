import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Cause from "effect/Cause"
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

let store: string
beforeEach(() => {
  store = join(root, ".private", "findings")
})

const key = (body: string, newline = "\n") =>
  ["-----BEGIN PRIVATE KEY-----", ...Array<string>(26).fill(body), "-----END PRIVATE KEY-----"].join(newline)
const firstKey = key("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=")
const secondKey = key("bW5vcHFyc3R1dnd4eXoYWJjZGVmZ2hpamts=")
const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
const revisions = { base: "a".repeat(40), head: "b".repeat(40) }
// Inject an Effect model service at the review's supported transport boundary.
const transport = (
  response: ReadonlyArray<Review.Finding>,
  seen: Array<ModelRequest.ModelRequest>
): Review.ReviewTransport =>
() =>
  Effect.succeed({
    modelId: "credential-review-service",
    model: Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          seen.push(request)
          return Stream.make(
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text", text: JSON.stringify(response) }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          )
        })
    })
  })

const storedRun = async (): Promise<{ path: string; record: Review.RunRecord }> => {
  const names = await Fs.readdir(join(store, "runs"))
  expect(names).toHaveLength(1)
  const path = join(store, "runs", names[0]!)
  return { path, record: JSON.parse(await Fs.readFile(path, "utf8")) as Review.RunRecord }
}

it.each(["\n", "\r\n"])("preserves %j separators while masking multiline and overlapping credentials", (newline) => {
  const credential = key(token, newline)
  const source = ["before", credential, "after", token, ""].join(newline)
  const masked = Review.redactCredentials(source)
  expect(masked.split("\n")).toHaveLength(source.split("\n").length)
  expect(masked.match(/\r?\n/g)).toEqual(source.match(/\r?\n/g))
  expect(masked.split(newline)[29]).toBe("after")
  expect(masked).toContain("<credential:private-key:")
  expect(masked).not.toContain("PRIVATE KEY")
  expect(masked).not.toContain(token)
})

it("keeps JSON-escaped multiline credential replacements on their original line", () => {
  const source = `const privateKey = ${JSON.stringify(firstKey)}\nconst value = 1\n`
  const masked = Review.redactCredentials(source)
  expect(masked.split("\n")).toHaveLength(3)
  expect(masked.split("\n")[1]).toBe("const value = 1")
  expect(masked).toContain("<credential:")
  expect(masked).not.toContain("YWJjZGVm")
})

it.each([["another private key", secondKey], ["a token", token]])(
  "stores credentials followed by %s at real source lines and resumes completed batches",
  async (_, following) => {
    const contents = ["export const a = 1", firstKey, "export const b = 2", following, "danger()", ""].join("\n")
    const seen: Array<ModelRequest.ModelRequest> = []
    const options = {
      workspaceRoot: root,
      revisions,
      snapshot: [{ path: "src/a.ts", contents, changed: true }],
      transport: transport([], seen),
      store: { directory: store }
    }
    const failure = await Effect.runPromise(Effect.flip(Review.review(options, payload)))
    expect(failure).toBeInstanceOf(Review.FindingsError)
    const findings = (failure as Review.FindingsError).findings
    expect(findings.filter(({ severity }) => severity === "error").map(({ line }) => line).sort((a, b) => a - b))
      .toEqual([2, 31])
    expect((failure as Review.FindingsError).fingerprints).toHaveLength(2)
    const records = await Effect.runPromise(Review.storedFindings(store))
    expect(records.map(({ finding }) => finding.line).sort((a, b) => a - b)).toEqual([2, 31])
    const { path, record } = await storedRun()
    expect(record.status).toBe("completed")
    expect(record.manifest.batches[0]!.changed[0]!.lastLine).toBe(contents.split("\n").length)
    expect(record.usage.modelCalls).toBe(1)
    const request = JSON.stringify(seen)
    expect(request).toContain("<credential:private-key:")
    expect(request).not.toContain("YWJjZGVm")
    expect(request).not.toContain(token)
    expect(JSON.stringify(records)).not.toContain("YWJjZGVm")
    expect(JSON.stringify(records)).not.toContain(token)

    // Replay a completed batch from a run interrupted before final settlement.
    await Fs.writeFile(path, JSON.stringify({ ...record, status: "running" }))
    const resumed = await Effect.runPromise(Effect.flip(Review.review(options, payload)))
    expect(resumed).toBeInstanceOf(Review.FindingsError)
    expect((resumed as Review.FindingsError).fingerprints).toEqual((failure as Review.FindingsError).fingerprints)
    expect(seen).toHaveLength(1)
    expect((await storedRun()).record.status).toBe("completed")
  }
)

it("accepts model findings below a multiline credential at the original source line", async () => {
  const contents = [firstKey, "danger()", ""].join("\n")
  const finding: Review.Finding = { file: "src/a.ts", line: 29, severity: "warning", message: "danger() is unsafe" }
  const seen: Array<ModelRequest.ModelRequest> = []
  const failure = await Effect.runPromise(Effect.flip(Review.review({
    workspaceRoot: root,
    revisions,
    snapshot: [{ path: "src/a.ts", contents, changed: true }],
    transport: transport([finding], seen),
    store: { directory: store }
  }, payload)))
  expect(failure).toBeInstanceOf(Review.FindingsError)
  expect((failure as Review.FindingsError).findings).toContainEqual(finding)
  expect((await storedRun()).record.status).toBe("completed")
})

it.each([
  { file: "src/a.ts", line: 99 },
  { file: "src/missing.ts", line: 1 }
])("fails a replayed finding with no source line as a typed store error: %j", async (location) => {
  const seen: Array<ModelRequest.ModelRequest> = []
  const options = {
    workspaceRoot: root,
    revisions,
    snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }],
    transport: transport([], seen),
    store: { directory: store }
  }
  await Effect.runPromise(Review.review(options, payload))
  const { path, record } = await storedRun()
  await Fs.writeFile(
    path,
    JSON.stringify({
      ...record,
      status: "running",
      batches: [{ ...record.batches[0], findings: [{ ...location, severity: "warning", message: "inspect" }] }]
    })
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    const failure = await Effect.runPromise(Effect.flip(Review.review(options, payload)))
    expect(failure).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "store" })
    expect(failure.message).toContain("source line")
    expect((await storedRun()).record.status).toBe("failed")
  }
  expect(seen).toHaveLength(1)
})

it("marks a defect failed without persisting its private details and resumes successfully", async () => {
  const options = {
    workspaceRoot: root,
    revisions,
    snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }],
    store: { directory: store }
  }
  const exit = await Effect.runPromiseExit(Review.review({
    ...options,
    transport: () => Effect.die(new Error(`private response ${token}`))
  }, payload))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") expect(Cause.hasDies(exit.cause)).toBe(true)
  const { record } = await storedRun()
  expect(record).toMatchObject({ status: "failed", error: "Review failed unexpectedly", usage: { modelCalls: 1 } })
  expect(JSON.stringify(record)).not.toContain("private response")
  expect(JSON.stringify(record)).not.toContain(token)
  const seen: Array<ModelRequest.ModelRequest> = []
  await Effect.runPromise(Review.review({ ...options, transport: transport([], seen) }, payload))
  expect(seen).toHaveLength(1)
  expect((await storedRun()).record).toMatchObject({ status: "completed", usage: { modelCalls: 2 } })
})
