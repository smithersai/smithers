import { afterAll, expect, it } from "@effect/vitest"
import { Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import type { Item } from "../../../examples/use-cases/triage.ts"
import { Classify, HandleItems, handlers, layer, Triage } from "../../../examples/use-cases/triage.ts"

const directory = mkdtempSync(join(tmpdir(), "triage-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const item = (id: string, assignTo: (typeof Item.Type)["assignTo"]): typeof Item.Type => ({
  id,
  title: `title of ${id}`,
  category: assignTo,
  priority: assignTo === "security" ? "urgent" : "medium",
  assignTo,
  reasoning: `routed to ${assignTo}`
})

/**
 * A classifier that answers with `classified`, and handlers that escalate
 * security items, handle everything else, and answer off-schema for any item
 * id in `broken`. Each handler request is recorded as `role <- id`.
 */
const script = (classified: ReadonlyArray<typeof Item.Type>, broken: ReadonlyArray<string> = []) => {
  const handled: Array<string> = []
  const triaged: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a triage specialist")) {
      triaged.push(asked)
      return { items: classified }
    }
    const role = /You are an? (.+) handler\./.exec(asked)?.[1]
    const id = /\nID: (.+)/.exec(asked)?.[1]
    if (role === undefined || id === undefined) return undefined
    handled.push(`${role} <- ${id}`)
    if (broken.includes(id)) return { unexpected: true }
    const escalated = role === "security incident"
    return {
      itemId: id,
      action: escalated ? "paged the on-call" : "opened a fix",
      status: escalated ? "escalated" : "handled",
      summary: `${role} took ${id}`
    }
  }
  return { answer, handled, triaged }
}

it.effect("routes each actionable item to its handler and skips ignored ones", () =>
  Effect.gen(function*() {
    const { answer, handled, triaged } = script([
      item("SEC-1", "security"),
      item("DOC-2", "docs"),
      item("NOISE-3", "ignore"),
      item("BUG-4", "bug-fix")
    ])
    const report = yield* Kit.run(Triage, {}, {
      filename: join(directory, "routes.sqlite"),
      executionId: "triage-routes",
      script: answer,
      actions: layer
    })

    // With no items given, the classifier is told the default source and command.
    expect(triaged).toHaveLength(1)
    expect(triaged[0]).toContain("Source: GitHub issues\nCommand to fetch items: gh issue list --json")
    // One handler per actionable item, chosen by its route; nothing for the ignored one.
    expect([...handled].sort()).toEqual(["bug fix <- BUG-4", "documentation <- DOC-2", "security incident <- SEC-1"])
    expect(report).toEqual({
      totalItems: 4,
      handled: 2,
      escalated: 1,
      deferred: 0,
      byCategory: { security: 1, docs: 1, ignore: 1, "bug-fix": 1 },
      summary: "Triaged 4 items: 2 handled, 1 escalated"
    })
  }))

it.effect("drops a failed handler's result and keeps the others", () =>
  Effect.gen(function*() {
    const { answer, handled } = script([item("BUG-1", "bug-fix"), item("FEAT-2", "feature")], ["BUG-1"])
    const report = yield* Kit.run(Triage, {}, {
      filename: join(directory, "continue-on-fail.sqlite"),
      executionId: "triage-continue-on-fail",
      script: answer,
      actions: layer
    })

    // The broken handler was asked (and re-asked for a correction) and then
    // failed, but the run settled and counted the handler that succeeded.
    expect(handled).toContain("bug fix <- BUG-1")
    expect(handled).toContain("feature request <- FEAT-2")
    expect(report.totalItems).toBe(2)
    expect(report.handled).toBe(1)
    expect(report.summary).toBe("Triaged 2 items: 1 handled, 0 escalated")
  }))

it.effect("asks no handler when every item is ignored", () =>
  Effect.gen(function*() {
    const { answer, handled, triaged } = script([item("NOISE-1", "ignore"), item("NOISE-2", "ignore")])
    const report = yield* Kit.run(Triage, { items: [{ title: "spam" }, { title: "dupe" }] }, {
      filename: join(directory, "all-ignored.sqlite"),
      executionId: "triage-all-ignored",
      script: answer,
      actions: layer
    })

    // Given items are handed to the classifier instead of the fetch command.
    expect(triaged[0]).toContain("\"title\": \"spam\"")
    expect(triaged[0]).not.toContain("Command to fetch items")
    expect(handled).toEqual([])
    expect(report).toEqual({
      totalItems: 2,
      handled: 0,
      escalated: 0,
      deferred: 0,
      byCategory: { ignore: 2 },
      summary: "Triaged 2 items: 0 handled, 0 escalated"
    })
  }))

it.effect("fails the run when a handler's seat has no model, instead of dropping its item", () =>
  Effect.gen(function*() {
    const { answer, handled } = script([item("BUG-1", "bug-fix"), item("FEAT-2", "feature")])
    const seats: Array<string> = []
    const error = yield* Effect.flip(Kit.run(Triage, {}, {
      filename: join(directory, "unresolved.sqlite"),
      executionId: "triage-unresolved",
      script: answer,
      actions: Layer.mergeAll(
        Classify.layer,
        handlers.security.layer,
        handlers["bug-fix"].layer.pipe(Layer.provide(Kit.refusingSeats(seats))),
        handlers.feature.layer,
        handlers.docs.layer,
        handlers.infra.layer,
        Interpreter.layer(HandleItems)
      )
    }))

    expect(seats).toContain("anthropic:claude-sonnet-5-5")
    expect(handled).not.toContain("bug fix <- BUG-1")
    expect(error._tag).toBe("@smthrs/agent/Seat/SeatUnresolved")
  }))
