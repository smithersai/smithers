import * as Permission from "@smthrs/capability/Permission"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import { Fuzz } from "@smthrs/fuzz"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { ModelRequest } from "@smthrs/model"
import { NotificationQueue } from "@smthrs/notifications"
import type * as NotificationModel from "@smthrs/notifications/Notification"
import * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Registry from "@smthrs/registry/Registry"
import { Arbitrary, Context, Effect, Exit, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  CallLedger,
  Cell,
  CellCalls,
  CellHistory,
  CellTurn,
  CellValidation,
  CompletionClaim,
  ContextWindow,
  DoneText,
  EngineLike,
  ExternalTranscript,
  FailedCall,
  FlowBinding,
  Notifications,
  QuickJSLifecycle,
  Sandbox,
  Steering,
  StructuredOutput,
  TruncatedOutput
} from "../src/index.ts"
import * as paidUsage from "../src/internal/paidUsage.ts"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as printChannel from "../src/internal/printChannel.ts"
import * as SchemaSignature from "../src/internal/schemaSignature.ts"
import * as unobservedCall from "../src/internal/unobservedCall.ts"
import * as QuickJSWorkerd from "../src/QuickJSWorkerd.ts"
import { descriptor, emits, prose, runEffect as runCellTurn, window as baseWindow } from "./fixtures/cellTurn.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261170")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const mkCall = (flowName: string, input: typeof Schema.Json.Type, declaration = "decl-digest"): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "sess-w7",
      frame: 0,
      cell: "cell-w7",
      ordinal: 0,
      declaration,
      layers: []
    })
  })

