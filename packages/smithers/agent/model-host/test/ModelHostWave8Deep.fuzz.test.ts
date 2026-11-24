import { Fuzz } from "@smthrs/fuzz"
import { Model, type ModelEvent } from "@smthrs/model"
import { AgentCommands, AgentTurnJournal, ContextPreflight, type NativeAgent } from "@smthrs/rpc"
import { Arbitrary, Effect, Exit, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  createHostDiagnostics,
  type DurableChatGrant,
  DurableChatProducer,
  type HostTransport
} from "../src/index.ts"
import { runDurableChatTurn, runHostTurn } from "./fixtures/durable.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const executions = Math.max(18, Math.min(Math.ceil(baseExecutions / 6), 36))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

const makeGrant = (opts: {
  readonly account?: boolean
  readonly api?: boolean
  readonly source?: boolean
  readonly shared?: boolean
  readonly agentInstructions?: string
}): DurableChatGrant => ({
  turnId: "turn-w8",
  ownerId: 1,
  ...(opts.account ? {} : { repositoryId: 42 }),
  runId: "run-w8",
  legId: "leg-1",
  generation: 1,
  token: "capability_capability_capability_w8_1234",
  cursor: { version: 1, runId: "run-w8", legId: "leg-1", batch: 0, position: 0, hash: "a".repeat(64) },
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  producerBaseUrl: "https://host.example",
  ...(opts.source ? { source: { repository: "acme/demo" } } : {}),
  ...(opts.api ? { api: { author: "alice", token: "secret-api-token-w8" } } : {}),
  ...(opts.agentInstructions ? { agentInstructions: opts.agentInstructions } : {}),
  request: {
    runId: "run-w8",
    instructions: "Help the author.",
    messages: [{ role: "user", content: "hello" }],
    ...(opts.shared ? { sharedConversation: true } : {})
  }
})

const makeToolCallModel = (calls: ReadonlyArray<{ readonly name: string; readonly args: string }>) => {
  let leg = 0
  return Model.make({
    stream: () => {
      const idx = leg++
      if (idx < calls.length) {
        const call = calls[idx]!
        const events: Array<ModelEvent.ModelEvent> = [
          { type: "tool-call-start", id: `tc-${idx}`, name: call.name },
          { type: "tool-call-delta", id: `tc-${idx}`, delta: call.args },
          { type: "tool-call-end", id: `tc-${idx}`, name: call.name, arguments: call.args },
          {
            type: "settle",
            stopReason: "tool-calls",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
          }
        ]
        return Stream.fromIterable(events)
      }
      return Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "text-delta", id: "t-final", text: "Done." },
        {
          type: "settle",
          stopReason: "stop",
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }
        }
      ])
    }
  })
}

const sampleDocs = [
  {
    slug: "getting-started",
    title: "Getting Started",
    summary: "Quick intro",
    markdown: "# Getting Started\nRun smithers."
  },
  {
    slug: "flows",
    title: "Flows",
    summary: "Durable flows",
    markdown: "# Flows\nDefine flows."
  }
]

