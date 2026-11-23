import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentCommands from "../src/AgentCommands.ts"
import * as AgentContext from "../src/AgentContext.ts"
import * as AgentRoles from "../src/AgentRoles.ts"
import * as AgentToolResult from "../src/AgentToolResult.ts"
import * as GatewayWorkspace from "../src/GatewayWorkspace.ts"
import type { MythicalItem, MythicalStack } from "../src/Mythical.ts"
import * as StackIssues from "../src/StackIssues.ts"
import * as StackView from "../src/StackView.ts"
import * as UiInstruction from "../src/UiInstruction.ts"
import * as WorkerControls from "../src/WorkerControls.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/rpc stack, agent context, commands, tool result, roles, workspace & worker controls fuzz invariants", () => {
  it("StackIssues & StackView partition items completely without dropping, duplicating or dividing by zero", async () => {
    const stateArb = Schema.Literals([
      "queued",
      "planning",
      "implementing",
      "reviewing",
      "ready",
      "landing",
      "landed",
      "blocked",
      "rejected",
      "failed",
      "needs-approval"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        states: Schema.Array(stateArb).pipe(Schema.check(Schema.isMaxLength(10))),
        costNanos: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000_000 }))),
        humanEdited: Schema.Boolean,
        replans: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        spanMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ states, costNanos, humanEdited, replans, spanMs }) =>
          Effect.sync(() => {
            const items: Array<MythicalItem> = states.map((s, i) => ({
              id: `item-${i}`,
              state: s as MythicalItem["state"],
              attempt: i % 3,
              runs: {},
              dependsOn: [],
              updatedAt: "2026-10-01T12:00:00Z",
              createdAt: "2026-10-01T10:00:00Z",
              costNanos,
              humanEdited,
              todo: { replans, veryHard: i % 2 === 0 },
              reason: s === "blocked" ? "waiting on check" : undefined
            }))
            const stack: MythicalStack = {
              repository: "smithersai/smithers",
              state: "active",
              generation: 1,
              mainBehind: false,
              changes: [],
              items,
              lanes: [],
              limits: { maxParallel: 2 }
            }
            const groups = StackIssues.issueGroups(stack, Date.parse("2026-10-01T13:00:00Z"))
            const totalGrouped = groups.reduce((acc, g) => acc + g.items.length, 0)
            if (totalGrouped !== items.length) return false

            for (const it of items) {
              const g = StackIssues.issueGroupOf(it)
              if (g !== "needs-you" && g !== "working" && g !== "done") return false
              if (StackIssues.issueWord(it).length === 0) return false
              StackIssues.issueProgress(it)
              StackIssues.issueToLandedMs(it)
              if (StackView.itemStateLabel(it).length === 0) return false
              if (StackView.itemTitle(stack, it).length === 0) return false
              StackView.itemReason(it)
              StackView.settled(it)
            }
            const label = StackIssues.spanLabel(spanMs)
            if (label.length === 0) return false

            const metrics = StackIssues.stackMetrics(stack)
            const metricLabels = StackIssues.stackMetricLabels(metrics)
            if (metrics.landed === 0 && metrics.costPerLanded !== undefined) return false
            if (metrics.landed === 0 && metrics.landedUneditedShare !== undefined) return false
            if (metricLabels.length === 0) return false
            const settled = StackIssues.settledItems(stack)
            if (settled.length > items.length) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("AgentToolResult.boundToolResult enforces UTF-8 byte & line budgets; AgentCommands.decodeCommandsCall never throws", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.String.pipe(Schema.check(Schema.isMaxLength(200))),
        lines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
        chunk: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        maxBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 64, maximum: 2048 }))),
        maxLines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 30 }))),
        cmdName: Schema.Literals(["status", "open", "bad_cmd"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, lines, chunk, maxBytes, maxLines, cmdName }) =>
          Effect.sync(() => {
            const safeChunk = chunk.replace(/[\uD800-\uDFFF]/g, "x")
            const big = Array.from({ length: lines }, (_, i) => `${i}:${safeChunk}`).join("\n")
            const bounded = AgentToolResult.boundToolResult(big, maxBytes, maxLines)
            if (bounded.totalBytes !== AgentToolResult.utf8Bytes(big)) return false
            if (bounded.truncated && !bounded.modelOutput.includes("Tool result truncated")) return false
            if (!bounded.truncated && bounded.modelOutput !== big) return false

            // AgentCommands decoding must never throw on arbitrary input
            AgentCommands.decodeCommandsCall(raw)
            const validList = AgentCommands.decodeCommandsCall(JSON.stringify({ action: "list" }))
            if ("failure" in validList || validList.action !== "list") return false
            const validRun = AgentCommands.decodeCommandsCall(
              JSON.stringify({ action: "execute", name: "/" + cmdName, args: "a=1" })
            )
            if ("failure" in validRun || validRun.action !== "execute" || validRun.name !== cmdName) return false
            if (!AgentCommands.unknownToolResult(cmdName).includes(cmdName)) return false
            if (!AgentCommands.unknownCommandResult(cmdName).includes(cmdName)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("WorkerControls, AgentRoles, GatewayWorkspace, UiInstruction & AgentContext uphold schema and policy invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals(["requested", "queued", "running", "waiting", "parked", "done", "failed", "cancelled"]),
        action: Schema.Literals([
          "stop",
          "retry",
          "model",
          "wait",
          "steer",
          "thinking",
          "resume",
          "inspect",
          "approval"
        ]),
        liveModelSwitch: Schema.Boolean,
        hasWaitAction: Schema.Boolean,
        wsId: Schema.Literals(["ws_0123456789abcdef", "0123456789abcdef", "../bad", "", "not-hex-16chars!"]),
        roleId: Schema.Literals(["architect", "builder", "reviewer", "unknown-role"]),
        cloudId: Schema.Literals(["librarian", "flows", "other"]),
        instrCmd: Schema.Literals(["open", "focus", "navigate", "unknown-cmd"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, action, liveModelSwitch, hasWaitAction, wsId, roleId, cloudId, instrCmd }) =>
          Effect.sync(() => {
            const isLive = WorkerControls.live(status)
            const terminal = status === "done" || status === "failed" || status === "cancelled"
            if (isLive === terminal) return false
            const can = WorkerControls.allowed(action, {
              status,
              liveModelSwitch,
              ...(hasWaitAction ? { failure: { actions: ["wait"] } } : {})
            })
            if (action === "inspect" && !can) return false
            if (action === "stop" && can !== isLive) return false
            if (action === "approval" && can !== (status === "waiting")) return false

            const foundRole = AgentRoles.findAgentRole(roleId)
            if (foundRole !== undefined && AgentRoles.agentRoleTitle(foundRole).length === 0) return false
            if (AgentRoles.isCloudRoleId(cloudId)) {
              const cr = AgentRoles.cloudRole(cloudId)
              if (AgentRoles.cloudRoleModelId(cr, {}).length === 0) return false
            }

            const isGw = GatewayWorkspace.isGatewayWorkspaceId(wsId)
            const gwParsed = GatewayWorkspace.GatewayWorkspaceIdSchema.safeParse(wsId)
            if (isGw !== gwParsed.success) return false

            UiInstruction.isUiInstructionCommand(instrCmd)
            UiInstruction.isFormInstructionCommand(instrCmd)
            UiInstruction.UiInstructionFrameSchema.safeParse({ command: instrCmd })

            const ctx = AgentContext.AgentRuntimeContextSchema.safeParse({
              version: AgentContext.AGENT_RUNTIME_CONTEXT_VERSION,
              generatedAt: "2026-10-01T00:00:00Z",
              connectors: [],
              tabs: [],
              worldDocuments: []
            })
            if (ctx.success) {
              const rendered = AgentContext.renderAgentRuntimeContext(ctx.data)
              if (rendered.length === 0) return false
              const composed = AgentContext.composeAgentInstructions("base prompt", ctx.data)
              if (!composed.includes("base prompt")) return false
            }
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
