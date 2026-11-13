import { afterAll, expect, it } from "@effect/vitest"
import { Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import type { Classified } from "../../../examples/use-cases/service-desk-dispatcher.ts"
import {
  Classify,
  handlers,
  HandleTickets,
  Intake,
  layer,
  ServiceDeskDispatcher
} from "../../../examples/use-cases/service-desk-dispatcher.ts"

const directory = mkdtempSync(join(tmpdir(), "service-desk-dispatcher-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

type Category = (typeof Classified.Type)["category"]

const line = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

/**
 * Intake normalizes `received` into tickets, and the classifier labels each
 * ticket it is handed with the category its id starts with (`INC-`, `REQ-`,
 * `POL-`), so a test checks the handoff from intake to classification. The
 * incident handler escalates, the others resolve, and any ticket id in
 * `broken` gets an off-schema answer. Handler requests are recorded as
 * `specialist <- id`.
 */
const script = (received: ReadonlyArray<string>, broken: ReadonlyArray<string> = []) => {
  const intakes: Array<string> = []
  const handled: Array<string> = []
  const prefixes: Record<string, Category> = { INC: "incident", REQ: "request", POL: "policy" }
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a service-desk intake agent")) {
      intakes.push(`${line(asked, "Source")} | ${line(asked, "Tickets")} | ${line(asked, "Fetch command")}`)
      const tickets = received.map((id, index) => ({
        id,
        title: `title of ${id}`,
        description: `description of ${id}, source ${index}`,
        submitter: `submitter-${index}`
      }))
      return { tickets, totalReceived: tickets.length }
    }
    if (asked.includes("You are a service-desk classifier")) {
      const tickets = JSON.parse(line(asked, "Tickets")) as ReadonlyArray<
        { readonly id: string; readonly title: string; readonly description: string; readonly submitter: string }
      >
      return {
        classified: tickets.map(({ description, id, submitter, title }) => ({
          id,
          title,
          description,
          submitter,
          category: prefixes[id.slice(0, 3)],
          urgency: "high",
          reasoning: `prefix ${id.slice(0, 3)}`
        }))
      }
    }
    const specialist = /You are an? (incident handler|service-request fulfillment agent|policy advisor)\./.exec(asked)
      ?.[1]
    const id = line(asked, "ID")
    if (specialist === undefined || id === "") return undefined
    handled.push(`${specialist} <- ${id}`)
    if (broken.includes(id)) return { unexpected: true }
    const escalated = specialist === "incident handler"
    return {
      ticketId: id,
      action: escalated ? "paged on-call" : "done",
      status: escalated ? "escalated" : "resolved",
      resolution: `${specialist} took ${id}`
    }
  }
  return { answer, handled, intakes }
}

it.effect("routes each classified ticket to its category's specialist and counts the outcomes", () =>
  Effect.gen(function*() {
    const { answer, handled, intakes } = script(["INC-1", "REQ-2", "POL-3", "REQ-4"])
    const report = yield* Kit.run(ServiceDeskDispatcher, {}, {
      filename: join(directory, "routes.sqlite"),
      executionId: "service-desk-routes",
      script: answer,
      actions: layer
    })

    // With no payload, intake is told the default source and no tickets or command.
    expect(intakes).toEqual(["service desk queue | null | none"])
    expect([...handled].sort()).toEqual([
      "incident handler <- INC-1",
      "policy advisor <- POL-3",
      "service-request fulfillment agent <- REQ-2",
      "service-request fulfillment agent <- REQ-4"
    ])
    expect(report).toEqual({
      totalTickets: 4,
      incidents: 1,
      requests: 2,
      policyQuestions: 1,
      resolved: 3,
      escalated: 1,
      pending: 0,
      summary: "Dispatched 4 tickets: 1 incidents, 2 requests, 1 policy questions — 3 resolved, 1 escalated"
    })
  }))

it.effect("drops a failed handler's result and keeps the others", () =>
  Effect.gen(function*() {
    const { answer, handled, intakes } = script(["INC-1", "POL-2"], ["INC-1"])
    const report = yield* Kit.run(ServiceDeskDispatcher, { source: "it-queue", fetchCmd: "itsm list --open" }, {
      filename: join(directory, "continue-on-fail.sqlite"),
      executionId: "service-desk-continue-on-fail",
      script: answer,
      actions: layer
    })

    expect(intakes).toEqual(["it-queue | null | itsm list --open"])
    // The broken handler was asked and failed, but the run settled: the
    // ticket still counts as an incident, its outcome does not.
    expect(handled).toContain("incident handler <- INC-1")
    expect(handled).toContain("policy advisor <- POL-2")
    expect(report.incidents).toBe(1)
    expect(report.escalated).toBe(0)
    expect(report.resolved).toBe(1)
  }))

it.effect("hands given tickets to intake and asks no specialist when none are classified", () =>
  Effect.gen(function*() {
    const { answer, handled, intakes } = script([])
    const report = yield* Kit.run(ServiceDeskDispatcher, { tickets: [{ subject: "printer" }] }, {
      filename: join(directory, "empty.sqlite"),
      executionId: "service-desk-empty",
      script: answer,
      actions: layer
    })

    expect(intakes).toEqual(["service desk queue | [{\"subject\":\"printer\"}] | none"])
    expect(handled).toEqual([])
    expect(report.totalTickets).toBe(0)
    expect(report.summary).toBe(
      "Dispatched 0 tickets: 0 incidents, 0 requests, 0 policy questions — 0 resolved, 0 escalated"
    )
  }))

it.effect("fails the run when a specialist's seat has no model, instead of dropping its ticket", () =>
  Effect.gen(function*() {
    const { answer, handled } = script(["INC-1", "POL-2"])
    const seats: Array<string> = []
    const error = yield* Effect.flip(Kit.run(ServiceDeskDispatcher, {}, {
      filename: join(directory, "unresolved.sqlite"),
      executionId: "service-desk-unresolved",
      script: answer,
      actions: Layer.mergeAll(
        Intake.layer,
        Classify.layer,
        handlers.incident.layer.pipe(Layer.provide(Kit.refusingSeats(seats))),
        handlers.request.layer,
        handlers.policy.layer,
        Interpreter.layer(HandleTickets)
      )
    }))

    expect(seats).toContain("anthropic:claude-sonnet-5-5")
    expect(handled).not.toContain("incident handler <- INC-1")
    expect(error._tag).toBe("@smthrs/agent/Seat/SeatUnresolved")
  }))

it.effect("dispatches repeated ids separately and passes the description and submitter", () =>
  Effect.gen(function*() {
    const { answer, handled } = script(["POL-1", "POL-1"])
    const prompts: Array<string> = []
    const report = yield* Kit.run(ServiceDeskDispatcher, {}, {
      filename: join(directory, "duplicate-ids.sqlite"),
      executionId: "service-desk-duplicate-ids",
      script: (asked) => {
        prompts.push(asked)
        return answer(asked)
      },
      actions: layer
    })
    expect(handled).toEqual(["policy advisor <- POL-1", "policy advisor <- POL-1"])
    expect(report).toMatchObject({ totalTickets: 2, resolved: 2 })
    const requests = prompts.filter((asked) => asked.includes("You are a policy advisor."))
    expect(requests).toHaveLength(2)
    expect(requests.map((asked) => [line(asked, "Description"), line(asked, "Submitter")]).sort()).toEqual([
      ["description of POL-1, source 0", "submitter-0"],
      ["description of POL-1, source 1", "submitter-1"]
    ])
  }))
