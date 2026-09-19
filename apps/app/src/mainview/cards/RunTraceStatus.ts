import { Option, Schema } from "effect"
import * as Digest from "@smthrs/core/Digest"
import { openCallIndex, uniqueCallEvents } from "@smthrs/gateway/Diagnosis"
import { Implementation, Receipt, receiptMatches, type Plan } from "../../../../../flows/coding/schema"
import { engineRunEvidence } from "./EngineTrace"
import type { JournalRecord, TraceModel } from "./RunTrace"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined
const strings = (value: unknown): ReadonlyArray<string> => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
const terminal = new Set(["completed", "failed", "cancelled", "no-capacity"])
const visible = (model: TraceModel, cursor = Infinity) => uniqueCallEvents(model.journal.filter(row =>
  Number.isSafeInteger(row.sequence) && row.sequence! <= cursor &&
  (row.runId === undefined || `run:${row.runId}` === model.root.id)))

export interface RunStatus {
  readonly verdict?: string
  readonly activity?: string
  readonly condition?: "thrashing" | "blocked" | "approval"
  readonly action?: "resume" | "approval"
}

/** Current work and a separate condition. Historical callers must supply their cursor. */
export const traceStatus = (model: TraceModel, cursor?: number): RunStatus => {
  const latest = model.journal.reduce((seq, row) => Math.max(seq, row.sequence ?? 0), 0)
  if ((cursor === undefined || cursor >= latest) && terminal.has(model.root.status)) return { verdict: model.root.status }
  let activity: string | undefined, condition: RunStatus["condition"], action: RunStatus["action"], verdict: string | undefined
  const approvals = new Set<string>()
  for (const row of visible(model, cursor)) {
    const p = record(row.payload)
    switch (row.kind) {
      case "control.agent.turn-opened": activity = "Thinking"; break
      case "control.agent.cell-produced": activity = "Running code"; break
      case "control.agent.cell-call-started": {
        const name = text(p.flowName), input = record(p.input)
        if (name === undefined) break
        const verbs = new Map([["read", "Reading"], ["grep", "Searching"], ["glob", "Listing"], ["ls", "Listing"],
          ["edit", "Editing"], ["write", "Writing"], ["apply_patch", "Editing"], ["test", "Testing"], ["bash", "Running"]])
        const subject = text(input.path) ?? text(input.command) ?? text(input.pattern) ?? strings(input.selection).join(" ")
        activity = `${verbs.get(name) ?? `Running ${name}`}${subject ? ` ${subject}` : ""}`
        break
      }
      case "control.agent.repeat-demanded": condition = "thrashing"; break
      case "control.agent.mutation-observed":
        if (p.basis === "observed" && p.mutated === true && condition === "thrashing") condition = undefined
        break
      case "control.agent.sufficiency-observed":
        if (text(p.flow) !== undefined && p.passed !== undefined && condition === "thrashing") condition = undefined
        break
      case "control.agent.suspended":
      case "control.run.parked": condition = "blocked"; action = p.reason === "approval" ? undefined : "resume"; break
      case "control.run.resumed": condition = undefined; action = undefined; break
      case "control.approval.requested":
        if (text(p.requestId) !== undefined) approvals.add(p.requestId as string)
        break
      case "control.approval.approved":
      case "control.approval.denied": {
        const id = text(p.requestId) ?? text(p.tokenId)
        if (id !== undefined) approvals.delete(id)
        break
      }
      case "control.run.completed": verdict = "completed"; break
      case "control.run.failed": verdict = "failed"; break
      case "control.run.cancelled": verdict = "cancelled"; break
    }
  }
  if (verdict !== undefined) return { verdict }
  if (approvals.size > 0) { condition = "approval"; action = "approval" }
  return { ...(activity === undefined ? {} : { activity }), ...(condition === undefined ? {} : { condition }), ...(action === undefined ? {} : { action }) }
}

export type GoalState = "pending" | "running" | "passed" | "failed" | "narrowed" | "stale"
export interface GoalCheck { readonly id: string; readonly target: string; readonly required: boolean; readonly state: GoalState }
export interface TraceGoal { readonly id: string; readonly title: string; readonly state: GoalState; readonly checks: ReadonlyArray<GoalCheck> }

