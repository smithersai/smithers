import { Fuzz } from "@smthrs/fuzz"
import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { AgentTurnJournal, type NativeAgent } from "@smthrs/rpc"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import { apiCaller, runDurableChatTurn, sourceLister, sourceReader } from "./fixtures/durable.ts"
import type { DurableChatGrant } from "./fixtures/durable.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

const makeGrant = (withInstall: boolean): DurableChatGrant => ({
  turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
  ownerId: 7,
  runId: "run-fuzz",
  legId: "leg-fuzz",
  generation: 2,
  token: "producer_capability_producer_capability_1234",
  cursor: {
    version: 1,
    runId: "run-fuzz",
    legId: "leg-fuzz",
    batch: 0,
    position: 0,
    hash: "a".repeat(64)
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: {
    runId: "run-fuzz",
    instructions: "Answer briefly using host tools.",
    messages: [{ role: "user", content: "Inspect repository and TODOs." }]
  },
  producerBaseUrl: "http://callback.test/",
  source: { repository: "acme/app" },
  ...(withInstall
    ? {
      installOrigin: "http://127.0.0.1:4567",
      api: { author: "ben", token: "smithers_" + "a".repeat(40) }
    }
    : {})
})

const makeModel = (calls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>) =>
  Model.make({
    stream: (request: ModelRequest.ModelRequest) => {
      const results = request.messages.flatMap((m) => (m.role === "tool" ? [m] : []))
      const call = calls[results.length]
      if (call === undefined) {
        const last = results.at(-1)?.content.at(-1)?.content ?? "done"
        const events: ReadonlyArray<ModelEvent.ModelEvent> = [
          { type: "text-delta", id: "t", text: `Answer: ${last.slice(0, 80)}` },
          { type: "usage", inputTokens: 20, outputTokens: 5 },
          { type: "settle", stopReason: "stop" }
        ]
        return Stream.fromIterable(events)
      }
      const id = `call-${results.length}`
      const events: ReadonlyArray<ModelEvent.ModelEvent> = [
        { type: "tool-call-start", id, name: call.name },
        { type: "tool-call-end", id, arguments: call.arguments },
        { type: "usage", inputTokens: 10, outputTokens: 2 },
        { type: "settle", stopReason: "tool-calls" }
      ]
      return Stream.fromIterable(events)
    }
  })

const makeProducerFetch = (
  cursorInit: AgentTurnJournal.AgentTurnCursor,
  statusMode: "ok" | "not_found" | "forbidden" | "too_large" | "server_err"
): { readonly frames: Array<NativeAgent.AgentTurnFrame>; readonly fetchImpl: NativeAgent.FetchLike } => {
  const frames: Array<NativeAgent.AgentTurnFrame> = []
  let expected = cursorInit
  const fetchImpl: NativeAgent.FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/internal/chat/provider-started") return new Response(null, { status: 204 })
    if (url.pathname === "/internal/chat/source/read") {
      const body = JSON.parse(String(init?.body))
      if (statusMode === "not_found") return Response.json({ status: "error", code: "not_found" }, { status: 404 })
      if (statusMode === "forbidden") return Response.json({ status: "error", code: "forbidden" }, { status: 403 })
      if (statusMode === "too_large") return Response.json({ status: "error", code: "too_large" }, { status: 413 })
      if (statusMode === "server_err") return new Response("err", { status: 500 })
      return Response.json({
        repository: "acme/app",
        path: body.path,
        commit: COMMIT,
        content: `content of ${body.path}\nline 2\n`,
        binary: body.path.endsWith(".bin")
      })
    }
    if (url.pathname === "/internal/chat/source/list") {
      const body = JSON.parse(String(init?.body))
      if (statusMode === "not_found") return Response.json({ status: "error", code: "not_found" }, { status: 404 })
      if (statusMode === "forbidden") return Response.json({ status: "error", code: "path_refused" }, { status: 400 })
      return Response.json({
        repository: "acme/app",
        path: body.path,
        commit: COMMIT,
        entries: [
          { name: "README.md", kind: "file" },
          { name: "src", kind: "dir" }
        ],
        truncated: false
      })
    }
    if (url.pathname.startsWith("/api/")) {
      if (statusMode === "not_found") return Response.json({ code: "not_found", message: "missing" }, { status: 404 })
      if (statusMode === "forbidden") return Response.json({ code: "forbidden", message: "denied" }, { status: 403 })
      if (statusMode === "server_err") return new Response("boom", { status: 500 })
      if (url.pathname === "/api/todos") {
        return Response.json({ items: [{ id: "T12", title: "Add fuzzing", state: "open" }] })
      }
      if (url.pathname.startsWith("/api/todos/")) {
        return Response.json({ id: "T12", title: "Add fuzzing", state: "open" })
      }
      if (url.pathname === "/api/flows") {
        return Response.json([{ name: "todo", system: false, source: { builtin: true }, versions: [] }])
      }
      if (url.pathname.startsWith("/api/flows/")) {
        return Response.json({ name: "todo", system: false, source: { builtin: true }, versions: [] })
      }
      if (url.pathname.startsWith("/api/search")) {
        return Response.json({ hits: [{ path: "README.md", line: 1, text: "hello" }] })
      }
      if (url.pathname.startsWith("/api/runs/")) {
        return Response.json({ id: "run-7", status: "completed" })
      }
      return Response.json({ ok: true })
    }
    const body = JSON.parse(String(init?.body))
    const frame = body.frames[0] as NativeAgent.AgentTurnFrame
    frames.push(frame)
    const unsigned = {
      version: 1 as const,
      runId: expected.runId,
      legId: expected.legId,
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
      runId: expected.runId,
      legId: expected.legId,
      batch: unsigned.batch,
      position: unsigned.from,
      hash
    }
    return Response.json({ status: "committed", batch: { ...unsigned, hash }, cursor: expected })
  }
  return { frames, fetchImpl }
}