describe("@smthrs/harness Wave7 Deep Fuzz", () => {
  it("DoneText regex/comments/templates/escapes & CompletionClaim passages/newest", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        escapeKind: Schema.Literals([
          "braced-ok",
          "braced-empty",
          "braced-overflow",
          "braced-badhex",
          "braced-cut",
          "null-ok",
          "null-octal",
          "null-cut",
          "octal-1",
          "hex-ok",
          "hex-cut",
          "hex-bad",
          "uni-ok",
          "uni-cut",
          "unknown-esc",
          "crlf-tpl",
          "dollar-tpl",
          "high-surrogate"
        ]),
        prefixKind: Schema.Literals([
          "regex",
          "regex-class",
          "regex-unterm",
          "block-comment",
          "unclosed-comment",
          "template-interp",
          "division"
        ]),
        sentenceCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ escapeKind, prefixKind, sentenceCount }) =>
          Effect.sync(() => {
            const prefix = prefixKind === "regex"
              ? `const r = /ctx\\.done\\("fake"\\)/gi;\n`
              : prefixKind === "regex-class"
              ? `const r = /[a/b\\]]+\\/x/m;\n`
              : prefixKind === "regex-unterm"
              ? `const r = /unterminated\n`
              : prefixKind === "block-comment"
              ? `/* ctx.done("commented") */\n`
              : prefixKind === "unclosed-comment"
              ? `/* never closed`
              : prefixKind === "template-interp"
              ? "const t = `a ${1 + 2} b`;\n"
              : `const d = a / b;\n`

            const lit = escapeKind === "braced-ok"
              ? `"hi \\u{1F600}!"`
              : escapeKind === "braced-empty"
              ? `"hi \\u{}"`
              : escapeKind === "braced-overflow"
              ? `"hi \\u{110000}"`
              : escapeKind === "braced-badhex"
              ? `"hi \\u{12ZZ}"`
              : escapeKind === "braced-cut"
              ? `"hi \\u{12`
              : escapeKind === "null-ok"
              ? `"hi \\0a"`
              : escapeKind === "null-octal"
              ? `"hi \\01"`
              : escapeKind === "null-cut"
              ? `"hi \\0`
              : escapeKind === "octal-1"
              ? `"hi \\1"`
              : escapeKind === "hex-ok"
              ? `"hi \\x41"`
              : escapeKind === "hex-cut"
              ? `"hi \\x4`
              : escapeKind === "hex-bad"
              ? `"hi \\xZZ"`
              : escapeKind === "uni-ok"
              ? `"hi \\u0041"`
              : escapeKind === "uni-cut"
              ? `"hi \\u00`
              : escapeKind === "unknown-esc"
              ? `"hi \\q"`
              : escapeKind === "crlf-tpl"
              ? "`line1\r\nline2\rline3`"
              : escapeKind === "dollar-tpl"
              ? "`hello ${x}`"
              : `"\\uD83D`

            const fenced = "```js\n" + prefix + (prefixKind === "unclosed-comment" ? "" : `ctx.done(${lit})`) + "\n```"
            const proj = DoneText.project(fenced)
            if (prefixKind === "unclosed-comment" && Option.isSome(proj)) return false

            const longUnit = "Sentence ".repeat(120) + "end."
            const manySentences = Array.from({ length: sentenceCount }, (_, i) => `Claim item ${i}: ${longUnit}`).join(
              " "
            )
            const sents = CompletionClaim.sentences(manySentences)
            const pass = CompletionClaim.passages(manySentences)
            const huge = "x".repeat(CompletionClaim.outputBytes + 200)
            const newest = CompletionClaim.newest(huge)
            const tinyNewest = CompletionClaim.newest("short")
            return sents.length >= 1 && pass.length >= 1 && newest.includes("elided") && tinyNewest === "short"
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("printChannel matchList, table, render, shares, capacity, buffer invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "match-list",
          "table-uniform",
          "table-sparse",
          "table-onecol",
          "failed-envelope",
          "wrapped-match",
          "wrapped-table",
          "wrapped-two-tables",
          "boxed-string"
        ]),
        unread: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        stmtCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 40 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, unread, stmtCount }) =>
          Effect.sync(() => {
            let value: Schema.Json
            if (mode === "match-list") {
              value = [
                {
                  file: "src/a.ts",
                  line: 10,
                  text: "const a = 1",
                  before: [{ line: 9, text: "// before" }],
                  after: [{ line: 11, text: "// after" }],
                  symbol: { kind: "function", name: "fn", startLine: 8, endLine: 15 }
                },
                { file: "src/a.ts", line: 20, text: "const b = 2" },
                { file: "src/b.ts", line: 3, text: "export const c = 3" }
              ]
            } else if (mode === "table-uniform") {
              value = [
                { id: "a", label: "ok", extra: "x|y" },
                { id: "b", label: "line1\nline2" },
                { id: "c", label: "ok", extra: "z" }
              ]
            } else if (mode === "table-sparse") {
              value = Array.from({ length: 12 }, (_, i) => ({ [`k${i}`]: i, [`m${i}`]: i }))
            } else if (mode === "table-onecol") {
              value = [{ only: 1 }, { only: 2 }, { only: 3 }]
            } else if (mode === "failed-envelope") {
              value = {
                ok: false,
                error: { code: "timed_out", message: "too slow", hint: "narrow scope", output: "partial out" }
              }
            } else if (mode === "wrapped-match") {
              value = {
                truncated: false,
                matches: [{ file: "a.ts", line: 1, text: "hit" }]
              }
            } else if (mode === "wrapped-table") {
              value = {
                rows: [
                  { name: "a", val: 1 },
                  { name: "b", val: 2 },
                  { name: "c", val: 3 }
                ]
              }
            } else if (mode === "wrapped-two-tables") {
              const t = [
                { a: 1, b: 2 },
                { a: 3, b: 4 },
                { a: 5, b: 6 }
              ]
              value = { first: t, second: t }
            } else {
              value = "plain-boxed-string"
            }

            const rendered = printChannel.render(value)
            if (typeof rendered !== "string" || rendered.length === 0) return false
            void printChannel.table(value)

            const stmts: Array<printChannel.Statement> = Array.from({ length: stmtCount }, (_, i) => {
              const text = i % 2 === 0 ? `row-${i}-${"a".repeat(600)}` : `row-${i}-${"b".repeat(600)}`
              return { text, bytes: Buffer.byteLength(text, "utf8") }
            })
            const buf = printChannel.buffer(stmts, unread)
            if (unread > 0 && !buf.includes("further print statements")) return false
            const sh = printChannel.shares([100, 100, 50, 200], 300)
            return sh.length === 4 && sh.reduce((a, b) => a + b, 0) <= 300
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("unobservedCall AST flow, completionReads, actsOn, loggingOnly & blind invariants", async () => {
    const snippets = [
      `const r = await ctx.call("read", { path: "a" }); console.log(r); ctx.done("blind")`,
      `const r = await ctx.call("read", { path: "a" }); if (r.ok) { console.log(r.value); } else { ; } ctx.done("blind")`,
      `const r = await ctx.call("read", { path: "a" }); switch (r.ok) { case true: console.log(r); break; default: console.log("no"); } ctx.done("blind")`,
      `const { value: [a, ...rest], z = 1 } = await ctx.call("read", {}); let x; x = a; const obj = { m(p) { return p } }; ctx.done(x)`,
      `const r = await ctx.call("read", {}); const all = []; all.push(r); const s = String(r); const p = JSON.stringify(r); const t = r.stdout.trim(); ctx.done("still blind")`,
      `function helper() { return ctx.call("read", {}); } const r = await helper(); for (const item of r.items) { console.log(item) } ctx.done("ok")`,
      `const r = await ctx.call("read", {}); try { console.log(1) } catch (e) { ctx.done("caught") }`,
      `const r = await ctx.call("read", {}); const y = r.ok ? ctx.done("yes") : null`,
      `const r = await ctx.call("read", {}); while (r.more) { ctx.done("loop") }`,
      `const r = await ctx.call("read", {}); r.ok && ctx.done("and")`,
      `const r = await ctx.call("read", {}); switch (r.kind) { case "a": ctx.done("sw"); break }`,
      `const r = await ctx.call("read", {}); for (const k in r) { ctx.done("forin") }`,
      `const r1 = await ctx.call("read", {}); const r2 = await ctx.call("read", {}); if (r1.ok) { doSomething(r1) } console.log(r2); ctx.done("partial")`,
      `void await ctx.call("write", { x: 1 }); ctx.done("void")`,
      `const a = {}; a.b = await ctx.call("read", {}); if (a.b.ok) { const w = 1; while (a.b.ok) { break } switch (a.b.kind) { case a.b.v: break } } ctx.done("act")`,
      `class C { method(x) { return x } } const r = await ctx.call("read", {}); const c = new C(); c.method(r); ctx.done("cls")`,
      `const broken = (((`
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({ offset: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: snippets.length - 1 }))) })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ offset }) =>
          Effect.sync(() => {
            for (let k = 0; k < 4; k++) {
              const src = snippets[(offset + k) % snippets.length]!
              const parsed = unobservedCall.parseCell(src)
              const isBlind = unobservedCall.blind(src)
              if (parsed !== undefined) {
                const fl = unobservedCall.flows(parsed.program)
                if (!Array.isArray(fl)) return false
              }
              if (typeof isBlind !== "boolean") return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Notifications steerItem (Seat/Thinking/Tools), outside_change coalescing/errors & layerForExecution", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "seat",
          "thinking",
          "tools",
          "outside-valid",
          "outside-self-skip",
          "outside-dup-same",
          "outside-dup-conflict",
          "outside-invalid-tag",
          "outside-invalid-actor",
          "outside-invalid-files",
          "exec-with-session",
          "exec-no-session",
          "exec-missing-instance"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind }) =>
          Effect.gen(function*() {
            const runId = `run-${kind}`
            const lineageId = `lin-${kind}`
            const journal = TestJournal.layer()
            const queueLayer = NotificationQueue.layer.pipe(Layer.provide(journal))

            const mkNote = (
              overrides: Partial<NotificationModel.Notification> & { id: string }
            ): NotificationModel.Notification => ({
              _tag: "system-event",
              delivery: "steer",
              targetLineageId: lineageId,
              provenance: { sourceRunId: "op", sourceLineageId: "op/root", sourceTurn: 0, sourceActor: "human:tester" },
              payload: {},
              ...overrides
            } as any)

            if (kind === "exec-missing-instance") {
              const exit = yield* Effect.exit(
                Effect.gen(function*() {
                  const src = yield* Steering.Source
                  return yield* src.read()
                }).pipe(Effect.provide(Notifications.layerForExecution().pipe(Layer.provide(queueLayer))))
              )
              return Exit.isFailure(exit)
            }

            if (kind === "exec-with-session" || kind === "exec-no-session") {
              const fakeInstance = {
                executionId: runId,
                flowName: "test",
                id: runId
              } as any
              const committedNote = mkNote({
                id: "n-exec",
                targetLineageId: runId,
                payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: ["a.ts"] }
              })
              const committedQueue = Layer.succeed(NotificationQueue.NotificationQueue)({
                admit: () => Effect.void,
                pending: () => Effect.succeed([committedNote]),
                drain: ({ boundary }: { readonly boundary: string }) =>
                  Effect.succeed({ notifications: [committedNote], boundary, duplicate: false })
              } as any)
              const res = yield* Effect.gen(function*() {
                const src = yield* Steering.Source
                const pending = yield* src.read()
                const drained = yield* src.drain({
                  boundary: "b0",
                  wouldIdle: false,
                  ...(kind === "exec-with-session" ? { session: "s1" } : {})
                })
                return pending.items.length === 1 && drained.inserts.length === 1
              }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    committedQueue,
                    Notifications.layerForExecution().pipe(Layer.provide(committedQueue)),
                    Layer.succeed(FlowRuntime.FlowInstance)(fakeInstance)
                  )
                )
              )
              return res
            }

            const notes: Array<NotificationModel.Notification> = []
            if (kind === "seat") {
              notes.push(mkNote({ id: "s1", _tag: "human-steer", payload: { kind: "Seat", seat: "fast" } }))
            } else if (kind === "thinking") {
              notes.push(mkNote({ id: "t1", _tag: "human-steer", payload: { kind: "Thinking", thinking: "high" } }))
            } else if (kind === "tools") {
              notes.push(mkNote({ id: "tl1", _tag: "human-steer", payload: { kind: "Tools", toolNames: ["bash", "read"] } }))
            } else if (kind === "outside-valid") {
              notes.push(
                mkNote({
                  id: "o1",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "person", id: "will" }, files: ["b.ts", "a.ts"] }
                }),
                mkNote({
                  id: "o2",
                  payload: { kind: "outside_change", id: "b2", actor: { id: "will", kind: "person" }, files: ["c.ts"] }
                })
              )
            } else if (kind === "outside-self-skip") {
              notes.push(
                mkNote({
                  id: "o1",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "agent", id: "self-agent" }, files: ["a.ts"] }
                })
              )
            } else if (kind === "outside-dup-same") {
              notes.push(
                mkNote({
                  id: "o1",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: ["a.ts"] }
                }),
                mkNote({
                  id: "o2",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: ["a.ts"] }
                })
              )
            } else if (kind === "outside-dup-conflict") {
              notes.push(
                mkNote({
                  id: "o1",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: ["a.ts"] }
                }),
                mkNote({
                  id: "o2",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: ["b.ts"] }
                })
              )
            } else if (kind === "outside-invalid-tag") {
              notes.push(
                mkNote({
                  id: "o1",
                  _tag: "human-steer",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: ["a.ts"] }
                })
              )
            } else if (kind === "outside-invalid-actor") {
              notes.push(
                mkNote({
                  id: "o1",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "person", id: "" }, files: ["a.ts"] }
                })
              )
            } else if (kind === "outside-invalid-files") {
              notes.push(
                mkNote({
                  id: "o1",
                  payload: { kind: "outside_change", id: "b1", actor: { kind: "outside" }, files: [] }
                })
              )
            }

            const isOutside = kind.startsWith("outside-")
            const effectiveQueueLayer = isOutside
              ? Layer.succeed(NotificationQueue.NotificationQueue)({
                admit: () => Effect.void,
                pending: () => Effect.succeed(notes),
                drain: ({ boundary }: { readonly boundary: string }) =>
                  Effect.succeed({ notifications: notes, boundary, duplicate: false })
              } as any)
              : queueLayer

            const exit = yield* Effect.exit(
              Effect.gen(function*() {
                if (!isOutside) {
                  const q = yield* NotificationQueue.NotificationQueue
                  for (const n of notes) yield* q.admit(runId, n)
                }
                const src = yield* Steering.Source
                const pending = yield* src.read()
                const drained = yield* src.drain({ boundary: "b0", wouldIdle: false })
                return { pending, drained }
              }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    effectiveQueueLayer,
                    Notifications.layer({ runId, lineageId, codingParticipantId: "self-agent" }).pipe(
                      Layer.provide(effectiveQueueLayer)
                    )
                  )
                )
              )
            )
            if (kind === "outside-dup-conflict" || kind.startsWith("outside-invalid-")) {
              return Exit.isFailure(exit)
            }
            if (Exit.isFailure(exit)) return false
            if (kind === "seat" || kind === "thinking") return exit.value.drained.seatChanges.length === 1
            if (kind === "tools") return exit.value.drained.inserts.length === 1
            if (kind === "outside-self-skip") return exit.value.drained.inserts.length === 0
            return exit.value.drained.inserts.length === 1
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    assertPassed(report)
  })

  it("ExternalTranscript Codex & Claude edge records, errors, and tool conversions", async () => {
    const codexHeader = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-10-01T00:00:00Z",
      payload: { id: "s1", cli_version: "0.160.0", cwd: "/tmp" }
    })
    const codexCases = [
      JSON.stringify({ type: "session_meta", payload: { cli_version: "99.0.0" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "error", message: "before meta" } }),
      "not-json",
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "unknown_resp" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "", name: "exec", input: "x" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "patch" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "apply_patch verification failed: Failed to find expected lines in src/a.ts:\nctx" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "agent_message", content: "bad" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "" }] } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "cipher" }] } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "agent_message", content: [{ type: "output_text", text: "hi" }] } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "agent_message", content: [{ type: "output_text" }] } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "response_item", payload: { type: "agent_message", content: [{ type: "weird" }] } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", started_at_ms: 10, completed_at_ms: 25, item: { type: "McpToolCall", id: "m1", server: "gh", tool: "get", arguments: { id: 1 }, status: "completed", result: { content: [{ type: "text", text: "ok" }] } } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "m2", server: "gh", tool: "err", status: "failed", error: { message: "boom" } } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "m3", server: "gh", tool: "run", status: "in_progress" } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "FunctionCallOutput", id: "f1", namespace: "ns", name: "fn", output: "val" } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "ImageView", id: "iv1", path: "/tmp/a.png" } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "Extension", id: "ex1", action: { pattern: "*.ts" } } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: "bad" } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "wrong" }] } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text" }] } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "thread_goal_updated", goal: { objective: "ship", status: "active" } } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "thread_goal_updated", goal: { objective: "ship", status: "active" } } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "quota" }, turn_id: "t1" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: {} } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "error" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "event_msg", payload: { type: "unknown_evt" } })}`,
      `${codexHeader}\n${JSON.stringify({ type: "unknown_row" })}`
    ]

    const baseClaude = { uuid: "u1", version: "2.1.0", sessionId: "cs1", timestamp: "2026-10-01T00:00:00Z" }
    const claudeCases = [
      JSON.stringify({ type: "unknown_type" }),
      JSON.stringify({ type: "" }),
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "user", uuid: "u1" }),
      JSON.stringify({ type: "user", uuid: "u1", version: "99.0.0" }),
      JSON.stringify({ type: "user", uuid: "u1", version: "2.1.0" }),
      JSON.stringify({ ...baseClaude, type: "user", isSidechain: true, message: { content: "hi" } }),
      JSON.stringify({ ...baseClaude, type: "user", message: {} }),
      JSON.stringify({ ...baseClaude, type: "user", message: { content: [{ type: "weird_block" }] } }),
      JSON.stringify({
        ...baseClaude,
        type: "assistant",
        message: { content: [{ type: "redacted_thinking" }, { type: "fallback" }, { type: "weird" }] }
      }),
      JSON.stringify({
        ...baseClaude,
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "", name: "Read", input: {} }] }
      }),
      JSON.stringify({ ...baseClaude, type: "system", subtype: "compact_boundary" }),
      JSON.stringify({ ...baseClaude, type: "system", subtype: "unknown_sub" }),
      JSON.stringify({ ...baseClaude, type: "attachment", attachment: { type: "unknown_att" } }),
      [
        JSON.stringify({
          ...baseClaude,
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "NotebookEdit", input: { notebook_path: "a.ipynb", new_source: "x=1" } },
              {
                type: "tool_use",
                id: "t2",
                name: "MultiEdit",
                input: { file_path: "b.ts", edits: [{ old_string: "a", new_string: "b" }] }
              },
              { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "foo", path: "src/a.ts" } },
              { type: "tool_use", id: "t4", name: "LS", input: { path: "src" } }
            ]
          }
        }),
        JSON.stringify({
          ...baseClaude,
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
              { type: "tool_result", tool_use_id: "t2", content: "ok" },
              { type: "tool_result", tool_use_id: "t3", content: "ok" },
              { type: "tool_result", tool_use_id: "t4", content: "ok" }
            ]
          }
        })
      ].join("\n")
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        isCodex: Schema.Boolean,
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 28 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ isCodex, idx }) =>
          Effect.sync(() => {
            for (let k = 0; k < 5; k++) {
              if (isCodex) {
                const raw = codexCases[(idx + k) % codexCases.length]! + "\n"
                const res = ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, raw)
                if (!Result.isSuccess(res) && !Result.isFailure(res)) return false
              } else {
                const raw = claudeCases[(idx + k) % claudeCases.length]! + "\n"
                const res = ExternalTranscript.decodeClaude(ExternalTranscript.claudeStart, raw)
                if (!Result.isSuccess(res) && !Result.isFailure(res)) return false
              }
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Sandbox helpers, driveCell, QuickJSWorkerd.variantFrom & QuickJSSandbox deep paths", async () => {
    const badVariant = QuickJSWorkerd.variantFrom(() => Promise.reject(new Error("no wasm")))
    const badExit = await Effect.runPromiseExit(Effect.void.pipe(Effect.provide(badVariant)))
    expect(Exit.isFailure(badExit)).toBe(true)

    expect(Sandbox.callTimedOut("bash", 2000).outcome).toBe("failure")
    expect(Sandbox.callTimedOut("bash", 1500).outcome).toBe("failure")
    expect(Sandbox.callLimit(1000, { input: { timeoutMs: 3000 }, remainingMs: 2500 })).toBeGreaterThanOrEqual(1000)
    expect(Sandbox.callLimit(1000, { input: { timeoutMs: 3000 } })).toBe(4000)
    expect(Sandbox.compile(Cell.source("const x: number = 1", "typescript"))).toBeTypeOf("string")
    expect(Sandbox.raisedOutcome(new TypeError("bad")).name).toBe("TypeError")
    expect(Sandbox.raisedOutcome({ code: 42 }).message).toContain("42")
    expect(Sandbox.raisedOutcome(Symbol("s")).message).toContain("Symbol")

    const noop = Sandbox.makeNoop()
    expect(noop.capabilities.calls).toBe(false)
    await Effect.runPromise(Effect.serviceOption(Sandbox.Sandbox).pipe(Effect.provide(Sandbox.layerNoop())))

    for (const badLimits of [
      { calls: -1 },
      { steps: 0 },
      { timeMs: 0 },
      { pauseTotalMsFor: [""] }
    ] as Array<Sandbox.EvaluationLimits>) {
      const ex = await Effect.runPromiseExit(Sandbox.evaluationLimits(Sandbox.defaultLimits, badLimits))
      expect(Exit.isFailure(ex)).toBe(true)
    }

    // memoryBytes validation via openRealm
    const badMemExit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function*() {
          const sb = yield* Sandbox.Sandbox
          return yield* sb.openRealm!({ flows: {}, limits: { memoryBytes: 10 } })
        }).pipe(Effect.provide(QuickJSSandbox.layer))
      )
    )
    expect(Exit.isFailure(badMemExit)).toBe(true)

    const mkPending = (ordinal: number, flow = "read") => {
      let aborted: string | undefined
      let settled: Cell.CallResult | undefined
      const call: Sandbox.PendingCall = {
        ordinal,
        flow,
        input: {},
        kind: "call",
        settle: (r) => {
          settled = r
        },
        abort: (m) => {
          aborted = m
        }
      }
      return { call, getAborted: () => aborted, getSettled: () => settled }
    }

    const pReplay = mkPending(2)
    const replayOutcome = await Effect.runPromise(
      Sandbox.driveCell({
        pending: [pReplay.call],
        replay: {
          boundary: { terminal: "timeout", dispatched: 0, settled: 0 },
          outcome: new Cell.Rejected({ code: "limit_exceeded", message: "replayed" })
        },
        abort: () => {},
        flush: () => {},
        finished: () => undefined,
        handler: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: 1 }))
      })
    )
    expect(replayOutcome._tag).toBe("rejected")
    expect(pReplay.getAborted()).toBe("The cell was interrupted")

    const pLimit = mkPending(0)
    const limitOutcome = await Effect.runPromise(
      Sandbox.driveCell({
        pending: [pLimit.call],
        limits: { calls: 0 },
        abort: () => {},
        flush: () => {},
        finished: () => undefined,
        handler: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: 1 }))
      })
    )
    expect(limitOutcome._tag).toBe("rejected")

    const pTimeout = mkPending(0)
    let ticks = 0
    const timeoutOutcome = await Effect.runPromise(
      Sandbox.driveCell({
        pending: [pTimeout.call],
        limits: { callMs: 15 },
        abort: () => {},
        flush: () => {},
        finished: () => (++ticks > 1 ? new Cell.Settled({ transition: new Cell.Continue({}) }) : undefined),
        handler: () => Effect.sleep("200 millis").pipe(Effect.as(new Cell.CallResult({ outcome: "success", value: 1 })))
      })
    )
    expect(timeoutOutcome._tag).toBe("settled")
    expect(pTimeout.getSettled()?.outcome).toBe("failure")

    const pInt = mkPending(0)
    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          Sandbox.driveCell({
            pending: [pInt.call],
            abort: () => {},
            flush: () => {},
            finished: () => undefined,
            handler: () => Effect.never
          })
        )
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(fiber)
      })
    )
    expect(pInt.getAborted()).toBe("The cell was interrupted")

    // 1-shot heavy QuickJSSandbox resource ceiling checks (kept outside fuzz loop for speed)
    for (const heavyKind of ["steps-limit", "time-limit", "memory-over-budget", "too-large-to-weigh"] as const) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sandbox = yield* Sandbox.Sandbox
            const realm = yield* sandbox.openRealm!({
              flows: {},
              task: "fuzz-heavy",
              limits: heavyKind === "steps-limit"
                ? { steps: 20, totalMs: 500, timeMs: 500 }
                : heavyKind === "time-limit"
                ? { timeMs: 5, totalMs: 500, steps: 10_000_000 }
                : { memoryBytes: 1024 * 1024, totalMs: 500, timeMs: 500 }
            })
            if (heavyKind === "memory-over-budget") {
              yield* realm.evaluate({
                frame: 0,
                cell: Cell.source(`var big1 = "a".repeat(300000); var big2 = "b".repeat(300000);`, "javascript"),
                call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "ok" }))
              })
              const f2 = yield* realm.evaluate({
                frame: 1,
                cell: Cell.source(`ctx.done("after-mem")`, "javascript"),
                call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "ok" }))
              })
              expect(f2.outcome._tag).toBe("rejected")
            } else if (heavyKind === "too-large-to-weigh") {
              yield* realm.evaluate({
                frame: 0,
                cell: Cell.source(`var nodes = []; for (let i = 0; i < 6000; i++) nodes.push({ a: i, b: [i] });`, "javascript"),
                call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "ok" }))
              })
              const f2 = yield* realm.evaluate({
                frame: 1,
                cell: Cell.source(`ctx.done("after-weigh")`, "javascript"),
                call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "ok" }))
              })
              expect(f2.outcome).toBeDefined()
            } else {
              const f = yield* realm.evaluate({
                frame: 0,
                cell: Cell.source(`while (true) {}`, "javascript"),
                call: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "ok" }))
              })
              expect(f.outcome._tag).toBe("rejected")
            }
          }).pipe(Effect.provide(QuickJSSandbox.layer))
        )
      )
    }

    const realmCases = [
      "throw-error",
      "throw-object",
      "throw-primitive",
      "park-valid",
      "park-invalid",
      "checkpoint-mint",
      "deep-json",
      "stalled-promise",
      "pause-total-ms",
      "print-overflow",
      "replay-frame",
      "compile-fail-quickjs"
    ] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: realmCases.length - 1 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caseIdx }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const kind = realmCases[caseIdx]!
              const sandbox = yield* Sandbox.Sandbox
              const realm = yield* sandbox.openRealm!({
                flows: {
                  read: new Cell.FlowProjection({
                    name: "read",
                    description: "Read a file.",
                    capabilities: ["fs:read:**"],
                    tier: "sealed",
                    placement: Option.none(),
                    input: Option.none()
                  })
                },
                task: "fuzz",
                limits: kind === "pause-total-ms"
                  ? { pauseTotalMsFor: ["read"], totalMs: 60, timeMs: 500 }
                  : { totalMs: 250, timeMs: 200 }
              })
              const code = kind === "throw-error"
                ? `throw new TypeError("boom")`
                : kind === "throw-object"
                ? `throw { reason: "custom", count: 3 }`
                : kind === "throw-primitive"
                ? `throw "raw-str"`
                : kind === "park-valid"
                ? `ctx.park("waiting-input", "please confirm")`
                : kind === "park-invalid"
                ? `ctx.park("not-a-reason", "bad")`
                : kind === "checkpoint-mint"
                ? `const cp = await ctx.checkpoint(); ctx.done(cp)`
                : kind === "deep-json"
                ? `const r = await ctx.call("read", {}); ctx.done(r)`
                : kind === "stalled-promise"
                ? `await new Promise(() => {})`
                : kind === "pause-total-ms"
                ? `await ctx.call("read", {}); await new Promise(() => {})`
                : kind === "print-overflow"
                ? `const big = "x".repeat(40000); for (let i = 0; i < 6; i++) console.log(big); ctx.done("ok")`
                : kind === "replay-frame"
                ? `ctx.done("replayed")`
                : `var x = 1;`

              let deep: any = 1
              for (let i = 0; i < 135; i++) deep = { next: deep }

              const frame = yield* realm.evaluate({
                frame: 0,
                cell: Cell.source(code, "javascript"),
                ...(kind === "compile-fail-quickjs" ? { program: "function ( { broken" } : {}),
                ...(kind === "checkpoint-mint"
                  ? { mint: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: { checkpoint: "cp-1" } })) }
                  : {}),
                ...(kind === "replay-frame"
                  ? {
                    replay: {
                      boundary: { terminal: "settled", dispatched: 0, settled: 0 },
                      outcome: new Cell.Settled({ transition: new Cell.Complete({ output: "replayed", value: "replayed" }) })
                    }
                  }
                  : {}),
                call: () =>
                  kind === "deep-json"
                    ? Effect.succeed(new Cell.CallResult({ outcome: "success", value: deep }))
                    : kind === "pause-total-ms"
                    ? Effect.sleep("30 millis").pipe(Effect.as(new Cell.CallResult({ outcome: "success", value: "ok" })))
                    : Effect.succeed(new Cell.CallResult({ outcome: "success", value: "ok" }))
              })
              return frame.outcome !== undefined
            }).pipe(Effect.provide(QuickJSSandbox.layer))
          ),
        { seed, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(report)
    expect(QuickJSLifecycle.isQuarantined({} as any)).toBe(false)
  })

  it("FlowBinding, CellCalls, EngineLike, CellValidation & SchemaSignature deep paths", async () => {
    const noopEngine = EngineLike.makeNoop()
    const spend = await Effect.runPromise(Effect.service(EngineLike.Spend))
    const ft = await Effect.runPromise(Effect.service(EngineLike.FailedTimings))
    await Effect.runPromise(ft({ startedAt: 0, attempts: 1 }))
    expect(spend).toBeUndefined()
    const req = ModelRequest.ModelRequest.make({
      modelId: "m",
      system: [ModelRequest.SystemPart.make({ text: "s" })],
      messages: [],
      tools: [],
      toolChoice: "none",
      params: {}
    })
    const resolved = await Effect.runPromise(EngineLike.resolve(noopEngine, req))
    expect(Option.isSome(resolved)).toBe(true)
    expect(Option.isNone(await Effect.runPromise(noopEngine.capture({} as any)))).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(Stream.runDrain(noopEngine.sealStep({ request: req, keyMaterial: {} as any, modelCallMs: 100 })))
      )
    ).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(Stream.runDrain(noopEngine.splice({} as any))))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(noopEngine.call({} as any)))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(noopEngine.record({} as any)))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(noopEngine.suspend({} as any)))).toBe(true)
    await Effect.runPromise(Effect.service(EngineLike.EngineLike).pipe(Effect.provide(EngineLike.layerNoop())))

    for (const [text, lang, expectReject] of [
      ["return 1", "javascript", true],
      ["const ctx = 1", "javascript", true],
      ["const console = 1", "javascript", true],
      ["enum Color { Red }", "typescript", true],
      ["class Box { x = 1 }\nlet uninit;\nctx.done(new Box().x)", "javascript", false]
    ] as const) {
      const v = CellValidation.validate(Cell.source(text, lang))
      if (expectReject) expect(v.rejected).toBeDefined()
      else expect(v.compiled).toBeDefined()
    }

    for (const schema of [
      { type: "object", properties: { a: { type: "string" } }, required: ["missing"] },
      { type: "object", properties: {}, additionalProperties: false },
      { type: "object", properties: {}, additionalProperties: { type: "number" } },
      { anyOf: [{ type: "null" }] },
      { anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }] },
      { enum: ["a", "b"], type: "string" },
      { enum: [1, 2], type: "integer" },
      { enum: [null], type: "null" },
      { enum: [true], type: "boolean" },
      { enum: ["x"], type: "bogus" },
      { type: "array" },
      { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }], description: "item" } },
      { type: "unknown-kind" },
      {}
    ] as Array<Schema.Json>) {
      void SchemaSignature.render({ dialect: "draft-2020-12", schema, definitions: {} })
    }
    void SchemaSignature.render({ dialect: "draft-2020-12", schema: {}, unknownKey: 1 } as any)

    // ContextWindow static helpers, activeTools dedup, compactPrefix errors & valid
    const cwEmpty = ContextWindow.ContextWindow.empty("m1")
    const cwMade = ContextWindow.ContextWindow.make({
      modelId: "m1",
      activeTools: ["Read", " read ", "", "Write"],
      segments: [
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "sys" })] },
        { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("u1")] }
      ]
    })
    const cwApp = ContextWindow.ContextWindow.appendTurn(cwMade, ModelRequest.Message.assistant("a1"))
    void ContextWindow.ContextWindow.render(cwApp)
    void ContextWindow.ContextWindow.compact(cwApp, ModelRequest.Message.user("sum"))
    expect(Result.isFailure(ContextWindow.compactPrefix(cwApp, -1, ModelRequest.Message.user("s")))).toBe(true)
    expect(Result.isFailure(ContextWindow.compactPrefix(cwApp, 99, ModelRequest.Message.user("s")))).toBe(true)
    expect(Result.isSuccess(ContextWindow.compactPrefix(cwApp, 1, ModelRequest.Message.user("s")))).toBe(true)
    expect(cwEmpty.pipe((w) => w.segments.length)).toBe(0)
    expect(baseWindow.pipe((w) => w.segments.length)).toBe(baseWindow.segments.length)

    // StructuredOutput mismatched bracket balance & value decoding errors
    void StructuredOutput.candidates("before { [ } ] after")
    const minLenSchema = Schema.String.pipe(Schema.check(Schema.isMinLength(5)))
    const structErr1 = await Effect.runPromiseExit(
      StructuredOutput.decode(minLenSchema, "hi", { corrections: 0, limit: 1 }, "hi")
    )
    expect(Exit.isFailure(structErr1)).toBe(true)
    const structErr2 = await Effect.runPromiseExit(
      StructuredOutput.decode(minLenSchema, "hi", { corrections: 1, limit: 1 }, "hi")
    )
    expect(Exit.isFailure(structErr2)).toBe(true)
    const structErr3 = await Effect.runPromiseExit(
      StructuredOutput.decode(minLenSchema, "hi", { corrections: 0, limit: 1 })
    )
    expect(Exit.isFailure(structErr3)).toBe(true)

    // CallLedger control chars + array leaves, FailedCall destructuring, paidUsage, TruncatedOutput, CellHistory
    const ledgerEntry = CallLedger.entry(1, {
      flow: "read",
      input: { items: [{ a: 1 }, { a: 2 }], note: "a\nb\rc\td\u0007" },
      ok: true,
      value: { ok: true }
    })
    const renderedLedger = CallLedger.render([ledgerEntry], 0)
    expect(renderedLedger).toContain("\\n")
    expect(FailedCall.inspects(`let ok; ({ ok } = await ctx.call("read", {}));`, "read")).toBe(true)
    expect(
      FailedCall.inspects(`const rs = await Promise.all([ctx.call("read", {})]); for (const { error } of rs) { console.log(error) }`, "read")
    ).toBe(true)
    expect(FailedCall.inspects(`(await ctx.call("read", {})).error`, "read")).toBe(true)
    const pu = paidUsage.paidUsage([
      undefined,
      { modelId: "m1", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      { modelId: "m1", inputTokens: 20, outputTokens: 10, costUsd: 0.02 },
      { modelId: "m2", inputTokens: 5, outputTokens: 2 }
    ])
    expect(pu?.length).toBe(2)
    const truncContent = "x".repeat(TruncatedOutput.minimumBytes + 200)
    const caps = TruncatedOutput.captures("read", { truncated: true, content: truncContent })
    expect(caps.length).toBeGreaterThan(0)
    const reused = TruncatedOutput.reuse({ content: truncContent }, caps)
    expect(reused).toBeDefined()
    if (reused !== undefined) expect(TruncatedOutput.refusal("write", reused).length).toBeGreaterThan(0)
    const hist = await Effect.runPromise(CellHistory.make)
    await Effect.runPromise(hist.record({ frame: 0, cell: Cell.source("ctx.done(1)"), digest: "d1" } as any))
    expect((await Effect.runPromise(hist.cells())).length).toBe(1)
    const noopHist = CellHistory.makeNoop()
    await Effect.runPromise(noopHist.record({} as any))
    expect((await Effect.runPromise(noopHist.cells())).length).toBe(0)
    await Effect.runPromise(Effect.service(CellHistory.CellHistory).pipe(Effect.provide(CellHistory.layerNoop())))
    await Effect.runPromise(Effect.service(CellHistory.CellHistory).pipe(Effect.provide(CellHistory.layerCells([]))))

    const TestService = Context.Service<{ readonly tag: string }>("Wave7TestSvc")
    const inputSchema = Schema.Struct({
      name: Schema.String,
      opt: Schema.optional(Schema.String)
    })
    const outputSchema = Schema.Struct({ ok: Schema.Boolean })

    const makeBinding = (
      mode: "ok" | "fail-pub" | "fail-throw" | "fail-timeout" | "fail-perm-denied" | "bad-output" | "non-json-output"
    ) => {
      const b = FlowBinding.make({
        flow: {
          name: "demo",
          description: "demo flow",
          capabilities: [],
          effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize" } as any,
          input: inputSchema,
          output: mode === "non-json-output" ? (Schema.Any as any) : outputSchema
        },
        publicError: (e: any) => {
          if (mode === "fail-throw") throw new Error("renderer crash")
          return mode === "fail-pub" || mode === "fail-timeout" ? String(e) : undefined
        },
        timedOut: (e: any) =>
          mode === "fail-timeout" ? { limitMillis: 1234, output: { partial: String(e) } } : undefined,
        handler: () =>
          Effect.gen(function*() {
            yield* TestService
            if (mode === "fail-perm-denied") {
              return yield* new Permission.PermissionDenied({ capability: "fs.write", reason: "nope" } as any)
            }
            if (mode === "fail-pub" || mode === "fail-throw" || mode === "fail-timeout") {
              return yield* Effect.fail("handler-err")
            }
            if (mode === "bad-output") return { ok: "not-bool" } as any
            if (mode === "non-json-output") return { fn: () => 1 } as any
            return { ok: true }
          })
      })
      return FlowBinding.provide(b, Context.make(TestService, { tag: "hi" }))
    }

    const modes = ["ok", "fail-pub", "fail-throw", "fail-timeout", "fail-perm-denied", "bad-output", "non-json-output"] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        modeIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: modes.length - 1 }))),
        nullOpt: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ modeIdx, nullOpt }) =>
          Effect.gen(function*() {
            const mode = modes[modeIdx]!
            const binding = makeBinding(mode)
            const call = mkCall(
              "demo",
              nullOpt ? { name: "a", opt: null } : { name: "a" },
              Cell.declarationDigest(binding.descriptor)
            )
            const exit = yield* Effect.exit(binding.run(call))
            if (mode === "fail-perm-denied") return Exit.isFailure(exit)
            if (Exit.isFailure(exit)) return false
            return mode === "ok" ? exit.value.outcome === "success" : exit.value.outcome === "failure"
          }),
        { seed, executions: Math.min(executions, 60) }
      )
    )
    assertPassed(report)

    const hiddenDesc = new Descriptor.FlowDescriptor({ ...descriptor("hidden"), modelInvocable: false })
    const mdDesc = new Descriptor.FlowDescriptor({
      ...descriptor("md"),
      body: new Descriptor.BodyRefMarkdown({ path: "md.md", baseDirectory: "/tmp", contentDigest: "0".repeat(64) })
    })
    const plainDesc = descriptor("plain")
    const otherDesc = new Descriptor.FlowDescriptor({ ...descriptor("demo"), description: "different" })
    const fakeRegistry = {
      list: () => Effect.succeed([hiddenDesc, mdDesc, plainDesc, otherDesc]),
      visible: () => Effect.succeed([mdDesc, plainDesc, otherDesc]),
      getOption: (name: string) => {
        const found = [hiddenDesc, mdDesc, plainDesc, otherDesc].find((d) => d.name === name)
        return Effect.succeed(Option.fromNullishOr(found))
      },
      get: () => Effect.fail(new Error("not found") as any),
      warnings: () => Effect.succeed([]),
      runPrompt: () => Effect.fail(new Error("prompt load failed") as any)
    } as any

    const okBinding = makeBinding("ok")
    const catalogRes = FlowBinding.catalogResult([okBinding])
    expect(Result.isSuccess(catalogRes)).toBe(true)
    const catalog = Result.isSuccess(catalogRes) ? catalogRes.success : ({ entries: [], bindings: new Map(), descriptors: [] } as any)
    const resolver = CellCalls.make({ registry: fakeRegistry, catalog })
    const rHidden = await Effect.runPromise(resolver.run(mkCall("hidden", {}, Cell.declarationDigest(hiddenDesc))))
    expect(rHidden.outcome).toBe("failure")
    const rChanged = await Effect.runPromise(resolver.run(mkCall("plain", {}, "wrong-digest")))
    expect(rChanged.outcome).toBe("failure")
    const rBindMismatch = await Effect.runPromise(resolver.run(mkCall("demo", {}, Cell.declarationDigest(otherDesc))))
    expect(rBindMismatch.outcome).toBe("failure")
    const rMdNoPrompt = await Effect.runPromise(resolver.run(mkCall("md", { args: "hi" }, Cell.declarationDigest(mdDesc))))
    expect(rMdNoPrompt.outcome).toBe("failure")
    const rUnimpl = await Effect.runPromise(resolver.run(mkCall("plain", {}, Cell.declarationDigest(plainDesc))))
    expect(rUnimpl.outcome).toBe("failure")

    const resolverWithPrompt = CellCalls.make({
      registry: fakeRegistry,
      prompt: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: "p" }))
    })
    const rMdBadIn = await Effect.runPromise(
      resolverWithPrompt.run(mkCall("md", { args: 123 as any }, Cell.declarationDigest(mdDesc)))
    )
    expect(rMdBadIn.outcome).toBe("failure")
    const rMdFail = await Effect.runPromiseExit(
      resolverWithPrompt.run(mkCall("md", { args: "hi" }, Cell.declarationDigest(mdDesc)))
    )
    expect(Exit.isFailure(rMdFail)).toBe(true)

    const overlaid = FlowBinding.registry(fakeRegistry, catalog)
    const listed = await Effect.runPromise(overlaid.list())
    const vis = await Effect.runPromise(overlaid.visible())
    const got = await Effect.runPromise(overlaid.get("demo"))
    const gotMiss = await Effect.runPromiseExit(overlaid.get("missing-xyz"))
    const warns = await Effect.runPromise(overlaid.warnings())
    expect(listed.length).toBeGreaterThan(0)
    expect(vis.length).toBeGreaterThan(0)
    expect(got.name).toBe("demo")
    expect(Exit.isFailure(gotMiss)).toBe(true)
    expect(warns.length).toBeGreaterThan(0)
  })

  it("CellTurn checkpoint at-option refusals, rejected-frame cap, park steering, compaction & placements", async () => {
    const scenarios = [
      "at-invalid",
      "at-unknown",
      "at-readonly-write",
      "rejected-compile-cap",
      "park-answered-steering",
      "compaction-summary",
      "compaction-empty-summary",
      "unmoved-claim-bounce",
      "claim-unproven-refuse",
      "placement-client",
      "placement-local",
      "placement-remote",
      "placement-sandbox"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: scenarios.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            const baseState = (overrides: Partial<Parameters<typeof CellTurn.make>[0]> = {}) =>
              CellTurn.make({
                session: "sess-w7",
                seat: "anthropic:test-model",
                modelParams: ModelRequest.GenerationParams.make(),
                layers: [],
                capabilityEnvelope: [],
                placement: Option.none(),
                contextWindow: baseWindow,
                maxFrames: 6,
                repeatCap: 0,
                narrowingCap: 0,
                unmovedCap: 0,
                unresolvedCap: 0,
                claimCap: 0,
                ...overrides
              })
            const sc = scenarios[idx]!
            if (sc.startsWith("placement-")) {
              const placement = sc.replace("placement-", "") as "client" | "local" | "remote" | "sandbox"
              const out = yield* runCellTurn({
                state: baseState({ placement: Option.some(placement) }),
                script: [emits(`await ctx.call("read", {}); ctx.done("ok")`)],
                flows: [descriptor("read")],
                calls: [{ _tag: "Success", value: "v" }]
              })
              return out.failure === undefined
            }
            if (sc === "at-invalid") {
              const out = yield* runCellTurn({
                state: baseState(),
                script: [emits(`const r = await ctx.call("read", {}, { at: "not-a-checkpoint" }); ctx.done(r.error.code)`)],
                flows: [descriptor("read")]
              })
              return out.failure === undefined
            }
            if (sc === "at-unknown") {
              const out = yield* runCellTurn({
                state: baseState(),
                script: [emits(`const r = await ctx.call("read", {}, { at: { checkpoint: "cp-missing" } }); ctx.done(r.error.code)`)],
                flows: [descriptor("read")]
              })
              return out.failure === undefined
            }
            if (sc === "at-readonly-write") {
              const out = yield* runCellTurn({
                state: baseState(),
                script: [emits(`const r = await ctx.call("write", {}, { at: ctx.base }); ctx.done(r.error.code)`)],
                flows: [descriptor("write", { writes: ["*"] })]
              })
              return out.failure === undefined
            }
            if (sc === "rejected-compile-cap") {
              const out = yield* runCellTurn({
                state: baseState({ readOnlyCap: 1 }),
                script: [
                  emits(`return 1`),
                  emits(`return 2`),
                  emits(`return 3`),
                  emits(`return 4`)
                ]
              })
              return out.failure !== undefined
            }
            if (sc === "compaction-summary" || sc === "compaction-empty-summary") {
              const bigText = "word ".repeat(350)
              const out = yield* runCellTurn({
                state: {
                  ...baseState({
                    contextWindowTokens: 120
                  }),
                  compactionDue: ["context-budget"]
                } as any,
                script: [
                  emits(`console.log(${JSON.stringify(bigText)})`),
                  emits(`console.log(${JSON.stringify(bigText)})`),
                  prose(sc === "compaction-empty-summary" ? "   " : "Summary of prior tool outputs and steps."),
                  emits(`ctx.done("compacted")`)
                ]
              })
              return out.events.length > 0
            }
            if (sc === "unmoved-claim-bounce" || sc === "claim-unproven-refuse") {
              const inventedEval = Evaluator.layerScripted(() => ({
                complete: { probability: 0.05 },
                overclaims: { probability: sc === "unmoved-claim-bounce" ? 0.99 : 0.01 },
                invented: { probability: sc === "unmoved-claim-bounce" ? 0.99 : 0.01 },
                unfinished: { probability: 0.99 }
              }))
              const out = yield* runCellTurn({
                state: baseState({
                  unmovedCap: sc === "unmoved-claim-bounce" ? 1 : 0,
                  claimCap: 0
                }),
                script: [
                  emits(`ctx.done("I could not finish editing src/a.ts because of a blocker.")`),
                  emits(`ctx.done("Still blocked.")`)
                ],
                tree: "digest-static",
                evaluator: inventedEval
              })
              return out.events.length > 0
            }
            let parkCalls = 0
            const steering = Layer.succeed(Steering.Source)(
              Steering.make({
                read: () => Effect.succeed(Steering.empty()),
                drain: (input) =>
                  Effect.sync(() => {
                    if (input.wouldIdle) {
                      parkCalls++
                      if (parkCalls === 1) {
                        return {
                          inserts: [],
                          instructions: [],
                          seatChanges: [],
                          remaining: Steering.empty(),
                          duplicate: true
                        }
                      }
                      const msg = ModelRequest.Message.user("proceed now")
                      return {
                        inserts: [msg],
                        instructions: [msg],
                        seatChanges: [],
                        remaining: Steering.empty(),
                        duplicate: false
                      }
                    }
                    return { inserts: [], instructions: [], seatChanges: [], remaining: Steering.empty(), duplicate: false }
                  })
              })
            )
            const out = yield* runCellTurn({
              state: baseState(),
              script: [
                emits(`ctx.park("waiting-input", "confirm?")`),
                emits(`ctx.done("resumed")`)
              ],
              steering
            })
            return out.events.length > 0
          }),
        { seed, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  })
})