/** Only these direct runner forms establish command checks. Shell programs and unknown runners do not. */
const checkSelection = (flow: string, input: unknown): ReadonlyArray<string> | undefined => {
  const p = record(input)
  if (flow === "test") return p.against === "base" ? undefined : strings(p.selection)
  if (flow === "target.run") return text(p.label) === undefined ? undefined : [p.label as string]
  if (flow !== "bash" || typeof p.command !== "string" || /[;&|`$<>\n]/.test(p.command)) return undefined
  const tokens = p.command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(token => token.replace(/^(['"])(.*)\1$/, "$2")) ?? []
  const prefix = tokens.slice(0, 3).join(" ")
  if (prefix === "bun run check" || prefix === "pnpm run check" || prefix === "python -m pytest") return tokens.slice(3)
  if (["bun test", "npx vitest", "pnpm vitest"].includes(tokens.slice(0, 2).join(" "))) return tokens.slice(tokens[2] === "run" ? 3 : 2)
  if (tokens[0] === "pytest" || tokens[0] === "vitest") return tokens.slice(tokens[1] === "run" ? 2 : 1)
  return undefined
}

const match = (selection: ReadonlyArray<string> | undefined, target: string): "full" | "narrowed" | undefined => {
  if (selection === undefined || target === "") return undefined
  const exact = selection.includes(target)
  const child = !target.startsWith("//") && selection.some(value => value.startsWith(`${target}/`) || value.startsWith(`${target}::`))
  if (!exact && !child) return undefined
  // Unknown flags cannot establish full verification. Preserve the narrower evidence without ticking the goal.
  return child || selection.some(token => token.startsWith("-")) ? "narrowed" : "full"
}

const overlap = (left: string, right: string): boolean => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`) || /[*?]/.test(left + right)
const decodeImplementation = Schema.decodeUnknownOption(Implementation)
const decodeReceipt = Schema.decodeUnknownOption(Receipt)

/** Goals are the plan's changes. Only matching results can advance their checks. */
export const traceGoals = (model: TraceModel, plan: Plan | undefined, cursor?: number): ReadonlyArray<TraceGoal> => {
  if (plan === undefined) return []
  const journal = visible(model, cursor)
  const native = engineRunEvidence(journal, model.root.id.slice(4))
  const planKey = Digest.canonical(plan)
  const planSequence = native.completed.reduce((seq, execution) =>
    ["coding/PreparePlan", "coding/PrepareWithWiki"].includes(execution.flowName ?? "") && Digest.canonical(execution.result!.value) === planKey
      ? Math.max(seq, execution.result!.sequence) : seq, 0)
  return plan.changes.map(change => {
    const paths = change.atoms.flatMap(atom => [...atom.reads, ...atom.writes])
    const checks = change.checks.map(check => {
      let state: GoalState = "pending", invalidated = 0, resultSequence = 0
      let checkedTree: string | undefined
      const nativeChecks = native.executions.flatMap(execution => {
        const wrapper = record(execution.input), input = record(wrapper.input ?? wrapper)
        const implementation = decodeImplementation(input.implementation)
        if (Option.isNone(implementation) || implementation.value.change !== change.id || input.check === undefined ||
          Digest.canonical(input.check) !== Digest.canonical(check) ||
          execution.flowName !== "coding/CommandCheck" && execution.flowName !== check.flow ||
          execution.flowName === "coding/CommandCheck" && wrapper.flow !== check.flow) return []
        const first = journal.find(row => row.kind === "control.engine.event" &&
          record(row.payload).executionId === execution.executionId && record(row.payload).generation === execution.generation)
        if (first === undefined || first.sequence! < planSequence) return []
        return [{ execution, implementation: implementation.value, opened: first.sequence! }]
      })
      const open: Array<{ flowName: string; callId?: string; input: unknown; sequence: number; match?: "full" | "narrowed" }> = []
      const invalidate = (seq: number, changed: ReadonlyArray<string>) => {
        if (changed.length > 0 && paths.length > 0 && !changed.some(path => paths.some(planned => overlap(path, planned)) || overlap(path, check.target))) return
        invalidated = seq
        if (state !== "pending") state = "stale"
      }
      for (const row of journal) {
        const p = record(row.payload), seq = row.sequence!
        if (seq < planSequence) continue
        for (const entry of nativeChecks.filter(entry => entry.opened === seq)) {
          state = "running"; resultSequence = seq
        }
        if (row.kind === "control.agent.mutation-observed" && p.basis === "observed" && p.mutated === true) invalidate(seq, strings(p.paths))
        if (row.kind === "control.agent.cell-call-started") {
          const flowName = text(p.flowName) ?? "", matched = match(checkSelection(flowName, p.input), check.target)
          open.push({ flowName, callId: text(p.callId), input: p.input, sequence: seq, match: matched })
          if (matched !== undefined) { state = matched === "full" ? "running" : "narrowed"; resultSequence = seq }
        }
        if (row.kind === "control.agent.cell-call-settled") {
          const index = openCallIndex(open, text(p.callId), text(p.flowName))
          const call = index < 0 ? undefined : open.splice(index, 1)[0]
          if (call === undefined) continue
          if (["edit", "write", "apply_patch"].includes(call.flowName) && p.outcome === "success") {
            const input = record(call.input)
            const patchPaths = typeof input.input === "string" ? [...input.input.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm)].map(hit => hit[1]!) : []
            invalidate(seq, text(input.path) === undefined ? patchPaths : [input.path as string])
          }
          if (call.match === undefined || call.sequence < resultSequence) continue
          resultSequence = call.sequence
          const value = record(p.value)
          state = invalidated >= call.sequence ? "stale" : p.outcome === "failure" || value.invalidProbe !== undefined ? "failed"
            : typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode) ? "pending"
            : value.exitCode !== 0 || strings(value.failed).length > 0 ? "failed"
            : value.parsed === true && value.passed === 0 ? "pending" : call.match === "narrowed" ? "narrowed" : "passed"
        }
        if (row.kind === "control.agent.narrowed-demanded" || row.kind === "control.agent.narrow-only-demanded") {
          const inputs = [p.broader, p.narrower, p.check].map(value => {
            if (typeof value !== "string") return value
            try { return JSON.parse(value) as unknown } catch { return { command: value } }
          })
          if (inputs.some(input => match(checkSelection(text(p.flow) ?? "", input), check.target) !== undefined) || strings(p.targets).includes(check.target)) {
            state = "narrowed"; resultSequence = seq
          }
        }
        for (const execution of native.completed.filter(entry => entry.result!.sequence === seq)) {
          if (![change.implementation, "coding/Implement", "coding/ImplementAtoms"].includes(execution.flowName ?? "")) continue
          const implemented = decodeImplementation(execution.result!.value)
          if (Option.isSome(implemented) && implemented.value.change === change.id &&
            checkedTree !== undefined && checkedTree !== implemented.value.head.treeId) invalidate(seq, implemented.value.writes)
        }
        for (const { execution, implementation, opened } of nativeChecks) {
          if (opened < resultSequence) continue
          if (execution.failure?.sequence === seq) { state = "failed"; resultSequence = opened }
          if (execution.result?.sequence !== seq) continue
          const receipt = decodeReceipt(execution.result.value)
          if (Option.isNone(receipt) || !receiptMatches(implementation, check, receipt.value)) {
            state = "pending"
            continue
          }
          state = invalidated >= opened || receipt.value.status === "superseded" ? "stale" : receipt.value.status
          checkedTree = implementation.head.treeId
          resultSequence = opened
        }
      }
      return { id: check.id, target: check.target, required: check.required, state }
    })
    const required = checks.filter(check => check.required)
    const state: GoalState = required.length > 0 && required.every(check => check.state === "passed") ? "passed"
      : required.some(check => check.state === "failed") ? "failed"
      : required.some(check => check.state === "stale") ? "stale"
      : required.some(check => check.state === "narrowed") ? "narrowed"
      : required.some(check => check.state === "running") ? "running" : "pending"
    return { id: change.id, title: change.title, state, checks }
  })
}
