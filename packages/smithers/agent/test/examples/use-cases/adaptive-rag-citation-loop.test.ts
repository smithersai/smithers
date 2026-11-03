import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { type DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AdaptiveRagCitationLoop,
  DraftAnswer,
  FinalAnswer,
  JudgeCitations,
  layer,
  PlanRetrieval,
  RepairPlan,
  Retrieve,
  reviewTask,
  RouteQuery
} from "../../../examples/use-cases/adaptive-rag-citation-loop.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "adaptive-rag-citation-loop-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const question = "How long is the refund window for EU orders?"

/** The step's structured input: the one-line JSON after `INPUT:` that follows `instruction`. */
const input = (asked: string, instruction: string): any => {
  const at = asked.indexOf(instruction)
  return at === -1 ? undefined : JSON.parse(/INPUT: (.+)/.exec(asked.slice(at))![1]!)
}

/**
 * A router that answers `mode`; a planner that plans `sources`; retrievers
 * that each return one claim with a fresh source id; a writer that cites every
 * piece of evidence it was handed; a judge that grades the rounds with
 * `scores` in order (grounded at 0.85); a repair that renames the plan's
 * subquery and names a database source; and a final writer that reports what
 * it was handed. Every request is recorded in order.
 */
const script = (options: {
  readonly mode: string
  readonly sources?: ReadonlyArray<string>
  readonly scores: ReadonlyArray<number>
}) => {
  const turns: Array<string> = []
  let found = 0
  let judged = 0
  const answer: Kit.Script = (asked) => {
    if (input(asked, "Classify the question into a retrieval route.") !== undefined) {
      turns.push("route")
      return { mode: options.mode, reason: "policy question", risk: "medium" }
    }
    const plan = input(asked, "Create a retrieval plan")
    if (plan !== undefined) {
      turns.push(`plan ${plan.route.mode} in ${plan.corpus}`)
      return { subqueries: ["eu refund window"], sources: options.sources ?? [], mustCite: true, gapsToClose: [] }
    }
    const retrieve = input(asked, "Retrieve evidence for the requested source type.")
    if (retrieve !== undefined) {
      turns.push(`retrieve ${retrieve.source} for ${retrieve.plan.subqueries.join(", ")}`)
      const sourceId = `${retrieve.source}-${++found}`
      return {
        source: retrieve.source,
        query: retrieve.plan.subqueries[0],
        claims: [{ claim: `Refunds take 14 days (${sourceId})`, sourceId, quoteOrLocation: "p. 2", confidence: 0.9 }],
        gaps: []
      }
    }
    const draft = input(asked, "Draft an answer using only supplied evidence.")
    if (draft !== undefined) {
      turns.push(`draft from ${draft.evidence.length} evidence after ${draft.previousGrade?.score ?? "no grade"}`)
      const ids: ReadonlyArray<string> = draft.evidence.map((e: any) => e.claims[0].sourceId)
      return {
        answer: "EU orders can be refunded within 14 days.",
        citations: ids.map((id) => ({ sentence: "EU orders can be refunded within 14 days.", sourceIds: [id] })),
        unresolvedQuestions: []
      }
    }
    const judge = input(asked, "Judge whether the answer is grounded in the evidence.")
    if (judge !== undefined) {
      const score = options.scores[judged++]!
      turns.push(`judge ${judge.answer.citations.length} citations: ${score}`)
      return {
        grounded: score >= 0.85,
        score,
        missingEvidence: score >= 0.85 ? [] : ["EU statutory minimum"],
        unsupportedSentences: []
      }
    }
    const repair = input(asked, "Repair the retrieval plan based on the citation judge result.")
    if (repair !== undefined) {
      turns.push(`repair ${repair.priorPlan.subqueries.join(", ")} after ${repair.grade.score}`)
      return { subqueries: ["eu statutory minimum"], sources: ["database"], mustCite: true, gapsToClose: ["statute"] }
    }
    const final = input(asked, "Produce the final cited-answer status.")
    if (final !== undefined) {
      turns.push(`final grounded=${final.grounded} approval=${final.approval?.reviewer ?? "none"}`)
      return {
        status: final.grounded ? "answered" : final.approval ? "needs-human-review" : "insufficient-evidence",
        answer: final.answer.answer,
        citationCount: final.answer.citations.length,
        gaps: final.grade.missingEvidence,
        summary: final.approval ? final.approval.note : `scored ${final.grade.score}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("retrieves from three sources and answers when the first draft is grounded", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ mode: "retrieve", sources: ["vector", "database"], scores: [0.9] })
    const final = yield* Kit.run(AdaptiveRagCitationLoop, { question }, {
      filename: join(directory, "grounded.sqlite"),
      executionId: "adaptive-rag-grounded",
      script: answer,
      actions: layer
    })

    expect(turns.slice(0, 2)).toEqual(["route", "plan retrieve in fixtures/adaptive-rag"])
    // The three searches ran together; the plan's database source picked the third.
    expect(turns.slice(2, 5).sort()).toEqual([
      "retrieve database for eu refund window",
      "retrieve keyword for eu refund window",
      "retrieve vector for eu refund window"
    ])
    expect(turns.slice(5)).toEqual([
      "draft from 3 evidence after no grade",
      "judge 3 citations: 0.9",
      "final grounded=true approval=none"
    ])
    expect(final).toEqual({
      status: "answered",
      answer: "EU orders can be refunded within 14 days.",
      citationCount: 3,
      gaps: [],
      summary: "scored 0.9"
    })
  }))

it.effect("repairs the plan and redrafts until the judge accepts", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ mode: "retrieve", scores: [0.6, 0.88] })
    const final = yield* Kit.run(AdaptiveRagCitationLoop, { question }, {
      filename: join(directory, "repaired.sqlite"),
      executionId: "adaptive-rag-repaired",
      script: answer,
      actions: layer
    })

    expect(turns.slice(0, 2)).toEqual(["route", "plan retrieve in fixtures/adaptive-rag"])
    // The first plan names no database source, so its third search goes to
    // the web.
    expect(turns.slice(2, 5).sort()).toEqual([
      "retrieve keyword for eu refund window",
      "retrieve vector for eu refund window",
      "retrieve web for eu refund window"
    ])
    expect(turns.slice(5, 8)).toEqual([
      "draft from 3 evidence after no grade",
      "judge 3 citations: 0.6",
      "repair eu refund window after 0.6"
    ])
    // The second round searches with the repaired plan: its subquery, and its
    // database source for the third search.
    expect(turns.slice(8, 11).sort()).toEqual([
      "retrieve database for eu statutory minimum",
      "retrieve keyword for eu statutory minimum",
      "retrieve vector for eu statutory minimum"
    ])
    // The second draft read all six pieces of evidence and the first grade.
    expect(turns.slice(11)).toEqual([
      "draft from 6 evidence after 0.6",
      "judge 6 citations: 0.88",
      "final grounded=true approval=none"
    ])
    expect(final.status).toBe("answered")
    expect(final.citationCount).toBe(6)
  }))

it.effect("answers from memory without retrieving, and ends ungrounded at the round bound", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ mode: "answer-from-memory", scores: [0.7, 0.8] })
    const final = yield* Kit.run(AdaptiveRagCitationLoop, { question, maxIterations: 2 }, {
      filename: join(directory, "memory.sqlite"),
      executionId: "adaptive-rag-memory",
      script: answer,
      actions: layer
    })

    // No plan, no search and no repair; the last score clears the review
    // threshold, so nobody is asked.
    expect(turns).toEqual([
      "route",
      "draft from 0 evidence after no grade",
      "judge 0 citations: 0.7",
      "draft from 0 evidence after 0.7",
      "judge 0 citations: 0.8",
      "final grounded=false approval=none"
    ])
    expect(final).toEqual({
      status: "insufficient-evidence",
      answer: "EU orders can be refunded within 14 days.",
      citationCount: 0,
      gaps: ["EU statutory minimum"],
      summary: "scored 0.8"
    })
  }))

it.effect("asks a person to review an answer that ends below the review threshold", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ mode: "retrieve", scores: [0.4] })
    const reviews: Array<typeof HumanTask.action.payloadSchema.Type> = []
    const reviewer = Layer.effectDiscard(Effect.forkScoped(Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* Effect.andThen(
        Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10))),
        state.waiting("adaptive-rag-reviewed")
      ).pipe(Effect.repeat({ until: (row) => Option.isSome(row) && row.value.reason === "approval" }))
      const parked = Option.getOrThrow(row)
      reviews.push(typeof parked.request === "string" ? JSON.parse(parked.request) : parked.request)
      yield* HumanTask.answer({
        token: parked.token as DurableDeferred.Token,
        value: { approved: true, reviewer: "ana", note: "Ship with the statute caveat." }
      })
    })))
    const final = yield* Kit.run(AdaptiveRagCitationLoop, { question, maxIterations: 1 }, {
      filename: join(directory, "reviewed.sqlite"),
      executionId: "adaptive-rag-reviewed",
      script: answer,
      actions: Layer.mergeAll(
        RouteQuery.layer,
        PlanRetrieval.layer,
        Retrieve.layer,
        DraftAnswer.layer,
        JudgeCitations.layer,
        RepairPlan.layer,
        FinalAnswer.layer,
        reviewer
      )
    })

    // The last round still repaired the plan, as 0.x did, before the review.
    expect(turns.filter((turn) => !turn.startsWith("retrieve")).slice(-3)).toEqual([
      "judge 3 citations: 0.4",
      "repair eu refund window after 0.4",
      "final grounded=false approval=ana"
    ])
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      name: reviewTask,
      kind: "json",
      prompt: "Review insufficiently grounded answer\n\nCitation score 0.4; missing evidence: EU statutory minimum"
    })
    expect(final).toEqual({
      status: "needs-human-review",
      answer: "EU orders can be refunded within 14 days.",
      citationCount: 3,
      gaps: ["EU statutory minimum"],
      summary: "Ship with the statute caveat."
    })
  }))