describe("ModelHost Wave 8 deep fuzzing", () => {
  it("runHostTurn exercises ui, form, docs, flow, flow.edit, stack, todo, file, files, list, errors, and tool_limit", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "list-all",
          "list-ns",
          "unknown-tool",
          "bad-json-args",
          "unknown-cmd",
          "file-outcomes",
          "files-outcomes",
          "docs-read-and-card",
          "ui-theme",
          "form-account",
          "flow-and-edit",
          "stack-and-todo",
          "confirm-cmd",
          "tool-limit"
        ]),
        errorCode: Schema.Literals([
          "ok",
          "source_not_ready",
          "path_refused",
          "forbidden",
          "not_found",
          "too_large",
          "bad_status",
          "invalid_body"
        ]),
        rawArgsMode: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, errorCode, rawArgsMode }) =>
          Effect.gen(function*() {
            const frames: Array<NativeAgent.AgentTurnFrame> = []
            const write = (frame: NativeAgent.AgentTurnFrame) =>
              Effect.sync(() => {
                frames.push(frame)
              })
            const diag = createHostDiagnostics({ turnId: "turn-w8" })

            const isAccount = scenario === "form-account"
            const grant = makeGrant({
              account: isAccount,
              api: !isAccount,
              source: !isAccount,
              agentInstructions: rawArgsMode ? "Be brief." : undefined
            })

            const transport: HostTransport = {
              docs: sampleDocs,
              read: (path) =>
                Effect.succeed(
                  errorCode === "ok"
                    ? {
                      file: {
                        path,
                        content: "export const ok = true\n",
                        lines: 1,
                        sizeBytes: 23,
                        truncated: false,
                        revision: "rev-1"
                      }
                    }
                    : { code: errorCode === "bad_status" || errorCode === "invalid_body" ? "not_found" : errorCode }
                ),
              list: (path) =>
                Effect.succeed(
                  errorCode === "ok"
                    ? {
                      directory: {
                        path,
                        entries: [
                          { name: "src", path: "src", kind: "dir" as const },
                          { name: "README.md", path: "README.md", kind: "file" as const, sizeBytes: 120 }
                        ],
                        truncated: false,
                        revision: "rev-1"
                      }
                    }
                    : { code: errorCode === "path_refused" ? "path_refused" : "not_found" }
                ),
              api: (path, req) => {
                if (errorCode === "forbidden") return Effect.succeed({ code: "forbidden" })
                if (errorCode === "bad_status") return Effect.succeed({ status: 500, body: { error: "boom" } })
                if (errorCode === "invalid_body") return Effect.succeed({ status: 200, body: { bogus: true } })
                if (path === "/api/flows") {
                  return Effect.succeed({
                    status: 200,
                    body: [
                      {
                        name: "deploy",
                        title: "Deploy",
                        description: "Deploy app",
                        system: false,
                        path: ".smithers/flows/deploy/flow.ts",
                        capabilities: []
                      },
                      {
                        name: "system-check",
                        title: "System Check",
                        description: "Built-in",
                        system: true,
                        path: ".smithers/flows/system-check/flow.ts",
                        capabilities: []
                      }
                    ]
                  })
                }
                if (path.startsWith("/api/flows/")) {
                  const flowName = decodeURIComponent(path.slice("/api/flows/".length))
                  if (flowName === "fallback-flow") {
                    return Effect.succeed({
                      status: 200,
                      body: {
                        name: "fallback-flow",
                        title: "Fallback",
                        description: "Found by name",
                        system: false,
                        path: ".smithers/flows/fallback-flow/flow.ts",
                        capabilities: []
                      }
                    })
                  }
                  return Effect.succeed({ status: 404, body: { error: "not_found" } })
                }
                if (path.startsWith("/api/todos/") && req.method === "GET") {
                  const n = Number(path.split("/").pop()) || 1
                  return Effect.succeed({
                    status: 200,
                    body: {
                      n,
                      title: `Todo ${n}`,
                      state: "open",
                      branch: `todo-${n}`,
                      summary: "Work item"
                    }
                  })
                }
                if (path === "/api/stack" || path.includes("stack")) {
                  return Effect.succeed({
                    status: 200,
                    body: {
                      repository: "acme/demo",
                      items: [
                        { n: 1, title: "Open TODO", state: "open" },
                        { n: 2, title: "Merged TODO", state: "merged" },
                        { n: 3, title: "Dropped TODO", state: "dropped" }
                      ]
                    }
                  })
                }
                if (req.method === "POST") {
                  return Effect.succeed({
                    status: errorCode === "not_found" ? 200 : 202,
                    body: errorCode === "not_found"
                      ? { wrong: 1 }
                      : { confirmation: "conf-1", state: "pending" }
                  })
                }
                return Effect.succeed({ status: 200, body: { ok: true } })
              }
            }

            const cmdName = AgentCommands.commandsToolSpec.name
            const calls: Array<{ name: string; args: string }> = []
            switch (scenario) {
              case "list-all":
                calls.push({ name: cmdName, args: JSON.stringify({ action: "list" }) })
                break
              case "list-ns":
                calls.push({ name: cmdName, args: JSON.stringify({ action: "list", namespace: "flow" }) })
                break
              case "unknown-tool":
                calls.push({ name: "not_a_real_tool", args: "{}" })
                break
              case "bad-json-args":
                calls.push({ name: cmdName, args: "{bad json" })
                break
              case "unknown-cmd":
                calls.push({ name: cmdName, args: JSON.stringify({ action: "run", name: "nonexistent.cmd" }) })
                break
              case "file-outcomes":
                calls.push({
                  name: cmdName,
                  args: JSON.stringify({
                    action: "run",
                    name: "file",
                    args: rawArgsMode ? "src/index.ts" : JSON.stringify({ path: "src/index.ts" })
                  })
                })
                break
              case "files-outcomes":
                calls.push({
                  name: cmdName,
                  args: JSON.stringify({
                    action: "run",
                    name: "files",
                    args: rawArgsMode ? "src" : JSON.stringify({ path: "src" })
                  })
                })
                break
              case "docs-read-and-card":
                calls.push(
                  {
                    name: cmdName,
                    args: JSON.stringify({
                      action: "run",
                      name: "docs",
                      args: JSON.stringify({ mode: "read", page: errorCode === "not_found" ? "missing" : "flows" })
                    })
                  },
                  {
                    name: cmdName,
                    args: JSON.stringify({
                      action: "run",
                      name: "docs",
                      args: rawArgsMode ? "getting-started" : JSON.stringify({ page: "getting-started" })
                    })
                  }
                )
                break
              case "ui-theme":
                calls.push(
                  {
                    name: cmdName,
                    args: JSON.stringify({
                      action: "run",
                      name: "theme",
                      args: rawArgsMode ? JSON.stringify({ mode: "dark" }) : JSON.stringify({ mode: "neon" })
                    })
                  }
                )
                break
              case "form-account":
                calls.push({
                  name: cmdName,
                  args: JSON.stringify({
                    action: "run",
                    name: "flow.new",
                    args: rawArgsMode ? "ci-check" : JSON.stringify({ name: "ci-check", description: "" })
                  })
                })
                break
              case "flow-and-edit":
                calls.push(
                  {
                    name: cmdName,
                    args: JSON.stringify({
                      action: "run",
                      name: "flow",
                      args: rawArgsMode ? "fallback-flow" : JSON.stringify({ name: "deploy" })
                    })
                  },
                  {
                    name: cmdName,
                    args: JSON.stringify({
                      action: "run",
                      name: "flow.edit",
                      args: rawArgsMode
                        ? "system-check change it"
                        : JSON.stringify({ name: "deploy", request: "add retry" })
                    })
                  },
                  {
                    name: cmdName,
                    args: JSON.stringify({
                      action: "run",
                      name: "flow.edit",
                      args: JSON.stringify({ name: "missing-flow" })
                    })
                  }
                )
                break
              case "stack-and-todo":
                calls.push(
                  {
                    name: cmdName,
                    args: JSON.stringify({ action: "run", name: "stack", args: "{}" })
                  },
                  {
                    name: cmdName,
                    args: JSON.stringify({ action: "run", name: "todo", args: JSON.stringify({ n: 1 }) })
                  }
                )
                break
              case "confirm-cmd":
                calls.push({
                  name: cmdName,
                  args: JSON.stringify({
                    action: "run",
                    name: "todo.new",
                    args: JSON.stringify({ title: "Ship fuzzing" })
                  })
                })
                break
              case "tool-limit":
                for (let i = 0; i < 12; i++) {
                  calls.push({ name: cmdName, args: JSON.stringify({ action: "list" }) })
                }
                break
            }

            const model = makeToolCallModel(calls)
            yield* runHostTurn(model, grant, { modelId: "coding", credential: "secret-cred" }, write, transport, diag)
            expect(frames.length).toBeGreaterThan(0)
            // Never leak credentials in any frame
            const serialized = JSON.stringify(frames)
            expect(serialized).not.toContain("secret-cred")
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("runDurableChatTurn & DurableChatProducer handle preflight, duplicates, seal mismatch, refusals, and observer close", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "plain-ok",
          "preflight-ok",
          "preflight-wiki-only",
          "preflight-invalid-input",
          "shared-without-preflight",
          "provider-start-refused",
          "duplicate-receipt",
          "seal-mismatch",
          "commit-refused-409"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            let observerClosed = false
            let modelCalls = 0
            let cur: AgentTurnJournal.AgentTurnCursor = {
              version: 1,
              runId: "run-w8",
              legId: "leg-1",
              batch: 0,
              position: 0,
              hash: "a".repeat(64)
            }
            let commitCount = 0

            const model = Model.make({
              stream: () => {
                modelCalls++
                return Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-delta", id: "d1", text: "Answer text" },
                  { type: "settle", stopReason: "stop", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }
                ])
              }
            })

            const preflightModel = Model.make({
              stream: () =>
                Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-delta", id: "p1", text: '[{"index":0,"reason":"Relevant"}]' },
                  { type: "settle", stopReason: "stop" }
                ])
            })

            const fetchImpl: NativeAgent.FetchLike = async (url, init) => {
              const target = String(url)
              const bodyText = typeof init?.body === "string" ? init.body : ""
              if (target.includes("provider-started") || target.includes("started")) {
                if (mode === "provider-start-refused") {
                  return new Response(JSON.stringify({ code: "stale_generation" }), {
                    status: 409,
                    headers: { "content-type": "application/json" }
                  })
                }
                return new Response(JSON.stringify({ ok: true }), {
                  status: 200,
                  headers: { "content-type": "application/json" }
                })
              }
              commitCount++
              if (mode === "commit-refused-409") {
                return new Response(JSON.stringify({ status: "refused", code: "stale_generation" }), {
                  status: 409,
                  headers: { "content-type": "application/json" }
                })
              }
              const parsed = JSON.parse(bodyText) as {
                readonly expected: AgentTurnJournal.AgentTurnCursor
                readonly frames: ReadonlyArray<NativeAgent.AgentTurnFrame>
              }
              const unsigned = {
                version: 1 as const,
                runId: "run-w8",
                legId: "leg-1",
                batch: parsed.expected.batch + 1,
                from: parsed.expected.position + 1,
                previousHash: parsed.expected.hash,
                frames: parsed.frames
              }
              const hash = sha256(AgentTurnJournal.agentTurnJournalDigestInput("batch", unsigned))
              const batch: AgentTurnJournal.AgentTurnBatch = {
                ...unsigned,
                hash: mode === "seal-mismatch" ? "0".repeat(64) : hash
              }
              cur = {
                version: 1,
                runId: "run-w8",
                legId: "leg-1",
                batch: batch.batch,
                position: batch.from + batch.frames.length - 1,
                hash: batch.hash
              }
              const reply = {
                status: mode === "duplicate-receipt" && commitCount === 1 ? ("duplicate" as const) : ("committed" as const),
                batch,
                cursor: cur
              }
              return new Response(JSON.stringify(reply), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            }

            const grant = makeGrant({
              shared: mode === "shared-without-preflight" || mode === "preflight-ok",
              api: true,
              source: true
            })

            const preflightInput: ContextPreflight.ContextPreflightInput = {
              prompt: "how do flows work?",
              author: "alice",
              branch: "main",
              state: "synced",
              recent: [{ title: "Earlier", text: "prior msg" }],
              candidates: [
                {
                  item: { kind: "file", label: "flow.ts", ref: "src/flow.ts", revision: "r1" },
                  text: "export const flow = 1"
                },
                {
                  item: { kind: "page", label: "Flows", ref: "flows", revision: "2" },
                  text: "Flows are durable"
                }
              ],
              tokenBudget: 8000,
              wikiOnly: mode === "preflight-wiki-only"
            }

            const preflight =
              mode === "preflight-ok" || mode === "preflight-wiki-only"
                ? { input: preflightInput, model: preflightModel, options: { modelId: "fast" } }
                : mode === "preflight-invalid-input"
                ? { input: { bad: true } as unknown as ContextPreflight.ContextPreflightInput, model: preflightModel, options: { modelId: "fast" } }
                : undefined

            const exit = yield* Effect.exit(
              runDurableChatTurn(
                model,
                grant,
                { modelId: "coding" },
                "https://callback.example",
                fetchImpl,
                preflight,
                sampleDocs,
                createHostDiagnostics({ turnId: "turn-w8" }),
                () => ({
                  runtime: { runtime: "node", version: "26" },
                  begin: () => ({
                    run: (action) => action(),
                    fields: () => ({ phase: "response", durationMs: 1 })
                  }),
                  close: () => {
                    observerClosed = true
                  }
                })
              )
            )

            // Observer MUST always be closed regardless of success/failure
            expect(observerClosed).toBe(true)

            if (mode === "plain-ok" || mode === "preflight-ok" || mode === "preflight-wiki-only" || mode === "duplicate-receipt") {
              expect(Exit.isSuccess(exit)).toBe(true)
              expect(modelCalls).toBe(1)
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
              if (mode === "provider-start-refused" || mode === "shared-without-preflight" || mode === "preflight-invalid-input") {
                expect(modelCalls).toBe(0)
              }
            }

            // Direct DurableChatProducer construction sanity
            const prod = new DurableChatProducer("https://callback.example", grant, fetchImpl)
            expect(prod).toBeInstanceOf(DurableChatProducer)
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  }, 180_000)
})
