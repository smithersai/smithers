import { Flow, FlowRuntime } from "@smthrs/flow"
import { Evaluator } from "@smthrs/model"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import { escape } from "minimatch"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as JevLint from "../src/JevLint.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

let root: string
let savedKey: string | undefined

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-jevlint-")))
  savedKey = process.env[JevLint.keyVariable]
})

afterEach(async () => {
  if (savedKey === undefined) delete process.env[JevLint.keyVariable]
  else process.env[JevLint.keyVariable] = savedKey
  await Fs.rm(root, { recursive: true, force: true })
})

type PayloadRule = JevLint.Payload["rules"][number]

const rule = (id: string, pattern: string, overrides: Partial<PayloadRule> = {}): PayloadRule => ({
  id,
  files: [Input.glob(pattern)],
  lookFor: `Does this file break ${id}?`,
  violation: `It breaks ${id}.`,
  compliant: `It keeps ${id}.`,
  severity: "error",
  ...overrides
})

const payload = (rules: ReadonlyArray<PayloadRule>, overrides: Partial<JevLint.Payload> = {}): JevLint.Payload => ({
  rules,
  threshold: 0.8,
  failOn: "error",
  model: "typesafe-ai/jev",
  ...overrides
})

/** A scripted judge that records every question set it is asked. */
const recording = (answer: (request: Evaluator.Request) => ReturnType<Evaluator.Script>) => {
  const requests: Array<Evaluator.Request> = []
  const judge = Evaluator.layerScripted((request) => {
    requests.push(request)
    return answer(request)
  })
  return { judge, requests }
}

/** Every question answered with the probability its rule id maps to (0 when unmapped). */
const answering = (probabilities: Readonly<Record<string, number>>) => (request: Evaluator.Request) =>
  Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: probabilities[id] ?? 0 }]))

const review = (
  body: JevLint.Payload,
  options: Partial<JevLint.ReviewOptions> = {}
): Promise<LlmLint.Report> => Effect.runPromise(JevLint.review({ workspaceRoot: root, ...options }, body))

const failure = (
  body: JevLint.Payload,
  options: Partial<JevLint.ReviewOptions> = {}
): Promise<LlmLint.LlmReviewError | LlmLint.FindingsError> =>
  Effect.runPromise(Effect.flip(JevLint.review({ workspaceRoot: root, ...options }, body)))

