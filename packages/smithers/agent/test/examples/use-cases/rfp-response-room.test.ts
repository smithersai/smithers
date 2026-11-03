import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { type DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, RfpResponseRoom, smeReview } from "../../../examples/use-cases/rfp-response-room.vibe"

const directory = mkdtempSync(join(tmpdir(), "rfp-response-room-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const input = (asked: string) => JSON.parse(/\nINPUT: (.+)/.exec(asked)?.[1] ?? "null")

/** How a scripted drafter scores one requirement, and which reviewer blocks. */
interface Scenario {
  readonly confidence?: Readonly<Record<string, number>>
  readonly blocker?: string
}

/**
 * Agents whose answers are derived from the INPUT each was handed: the
 * parser turns the customer into two requirements, the planner assigns the
 * requirements it was given, each draft answers the requirement it was given
 * at the scenario's confidence, each reviewer lists the drafts it read, and
 * the packager names one file per draft it was handed and quotes the
 * approval. Requests are recorded in order as `step: detail`.
 */
const script = (scenario: Scenario = {}) => {
  const turns: Array<string> = []
  const packaged: Array<ReturnType<typeof input>> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are an RFP intake analyst")) {
      const { customer, rfp } = input(asked)
      turns.push(`parse: ${rfp} for ${customer}`)
      const requirement = (id: string, topic: string) => ({
        id,
        section: "3.1",
        question: `${id} question`,
        mandatory: true,
        topic
      })
      return {
        opportunityName: `${customer} platform`,
        customer,
        dueDate: "2026-11-01",
        requirements: [requirement("SEC-1", "security"), requirement("IMP-2", "implementation")],
        submissionInstructions: ["one PDF"]
      }
    }
    if (asked.includes("You are a proposal manager")) {
      const { pricingRules, rfp } = input(asked)
      const ids = rfp.requirements.map((r: { id: string }) => r.id)
      turns.push(`plan: ${ids.join(",")} with ${pricingRules}`)
      return {
        workstreams: [{ topic: "all", ownerRole: "proposal-manager", requirementIds: ids }],
        sourceCollections: ["approved-answers"],
        risks: []
      }
    }
    if (asked.includes("You are an RFP response drafter")) {
      const { answerPlan, requirement } = input(asked)
      turns.push(`draft: ${requirement.id} (plan owner ${answerPlan.workstreams[0].ownerRole})`)
      const confidence = scenario.confidence?.[requirement.id] ?? 0.9
      return {
        requirementId: requirement.id,
        topic: requirement.topic,
        answer: `answer to ${requirement.question}`,
        citedSourceIds: ["SRC-1"],
        confidence,
        needsSME: false
      }
    }
    if (asked.includes("You are a proposal reviewer")) {
      const { drafts, role } = input(asked)
      const ids = drafts.map((d: { requirementId: string }) => d.requirementId)
      turns.push(`review ${role}: ${ids.join(",")}`)
      const blocked = scenario.blocker === role
      return {
        reviewerRole: role,
        approved: !blocked,
        requirementIds: ids,
        blockers: blocked ? [`${role} cannot back ${ids[0]}`] : [],
        suggestedEdits: []
      }
    }
    if (asked.includes("You are a proposal packager")) {
      const packet = input(asked)
      packaged.push(packet)
      turns.push("package")
      return {
        files: packet.drafts.map((d: { requirementId: string }) => `${d.requirementId}.${packet.outputFormat}`),
        openQuestions: packet.approval === null ? [] : [packet.approval.note],
        submissionReady: true,
        summary: `${packet.drafts.length} answers, ${packet.reviews.length} reviews`
      }
    }
    return undefined
  }
  return { answer, packaged, turns }
}

type Decision = { readonly approved: boolean; readonly reviewer: string; readonly note: string }

/**
 * A person at the inbox. Once the run parks on an approval, it records the
 * question the park carries and answers it with `decision` through
 * `HumanTask.answer`, the way a host records a reviewer's decision. A run that
 * never parks leaves it waiting until the run's scope closes.
 */
const inbox = (executionId: string, decision: Decision) => {
  const questions: Array<unknown> = []
  const answering = Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const parked = yield* state.waitingTree(executionId).pipe(
        Effect.map((rows) => rows.find((row) => row.reason === "approval")),
        Effect.repeat({ until: (row) => row?.token != null, schedule: Schedule.spaced(20) })
      )
      questions.push(parked?.request)
      // The waiting row stores the token the park declared, as plain text.
      yield* HumanTask.answer({ token: parked!.token! as DurableDeferred.Token, value: decision })
    }).pipe(Effect.orDie)
  ))
  return { questions, actions: Layer.mergeAll(layer, answering) }
}

/** The question a park carries, as a person's inbox renders it. */
const question = (prompt: string) => ({ task: "human", name: smeReview, kind: "json", prompt, attempt: 1 })

