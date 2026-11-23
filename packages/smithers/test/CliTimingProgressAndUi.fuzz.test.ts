import type * as Audience from "@smthrs/build-cli/Audience"
import type { ControlSchema } from "@smthrs/control"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as Bug from "../src/Bug.ts"
import * as Compatibility from "../src/cli/Compatibility.ts"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as McpStdio from "../src/cli/McpStdio.ts"
import * as OperatorTokenFile from "../src/cli/OperatorTokenFile.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as CliError from "../src/CliError.ts"
import * as Detached from "../src/Detached.ts"
import * as Doctor from "../src/Doctor.ts"
import * as Forensics from "../src/Forensics.ts"
import * as Gc from "../src/Gc.ts"
import * as Init from "../src/Init.ts"
import * as BoundedEvents from "../src/internal/BoundedEvents.ts"
import * as Legacy from "../src/Legacy.ts"
import * as NodeOutput from "../src/NodeOutput.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Providers from "../src/Providers.ts"
import * as Serve from "../src/Serve.ts"
import * as Ui from "../src/Ui.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Update from "../src/Update.ts"
import * as Verb from "../src/Verb.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeTerminal = () => {
  const chunks: Array<string> = []
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk))
        cb()
      }
    }),
    { isTTY: true, columns: 100 }
  )
  return { output, text: () => chunks.join("") }
}

