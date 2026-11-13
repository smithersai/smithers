import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"

const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY"] as const
let root: string
let store: string
let saved: ReadonlyArray<string | undefined>

const write = async (relative: string, text: string): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  // A seat transport is the only credential route: no API key is on the box.
  saved = keys.map((name) => process.env[name])
  for (const name of keys) delete process.env[name]
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-transport-")))
  store = await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-transport-store-"))
  await write("src/a.ts", "export const a = 1\n")
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root })
  await write("src/a.ts", "export const a = 2\n")
})

afterEach(async () => {
  keys.forEach((name, index) => {
    const value = saved[index]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(store, { recursive: true, force: true })
})

const payload = (overrides: Partial<LlmLint.Payload> = {}): LlmLint.Payload => ({
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Rubric",
  engine: "claude",
  model: "claude-opus-5-5",
  batchSize: 1,
  failOn: "error",
  ...overrides
})

const completion = (findings: ReadonlyArray<unknown> = []) =>
  JSON.stringify({
    status: "completed",
    coverage: [{ checkId: "general", status: "completed", evidence: "Inspected src/a.ts." }],
    missingContext: [],
    findings
  })

type Seen = { seat: LlmLint.ReviewSeat; request: ModelRequest.ModelRequest }

/** A scripted seat model that answers every request with `answer` and records what it was sent. */
const seats = (
  answer: string | ((seat: LlmLint.ReviewSeat) => ReadonlyArray<ModelEvent.ModelEvent>),
  seen: Array<Seen>
): LlmLint.ReviewTransport =>
(seat) =>
  Effect.succeed({
    modelId: `resolved/${seat.model}`,
    model: Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          seen.push({ seat, request })
          return Stream.fromIterable(
            typeof answer === "function" ? answer(seat) : [
              ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: answer }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            ]
          )
        })
    })
  })