describe("JevLint.review", () => {
  it("asks every rule covering a file in one call and reports a yes at or above the threshold", async () => {
    await write("src/at.ts", "export const at = 1\n")
    await write("src/above.ts", "export const above = 1\n")
    await write("src/below.ts", "export const below = 1\n")
    const { judge, requests } = recording((request) => {
      const path = (request.state as { readonly path: string }).path
      const probability = path === "src/at.ts" ? 0.8 : path === "src/above.ts" ? 0.95 : 0.79
      return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability }]))
    })
    const report = await review(payload([rule("one", "src/*.ts", { severity: "warning" })]), { judge })
    expect(requests).toHaveLength(3)
    expect(report.files).toEqual(["src/above.ts", "src/at.ts", "src/below.ts"])
    expect(report.findings).toEqual([
      { file: "src/above.ts", line: 1, severity: "warning", message: "one: It breaks one. (Jev 0.95)" },
      { file: "src/at.ts", line: 1, severity: "warning", message: "one: It breaks one. (Jev 0.80)" }
    ])
    expect(report.usage).toEqual({ modelCalls: 3, promptTokens: 0 })
  })

  it("sends the file as state and each covering rule as a boolean question with its criteria", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write("docs/a.md", "# A\n")
    const { judge, requests } = recording(answering({}))
    await review(payload([rule("code", "src/**"), rule("all", "**/a.*")]), { judge, concurrency: 1 })
    expect(requests.map((request) => (request.state as { readonly path: string }).path)).toEqual([
      "docs/a.md",
      "src/a.ts"
    ])
    expect(Object.keys(requests[0]!.questions)).toEqual(["all"])
    expect(Object.keys(requests[1]!.questions)).toEqual(["code", "all"])
    expect(requests[1]!.state).toEqual({ path: "src/a.ts", contents: "export const a = 1\n" })
    const question = requests[1]!.questions["code"]!
    expect(question).toBeInstanceOf(Evaluator.BooleanQuestion)
    expect(question).toMatchObject({
      type: "boolean",
      instructions: "Does this file break code?",
      criteria: { true: "It breaks code.", false: "It keeps code." }
    })
  })

  it("fails on a finding that meets failOn, carrying every finding sorted by file then rule", async () => {
    await write("b.ts", "b\n")
    await write("a.ts", "a\n")
    const { judge } = recording(answering({ zeta: 0.9, alpha: 0.9 }))
    const error = await failure(
      payload([rule("zeta", "*.ts", { severity: "warning" }), rule("alpha", "*.ts"), rule("mid", "*.ts")]),
      { judge }
    )
    expect(error).toBeInstanceOf(LlmLint.FindingsError)
    expect(error).toMatchObject({ failOn: "error" })
    expect((error as LlmLint.FindingsError).findings.map((finding) => [finding.file, finding.message])).toEqual([
      ["a.ts", "alpha: It breaks alpha. (Jev 0.90)"],
      ["a.ts", "zeta: It breaks zeta. (Jev 0.90)"],
      ["b.ts", "alpha: It breaks alpha. (Jev 0.90)"],
      ["b.ts", "zeta: It breaks zeta. (Jev 0.90)"]
    ])
  })

  it("passes warning findings under failOn error and fails them under failOn warning", async () => {
    await write("a.ts", "a\n")
    const { judge } = recording(answering({ soft: 0.99 }))
    const rules = [rule("soft", "*.ts", { severity: "warning" })]
    const report = await review(payload(rules), { judge })
    expect(report.findings).toHaveLength(1)
    expect(await failure(payload(rules, { failOn: "warning" }), { judge })).toBeInstanceOf(LlmLint.FindingsError)
    expect(
      (await review(payload([rule("note", "*.ts", { severity: "info" })], { failOn: "warning" }), {
        judge: recording(answering({ note: 0.99 })).judge
      })).findings
    ).toHaveLength(1)
  })

  it("orders the report by file whatever order the judge answers in", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(`${name}.ts`, `${name}\n`)
    const delays: Record<string, number> = { "a.ts": 40, "b.ts": 0, "c.ts": 25, "d.ts": 5 }
    const judge = Evaluator.layerScripted((request) => {
      const path = (request.state as { readonly path: string }).path
      return Effect.as(Effect.sleep(delays[path]!), { r: { probability: 0.9 } })
    })
    const report = await review(payload([rule("r", "*.ts", { severity: "info" })]), { judge, concurrency: 4 })
    expect(report.findings.map((finding) => finding.file)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"])
  })

  it("masks credentials in the path and contents the judge sees and in the findings", async () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
    await write("src/config.ts", `export const githubToken = "${token}"\n`)
    const { judge, requests } = recording(answering({ leak: 0.9 }))
    const error = await failure(payload([rule("leak", "src/*.ts")]), { judge })
    expect(JSON.stringify(requests)).not.toContain(token)
    expect((requests[0]!.state as { readonly contents: string }).contents).toContain("export const githubToken")
    expect(JSON.stringify(error)).not.toContain(token)
  })

  it("fails a rule whose globs match no file", async () => {
    await write("src/a.ts", "a\n")
    const error = await failure(payload([rule("present", "src/*.ts"), rule("stale", "lib/*.ts")]), {
      judge: recording(answering({})).judge
    })
    expect(error).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "read" })
    expect(error.message).toContain("Rule stale matched no files")
  })

  it("expands workspace-rooted globs across nested packages and honors exclusions", async () => {
    await write("pkg/PACKAGE.ts", "export default {}\n")
    await write("pkg/src/a.ts", "a\n")
    await write("pkg/src/a.test.ts", "t\n")
    const { judge, requests } = recording(answering({}))
    await review(
      payload([{
        ...rule("nested", "unused"),
        files: [Input.glob("//pkg/src/*.ts", { exclude: ["//pkg/src/*.test.ts"] })]
      }]),
      { judge }
    )
    expect(requests.map((request) => (request.state as { readonly path: string }).path)).toEqual(["pkg/src/a.ts"])
  })

  it("fails a glob that leaves the workspace", async () => {
    const error = await failure(payload([rule("outside", "../*.ts")]), { judge: recording(answering({})).judge })
    expect(error).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "read" })
    expect(error.message).not.toBe("unknown failure")
  })

  it("refuses more files than one review admits", async () => {
    await Promise.all(
      Array.from({ length: LlmLint.maximumReviewFiles + 1 }, (_, index) => write(`many/f${index}.ts`, "x\n"))
    )
    const error = await failure(payload([rule("many", "many/*.ts")]), { judge: recording(answering({})).judge })
    expect(error.message).toContain(`more than ${LlmLint.maximumReviewFiles} files`)
  })

  it("never sends a file over Jev's window: it gets a not-judged finding and the rest is still judged", async () => {
    await write("big.ts", "x".repeat(JevLint.maximumJudgedFileBytes + 1))
    await write("edge.ts", "y".repeat(JevLint.maximumJudgedFileBytes))
    await write("small.ts", "z\n")
    const { judge, requests } = recording(answering({ size: 0.9 }))
    const report = await review(
      payload([rule("size", "*.ts", { severity: "info" }), rule("other", "big.ts", { severity: "warning" })]),
      { judge }
    )
    expect(requests.map((request) => (request.state as { readonly path: string }).path).sort()).toEqual([
      "edge.ts",
      "small.ts"
    ])
    expect(report.findings).toEqual([
      {
        file: "big.ts",
        line: 1,
        severity: "warning",
        message: `not-judged: ${JevLint.maximumJudgedFileBytes + 1} bytes is over the ` +
          `${JevLint.maximumJudgedFileBytes}-byte file Jev reads; split the file or narrow size, other`
      },
      { file: "edge.ts", line: 1, severity: "info", message: "size: It breaks size. (Jev 0.90)" },
      { file: "small.ts", line: 1, severity: "info", message: "size: It breaks size. (Jev 0.90)" }
    ])
    expect(report.usage).toEqual({ modelCalls: 2, promptTokens: 0 })
  })

  it("fails a file it cannot read as text, by name", async () => {
    await Fs.writeFile(NodePath.join(root, "binary.ts"), Buffer.from([0xff, 0xfe, 0xfd]))
    const { judge, requests } = recording(answering({}))
    const error = await failure(payload([rule("text", "*.ts")]), { judge })
    expect(requests).toHaveLength(0)
    expect(error).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "read" })
    expect(error.message).toContain("binary.ts")
    expect(error.message).toContain("not valid UTF-8")
  })

  it("fails on a not-judged file whose error rule went unasked, under the default failOn", async () => {
    await write("big.ts", "x".repeat(JevLint.maximumJudgedFileBytes + 1))
    const { judge, requests } = recording(answering({}))
    const error = await failure(
      payload([
        rule("advisory", "*.ts", { severity: "warning" }),
        rule("gate", "big.ts"),
        rule("note", "*.ts", { severity: "info" })
      ]),
      { judge }
    )
    expect(requests).toHaveLength(0)
    expect(error).toMatchObject({ _tag: "smithers-build/FindingsError", failOn: "error" })
    expect((error as LlmLint.FindingsError).findings).toEqual([{
      file: "big.ts",
      line: 1,
      severity: "error",
      message: `not-judged: ${JevLint.maximumJudgedFileBytes + 1} bytes is over the ` +
        `${JevLint.maximumJudgedFileBytes}-byte file Jev reads; split the file or narrow advisory, gate, note`
    }])
  })

  it("keeps an unjudged info-only file advisory unless failOn includes info", async () => {
    await write("big.ts", "x".repeat(JevLint.maximumJudgedFileBytes + 1))
    const { judge, requests } = recording(answering({}))
    const rules = [rule("note", "*.ts", { severity: "info" })]
    const report = await review(payload(rules), { judge })
    expect(report.findings).toMatchObject([{ file: "big.ts", severity: "info" }])
    expect(report.findings[0]!.message).toMatch(/^not-judged:/)
    const error = await failure(payload(rules, { failOn: "info" }), { judge })
    expect(error).toMatchObject({
      _tag: "smithers-build/FindingsError",
      failOn: "info",
      findings: [{ file: "big.ts", severity: "info" }]
    })
    expect(requests).toHaveLength(0)
  })

  it("fails on a not-judged file when failOn is warning", async () => {
    await write("big.ts", "x".repeat(JevLint.maximumJudgedFileBytes + 1))
    const { judge, requests } = recording(answering({}))
    const error = await failure(payload([rule("size", "*.ts", { severity: "warning" })], { failOn: "warning" }), {
      judge
    })
    expect(requests).toHaveLength(0)
    expect(error).toMatchObject({ _tag: "smithers-build/FindingsError", failOn: "warning" })
    expect((error as LlmLint.FindingsError).findings.map((finding) => finding.message.split(":")[0])).toEqual([
      "not-judged"
    ])
  })

  it("fails a file that disappears between discovery and its read", async () => {
    await write("a.ts", "a\n")
    await write("b.ts", "b\n")
    const judge = Evaluator.layerScripted((request) =>
      Effect.as(Effect.promise(() => Fs.rm(NodePath.join(root, "b.ts"))), {
        [Object.keys(request.questions)[0]!]: { probability: 0 }
      })
    )
    const error = await failure(payload([rule("gone", "*.ts")]), { judge, concurrency: 1 })
    expect(error).toMatchObject({ phase: "read", message: "Jev review file disappeared after discovery: b.ts" })
  })

  it("fails with Jev's public message, never the transport's own text", async () => {
    await write("a.ts", "a\n")
    const unreachable = Evaluator.layerScripted(() =>
      Effect.fail(
        new Evaluator.EvaluatorError({ code: "unreachable", message: "connect ECONNREFUSED 10.1.2.3:443 sk-private" })
      )
    )
    const error = await failure(payload([rule("r", "*.ts")]), { judge: unreachable })
    expect(error).toMatchObject({ phase: "review", message: `a.ts: ${Evaluator.unreachableMessage}` })
    const limited = Evaluator.layerScripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 429, message: "upstream body" }))
    )
    const quota = await failure(payload([rule("r", "*.ts")]), { judge: limited })
    expect(quota.message).toContain("usage limit (429)")
    expect(quota.message).not.toContain("upstream body")
  })

  it("fails parse when a question is left unanswered or answered with another shape", async () => {
    await write("a.ts", "a\n")
    const missing = await failure(payload([rule("r", "*.ts")]), { judge: recording(() => ({})).judge })
    expect(missing).toMatchObject({ phase: "parse", message: "a.ts: Jev gave no yes-or-no answer for r" })
    const choice = await failure(payload([rule("r", "*.ts")]), {
      judge: recording(() => ({ r: { type: "choice", choice: "yes" } })).judge
    })
    expect(choice).toMatchObject({ phase: "parse" })
  })

  it("fails a payload its schema rejects before reading anything", async () => {
    const error = await failure(payload([rule("r", "*.ts")], { threshold: 2 }), {
      judge: recording(answering({})).judge
    })
    expect(error).toMatchObject({ _tag: "smithers-build/LlmReviewError", phase: "review" })
    const duplicate = await failure(payload([rule("r", "*.ts"), rule("r", "*.md")]), {
      judge: recording(answering({})).judge
    })
    expect(duplicate.message).toContain("Rule id r is declared more than once")
  })

  it("fails when the workspace root does not exist", async () => {
    const error = await failure(payload([rule("r", "*.ts")]), {
      workspaceRoot: NodePath.join(root, "missing"),
      judge: recording(answering({})).judge
    })
    expect(error).toMatchObject({ phase: "read" })
  })

  it("fails when the judge cannot start", async () => {
    await write("a.ts", "a\n")
    const broken = Layer.effect(Evaluator.Evaluator, Effect.fail(new Error("no seat")))
    const error = await failure(payload([rule("r", "*.ts")]), { judge: broken })
    expect(error).toMatchObject({ phase: "review", message: "Jev judge could not start: no seat" })
  })
})

