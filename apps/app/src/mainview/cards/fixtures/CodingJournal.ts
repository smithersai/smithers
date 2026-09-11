import * as JournalRecords from "../../../../../../packages/smithers/flows/engine-store/src/internal/JournalRecords.ts"
import { Schema } from "effect"
import { EarlyFeedback } from "../../../../../../flows/coding/feedback-schema.ts"
import { CODING_PLAN } from "./CodingPlan"

/** Synthetic native records made with the production journal writer. */
export const codingDecision = (sequence: number, executionId: string, flowName: string, options: {
  readonly parent?: string
  readonly status?: "running" | "completed" | "failed"
  readonly value?: unknown
  readonly input?: unknown
  readonly generation?: number
  readonly cause?: unknown
} = {}) => {
  const record = JournalRecords.runDecision({ runId: executionId, sourceId: "engine", lineageId: executionId }, {
    decision: options.status === undefined ? "created" : "transitioned",
    ...(options.status === undefined ? {} : { status: options.status }),
    state: {
      version: 1, flowName, payload: options.input ?? {},
      ...(options.parent === undefined ? {} : { parentExecutionId: options.parent }),
      ...(options.status === "completed" ? { result: { _tag: "Complete", exit: { _tag: "Success", value: options.value } } }
        : options.status === "failed" ? { result: { _tag: "Complete", exit: { _tag: "Failure", cause: options.cause ?? [{ _tag: "Die", defect: options.value ?? "check failed" }] } } } : {})
    }
  })
  return {
    sequence, occurredAt: sequence * 100, kind: "control.engine.event",
    payload: { version: 1, executionId, generation: options.generation ?? 0,
      sequence, eventId: `${executionId}/${options.generation ?? 0}/${sequence}`, sourceId: "engine", sourceSequence: sequence,
      emittedAtMs: sequence * 100, eventType: record.eventType, payload: record.payload, meta: {} }
  }
}

export const preparedCodingJournal = (plan = CODING_PLAN) => [
  codingDecision(1, "run-1", "agent/run"),
  codingDecision(2, "request", "coding/Request", { parent: "run-1", status: "running" }),
  codingDecision(3, "prepare", "coding/PreparePlan", { parent: "request", status: "running" }),
  codingDecision(4, "prepare", "coding/PreparePlan", { parent: "request", status: "completed", value: plan }),
  codingDecision(5, "correct", "coding/CorrectPlan", { parent: "request", status: "running", input: { plan, maxRounds: 2 } })
]

export const blockedCorrection = { status: "blocked" as const, rounds: 1, result: null,
  blocked: { executionId: "failed-round", message: "The required fast check failed." } }

export const blockedCodingJournal = () => [
  ...preparedCodingJournal(),
  codingDecision(6, "failed-round", "coding/ImplementPlan", { parent: "correct", status: "running" }),
  codingDecision(7, "failed-round", "coding/ImplementPlan", { parent: "correct", status: "failed", value: "The required fast check failed." }),
  codingDecision(8, "correct", "coding/CorrectPlan", { parent: "request", status: "completed", input: { plan: CODING_PLAN, maxRounds: 2 }, value: blockedCorrection }),
  codingDecision(9, "request", "coding/Request", { parent: "run-1", status: "completed", value: { plan: CODING_PLAN, outcome: blockedCorrection } })
]

/** Synthetic early-review evidence encoded with the actual private recipe codec. */
export const earlyCodingJournal = () => {
  const heads = CODING_PLAN.changes.map((change, index) => ({ ...CODING_PLAN.base,
    changeId: change.atoms[0]!.changeId ?? "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
    commitId: String(index + 1).repeat(40), treeId: String(index + 3).repeat(40) }))
  const finding = { owner: "memory", message: "Keep the causal revision when merging wiki edits.", sourceCommitId: heads[0]!.commitId }
  const early = new EarlyFeedback({ result: { status: "changes-requested", findings: [finding],
    changes: CODING_PLAN.changes.map((change, index) => ({
      implementation: { change: change.id, parent: heads[index - 1] ?? CODING_PLAN.base,
        atoms: [heads[index]!], head: heads[index]!, reads: change.atoms.flatMap(atom => atom.reads), writes: change.atoms.flatMap(atom => atom.writes) },
      receipts: change.checks.filter(check => check.tier === "fast" || index === 0 && check.tier === "slow").map(check => ({
        checkId: check.id, target: check.target, tier: check.tier, change: change.id,
        commitId: heads[index]!.commitId, treeId: heads[index]!.treeId, inputDigest: "synthetic-input",
        status: check.tier === "slow" ? "failed" as const : "passed" as const,
        evidence: check.tier === "slow" ? finding.message : "Synthetic passing fast check",
        findings: check.tier === "slow" ? [finding] : []
      }))
    }))
  } })
  return [...preparedCodingJournal(), codingDecision(6, "observe", "coding/ObservePlan", {
    parent: "correct", status: "failed", input: { plan: CODING_PLAN },
    cause: [{ _tag: "Fail", error: Schema.encodeSync(EarlyFeedback)(early) }]
  })]
}
