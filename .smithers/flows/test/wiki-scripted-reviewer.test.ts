/**
 * The install's scripted model (@smthrs/testing BuiltinScript, served by the
 * real-run stand-in) reviews the pages the wiki flow really builds. Each test
 * runs smithers/Wiki end to end: Collect builds the evidence, the real
 * ReviewPage AgentAction renders its request, the scripted model answers it,
 * and exact assessment, the citation check and the verified write all hold.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Crypto } from "@smthrs/crypto"
import { BuiltinScript } from "@smthrs/testing"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import type { PageSpec } from "../wiki/schema.ts"

// Effect 4.1 removed effect/Crypto, and NodeServices.layer no longer provides it.
const nodeServices = Layer.merge(NodeServices.layer, Crypto.layerFromDigest(NodeCrypto.layerDigest))

/** A repository shaped like the install's real target (codeplanesmithers/canary-sandbox) plus the source shapes real repositories carry. */
const repository = async (t: TestContext, files: Readonly<Record<string, string>>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-wiki-scripted-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}
const canary = {
  "README.md": "# canary-sandbox\n\nSmithers Cloud canary fixture repo.\n",
  "package.json":
    "{\"name\":\"canary-sandbox\",\"private\":true,\"scripts\":{\"test\":\"node --check video-demo-server.mjs\"}}\n",
  "package-lock.json": "{\n  \"name\": \"canary-sandbox\",\n  \"lockfileVersion\": 3,\n  \"requires\": true\n}\n",
  "real-run-20261009-r14.md": "Hello from Smithers!\nHello from Smithers!\n",
  "video-demo-server.mjs": "import { createServer } from \"node:http\"\n",
  "big.txt": "x\n",
  "docs/nested/hello.txt": "hello\n"
}

/** A page of the install's generated catalog, as services/flow_config.go installWikiPages declares it. */
const generated = (id: string, title: string, sourceDirectory: string): PageSpec => ({
  id,
  title,
  purpose: "Describe the code with source citations",
  kind: "current",
  document: "",
  sourceDirectory,
  inputs: [],
  related: []
})

/**
 * Runs smithers/Wiki in verified mode with the scripted model as the reviewer
 * seat and the stand-in's judge answering the citation check.
 */
const refresh = async (root: string, pages: ReadonlyArray<PageSpec>) => {
  const { Action, Interpreter } = await import("@smthrs/flow")
  const { FlowEngine } = await import("@smthrs/engine")
  const { Layer, Stream } = await import("effect")
  const Model = await import("@smthrs/model/Model")
  const ModelEvent = await import("@smthrs/model/ModelEvent")
  const Evaluator = await import("@smthrs/model/Evaluator")
  const ScriptedJudge = await import("@smthrs/agent/ScriptedJudge")
  const Seat = await import("@smthrs/agent/Seat")
  const SeatResolver = await import("@smthrs/agent/SeatResolver")
  const { default: Wiki } = await import("../wiki/flow.ts")
  const { actionLayers, agentLayers } = await import("../wiki/runtime.ts")
  const steps: Array<string> = []
  const script = BuiltinScript.make()
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const turn = script.script(request)
        steps.push(turn?.name ?? "unscripted")
        assert.ok(turn !== undefined, "the scripted model has no answer for this turn")
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "review" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "review", text: turn.text }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "review" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
  const seats = SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({
        id,
        modelId: "scripted-install",
        model,
        contextWindowTokens: 200_000,
        route: {
          prepare: () =>
            Effect.succeed({
              routeId: "wiki-scripted",
              protocolId: "wiki-scripted",
              method: "POST",
              url: "https://example.invalid",
              publicHeaders: {},
              body: new TextEncoder().encode("{}"),
              bodyText: "{}"
            })
        }
      }))
  })
  // Jev as the stand-in answers it: the coding run's questions, the
  // completion brake's among them, and the citation check come from the same
  // script; the agent's own readings keep
  // the shared scripted answers.
  const judge = Evaluator.layerScripted((request) => {
    const ids = Object.keys(request.questions)
    if (BuiltinScript.isJudgement(request.questions) || (ids.length === 1 && ids[0] === "support")) {
      return Object.fromEntries(ids.map((id) => [id, BuiltinScript.answer(id, request.questions[id]!)]))
    }
    const agent = ScriptedJudge.answererFor(ids)
    if (agent !== undefined) return agent(request)
    return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: `unscripted: ${ids.join(",")}` }))
  })
  const output = join(root, ".flows/wiki")
  const layer = Layer.mergeAll(
    actionLayers({ root, output, evaluator: judge }),
    agentLayers(seats, 60_000, judge),
    Interpreter.layer(Wiki)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(nodeServices)
  )
  const receipt = await Effect.runPromise(Effect.scoped(
    Wiki.execute({ pages, mode: "verified", reviewer: "scripted-install" }, { executionId: "wiki-scripted" })
      .pipe(Effect.provide(layer))
  ))
  return { receipt, steps }
}

test(
  "the scripted reviewer verifies the install's generated pages on a real repository",
  { timeout: 120_000 },
  async (t) => {
    const root = await repository(t, {
      ...canary,
      // A symbol whose quoted line opens a bracket before the source link.
      "src/routes.ts":
        "export const routes = [\n  \"home\"\n]\nexport function handler(path: string): string {\n  return path\n}\n",
      // Windows line endings: each numbered line carries a carriage return.
      "src/windows.ts": "export const crlf = 1\r\nexport function lineEnding() {}\r\n",
      // A file with no symbol: the page cites its first line.
      "src/notes.md": "Plain notes without symbols.\n",
      // An empty source the inventory still captures.
      "src/empty.ts": ""
    })
    const pages = [
      generated("overview", "Overview", "."),
      generated("architecture", "Architecture", "."),
      generated("package-src", "src", "src")
    ]
    const { receipt, steps } = await refresh(root, pages)
    assert.equal(receipt.verification, "verified")
    assert.equal(receipt.pages, 3)
    // One review per page; no exact-validation repair was needed.
    assert.deepEqual(steps, ["wiki/review-page", "wiki/review-page", "wiki/review-page"])
  }
)

test("the scripted reviewer verifies declared current and intent pages, citing only visible lines", {
  timeout: 120_000
}, async (t) => {
  const root = await repository(t, {
    "src/routes.ts":
      "export const routes = [\n  \"home\"\n]\nexport function handler(path: string): string {\n  return path\n}\n",
    "docs/guide.md":
      "# Guide\n\nThe handler returns the path it is given.\n\n```ts\nexport function handler(path: string): string {\n```\n\n## Routes\n\nThe handler echoes its input:\n\n    return path\n",
    "docs/roadmap.md": "# Roadmap\n\nPlanned: a retry queue for failed deliveries.\n"
  })
  const pages: ReadonlyArray<PageSpec> = [
    {
      id: "guide",
      title: "Guide",
      purpose: "Explain the handler.",
      kind: "current",
      document: "docs/guide.md",
      inputs: ["src/routes.ts"],
      related: ["roadmap"],
      excerpts: { "src/routes.ts": [{ start: 4, end: 6 }] }
    },
    {
      id: "roadmap",
      title: "Roadmap",
      purpose: "Planned work.",
      kind: "intent",
      document: "docs/roadmap.md",
      inputs: [],
      related: []
    }
  ]
  const { receipt } = await refresh(root, pages)
  assert.equal(receipt.verification, "verified")
})
