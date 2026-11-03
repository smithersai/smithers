import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { approvalTask, layer, LeadRouterWithApproval } from "../../../examples/use-cases/lead-router-with-approval.vibe"

const directory = mkdtempSync(join(tmpdir(), "lead-router-with-approval-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

/**
 * An intake that echoes the raw lead's company, a scorer that flags the lead
 * when `borderline`, and a CRM agent that answers from the routed lead it was
 * handed. Every request is recorded in order.
 */
const script = (borderline: boolean) => {
  const turns: Array<string> = []
  const routed: Array<Record<string, unknown>> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a lead intake specialist")) {
      const raw = JSON.parse(field(asked, "Raw lead")) as { readonly company: string }
      turns.push(`intake: ${field(asked, "Source")} ${raw.company}`)
      return {
        company: raw.company,
        contactEmail: `buyer@${raw.company.toLowerCase()}.test`,
        source: field(asked, "Source"),
        annualContractValue: 48_000,
        employeeCount: 300,
        intent: "demo request",
        rawNotes: "wants SSO"
      }
    }
    if (asked.includes("You are a lead scoring and routing engine")) {
      const lead = JSON.parse(field(asked, "Lead")) as { readonly company: string }
      turns.push(`score: ${lead.company}`)
      return {
        score: borderline ? 55 : 88,
        tier: "mid-market",
        route: "sales-west",
        needsApproval: borderline,
        reasoning: borderline ? "budget unclear" : "clear fit",
        signals: ["demo request"]
      }
    }
    if (asked.includes("You are a CRM integration agent")) {
      const lead = JSON.parse(field(asked, "Routed lead")) as Record<string, unknown>
      turns.push(`sink: ${String(lead["company"])}`)
      routed.push(lead)
      return {
        crmRecordId: `crm-${String(lead["company"])}`,
        assignedTo: String(lead["route"]),
        nextAction: lead["approvalNote"] === "" ? "Book a demo" : `Book a demo: ${String(lead["approvalNote"])}`,
        status: "routed",
        summary: `Routed to ${String(lead["route"])}`
      }
    }
    return undefined
  }
  return { answer, routed, turns }
}

/**
 * The person at the other end of the approval question. It waits until the
 * run parks on the question, records the prompt it was shown, and answers
 * with `decide`'s decision.
 */
const approver = (
  executionId: string,
  decide: (prompt: string) => { readonly approved: boolean; readonly reviewer: string; readonly note: string }
) => {
  const shown: Array<string> = []
  const answering = Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting(executionId).pipe(
      Effect.repeat({
        until: (waiting) =>
          Option.isSome(waiting) && waiting.value.reason === "approval" && waiting.value.token !== null,
        schedule: Schedule.spaced(10)
      })
    )
    const { request, token } = Option.getOrThrow(row)
    const { name, prompt } = request as { readonly name: string; readonly prompt: string }
    shown.push(`${name}: ${prompt}`)
    yield* HumanTask.answer({ token: DurableDeferred.Token.make(token ?? ""), value: decide(prompt) })
  })
  return { shown, layer: Layer.effectDiscard(Effect.forkScoped(Effect.orDie(answering))) }
}

it.live("records a route that needs no approval without asking anyone", () =>
  Effect.gen(function*() {
    const { answer, routed, turns } = script(false)
    const person = approver("lead-router-clear", () => ({ approved: true, reviewer: "dana", note: "unused" }))
    const sink = yield* Kit.run(LeadRouterWithApproval, { lead: { company: "Initech" } }, {
      filename: join(directory, "clear.sqlite"),
      executionId: "lead-router-clear",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    })

    // The raw lead defaults to an inbound-form source and nobody is asked.
    expect(turns).toEqual(["intake: inbound-form Initech", "score: Initech", "sink: Initech"])
    expect(person.shown).toEqual([])
    expect(routed[0]).toMatchObject({
      score: 88,
      route: "sales-west",
      approved: true,
      approvalNote: "",
      borderline: false
    })
    expect(sink).toEqual({
      crmRecordId: "crm-Initech",
      assignedTo: "sales-west",
      nextAction: "Book a demo",
      status: "routed",
      summary: "Routed to sales-west"
    })
  }), { timeout: 60_000 })

it.live("asks a person about a borderline route and hands their note to the CRM step", () =>
  Effect.gen(function*() {
    const { answer, routed, turns } = script(true)
    const person = approver("lead-router-approved", (prompt) => ({
      approved: true,
      reviewer: "dana",
      note: prompt.includes("budget unclear") ? "confirm budget on the call" : "ok"
    }))
    const sink = yield* Kit.run(LeadRouterWithApproval, { rawPayload: { company: "Globex" }, source: "webinar" }, {
      filename: join(directory, "approved.sqlite"),
      executionId: "lead-router-approved",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    })

    expect(turns).toEqual(["intake: webinar Globex", "score: Globex", "sink: Globex"])
    // The person saw 0.x's request title and summary, built from the score.
    expect(person.shown).toEqual([
      `${approvalTask}: Approve routing for Globex\n\nScore 55/100 (mid-market) — proposed route: sales-west. Reasoning: budget unclear`
    ])
    expect(routed[0]).toMatchObject({ approved: true, approvalNote: "confirm budget on the call", borderline: true })
    expect(sink.nextAction).toBe("Book a demo: confirm budget on the call")
  }), { timeout: 60_000 })

it.live("fails the run when a person denies a borderline route, before the CRM step", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const person = approver(
      "lead-router-denied",
      () => ({ approved: false, reviewer: "dana", note: "existing customer" })
    )
    const failure = yield* Effect.flip(Kit.run(LeadRouterWithApproval, { lead: { company: "Globex" } }, {
      filename: join(directory, "denied.sqlite"),
      executionId: "lead-router-denied",
      script: answer,
      actions: Layer.mergeAll(layer, person.layer)
    }))

    expect(person.shown).toHaveLength(1)
    expect(turns).toEqual(["intake: inbound-form Globex", "score: Globex"])
    expect(failure).toMatchObject({
      _tag: "examples/LeadRouterWithApproval/RouteDenied",
      company: "Globex",
      reviewer: "dana",
      note: "existing customer"
    })
  }), { timeout: 60_000 })