const buildSyntheticStream = (opts: {
  readonly runId: string
  readonly frames: number
  readonly withCompaction: boolean
  readonly withRetry: boolean
  readonly withFailure: boolean
  readonly withNativeFacts: boolean
  readonly withApproval: boolean
  readonly finalStatus: "completed" | "failed" | "cancelled" | "running"
}): Array<ControlSchema.ControlEvent> => {
  const events: Array<ControlSchema.ControlEvent> = []
  let seq = 1
  const push = (kind: string, at: number, payload: Record<string, unknown> = {}) => {
    events.push({
      sequence: seq++,
      kind,
      runId: opts.runId as ControlSchema.ControlEvent["runId"],
      occurredAt: at,
      payload: payload as ControlSchema.ControlEvent["payload"]
    })
  }
  const agent = (name: string, at: number, payload: Record<string, unknown> = {}) =>
    push(`control.agent.${name}`, at, { ...payload, at })

  let t = 1_000
  push("control.run.accepted", t, { runId: opts.runId, flowId: "demo/flow", status: "accepted" })
  t += 50
  push("control.run.running", t, { runId: opts.runId, status: "running" })
  t += 100
  push("flows.agent.usage.v1", t, { stepKey: "boundary/a", spent: 800, costUsd: 0.002, costSource: "estimated" })
  agent("decision-settled", t + 20, {
    frame: 0,
    classifier: "relevance/unnecessary",
    latencyMs: 120,
    usage: { inputTokens: 700, outputTokens: 100, modelId: "jev" }
  })
  agent("relevance-settled", t + 20, {
    frame: 0,
    latencyMs: 120,
    usage: { inputTokens: 700, outputTokens: 100, modelId: "jev" }
  })

  for (let f = 0; f < opts.frames; f++) {
    t += 100
    agent("turn-opened", t, { frame: f, seat: "openai:gpt-test" })
    agent("model-requested", t + 10, {
      frame: f,
      attempt: 1,
      purpose: "frame",
      modelId: "gpt-test",
      promptTokens: 1000 + f * 200
    })
    if (opts.withRetry && f === 0) {
      t += 200
      agent("model-failed", t, {
        frame: f,
        attempt: 1,
        purpose: "frame",
        durationMillis: 190,
        retryable: true,
        message: "rate limit"
      })
      agent("model-requested", t + 50, { frame: f, attempt: 2, purpose: "frame", modelId: "gpt-test" })
      t += 100
    }
    t += 400
    push("flows.agent.usage.v1", t - 5, {
      stepKey: `frame-${f}`,
      spent: 1500,
      costUsd: 0.015,
      costSource: "reported"
    })
    agent("model-settled", t, {
      frame: f,
      durationMillis: 380,
      costUsd: 0.015,
      modelId: "gpt-test",
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 300,
        reasoningTokens: 100,
        totalTokens: 1300
      }
    })
    agent("cell-produced", t + 5, { frame: f, code: `console.log("frame ${f}")` })
    agent("cell-printed", t + 10, { frame: f, text: `Working on frame ${f}\nDone step` })
    const callId = `cell-call-v1:${String(f).padStart(64, "a")}`
    agent("cell-call-started", t + 20, { frame: f, callId, flowName: "bash", input: { cmd: "echo hi" } })
    if (opts.withNativeFacts) {
      push("control.engine.event", t + 25, {
        version: 1,
        executionId: opts.runId,
        generation: 0,
        sequence: seq,
        emittedAtMs: t + 25,
        sourceSequence: f * 10 + 1,
        sourceId: `call-fact-v1:${callId}:invoked`,
        eventType: "flows.harness.call-fact.v1",
        payload: {
          version: 1,
          phase: "invoked",
          callId,
          identity: { runId: opts.runId, frame: f, cell: `cell-${f}`, ordinal: 0, declaration: "d", layers: [] },
          flowName: "bash",
          input: { cmd: "echo hi" }
        }
      })
      push("control.engine.event", t + 45, {
        version: 1,
        executionId: opts.runId,
        generation: 0,
        sequence: seq,
        emittedAtMs: t + 45,
        sourceSequence: f * 10 + 2,
        sourceId: `node-sched-${f}`,
        eventType: "flows.node.scheduled.v1",
        payload: { nodeId: `step-${f}`, kind: "ActionCall", actionTag: "bash" }
      })
      push("control.engine.event", t + 85, {
        version: 1,
        executionId: opts.runId,
        generation: 0,
        sequence: seq,
        emittedAtMs: t + 85,
        sourceSequence: f * 10 + 3,
        sourceId: `node-done-${f}`,
        eventType: "flows.node.completed.v1",
        payload: { nodeId: `step-${f}`, value: { ok: true, frame: f } }
      })
      push("control.engine.event", t + 90, {
        version: 1,
        executionId: opts.runId,
        generation: 0,
        sequence: seq,
        emittedAtMs: t + 90,
        sourceSequence: f * 10 + 4,
        sourceId: `call-fact-v1:${callId}:settled`,
        eventType: "flows.harness.call-fact.v1",
        payload: {
          version: 1,
          phase: "settled",
          callId,
          identity: { runId: opts.runId, frame: f, cell: `cell-${f}`, ordinal: 0, declaration: "d", layers: [] },
          flowName: "bash",
          outcome: opts.withFailure && f === opts.frames - 1 ? "failure" : "success",
          value: { out: "ok" },
          ...(opts.withFailure && f === opts.frames - 1 ? { message: "command exited 1" } : {})
        }
      })
    }
    agent("cell-call-settled", t + 100, {
      frame: f,
      callId,
      flowName: "bash",
      outcome: opts.withFailure && f === opts.frames - 1 ? "failure" : "success",
      value: { ok: !opts.withFailure }
    })
    agent("cell-settled", t + 110, {
      frame: f,
      outcome: { _tag: "settled", transition: { _tag: f === opts.frames - 1 ? "done" : "continue" } }
    })
    agent("mutation-observed", t + 115, { frame: f, mutated: f % 2 === 0, basis: "observed" })
    agent("supervisor-settled", t + 120, {
      frame: f,
      latencyMs: 80,
      crossed: false,
      nudged: false,
      usage: { inputTokens: 300, outputTokens: 40, modelId: "jev" }
    })
    agent("turn-closed", t + 130, { frame: f, outcome: f === opts.frames - 1 ? "done" : "continue" })

    if (opts.withCompaction && f === 0) {
      t += 150
      agent("compaction-started", t, { frame: f, beforeTokens: 12000 })
      agent("model-requested", t + 10, { frame: f, attempt: 1, purpose: "compaction", modelId: "gpt-test" })
      agent("model-settled", t + 200, {
        frame: f,
        purpose: "compaction",
        durationMillis: 190,
        costUsd: 0.003,
        usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 120, reasoningTokens: 0, totalTokens: 620 }
      })
      agent("compaction-settled", t + 210, { frame: f, beforeTokens: 12000, afterTokens: 2000 })
    }
  }

  if (opts.withApproval) {
    t += 50
    push("control.approval.requested", t, {
      approvalId: "appr-1",
      action: "fs:write",
      resource: "src/app.ts",
      reason: "modify source"
    })
    push("control.approval.resolved", t + 50, { approvalId: "appr-1", decision: "approve" })
  }

  t += 100
  if (opts.finalStatus === "completed") {
    push("control.engine.event", t - 10, {
      version: 1,
      executionId: opts.runId,
      generation: 0,
      sequence: seq,
      emittedAtMs: t - 10,
      sourceSequence: 999,
      sourceId: "exec-done",
      eventType: "flows.execution.completed.v1",
      payload: { value: { summary: "all green" } }
    })
    push("control.run.completed", t, { runId: opts.runId, status: "completed", output: { summary: "all green" } })
  } else if (opts.finalStatus === "failed") {
    push("control.run.failed", t, {
      runId: opts.runId,
      status: "failed",
      error: { message: "step failed", code: "step_error" }
    })
  } else if (opts.finalStatus === "cancelled") {
    push("control.run.cancelled", t, { runId: opts.runId, status: "cancelled", reason: "user requested" })
  }

  return events
}