const approve: Decision = { approved: true, reviewer: "dana", note: "SEC-1 cleared by the CISO" }

it.live(
  "drafts every requirement, reviews them, and packages with no person asked when nothing is flagged",
  () =>
    Effect.gen(function*() {
      const { answer, packaged, turns } = script()
      const person = inbox("rfp-clean", approve)
      const output = yield* Kit.run(RfpResponseRoom, { customer: "Acme" }, {
        filename: join(directory, "clean.sqlite"),
        executionId: "rfp-clean",
        script: answer,
        actions: person.actions
      })

      // Each step read the one before it: the plan covers the parsed
      // requirements, each draft was handed the plan, and every reviewer read
      // both drafts.
      expect(turns.slice(0, 2)).toEqual([
        "parse: fixtures/rfp-response-room/rfp.md for Acme",
        "plan: SEC-1,IMP-2 with fixtures/rfp-response-room/pricing-rules.md"
      ])
      expect([...turns.slice(2, 4)].sort()).toEqual([
        "draft: IMP-2 (plan owner proposal-manager)",
        "draft: SEC-1 (plan owner proposal-manager)"
      ])
      expect([...turns.slice(4, 7)].sort()).toEqual([
        "review legal: SEC-1,IMP-2",
        "review product: SEC-1,IMP-2",
        "review security: SEC-1,IMP-2"
      ])
      expect(turns[7]).toBe("package")
      expect(person.questions).toEqual([])
      // The packager got the drafts in requirement order, the three reviews, and no approval.
      expect(packaged[0].approval).toBeNull()
      expect(packaged[0].reviews.map((r: { reviewerRole: string }) => r.reviewerRole)).toEqual([
        "security",
        "legal",
        "product"
      ])
      expect(output).toEqual({
        files: ["SEC-1.markdown", "IMP-2.markdown"],
        openQuestions: [],
        submissionReady: true,
        summary: "2 answers, 3 reviews"
      })
    }),
  { timeout: 60_000 }
)

it.live(
  "parks on a low-confidence draft until a person approves, then packages with the approval",
  () =>
    Effect.gen(function*() {
      const { answer, packaged, turns } = script({ confidence: { "SEC-1": 0.6 } })
      const person = inbox("rfp-approved", approve)
      const output = yield* Kit.run(RfpResponseRoom, { outputFormat: "docx" }, {
        filename: join(directory, "approved.sqlite"),
        executionId: "rfp-approved",
        script: answer,
        actions: person.actions
      })

      expect(person.questions).toMatchObject([
        question("Review RFP response exceptions\n1 low-confidence draft(s); 0 blocker(s).")
      ])
      expect(turns.at(-1)).toBe("package")
      expect(packaged[0].approval).toEqual(approve)
      expect(output.files).toEqual(["SEC-1.docx", "IMP-2.docx"])
      expect(output.openQuestions).toEqual(["SEC-1 cleared by the CISO"])
    }),
  { timeout: 60_000 }
)

it.live("ends the run without a package when the person denies a blocked review", () =>
  Effect.gen(function*() {
    // A threshold of 0.5 lets the 0.6 draft through, but the question still
    // counts it: as in 0.x, the count uses 0.8.
    const { answer, turns } = script({ confidence: { "SEC-1": 0.6 }, blocker: "legal" })
    const person = inbox("rfp-denied", { approved: false, reviewer: "dana", note: "legal is right" })
    const exit = yield* Effect.exit(Kit.run(RfpResponseRoom, { confidenceThreshold: 0.5 }, {
      filename: join(directory, "denied.sqlite"),
      executionId: "rfp-denied",
      script: answer,
      actions: person.actions
    }))

    expect(person.questions).toMatchObject([
      question("Review RFP response exceptions\n1 low-confidence draft(s); 1 blocker(s).")
    ])
    expect(turns).not.toContain("package")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
      "The SME denied the RFP response exceptions."
    )
  }), { timeout: 60_000 })

it.live("packages a draft under a lowered threshold with no person asked", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ confidence: { "SEC-1": 0.6 } })
    const person = inbox("rfp-threshold", approve)
    const output = yield* Kit.run(RfpResponseRoom, { confidenceThreshold: 0.5, maxDraftConcurrency: 1 }, {
      filename: join(directory, "threshold.sqlite"),
      executionId: "rfp-threshold",
      script: answer,
      actions: person.actions
    })

    // One draft at a time runs them in requirement order.
    expect(turns.slice(2, 4)).toEqual([
      "draft: SEC-1 (plan owner proposal-manager)",
      "draft: IMP-2 (plan owner proposal-manager)"
    ])
    expect(person.questions).toEqual([])
    expect(output.openQuestions).toEqual([])
  }), { timeout: 60_000 })