describe("JevLint default judge", () => {
  it("fails without a gateway key and never skips", async () => {
    await write("a.ts", "a\n")
    delete process.env[JevLint.keyVariable]
    expect(await failure(payload([rule("r", "*.ts")]))).toMatchObject({
      phase: "review",
      message: "Jev review requires AI_GATEWAY_API_KEY"
    })
    process.env[JevLint.keyVariable] = "   "
    expect((await failure(payload([rule("r", "*.ts")]))).message).toBe("Jev review requires AI_GATEWAY_API_KEY")
  })

  /** A loopback gateway that answers Jev's wire protocol, recording each request. */
  const gateway = async (
    respond: (body: { readonly questions: Record<string, unknown> }, response: Http.ServerResponse) => void
  ) => {
    const seen: Array<{ readonly authorization: string | undefined; readonly model: string | undefined }> = []
    const server = Http.createServer((request, response) => {
      let text = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        text += chunk
      })
      request.on("end", () => {
        seen.push({
          authorization: request.headers.authorization,
          model: request.headers["ai-model-id"] as string | undefined
        })
        respond(JSON.parse(text) as { readonly questions: Record<string, unknown> }, response)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    return {
      url: `http://127.0.0.1:${port}/v4/ai/evaluation-model`,
      seen,
      close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it("asks Jev through the gateway with the key and model, and sums the input tokens", async () => {
    await write("a.ts", "a\n")
    await write("b.ts", "b\n")
    process.env[JevLint.keyVariable] = "vck-test"
    const server = await gateway((body, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { type: "boolean", probability: 0.1 }])
        ),
        usage: { inputTokens: 21, outputTokens: 3 }
      }))
    })
    try {
      const report = await review(payload([rule("r", "*.ts")], { model: "typesafe-ai/jev-next" }), {
        gatewayUrl: server.url,
        timeoutMs: 10_000
      })
      expect(report.usage).toEqual({ modelCalls: 2, promptTokens: 42 })
      expect(server.seen).toEqual([
        { authorization: "Bearer vck-test", model: "typesafe-ai/jev-next" },
        { authorization: "Bearer vck-test", model: "typesafe-ai/jev-next" }
      ])
    } finally {
      await server.close()
    }
  })

  it("asks Jev's own endpoint by default, without redirects or ambient credentials", async () => {
    await write("a.ts", "a\n")
    process.env[JevLint.keyVariable] = "vck-test"
    const sent: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const provider: typeof globalThis.fetch = async (input, init) => {
      sent.push({ url: String(input), init })
      return new Response(JSON.stringify({ answers: { r: { type: "boolean", probability: 0.2 } } }), {
        headers: { "content-type": "application/json" }
      })
    }
    const report = await Effect.runPromise(
      JevLint.review({ workspaceRoot: root }, payload([rule("r", "*.ts")])).pipe(
        Effect.provideService(FetchHttpClient.Fetch, provider)
      )
    )
    expect(report).toMatchObject({ files: ["a.ts"], findings: [], usage: { modelCalls: 1, promptTokens: 0 } })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(Evaluator.defaultBaseUrl)
    expect(sent[0]!.init).toMatchObject({ redirect: "error", credentials: "omit" })
    expect(new Headers(sent[0]!.init?.headers).get("ai-model-id")).toBe("typesafe-ai/jev")
  })

  it("refuses to follow a gateway redirect with the key", async () => {
    await write("a.ts", "a\n")
    process.env[JevLint.keyVariable] = "vck-test"
    const server = await gateway((_body, response) => {
      response.statusCode = 307
      response.setHeader("location", "http://127.0.0.1:9/elsewhere")
      response.end()
    })
    try {
      const error = await failure(payload([rule("r", "*.ts")]), { gatewayUrl: server.url })
      expect(error).toMatchObject({ phase: "review", message: `a.ts: ${Evaluator.unreachableMessage}` })
    } finally {
      await server.close()
    }
  })
})

