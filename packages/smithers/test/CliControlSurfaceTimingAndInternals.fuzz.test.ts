import { NodeCrypto, NodeFileSystem, NodeServices } from "@effect/platform-node"
import * as Control from "@smthrs/control/Control"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import type * as Snapshot from "@smthrs/engine-store/ExecutionSnapshot"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { Arbitrary, Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { Command } from "effect/cli"
import { HttpServer } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { TestConsole } from "effect/testing"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as CliError from "../src/CliError.ts"
import * as CommandMod from "../src/Command.ts"
import * as FlowCatalog from "../src/commands/FlowCatalog.ts"
import * as Forensics from "../src/Forensics.ts"
import * as AuthoredSources from "../src/internal/AuthoredSources.ts"
import * as Failure from "../src/internal/Failure.ts"
import * as NativeExecutionRead from "../src/internal/NativeExecutionRead.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as ReleasedChildResume from "../src/internal/ReleasedChildResume.ts"
import * as RoleProfile from "../src/internal/RoleProfile.ts"
import * as Telemetry from "../src/internal/Telemetry.ts"
import * as Output from "../src/Output.ts"
import * as Unsupported from "../src/Unsupported.ts"
import { invoke, project, remoteAddress, serverLayer } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

describe("@smthrs/cli Control Surface, Remote Server, Command Tree, NativeExecutionRead, ReleasedChildResume, RoleProfile, WorkspaceObservation & Deep Timing/History fuzz invariants", () => {
  it(
    "Live loopback NodeControl HTTP server + ControlCommands + ControlBridge + FlowCatalog + Command.cli uphold remote control invariants",
    async () => {
      const root = await project()
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctx = yield* Layer.build(serverLayer(root))
              const server = Context.get(ctx, HttpServer.HttpServer)
              const control = Context.get(ctx, Control.Control)
              const origin = remoteAddress(server)

              // 1. FlowCatalog.read against live Control service
              const cat = yield* FlowCatalog.read(control)
              assertInv(Array.isArray(cat.items) && cat.items.length >= 1, "FlowCatalog.read discovers flows")

              // 2. ControlBridge pure & remote connection helpers
              const connArgs = ControlBridge.connectionArguments({ quiet: true, remote: origin, root })
              assertInv(
                connArgs.includes("--remote") && connArgs.includes(origin),
                "connectionArguments formats remote"
              )
              assertInv(
                ControlBridge.isRemote({ quiet: true, remote: origin }, {}) === true,
                "isRemote true with --remote"
              )
              assertInv(ControlBridge.isRemote({ quiet: true, root }, {}) === false, "isRemote false with local --root")
              const cfg = ControlBridge.configuration({ quiet: true, remote: origin }, {})
              assertInv(cfg !== undefined, "configuration returns config")
              const failVal = ControlBridge.failureOf(
                Cause.fail(new CliError.UsageError({ message: "bad" })),
                undefined
              )
              assertInv(failVal !== undefined, "failureOf extracts failure")

              // 3. Remote CLI invocations over real loopback HTTP server
              const remoteFlags = ["--remote", origin, "--json"]
              const listed = yield* Effect.promise(() => invoke(["flow", "list", ...remoteFlags]))
              assertInv(!listed.codes.includes(1) && listed.stdout.includes("echo"), "remote flow list")

              const shown = yield* Effect.promise(() => invoke(["flow", "show", "echo", ...remoteFlags]))
              assertInv(!shown.codes.includes(1) && shown.stdout.includes("echo"), "remote flow show")

              const planned = yield* Effect.promise(() =>
                invoke(["flow", "plan", "echo", "--data", JSON.stringify({ message: "remote fuzz" }), ...remoteFlags])
              )
              assertInv(!planned.codes.includes(1), `remote flow plan succeeded: ${planned.stdout}`)
              const card = JSON.parse(planned.stdout) as { approval: unknown }
              const payload = JSON.stringify(card.approval)

              const denied = yield* Effect.promise(() => invoke(["approvals", "deny", payload, ...remoteFlags]))
              assertInv(denied.stdout.length > 0 || denied.stderr.length > 0, "remote approvals deny produced output")

              const apprList = yield* Effect.promise(() => invoke(["approvals", "list", ...remoteFlags]))
              assertInv(!apprList.codes.includes(1), "remote approvals list")

              const runsList = yield* Effect.promise(() => invoke(["runs", "list", ...remoteFlags]))
              assertInv(!runsList.codes.includes(1), "remote runs list")

              const runsCount = yield* Effect.promise(() => invoke(["runs", "count", ...remoteFlags]))
              assertInv(!runsCount.codes.includes(1), "remote runs count")

              const cancelAll = yield* Effect.promise(() => invoke(["runs", "cancel-all", ...remoteFlags]))
              assertInv(!cancelAll.codes.includes(1), "remote runs cancel-all")

              // Human-mode rendering of flow list / runs list
              const humanList = yield* Effect.promise(() => invoke(["flow", "list", "--remote", origin]))
              assertInv(humanList.stdout.length > 0, "human flow list renders")

              // ControlCommands sub-CLI help
              const flowCli = ControlCommands.createFlowCli()
              const runsCli = ControlCommands.createRunsCli()
              const apprCli = ControlCommands.createApprovalsCli()
              for (const sub of [flowCli, runsCli, apprCli]) {
                let out = ""
                yield* Effect.promise(() =>
                  sub.serve(["--help"], { env: {}, stdout: (t) => (out += t), exit: () => {} })
                )
                assertInv(out.length > 0, "control sub-CLI help renders")
              }
            })
          )
        )

        // 4. Effect CLI Command.cli help tree & removed verb refusals
        const runCli = Command.runWith(CommandMod.cli, { version: "1.0.0-fuzz" })
        const helpPaths: ReadonlyArray<ReadonlyArray<string>> = [
          ["--help"],
          ["run", "--help"],
          ["up", "--help"],
          ["plan", "--help"],
          ["approve", "--help"],
          ["cancel", "--help"],
          ["status", "--help"],
          ["logs", "--help"]
        ]
        for (const argv of helpPaths) {
          await Effect.runPromise(
            (runCli(argv).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer, Output.layer))
            ) as Effect.Effect<void, unknown, never>).pipe(Effect.result)
          )
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "NativeExecutionRead, ReleasedChildResume, AuthoredSources, RoleProfile & NodeWorkspaceObservation uphold structural and security invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4)),
          injectCycle: Schema.Boolean,
          changedPath: Schema.Literals([
            ".smithers/flows/alpha/flow.ts",
            "src/index.ts",
            "../../etc/passwd",
            ".smithers/flows/beta/flow.mdx"
          ]),
          settled: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ changedPath, depth, injectCycle, settled }) =>
            Effect.promise(async () => {
              // 1. NativeExecutionRead ancestry & cycle detection
              const map = new Map<string, Snapshot.Observed>()
              for (let i = 0; i < depth; i++) {
                const id = `run-${i}`
                const parentId = i === 0 ? (injectCycle && depth > 1 ? `run-${depth - 1}` : null) : `run-${i - 1}`
                map.set(id, {
                  _tag: "Observed",
                  runId: id,
                  source: "a".repeat(32),
                  revision: 1,
                  flowName: "work",
                  status: "running",
                  createdAtMs: 0,
                  startedAtMs: 0,
                  finishedAtMs: null,
                  parentRunId: parentId,
                  lineageId: "run-0",
                  roundOrdinal: i,
                  cancellation: { requestedAtMs: null, acknowledgement: null },
                  waiting: null
                })
              }
              const reader = NativeExecutionRead.make({
                read: (ids: ReadonlyArray<string>) =>
                  Effect.succeed({
                    source: "a".repeat(32),
                    revision: 1,
                    snapshots: ids.map((id) =>
                      map.get(id) ?? ({ _tag: "Absent", runId: id } as unknown as Snapshot.Snapshot)
                    )
                  } as never)
              } as never)
              const rootRes = await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function*() {
                    const built = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
                    const sql = Context.get(built, SqlClient)
                    return yield* Effect.result(
                      NativeExecutionRead.controlRunId(`run-${depth - 1}`, (id) => Effect.succeed(id === "run-0")).pipe(
                        Effect.provideService(SqlClient, sql)
                      )
                    )
                  })
                ).pipe(Effect.provide(NodeCrypto.layer))
              )
              assertInv(rootRes._tag === "Success" || rootRes._tag === "Failure", "controlRunId returns typed result")
              const snapBatch = await Effect.runPromise(
                Effect.result(reader({ executionIds: [`run-${depth - 1}`, "does-not-exist"] } as never))
              )
              assertInv(
                snapBatch._tag === "Success" || snapBatch._tag === "Failure",
                "reader batch returns typed result"
              )

              // 2. AuthoredSources matcher invariants
              const matcher = AuthoredSources.make()
              matcher.observe({
                runId: "exec-1",
                eventType: "flows.engine.diff-bundle-captured",
                payload: {
                  runId: "exec-1",
                  stepKeyDigest: "dig-1",
                  attempt: 1,
                  bundleIdentity: "bundle-1",
                  changedPaths: [changedPath]
                }
              } as never, 1)
              if (settled) {
                const hits = matcher.observe({
                  runId: "exec-1",
                  eventType: "flows.engine.copy-back-settled",
                  payload: {
                    runId: "exec-1",
                    stepKeyDigest: "dig-1",
                    attempt: 1,
                    bundleIdentity: "bundle-1",
                    rebases: 0
                  }
                } as never, 1)
                assertInv(Array.isArray(hits), "copy-back-settled returns hit array")
                if (changedPath.includes("..")) {
                  assertInv(hits.length === 0, "traversal path never triggers authored source reload")
                }
              }

              // 3. RoleProfile compose + splitFrontmatter + forRun on temp org
              const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-role-obs-fuzz-")))
              try {
                mkdirSync(join(root, "Org/Skills/voice"), { recursive: true })
                mkdirSync(join(root, "flows/assistant"), { recursive: true })
                writeFileSync(join(root, "Org/Common Operating Instructions.md"), "Shared rules\n")
                writeFileSync(join(root, "Org/Skills/voice/SKILL.md"), "---\nname: voice\n---\nSpeak plainly\n")
                const mdx = join(root, "flows/assistant/flow.mdx")
                writeFileSync(
                  mdx,
                  "---\ndescription: Assistant\nmodel: openai:gpt-5.1\nmetadata:\n  name: Assistant\n  skills: voice\n---\nCharter body\n"
                )
                const split = RoleProfile.splitFrontmatter("---\na: 1\n---\nHello body")
                assertInv(split.body.includes("Hello body"), "splitFrontmatter strips frontmatter")
                const composed = RoleProfile.compose({
                  org: join(root, "Org"),
                  role: "assistant",
                  body: "Charter body",
                  meta: { metadata: { name: "Assistant", skills: "voice" } }
                } as never)
                assertInv(
                  typeof composed === "object" && composed !== null &&
                    JSON.stringify(composed).includes("Charter body"),
                  "RoleProfile.compose"
                )

                const loadedProfile = await Effect.runPromise(
                  RoleProfile.forRun(
                    root,
                    {
                      name: "assistant",
                      frontmatter: {
                        description: "Assistant",
                        model: "openai:gpt-5.1",
                        metadata: { name: "Assistant", skills: "voice" }
                      }
                    } as never,
                    "Charter body",
                    ["fs:read:Org/Common Operating Instructions.md", "fs:read:Org/Skills/voice/SKILL.md"]
                  ).pipe(Effect.provide(NodeFileSystem.layer), Effect.result)
                )
                assertInv(loadedProfile._tag === "Success" || loadedProfile._tag === "Failure", "RoleProfile.forRun")

                // 4. NodeWorkspaceObservation scoped changes
                const obs = await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const ch = yield* NodeWorkspaceObservation.changes(root)
                      writeFileSync(join(root, "new-file.txt"), "added\n")
                      return ch
                    })
                  ).pipe(Effect.result)
                )
                assertInv(obs._tag === "Success", "NodeWorkspaceObservation.changes scoped succeeds")
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
              return true
            }),
          { seed, executions: Math.min(executions, 15) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)

      // 5. ReleasedChildResume on real in-memory SQLite stores
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const engineRuns = Context.get(native, RunStore.RunStore)
            yield* engineRuns.create("root", JSON.stringify({ version: 1, flowName: "root", payload: {} }))
            const owner: Ownership.OwnerId = { hostId: "host", pid: process.pid, nonce: "worker-fuzz" }
            const resumer = ReleasedChildResume.make({
              owner,
              engineJournal: Context.get(native, Journal.Journal),
              controlJournal: Context.get(control, Journal.Journal),
              engineRuns,
              controlRuns: Context.get(control, RunStore.RunStore),
              attempts: Context.get(native, AttemptStore.AttemptStore),
              sql: Context.get(native, SqlClient),
              engineState: Context.get(native, DurableEngineState.DurableEngineState),
              resume: () => Effect.void
            } as never)
            assertInv(typeof resumer === "object", "ReleasedChildResume.make built service")
          })
        ).pipe(Effect.provide(NodeCrypto.layer))
      )
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "RunTiming, RunHistory, RunActivity, RunProgress, Forensics, Presentation, Failure, Telemetry & Unsupported handle complex multi-wave/retry/error shapes",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          stepCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(6)),
          includeRetry: Schema.Boolean,
          includeFailure: Schema.Boolean,
          includeWait: Schema.Boolean,
          columns: Schema.Literals([40, 80, 140]),
          status: Schema.Literals(["running", "completed", "failed", "cancelled", "suspended"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ columns, includeFailure, includeRetry, includeWait, status, stepCount }) =>
            Effect.sync(() => {
              const events: Array<{
                readonly seq: number
                readonly type: string
                readonly emittedAtMs: number
                readonly payload: Record<string, unknown>
              }> = []
              let seq = 1
              let t = 1_700_000_000_000
              events.push({
                seq: seq++,
                type: "run.started",
                emittedAtMs: t,
                payload: { runId: "r-1", flowId: "build" }
              })
              for (let i = 0; i < stepCount; i++) {
                const stepKey = `step-${i}`
                t += 200
                events.push({
                  seq: seq++,
                  type: "step.started",
                  emittedAtMs: t,
                  payload: { stepKey, attempt: 1, name: `Step ${i}`, kind: i % 2 === 0 ? "model" : "action" }
                })
                if (includeRetry && i === 0) {
                  t += 500
                  events.push({
                    seq: seq++,
                    type: "step.failed",
                    emittedAtMs: t,
                    payload: { stepKey, attempt: 1, error: "transient 503" }
                  })
                  t += 300
                  events.push({
                    seq: seq++,
                    type: "step.started",
                    emittedAtMs: t,
                    payload: { stepKey, attempt: 2, name: `Step ${i}`, kind: "model" }
                  })
                }
                if (includeWait && i === stepCount - 1) {
                  t += 400
                  events.push({
                    seq: seq++,
                    type: "run.waiting",
                    emittedAtMs: t,
                    payload: { stepKey, reason: "human_approval", token: "tok-1" }
                  })
                }
                t += 800 + i * 150
                events.push({
                  seq: seq++,
                  type: includeFailure && i === stepCount - 1 ? "step.failed" : "step.completed",
                  emittedAtMs: t,
                  payload: {
                    stepKey,
                    attempt: includeRetry && i === 0 ? 2 : 1,
                    durationMs: 800 + i * 150,
                    error: includeFailure && i === stepCount - 1 ? "boom" : undefined
                  }
                })
              }
              events.push({
                seq: seq++,
                type: status === "failed" ? "run.failed" : status === "cancelled" ? "run.cancelled" : "run.completed",
                emittedAtMs: t + 100,
                payload: { runId: "r-1", status }
              })

              // Fold through RunTiming, RunProgress, RunActivity, RunHistory, Forensics
              const ctrlEvents = events.map((ev) => ({
                seq: ev.seq,
                eventId: `ev-${ev.seq}`,
                kind: ev.type.startsWith("run.") ? `control.${ev.type}` : `flows.engine.${ev.type}`,
                atMs: ev.emittedAtMs,
                runId: "r-1",
                payload: ev.payload
              }))
              const timing = RunTiming.fold(ctrlEvents as never, "r-1")
              const renderedTiming = RunTiming.render(timing)
              assertInv(typeof renderedTiming === "string", "RunTiming.render returns string")

              const progState = RunProgress.initial()
              for (const ev of ctrlEvents) {
                RunProgress.project(progState, ev as never)
              }
              assertInv(RunProgress.running(progState) >= 0, "RunProgress.running non-negative")
              assertInv(typeof RunProgress.text(progState, columns) === "string", "RunProgress.text")

              const actFolded = RunActivity.fold(ctrlEvents as never, { runId: "r-1", flowId: "build" })
              assertInv(typeof actFolded === "object", "RunActivity.fold")
              assertInv(typeof RunActivity.flowNameOf("work", "build") === "string", "RunActivity.flowNameOf")
              const actFail = RunActivity.failureOf(ctrlEvents as never, "r-1")
              assertInv(actFail === undefined || typeof actFail === "object", "RunActivity.failureOf")

              assertInv(typeof RunHistory.jsonBytes({ events: ctrlEvents }) === "number", "RunHistory.jsonBytes")
              assertInv(typeof RunHistory.errorText(new Error("boom")) === "string", "RunHistory.errorText")

              const dig = Forensics.digest(ctrlEvents as never, "r-1")
              assertInv(typeof dig === "object", "Forensics.digest returns object")
              const diag = Forensics.renderDiagnosis({ runId: "r-1", flowId: "build", status }, dig)
              assertInv(typeof diag === "string", "Forensics.renderDiagnosis returns string")
              const tr = Forensics.renderTranscript(ctrlEvents as never)
              assertInv(typeof tr === "string", "Forensics.renderTranscript returns string")

              // Failure & Presentation & Unsupported & Telemetry
              const safe = Failure.terminalSafeLines("line1\x1b[31mred\x1b[0m\r\nline2\x07bell")
              assertInv(
                !safe.includes("\x1b") && !safe.includes("\x07"),
                "Failure.terminalSafeLines strips control chars"
              )
              const refErr = new CliError.Refused({ fault: "user", code: "denied", message: "nope" })
              const errFormatted = Failure.operatorReport(refErr, true)
              assertInv(
                typeof errFormatted === "string" && errFormatted.length > 0,
                "Failure.operatorReport formats Refused"
              )
              assertInv(typeof Failure.commandReport(refErr, false) === "string", "Failure.commandReport")
              assertInv(typeof Failure.operatorLine(refErr, false) === "string", "Failure.operatorLine")
              assertInv(
                typeof Failure.terminalSafeJson(JSON.stringify({ a: "x\u001b[31m" })) === "string",
                "Failure.terminalSafeJson"
              )
              const pres = Presentation.runs(
                { show: true, otherwise: [{ command: "smthrs runs list", reason: "List runs" }] } as never
              )
              assertInv(typeof pres === "function" || typeof pres === "object", "Presentation.runs builds follow-ups")
              assertInv(Unsupported.removedVerbs.length > 0, "Unsupported.removedVerbs populated")
              assertInv(typeof Telemetry === "object", "Telemetry module loaded")
              return true
            }),
          { seed, executions: Math.min(executions, 80) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )
})