describe("@smthrs/model-host HostTools & EnvironmentResolver deep fuzz invariants", () => {
  it(
    "runHostTurn dispatches all command namespaces, malformed arguments, unknown tools & API/source errors safely",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          toolKind: Schema.Literals([
            "list_all",
            "list_ns",
            "exec_file",
            "exec_file_bin",
            "exec_files",
            "exec_stack",
            "exec_todo",
            "exec_todo_new",
            "exec_todo_drop",
            "exec_flow",
            "exec_flow_edit",
            "exec_flow_run",
            "exec_search",
            "exec_run_inspect",
            "exec_merge",
            "bad_json",
            "array_args",
            "unknown_action",
            "unknown_tool"
          ]),
          withInstall: Schema.Boolean,
          statusMode: Schema.Literals(["ok", "not_found", "forbidden", "too_large", "server_err"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ toolKind, withInstall, statusMode }) =>
            Effect.gen(function*() {
              const grant = makeGrant(withInstall)
              const prod = makeProducerFetch(grant.cursor, statusMode)

              const call = toolKind === "list_all"
                ? { name: "commands", arguments: JSON.stringify({ action: "list" }) }
                : toolKind === "list_ns"
                ? { name: "commands", arguments: JSON.stringify({ action: "list", namespace: "todo" }) }
                : toolKind === "exec_file"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "file", arguments: "README.md" })
                }
                : toolKind === "exec_file_bin"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "file", arguments: "logo.bin" })
                }
                : toolKind === "exec_files"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "files", arguments: "" }) }
                : toolKind === "exec_stack"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "stack" }) }
                : toolKind === "exec_todo"
                ? { name: "commands", arguments: JSON.stringify({ action: "execute", name: "todo", arguments: "T12" }) }
                : toolKind === "exec_todo_new"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "todo.new", arguments: "Add tests" })
                }
                : toolKind === "exec_todo_drop"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "todo.drop", arguments: "T12" })
                }
                : toolKind === "exec_flow"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "flow", arguments: "todo" })
                }
                : toolKind === "exec_flow_edit"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "flow.edit", arguments: "todo Run tests" })
                }
                : toolKind === "exec_flow_run"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({
                    action: "execute",
                    name: "flow.run",
                    arguments: JSON.stringify({ name: "todo" })
                  })
                }
                : toolKind === "exec_search"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({
                    action: "execute",
                    name: "search",
                    arguments: JSON.stringify({ query: "hello" })
                  })
                }
                : toolKind === "exec_run_inspect"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({
                    action: "execute",
                    name: "run.inspect",
                    arguments: JSON.stringify({ id: "run-7" })
                  })
                }
                : toolKind === "exec_merge"
                ? {
                  name: "commands",
                  arguments: JSON.stringify({ action: "execute", name: "merge", arguments: "T12" })
                }
                : toolKind === "bad_json"
                ? { name: "commands", arguments: "{not json" }
                : toolKind === "array_args"
                ? { name: "commands", arguments: "[]" }
                : toolKind === "unknown_action"
                ? { name: "commands", arguments: JSON.stringify({ action: "run" }) }
                : { name: "shell", arguments: JSON.stringify({ command: "rm -rf /" }) }

              const res = yield* runDurableChatTurn(
                makeModel([call]),
                grant,
                { modelId: "fixture", credential: "fixture" },
                undefined,
                prod.fetchImpl
              ).pipe(Effect.result)

              return res._tag === "Success" && prod.frames.length > 0
            }),
          { seed, executions: Math.min(executions, 45) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    45_000
  )

  it(
    "sourceReader, sourceLister, apiCaller & environmentModelResolver enforce strict HTTP/NDJSON validation",
    async () => {
      const binding = {
        protocol: "openai-chat",
        baseUrl: "https://fixture.test",
        modelId: "fixture",
        credential: "FIXTURE"
      } as const
      const env = {
        SMITHERS_MODEL_KEY_FIXTURE: "fixture-key",
        SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://fixture.test"
      }

      const arb = Arbitrary.schema(
        Schema.Struct({
          ctxCase: Schema.Literals([
            "valid_ndjson",
            "status_503",
            "redirect_307",
            "bad_json",
            "oversized_header",
            "non_shared"
          ]),
          apiCase: Schema.Literals(["ok_200", "err_404", "err_500", "redirect_302"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ ctxCase, apiCase }) =>
            Effect.gen(function*() {
              const baseGrant = makeGrant(true)
              const sharedGrant: DurableChatGrant = {
                ...baseGrant,
                request: { ...baseGrant.request, sharedConversation: ctxCase !== "non_shared" }
              }

              const ctxFetch: NativeAgent.FetchLike = async () => {
                if (ctxCase === "status_503") return new Response("down", { status: 503 })
                if (ctxCase === "redirect_307") {
                  return new Response(null, { status: 307, headers: { location: "https://evil.test" } })
                }
                if (ctxCase === "bad_json") {
                  return new Response("not json")
                }
                if (ctxCase === "oversized_header") {
                  return new Response("{}", {
                    headers: { "content-length": "3000000" }
                  })
                }
                const records = [
                  {
                    type: "input",
                    version: 1,
                    value: {
                      prompt: "hi",
                      author: "ben",
                      branch: "main",
                      state: "ready",
                      tokenBudget: 8000,
                      wikiOnly: false
                    }
                  },
                  { type: "recent", value: { title: "Prev", text: "ok" } },
                  {
                    type: "candidate",
                    value: {
                      item: { kind: "file", label: "a.ts", ref: "src/a.ts", revision: "abc" },
                      text: "export const a = 1"
                    }
                  },
                  { type: "end", recent: 1, candidates: 1 }
                ]
                return new Response(records.map((r) => JSON.stringify(r) + "\n").join(""), {
                  headers: { "content-type": "application/x-ndjson" }
                })
              }

              const resolved = yield* environmentModelResolver({
                binding,
                env,
                fetchImpl: ctxFetch as unknown as typeof fetch
              })(sharedGrant).pipe(
                Effect.result
              )
              if (ctxCase === "valid_ndjson" || ctxCase === "non_shared") {
                if (resolved._tag !== "Success") return false
              } else {
                if (resolved._tag !== "Failure") return false
              }

              // Exercise sourceReader, sourceLister, apiCaller directly
              const apiFetch: NativeAgent.FetchLike = async () => {
                if (apiCase === "err_404") return Response.json({ status: "error", code: "not_found" }, { status: 404 })
                if (apiCase === "err_500") return new Response("boom", { status: 500 })
                if (apiCase === "redirect_302") {
                  return new Response(null, {
                    status: 302,
                    headers: { location: "https://evil.test" }
                  })
                }
                return Response.json({
                  repository: "acme/app",
                  path: "README.md",
                  commit: COMMIT,
                  content: "hi",
                  binary: false,
                  entries: [{ name: "a.ts", kind: "file" }],
                  truncated: false
                })
              }
              const reader = sourceReader(baseGrant.producerBaseUrl, baseGrant, apiFetch)
              const lister = sourceLister(baseGrant.producerBaseUrl, baseGrant, apiFetch)
              const caller = apiCaller(baseGrant.producerBaseUrl, baseGrant, apiFetch)
              const rAns = yield* reader("README.md")
              const lAns = yield* lister("")
              const aAns = yield* caller("/api/todos", { method: "GET" })
              return rAns !== undefined && lAns !== undefined && aAns !== undefined
            }),
          { seed: seed + 1, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    45_000
  )
})