describe("JevReviewLive", () => {
  it("registers the review action and runs it against the workspace", async () => {
    await write("a.ts", "a\n")
    type Registered = (
      payload: JevLint.Payload,
      executionId: string
    ) => Effect.Effect<LlmLint.Report, JevLint.ReviewError>
    let registered: Registered | undefined
    const runtime = FlowRuntime.FlowRuntime.of(
      {
        register: (_flow: unknown, execute: Registered) =>
          Effect.sync(() => {
            registered = execute
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"]
    )
    const report = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(
        JevLint.JevReviewLive({ workspaceRoot: root, judge: recording(answering({ r: 0.5 })).judge }).pipe(
          Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
        )
      )
      const instance = FlowRuntime.FlowInstance.of({
        executionId: "jev-live-test",
        actionState: { count: 0, latch: Latch.makeUnsafe() }
      } as never)
      return yield* registered!(payload([rule("r", "*.ts")]), "jev-live-test").pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
    })))
    expect(report).toMatchObject({ files: ["a.ts"], findings: [] })
  })
})

describe("JevLint declaration", () => {
  const declared = {
    id: "durable.no-retries",
    files: [Input.glob("//apps/mvp/worker/**/*.ts"), Input.file("//apps/mvp/src/[id].ts")],
    lookFor: "Does this file write its own retry loop?",
    violation: "It hand-rolls retries.",
    compliant: "It has no retry loop."
  }

  it("defaults to a manual, non-cacheable lint target that asks Jev at 0.8", () => {
    const target = JevLint.JevLint({ rules: [declared] })
    const metadata = Target.metadata(target)
    expect(metadata.kinds).toEqual(["lint"])
    expect(metadata.cacheable).toBe(false)
    expect(metadata.manual).toBe(true)
    expect(metadata.attrs).toMatchObject({ threshold: 0.8, failOn: "error", model: "typesafe-ai/jev", deps: [] })
    expect(Target.metadata(JevLint.JevLint({ rules: [declared], manual: false })).manual).toBe(false)
  })

  it("lowers files to escaped globs and resolves each rule's severity", () => {
    const files = [
      Input.glob("//apps/mvp/worker/**/*.ts"),
      Input.glob(escape("//apps/mvp/src/[id].ts", { windowsPathsNoEscape: true }))
    ]
    const target = Smithers.JevLint({
      rules: [declared, { ...declared, id: "durable.no-sweeps", severity: "warning" }],
      threshold: 0.9,
      failOn: "warning"
    })
    const calls = plannedCalls(target)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.action).toBe("smithers-build/jev-review")
    expect(calls[0]!.payload).toEqual({
      rules: [
        {
          ...declared,
          files,
          severity: "error"
        },
        {
          ...declared,
          id: "durable.no-sweeps",
          files,
          severity: "warning"
        }
      ],
      threshold: 0.9,
      failOn: "warning",
      model: "typesafe-ai/jev"
    })
  })

  it("rejects duplicate rule ids, a bad id, no rules and a threshold out of bounds", () => {
    expect(() => JevLint.JevLint({ rules: [declared, declared] })).toThrow(/declared more than once/)
    expect(() => JevLint.JevLint({ rules: [{ ...declared, id: "Bad Id" }] })).toThrow()
    expect(() => JevLint.JevLint({ rules: [] })).toThrow()
    expect(() => JevLint.JevLint({ rules: [declared], threshold: 0.49 })).toThrow()
    expect(() => JevLint.JevLint({ rules: [declared], threshold: 1 })).toThrow()
    expect(() => JevLint.JevLint({ rules: [{ ...declared, lookFor: "  " }] })).toThrow()
    expect(() => JevLint.JevLint({ rules: [{ ...declared, files: [] }] })).toThrow()
  })
})
