import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, SurveyAnswererAgent } from "../../../examples/use-cases/survey-answerer-agent.vibe"

const directory = mkdtempSync(join(tmpdir(), "survey-answerer-agent-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The JSON a prompt rendered on its `label:` line. */
const line = (asked: string, label: string): any => JSON.parse(new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!)

/**
 * A gatherer that turns every source into a key fact, an answerer that
 * answers a question only when a fact names its id, and an auditor that
 * revises every low-confidence answer it is handed. Each request is recorded
 * in order with the data it carried. `brokenAnswers` makes the answerer
 * answer off-schema.
 */
const script = (brokenAnswers = false) => {
  const turns: Array<{ readonly step: string; readonly saw: unknown }> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a source material analyst")) {
      const sources: Array<{ id: string; says: string }> = line(asked, "Sources")
      turns.push({ step: "gather", saw: line(asked, "Questions") })
      return {
        documentSummaries: sources.map((s) => ({
          sourceId: s.id,
          title: `doc ${s.id}`,
          relevantExcerpts: [s.says],
          topics: [s.id]
        })),
        keyFacts: Object.fromEntries(sources.map((s) => [s.id, s.says])),
        summary: `${sources.length} sources`
      }
    }
    if (asked.includes("You are a survey response specialist")) {
      const questions: Array<{ id: string; text: string }> = line(asked, "Questions")
      const keyFacts: Record<string, string> = line(asked, "Key facts")
      turns.push({ step: "answer", saw: keyFacts })
      if (brokenAnswers) return { answers: "all yes" }
      const known = questions.filter((q) => keyFacts[q.id] !== undefined)
      return {
        answers: known.map((q) => ({
          questionId: q.id,
          questionText: q.text,
          answer: keyFacts[q.id]!,
          confidence: q.id === "q2" ? "low" : "high",
          sourceRefs: [q.id],
          reasoning: "stated in the source"
        })),
        unanswered: questions.filter((q) => keyFacts[q.id] === undefined).map((q) => ({
          questionId: q.id,
          questionText: q.text,
          reason: "no source covers it"
        })),
        summary: `${known.length} answered`
      }
    }
    if (asked.includes("You are a consistency and accuracy auditor")) {
      const answers: Array<{ questionId: string; answer: string; confidence: string }> = line(asked, "Answers")
      const unanswered: Array<{ questionId: string }> = line(asked, "Unanswered")
      turns.push({
        step: "audit",
        saw: { answers: answers.map((a) => a.questionId), unanswered: unanswered.map((u) => u.questionId) }
      })
      const weak = answers.filter((a) => a.confidence === "low")
      return {
        overallConsistency: weak.length > 0 ? "warn" : "pass",
        contradictions: [],
        unsupportedClaims: weak.map((a) => ({ questionId: a.questionId, claim: a.answer, issue: "low confidence" })),
        revisedAnswers: weak.map((a) => ({
          questionId: a.questionId,
          originalAnswer: a.answer,
          revisedAnswer: `${a.answer} (unconfirmed)`,
          reason: "low confidence"
        })),
        summary: `${weak.length} revised`
      }
    }
    return undefined
  }
  return { answer, turns }
}

const questions = [
  { id: "q1", text: "Do you encrypt data at rest?" },
  { id: "q2", text: "How often do you rotate keys?" },
  { id: "q3", text: "Do you have a bug bounty?" }
]
const sources = [{ id: "q1", says: "AES-256 at rest" }, { id: "q2", says: "yearly" }]

it.effect("answers from the gathered facts and audits those answers", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(SurveyAnswererAgent, { sources, questions }, {
      filename: join(directory, "answered.sqlite"),
      executionId: "survey-answered",
      script: answer,
      actions: layer
    })

    // Gather saw the questions; the answerer saw the facts gather produced; the
    // auditor saw exactly what the answerer returned.
    expect(turns).toEqual([
      { step: "gather", saw: questions },
      { step: "answer", saw: { q1: "AES-256 at rest", q2: "yearly" } },
      { step: "audit", saw: { answers: ["q1", "q2"], unanswered: ["q3"] } }
    ])
    expect(output.answers.answers.map((a) => [a.questionId, a.answer])).toEqual([
      ["q1", "AES-256 at rest"],
      ["q2", "yearly"]
    ])
    expect(output.answers.unanswered).toEqual([
      { questionId: "q3", questionText: "Do you have a bug bounty?", reason: "no source covers it" }
    ])
    expect(output.validation.overallConsistency).toBe("warn")
    expect(output.validation.revisedAnswers).toEqual([
      { questionId: "q2", originalAnswer: "yearly", revisedAnswer: "yearly (unconfirmed)", reason: "low confidence" }
    ])
  }))

it.effect("defaults to no sources and no questions", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(SurveyAnswererAgent, {}, {
      filename: join(directory, "empty.sqlite"),
      executionId: "survey-empty",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      { step: "gather", saw: [] },
      { step: "answer", saw: {} },
      { step: "audit", saw: { answers: [], unanswered: [] } }
    ])
    expect(output.validation.overallConsistency).toBe("pass")
  }))

it.effect("fails without an audit when the answerer cannot produce typed answers", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(SurveyAnswererAgent, { sources, questions }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "survey-broken",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("StructuredOutput")
    expect(turns.map((t) => t.step)).toContain("answer")
    expect(turns.map((t) => t.step)).not.toContain("audit")
  }))
