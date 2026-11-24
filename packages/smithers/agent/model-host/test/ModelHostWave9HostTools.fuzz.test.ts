import { Fuzz } from "@smthrs/fuzz"
import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { AgentTurnJournal, NativeAgent } from "@smthrs/rpc"
import { fixtures as homeFixtures } from "@smthrs/rpc/fixtures/Home"
import { fixtures as todoFixtures } from "@smthrs/rpc/fixtures/Todo"
import { Arbitrary, Effect, Logger, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { type DurableChatGrant, runDurableChatTurn } from "./fixtures/durable.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261172")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(20, Math.min(Math.ceil(baseExecutions / 4), 48))

const assertPassed = <A>(report: Fuzz.Report<A, any>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

const makeGrant = (withSource: boolean, withInstall: boolean): DurableChatGrant => {
  const cursor: AgentTurnJournal.AgentTurnCursor = {
    version: 1,
    runId: "run-w9",
    legId: "leg-w9",
    batch: 0,
    position: 0,
    hash: "a".repeat(64)
  }
  return {
    turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
    ownerId: 7,
    runId: "run-w9",
    legId: "leg-w9",
    generation: 2,
    token: "producer_capability_producer_capability_1234",
    cursor,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    request: {
      runId: "run-w9",
      instructions: "Answer briefly using tools.",
      messages: [{ role: "user", content: "Inspect repository and tasks." }]
    },
    producerBaseUrl: "http://callback.test/",
    ...(withSource ? { source: { repository: "acme/app" } } : {}),
    ...(withInstall
      ? {
        installOrigin: "http://127.0.0.1:4567",
        api: { author: "ben", token: `smithers_${"a".repeat(40)}` }
      }
      : {})
  }
}

describe("@smthrs/model-host Wave 9 deep HostTools fuzzing", () => {
  it(
    "HostTools handles file, files, todo, home, catalog commands, error codes, binary files, truncated dirs, and malformed args without crashing",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          cmdKind: Schema.Literals([
            "list-commands",
            "file-ok",
            "file-binary",
            "file-err",
            "files-ok",
            "files-err",
            "todo-read",
            "todo-create",
            "home",
            "unknown-cmd",
            "bad-json-args",
            "unknown-tool"
          ]),
          errorCode: Schema.Literals(["source_not_ready", "path_refused", "forbidden", "not_found", "too_large"]),
          withSource: Schema.Boolean,
          withInstall: Schema.Boolean,
          apiStatus: Schema.Literals([200, 400, 404, 500]),
          truncatedDir: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ cmdKind, errorCode, withSource, withInstall, apiStatus, truncatedDir }) =>
            Effect.gen(function*() {
              const turn = makeGrant(withSource, withInstall)
              let expected = turn.cursor
              const frames: Array<NativeAgent.AgentTurnFrame> = []

              const fetchImpl: NativeAgent.FetchLike = async (input, init) => {
                const url = new URL(String(input))
                if (url.pathname === "/internal/chat/provider-started") {
                  return new Response(null, { status: 204 })
                }
                if (url.pathname.startsWith("/api/")) {
                  if (apiStatus !== 200) {
                    return Response.json(
                      { code: "api_error", class: "user", message: `HTTP ${apiStatus}` },
                      { status: apiStatus }
                    )
                  }
                  if (url.pathname.includes("home")) {
                    return Response.json(homeFixtures.fresh.model, { status: 200 })
                  }
                  return Response.json(todoFixtures.queued.model, { status: 200 })
                }
                const body = JSON.parse(String(init?.body))
                if (url.pathname === "/internal/chat/source/read") {
                  if (cmdKind === "file-err") {
                    return Response.json({ status: "error", code: errorCode }, {
                      status: errorCode === "forbidden" ? 403 : 404
                    })
                  }
                  return Response.json({
                    repository: "acme/app",
                    path: body.path,
                    commit: COMMIT,
                    content: cmdKind === "file-binary" ? "\x00\x01\x02" : "hello world\nline 2\n",
                    binary: cmdKind === "file-binary"
                  })
                }
                if (url.pathname === "/internal/chat/source/list") {
                  if (cmdKind === "files-err") {
                    return Response.json({ status: "error", code: errorCode }, {
                      status: errorCode === "forbidden" ? 403 : 404
                    })
                  }
                  return Response.json({
                    repository: "acme/app",
                    path: body.path,
                    commit: COMMIT,
                    entries: [
                      { name: "README.md", kind: "file" },
                      { name: "src", kind: "dir" }
                    ],
                    truncated: truncatedDir
                  })
                }
                const frame = body.frames[0] as NativeAgent.AgentTurnFrame
                frames.push(frame)
                const unsigned = {
                  version: 1 as const,
                  runId: turn.runId,
                  legId: turn.legId,
                  batch: expected.batch + 1,
                  from: expected.position + 1,
                  previousHash: expected.hash,
                  frames: [frame]
                }
                const hash = createHash("sha256")
                  .update(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned))
                  .digest("hex")
                expected = {
                  version: 1,
                  runId: turn.runId,
                  legId: turn.legId,
                  batch: unsigned.batch,
                  position: unsigned.from,
                  hash
                }
                return Response.json({ status: "committed", batch: { ...unsigned, hash }, cursor: expected })
              }

              const callSpec = cmdKind === "list-commands"
                ? { name: "commands", arguments: JSON.stringify({ action: "list" }) }
                : cmdKind === "file-ok" || cmdKind === "file-binary" || cmdKind === "file-err"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "file", args: "README.md" })
                }
                : cmdKind === "files-ok" || cmdKind === "files-err"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "files", args: "" }) }
                : cmdKind === "todo-read"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "todo", args: "T12" }) }
                : cmdKind === "todo-create"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "todo", args: "new Fix bug" })
                }
                : cmdKind === "home"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "home" }) }
                : cmdKind === "unknown-cmd"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "nonexistent" }) }
                : cmdKind === "bad-json-args"
                ? { name: "commands", arguments: "{not-json" }
                : { name: "totally_unknown_tool", arguments: "{}" }

              const scriptedModel = Model.make({
                stream: (req: ModelRequest.ModelRequest) => {
                  const results = req.messages.flatMap((m) => (m.role === "tool" ? [m] : []))
                  if (results.length === 0) {
                    const evs: ReadonlyArray<ModelEvent.ModelEvent> = [
                      { type: "tool-call-start", id: "c0", name: callSpec.name },
                      { type: "tool-call-end", id: "c0", arguments: callSpec.arguments },
                      { type: "usage", inputTokens: 10, outputTokens: 2 },
                      { type: "settle", stopReason: "tool-calls" }
                    ]
                    return Stream.fromIterable(evs)
                  }
                  const evs: ReadonlyArray<ModelEvent.ModelEvent> = [
                    { type: "text-delta", id: "t0", text: "Done." },
                    { type: "usage", inputTokens: 20, outputTokens: 3 },
                    { type: "settle", stopReason: "stop" }
                  ]
                  return Stream.fromIterable(evs)
                }
              })

              const outcome = yield* runDurableChatTurn(
                scriptedModel,
                turn,
                { modelId: "m-w9" },
                "http://callback.test",
                fetchImpl
              )
              expect(frames.length).toBeGreaterThan(0)
              return true
            }).pipe(Effect.provide(Logger.layer([]))),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