describe("@smthrs/cli RunTiming, RunProgress, RunActivity, RunHistory, Forensics, NodeOutput, Output, Ui & Core CLI fuzz invariants", () => {
  it("RunTiming, RunProgress, RunActivity, RunHistory, Forensics & NodeOutput fold and render arbitrary run streams without crashing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        frames: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
        withCompaction: Schema.Boolean,
        withRetry: Schema.Boolean,
        withFailure: Schema.Boolean,
        withNativeFacts: Schema.Boolean,
        withApproval: Schema.Boolean,
        finalStatus: Schema.Literals(["completed", "failed", "cancelled", "running"]),
        progressMode: Schema.Literals(["live", "plain", "silent"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (
          { frames, withCompaction, withRetry, withFailure, withNativeFacts, withApproval, finalStatus, progressMode }
        ) =>
          Effect.gen(function*() {
            const runId = "run-fuzz-1"
            const events = buildSyntheticStream({
              runId,
              frames,
              withCompaction,
              withRetry,
              withFailure,
              withNativeFacts,
              withApproval,
              finalStatus
            })

            // 1. RunTiming.fold + render
            const timing = RunTiming.fold(events, runId)
            const timingText = RunTiming.render(timing)
            assertInv(typeof timingText === "string" && timingText.length > 0, "RunTiming.render non-empty")

            // 2. RunProgress.project + make + observe
            let state = RunProgress.initial()
            for (const ev of events) {
              const projected = RunProgress.project(state, ev)
              state = projected.state
              assertInv(RunProgress.running(state) >= 0, "RunProgress.running non-negative")
            }
            const term = makeTerminal()
            const pol: Audience.Policy = {
              audience: progressMode === "silent" ? "agent" : "human",
              source: "override",
              harnesses: [],
              structured: true,
              progress: progressMode,
              interactive: progressMode === "live"
            }
            const renderer = RunProgress.make(runId, { policy: pol, output: term.output })
            for (const ev of events) renderer.event(ev)
            renderer.close("ended")
            assertInv(typeof RunProgress.text({ nested: "hello\nworld" }) === "string", "RunProgress.text")

            const observed = yield* Stream.runCollect(
              RunProgress.observe(Stream.fromIterable(events), runId, progressMode === "silent").pipe(
                Stream.provideService(RunProgress.Configuration, { policy: pol, output: term.output })
              )
            )
            assertInv(observed.length === events.length, "RunProgress.observe yields all events")

            // 3. Forensics.digest + renderDiagnosis + eventLine + renderTranscript + shellQuote
            const digest = Forensics.digest(events, runId)
            const diag = Forensics.renderDiagnosis(
              {
                runId,
                flowId: "demo/flow",
                status: finalStatus,
                codeDrift: { recorded: "abc123", current: "def456" }
              },
              digest
            )
            assertInv(diag.includes(runId), "Forensics.renderDiagnosis includes runId")
            for (const ev of events.slice(0, 6)) {
              assertInv(typeof Forensics.eventLine(ev) === "string", "Forensics.eventLine string")
            }
            const transcript = Forensics.renderTranscript(events, runId)
            assertInv(typeof transcript === "string", "Forensics.renderTranscript string")
            const sq = Forensics.shellQuote("hello 'world' $HOME")
            assertInv(sq.startsWith("'") && sq.endsWith("'"), "Forensics.shellQuote")

            // 4. RunActivity.fold + show + driftVerdict + failureOf + knownExecutionIds
            const runSummary: ControlSchema.RunSummary = {
              runId: runId as ControlSchema.RunSummary["runId"],
              flowId: "demo/flow",
              status: finalStatus,
              createdAt: 1000,
              updatedAt: 5000,
              codeDrift: { recorded: "abc", current: "def", recordedEngine: "1.0", currentEngine: "1.0" }
            }
            const activity = RunActivity.fold(events, runSummary)
            const shown = RunActivity.show(runSummary, events, 6000)
            assertInv(shown.runId === runId && typeof activity === "object", "RunActivity.show")
            assertInv(typeof RunActivity.driftVerdict(runSummary.codeDrift!) === "string", "driftVerdict")
            assertInv(Array.isArray(RunActivity.knownExecutionIds(events)), "knownExecutionIds")
            assertInv(typeof RunActivity.flowNameOf("demo/flow", "demo/flow") === "string", "flowNameOf")
            const failObj = RunActivity.failureOf(events, runId)
            assertInv(failObj === undefined || typeof failObj.message === "string", "failureOf shape")

            // 5. RunHistory.read + jsonBytes + errorText
            const history = yield* RunHistory.read(Stream.fromIterable(events), runId, BoundedEvents.defaultLimits)
            assertInv(history.events.length <= events.length, "RunHistory.read bounded")
            assertInv(RunHistory.jsonBytes({ a: 1 }) > 0, "RunHistory.jsonBytes")
            assertInv(typeof RunHistory.errorText(new Error("oops")) === "string", "RunHistory.errorText")

            // 6. NodeOutput.project + find + notFound + render
            const nodes = NodeOutput.project(events)
            assertInv(Array.isArray(nodes), "NodeOutput.project array")
            if (nodes.length > 0) {
              const found = NodeOutput.find(events, nodes[0]!.nodeId)
              assertInv(found !== undefined, "NodeOutput.find locates projected node")
              const renderedNode = NodeOutput.render(nodes[0]!)
              assertInv(typeof renderedNode === "string", "NodeOutput.render string")
            }
            assertInv(NodeOutput.notFound(runId, "missing-node", nodes).length > 0, "NodeOutput.notFound")

            return true
          }),
        { seed, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Output, Presentation, Ui, Compatibility, Unsupported, Verb, Bug, Update, Serve & Providers uphold CLI formatting and policy invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        verb: Schema.Literals([
          "build",
          "test",
          "flow",
          "runs",
          "targets",
          "doctor",
          "up",
          "down",
          "chat",
          "workflow",
          "ps",
          "logs",
          "unknown-cmd"
        ]),
        flag: Schema.Literals(["--json", "--format", "--watch", "--help", "--version", "--non-existent"]),
        seat: Schema.Literals([
          "codex-subscription",
          "kimi-k3",
          "openai",
          "gemini",
          "openrouter",
          "cerebras",
          "jev",
          "anthropic:claude-sonnet-4-5",
          "unknown"
        ]),
        ver: Schema.Literals(["0.9.0", "1.0.0-rc.18", "1.0.0", "2.0.0", "22.19.0", "18.0.0", "invalid"]),
        bindHost: Schema.Literals(["127.0.0.1", "::1", "localhost", "0.0.0.0", "192.168.1.5"]),
        secretText: Schema.Literals([
          "safe text",
          "Authorization: Bearer sk-ant-api03-1234567890abcdef1234567890",
          "ghp_1234567890abcdefghijklmnopqrstuvwx"
        ]),
        durationText: Schema.Literals(["30d", "12h", "45m", "10s", "0d", "invalid", "-5d"]),
        flowName: Schema.Literals(["my-flow", "valid_1", "", "../bad", "system/internal", "has spaces"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ verb, flag, seat, ver, bindHost, secretText, durationText, flowName }) =>
          Effect.gen(function*() {
            // Output.make
            const outSvc = Output.make()
            const renderedHuman = yield* outSvc.render({ ok: true, verb, nested: [1, 2] }, "human")
            const renderedJson = yield* outSvc.render({ ok: true, verb, nested: [1, 2] }, "json")
            assertInv(
              typeof renderedHuman.text === "string" && JSON.parse(renderedJson.text).verb === verb,
              "Output.make render"
            )

            // Presentation
            const cleanText = Presentation.clean("hello\u001b[31m world\u001b[0m\r\n")
            assertInv(!cleanText.includes("\u001b"), "Presentation.clean strips ANSI")
            const pol = Presentation.policy({ command: verb, formatExplicit: true }, {})
            assertInv(typeof pol.audience === "string", "Presentation.policy")
            const nextActs = Presentation.nextActions({ runId: "r-1", status: "running" })
            assertInv(Array.isArray(nextActs), "Presentation.nextActions")
            const envWrapped = yield* Effect.promise(() =>
              Presentation.withErrorEnvelope(() => {}, async (out) => {
                out("{\"ok\":true}\n")
                return { ok: true }
              })
            )
            assertInv(typeof envWrapped === "object", "Presentation.withErrorEnvelope")

            // Ui
            const term = makeTerminal()
            const ui = Ui.make({ output: term.output, interactive: false })
            yield* ui.note("fuzz note", "Title")
            yield* ui.info(verb)
            yield* ui.success("ok")
            yield* ui.warn(flag)
            yield* ui.checklist("Checks", [
              { level: "ok", name: "node", detail: ver },
              { level: "warn", name: "warn", detail: verb },
              { level: "fail", name: "fail", detail: flag }
            ])
            assertInv(Ui.levelWord("ok").trim() === "ok", "Ui.levelWord")
            const checklist = Ui.renderChecklist("Checks", [{ level: "ok", name: "x", detail: "y" }], {
              interactive: false
            })
            assertInv(checklist.includes("x"), "Ui.renderChecklist")

            // Compatibility, Unsupported, Verb
            const leg = Compatibility.legacyArguments([verb, flag])
            const fmtLog = Compatibility.formattedLogArguments([verb, flag])
            const agArgs = Compatibility.agentArguments([verb, flag])
            assertInv(leg === undefined || Array.isArray(leg), "Compatibility.legacyArguments")
            assertInv(fmtLog === undefined || Array.isArray(fmtLog), "Compatibility.formattedLogArguments")
            assertInv(agArgs === undefined || Array.isArray(agArgs), "Compatibility.agentArguments")

            const unsup = Unsupported.refusal([verb, flag])
            if (unsup !== undefined) assertInv(unsup instanceof CliError.UnsupportedError, "Unsupported.refusal type")
            if (flowName.startsWith("system/")) {
              assertInv(Unsupported.isReservedFlow(flowName), "isReservedFlow true")
              assertInv(
                Unsupported.reservedFlowError("start", flowName) instanceof CliError.UnsupportedError,
                "reservedFlowError"
              )
            }

            const foundVerb = Verb.find(verb)
            const selected = Verb.select([verb, flag])
            assertInv(typeof Verb.startsRuns([verb]) === "boolean", "Verb.startsRuns")
            if (foundVerb) assertInv(foundVerb.name === verb, "Verb.find matches")
            if (selected) assertInv(typeof selected.name === "string", "Verb.select matches")

            // Bug scrubbing — secrets MUST be redacted!
            const scrubbed = Bug.scrubText(secretText)
            if (secretText.includes("sk-ant-")) {
              assertInv(!scrubbed.includes("1234567890abcdef1234567890"), "Bug.scrubText redacts Anthropic key")
            }
            if (secretText.includes("ghp_")) {
              assertInv(!scrubbed.includes("ghp_1234567890"), "Bug.scrubText redacts GitHub token")
            }
            const bugRep = Bug.report({
              summary: secretText,
              version: "1.0.0",
              node: process.version,
              platform: process.platform,
              runs: []
            })
            assertInv(typeof bugRep.summary === "string", "Bug.report")

            // Update & Doctor.satisfiesNode
            const isNew = Update.isNewer(ver, "1.0.0-rc.18")
            assertInv(typeof isNew === "boolean", "Update.isNewer")
            const cmp = Update.compare("1.0.0-rc.18", { latest: ver, next: "1.0.0-rc.19" })
            assertInv(typeof Update.render(cmp) === "string", "Update.render")
            assertInv(typeof Doctor.satisfiesNode(ver) === "boolean", "Doctor.satisfiesNode")

            // Serve loopback refusal policy
            const isLoop = Serve.isLoopback(bindHost)
            const bind: Serve.Bind = { host: bindHost, port: 3000, listen: false, credential: undefined }
            const serveRefused = Serve.refuse(bind)
            if (!isLoop) assertInv(serveRefused instanceof CliError.UnsupportedError, "Serve refuses non-loopback")
            assertInv(typeof Serve.banner(bind) === "string", "Serve.banner")
            assertInv(Serve.workspaceHash("/tmp/ws").length > 0, "Serve.workspaceHash")
            assertInv(typeof Serve.health("/tmp/ws") === "object", "Serve.health")

            // Gc.duration
            const parsedDur = Gc.duration(durationText)
            if (durationText === "30d") assertInv(parsedDur === 30 * 24 * 60 * 60 * 1000, "Gc.duration 30d")
            if (durationText === "invalid" || durationText === "-5d") {
              assertInv(parsedDur === undefined, "Gc.duration rejects invalid")
            }
            assertInv(
              typeof Gc.failureMessage([{ database: "/tmp/x", reason: "locked" }]) === "string",
              "Gc.failureMessage"
            )

            // Providers & Agents & Init pure helpers
            const expanded = Providers.expandSeat(seat)
            assertInv(typeof expanded === "string", "Providers.expandSeat")
            assertInv(typeof Providers.isDecisionSeat(seat) === "boolean", "Providers.isDecisionSeat")
            const desc = Providers.describeSeat(seat)
            assertInv(desc === undefined || typeof desc.label === "string", "Providers.describeSeat")
            assertInv(
              Providers.providerKey(["OPENAI_API_KEY"], { OPENAI_API_KEY: "k" }) !== undefined,
              "Providers.providerKey"
            )
            assertInv(typeof Agents.codexConfigString(secretText) === "string", "Agents.codexConfigString")
            assertInv(
              typeof Agents.manualInstructions([Agents.agents[0]!.id], {}) === "string",
              "Agents.manualInstructions"
            )
            assertInv(typeof Init.isValidName(flowName) === "boolean", "Init.isValidName")
            if (Init.isValidName(flowName)) {
              const tmpl = Init.template(flowName, { seat: "openai:gpt-5", variable: "OPENAI_API_KEY", resolved: true })
              assertInv(tmpl.includes(flowName), "Init.template includes flowName")
            }

            // Detached admission line parsing
            const line = Detached.admissionLine("nonce-1", "run-abc")
            const parsedIds = Detached.announcedRunIds(`noise\n${line}\nmore`, "nonce-1")
            assertInv(parsedIds.length === 1 && parsedIds[0] === "run-abc", "Detached.announcedRunIds roundtrip")

            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Init.scaffold, Project, Legacy, Doctor.inspect, McpRemote token store, McpStdio framing & OperatorTokenFile work cleanly on real temp workspaces", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cli-fs-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          flowName: Schema.Literals(["hello", "review-pr", "nightly_check"]),
          withLegacyDb: Schema.Boolean,
          withGitignore: Schema.Boolean,
          origin: Schema.Literals(["https://smithers.sh", "http://127.0.0.1:4000", "https://app.smithers.sh/"]),
          repo: Schema.Literals(["NONE", "octo/app", "org/repo"]),
          vibe: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ flowName, withLegacyDb, withGitignore, origin, repo, vibe }) =>
            Effect.promise(async () => {
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "ws-"))
              try {
                // Mark as git dir marker so Init.ensureIgnored updates/creates .gitignore
                FsSync.mkdirSync(Path.join(dir, ".git"), { recursive: true })
                if (withGitignore) {
                  FsSync.writeFileSync(Path.join(dir, ".gitignore"), "node_modules/\n")
                }
                if (withLegacyDb) {
                  FsSync.mkdirSync(Path.join(dir, ".smithers"), { recursive: true })
                  const db = new DatabaseSync(Path.join(dir, ".smithers", "smithers.db"))
                  db.exec(
                    "CREATE TABLE _smithers_runs (run_id TEXT, workflow_name TEXT, workflow_path TEXT, status TEXT, heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT, pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER)"
                  )
                  db.prepare("INSERT INTO _smithers_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
                    "old-1",
                    "wf",
                    null,
                    "running",
                    Date.now(),
                    null,
                    null,
                    null,
                    null
                  )
                  db.close()
                }

                // Init.scaffold + ensureIgnored + Project + Legacy + Doctor.inspect
                const legacyPaths = Project.legacyState(dir)
                const igStatus = Init.ensureIgnored(dir)
                assertInv(
                  igStatus === "created" || igStatus === "updated" || igStatus === "unchanged" ||
                    igStatus === "skipped",
                  "Init.ensureIgnored"
                )
                const scaffolded = Init.scaffold(dir, flowName, { HOME: dir, OPENAI_API_KEY: "test-key" }, { vibe })
                assertInv(FsSync.existsSync(scaffolded.flowFile), "Init.scaffold writes flow file")
                assertInv(Project.flowsDirectory(dir).includes(".smithers"), "Project.flowsDirectory")
                if (withLegacyDb) {
                  assertInv(legacyPaths.length > 0, "Project.legacyState detects legacy db")
                  const legDb = Legacy.read(Path.join(dir, ".smithers", "smithers.db"))
                  assertInv(legDb.runs.length === 1, "Legacy.read reads rows")
                  const ref = Legacy.refusal([legDb])
                  assertInv(
                    typeof ref === "string" && ref.length > 0,
                    "Legacy.refusal returns notice for running legacy run"
                  )
                }

                const docReport = Doctor.inspect({
                  root: dir,
                  environment: { HOME: dir, PATH: process.env.PATH },
                  nodeVersion: process.version,
                  legacyPaths
                })
                assertInv(typeof Doctor.render(docReport) === "string", "Doctor.render")
                assertInv(typeof Doctor.failed(docReport) === "boolean", "Doctor.failed")

                // McpRemote token store roundtrip
                const normOrigin = McpRemote.normalizeOrigin(origin)
                const normRepo = McpRemote.normalizeRepo(repo === "NONE" ? undefined : repo)
                const epUrl = McpRemote.mcpEndpointUrl(normOrigin, normRepo)
                assertInv(epUrl.startsWith(normOrigin), "McpRemote.mcpEndpointUrl starts with origin")
                const tokPath = McpRemote.tokenStorePath({ HOME: dir, XDG_CONFIG_HOME: Path.join(dir, ".cfg") })
                McpRemote.writeStoredToken(tokPath, {
                  origin: normOrigin,
                  repo: normRepo ?? null,
                  token: "sma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  scope: "read write",
                  expiresAt: null,
                  updatedAt: new Date().toISOString()
                })
                const readBack = McpRemote.readStoredToken(tokPath, normOrigin, normRepo)
                assertInv(
                  readBack?.token === "sma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "McpRemote token roundtrip"
                )

                // OperatorTokenFile permissions (0600!)
                const opFile = Path.join(dir, "op.token")
                await OperatorTokenFile.writeOperatorTokenFile(opFile, "op_tok_secret")
                assertInv(FsSync.readFileSync(opFile, "utf8").trim() === "op_tok_secret", "OperatorTokenFile content")
                assertInv((FsSync.statSync(opFile).mode & 0o777) === 0o600, "OperatorTokenFile mode 0600")

                // McpStdio framing
                const frames: Array<string> = []
                const sink = new Writable({
                  write(chunk, _enc, cb) {
                    frames.push(String(chunk))
                    cb()
                  }
                })
                const framer = McpStdio.input(sink, 1024)
                const outChunks: Array<string> = []
                framer.on("data", (c: Buffer | string) => outChunks.push(String(c)))
                const done = new Promise<void>((resolve) => framer.on("end", resolve))
                framer.write("{\"jsonrpc\":\"2.0\",\"id\":1}\n")
                framer.end()
                await done
                assertInv(
                  (outChunks.join("") + frames.join("")).includes("\"jsonrpc\""),
                  "McpStdio.input forwards framed JSON"
                )

                return true
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }),
          { seed: seed + 2, executions: Math.min(executions, 15) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