describe("LlmLint.review seat transport", () => {
  it("keeps distinct same-line security findings and the strongest impact of a repeat", async () => {
    const candidate = {
      file: "docs/shared.md",
      line: 1,
      severity: "warning",
      message: "A shared boundary needs validation.",
      security: {
        checkId: "general",
        impact: "low",
        verification: "suspected",
        releaseRecommendation: "review",
        attackerPreconditions: "An attacker controls the input.",
        evidence: "Input reaches the shared boundary.",
        nextConfirmationStep: "Trace input validation."
      }
    }
    const stronger = { ...candidate, security: { ...candidate.security, impact: "medium" } }
    const distinct = { ...candidate, message: "A separate boundary needs validation." }
    const seen: Array<Seen> = []
    const report = await Effect.runPromise(LlmLint.review({
      workspaceRoot: root,
      snapshot: [
        { path: "src/a.ts", contents: "export const a = 1\n", changed: true },
        { path: "src/b.ts", contents: "export const b = 1\n", changed: true },
        { path: "docs/shared.md", contents: "shared\n", changed: false }
      ],
      transport: seats(completion([candidate, stronger, distinct]), seen)
    }, payload({ context: [Input.glob("//docs/shared.md")], securityChecks: ["general"] })))
    expect(report.findings).toEqual([stronger, distinct])
    expect(new Set(report.attempts?.map((attempt) => attempt.batch)).size).toBe(2)
  })

  it.each([
    [130, 1],
    [86, 16 * 1024]
  ])(
    "resumes %i security batches without charging replayed receipts to invocation limits",
    async (count, evidenceBytes) => {
      const seen: Array<Seen> = []
      const answer = JSON.stringify({
        status: "completed",
        coverage: [
          { checkId: "general", status: "completed", evidence: "x".repeat(evidenceBytes) },
          { checkId: "boundary", status: "completed", evidence: "y".repeat(evidenceBytes) }
        ],
        missingContext: [],
        findings: []
      })
      const snapshot = Array.from({ length: count }, (_, index) => ({
        path: "src/f" + String(index).padStart(3, "0") + ".ts",
        contents: "export const f" + index + " = " + index + "\n",
        changed: true
      }))
      const options = {
        workspaceRoot: root,
        snapshot,
        revisions: { base: "a".repeat(40), head: "b".repeat(40) },
        transport: seats(answer, seen),
        store: { directory: store, owner: "//:security" }
      }
      const request = payload({ scope: "all", securityChecks: ["general", "boundary"] })
      const invocations = Math.ceil(count / LlmLint.maximumReviewBatches)
      for (let invocation = 1; invocation < invocations; invocation++) {
        const failure = await Effect.runPromise(Effect.flip(LlmLint.review(options, request)))
        expect(failure.message).toContain("Review incomplete")
        expect((failure as LlmLint.LlmReviewError).attempts).toHaveLength(
          invocation * LlmLint.maximumReviewBatches * 3
        )
        expect(seen).toHaveLength(invocation * LlmLint.maximumReviewBatches * 3)
      }
      const report = await Effect.runPromise(LlmLint.review(options, request))
      expect(report.files).toEqual(snapshot.map(({ path }) => path))
      expect(report.attempts).toHaveLength(count * 3)
      expect(seen).toHaveLength(count * 3)
      expect(report.findings).toEqual([])
      const [name] = await Fs.readdir(Path.join(store, "runs"))
      const record = JSON.parse(await Fs.readFile(Path.join(store, "runs", name!), "utf8")) as LlmLint.RunRecord
      expect(record.status).toBe("completed")
      expect(record.batches).toHaveLength(count)
      expect(record.usage.modelCalls).toBe(count * 3)
    }
  )

  it("runs every security pass through the host's seats with no API key and records the seat transport", async () => {
    const seen: Array<Seen> = []
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, transport: seats(completion(), seen), store: { directory: store, owner: "//:security" } },
      payload({ securityChecks: ["general"], required: true })
    ))
    expect(report.files).toEqual(["src/a.ts"])
    expect(report.findings).toEqual([])
    // Selected family, the other family, then the selected family again.
    expect(seen.map(({ seat }) => seat)).toEqual([
      { engine: "claude", model: "claude-opus-5-5" },
      { engine: "codex", model: "gpt-6-sol" },
      { engine: "claude", model: "claude-opus-5-5" }
    ])
    for (const { seat, request } of seen) {
      expect(request.modelId).toBe(`resolved/${seat.model}`)
      expect(request.tools).toEqual([])
      expect(request.toolChoice).toBe("none")
      expect(request.system.map((part) => part.text).join("\n")).toContain("Rubric:\nRubric")
    }
    expect(report.manifest?.engine.transport).toBe("seat")
    expect(report.manifest?.engine.executable).toBeUndefined()
  })

  it.each(["changed", "all"] as const)("reviews extglob includes in %s scope", async (scope) => {
    await write("src/b.ts", "export const b = 1\n")
    await write("src/a/x.ts", "export const x = 1\n")
    await write("src/b/x.ts", "export const x = 2\n")
    for (
      const [pattern, files] of [
        ["src/+(a|b).ts", ["src/a.ts", "src/b.ts"]],
        ["src/@(a|b).ts", ["src/a.ts", "src/b.ts"]],
        ["+(src)/@(a|b).ts", ["src/a.ts", "src/b.ts"]],
        ["src/+(a|b)/x.ts", ["src/a/x.ts", "src/b/x.ts"]]
      ] as const
    ) {
      const seen: Array<Seen> = []
      const report = await Effect.runPromise(LlmLint.review(
        { workspaceRoot: root, transport: seats("[]", seen) },
        payload({ include: [Input.glob(pattern)], scope })
      ))
      expect(report.files, pattern).toEqual(files)
      expect(seen.length, pattern).toBeGreaterThan(0)
    }
  })

  it.each(["claude", "codex"] as const)("uses a configured alternate model with primary %s", async (engine) => {
    const seen: Array<Seen> = []
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, transport: seats(completion(), seen), store: { directory: store, owner: "//:security" } },
      payload({ engine, model: "primary-model", alternateModel: "host-alternate-model", securityChecks: ["general"] })
    ))
    const expected = [
      { engine, model: "primary-model" },
      { engine: engine === "claude" ? "codex" : "claude", model: "host-alternate-model" },
      { engine, model: "primary-model" }
    ]
    expect(seen.map(({ seat }) => seat)).toEqual(expected)
    expect(report.manifest?.engine.seats).toEqual(expected)
    expect(report.attempts?.map(({ engine, model }) => ({ engine, model }))).toEqual(expected)
  })

  it("uses the configured alternate model for candidate verification", async () => {
    const seen: Array<Seen> = []
    const candidate = {
      file: "src/a.ts",
      line: 1,
      severity: "info",
      message: "The caller may supply unchecked input.",
      security: {
        checkId: "general",
        impact: "low",
        verification: "suspected",
        releaseRecommendation: "allow",
        attackerPreconditions: "A caller supplies input.",
        evidence: "The operation uses that input.",
        nextConfirmationStep: "Inspect validation at the caller."
      }
    }
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, transport: seats(completion([candidate]), seen) },
      payload({ alternateModel: "verification-model", securityChecks: ["general"] })
    ))
    expect(seen.map(({ seat }) => seat.model)).toEqual([
      "claude-opus-5-5",
      "verification-model",
      "claude-opus-5-5",
      "verification-model"
    ])
    expect(report.attempts?.at(-1)).toMatchObject({
      purpose: "verify",
      engine: "codex",
      model: "verification-model",
      attempt: 1
    })
  })

  it("leaves a failed model call to the durable engine without retrying inside the action", async () => {
    let calls = 0
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      {
        workspaceRoot: root,
        transport: () => {
          calls++
          return Effect.fail(new Error("seat temporarily unavailable"))
        }
      },
      payload({ securityChecks: ["general"] })
    )))
    expect(calls).toBe(1)
    expect(failure).toMatchObject({
      _tag: "smithers-build/LlmReviewError",
      phase: "review",
      message: "Review seat unavailable: seat temporarily unavailable",
      attempts: [{ pass: 1, attempt: 1, status: "failed" }]
    })
  })

  it("fails a required review when a seat is unavailable instead of skipping it", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, transport: () => Effect.fail(new Error("Claude Code is signed out")) },
      payload({ securityChecks: ["general"], required: true })
    )))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    expect(failure.message).toBe("Review seat unavailable: Claude Code is signed out")
  })

  it("returns a generic review's findings from the seat answer", async () => {
    const seen: Array<Seen> = []
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      {
        workspaceRoot: root,
        transport: seats(JSON.stringify([{ file: "src/a.ts", line: 1, severity: "error", message: "bad" }]), seen)
      },
      payload()
    )))
    expect(failure).toBeInstanceOf(LlmLint.FindingsError)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.seat).toEqual({ engine: "claude", model: "claude-opus-5-5" })
  })

  it.each(
    [
      [
        "a tool call",
        [
          ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "c", name: "shell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" })
        ]
      ],
      ["an unsettled stream", [ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "[]" })]],
      [
        "a token-limited answer",
        [
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "[" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "length" })
        ]
      ]
    ] as const
  )("rejects %s from a seat like any provider answer", async (_name, events) => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, transport: seats(() => events, []) },
      payload()
    )))
    expect(failure.message).toBe("Review inference failed or returned an incomplete response")
  })

  it("reports a seat's content filter as a refusal, never a clean review", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      {
        workspaceRoot: root,
        transport: seats(() => [ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "content-filter" })], [])
      },
      payload()
    )))
    expect(failure.message).toBe("Review provider refused the request")
  })

  it("refuses an executable override beside a seat transport", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: "claude", transport: seats("[]", []) },
      payload()
    )))
    expect(failure.message).toBe("LLM review takes an executable override or a seat transport, not both")
  })
})

it("reports unavailable default-provider credentials through the review error channel", async () => {
  // This file's native environment setup removes provider keys and restores
  // them afterward, so default inference must fail before any HTTP request.
  const failure = await Effect.runPromise(
    Effect.flip(LlmLint.review({ workspaceRoot: root }, payload({ scope: "all" })))
  )
  expect(failure).toMatchObject({ phase: "review" })
  expect(failure.message).toContain("Review requires ANTHROPIC_API_KEY")
})
