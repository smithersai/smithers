import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Classified, IntakeItem } from "../../../examples/use-cases/classifier-switchboard.vibe"
import { ClassifierSwitchboard, layer } from "../../../examples/use-cases/classifier-switchboard.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "classifier-switchboard-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const item = (id: string, content: string): typeof IntakeItem.Type => ({
  id,
  content,
  source: "email",
  metadata: { from: `${id}@example.com` }
})

/**
 * An intake that answers with `normalized`, a classifier that assigns each
 * item the domain `domainOf` names, handlers that escalate security items and
 * resolve the rest (and answer off-schema for an item id in `broken`), and a
 * summary that counts the results it is handed. Each handler request is
 * recorded as `role <- item: content`.
 */
const script = (
  normalized: ReadonlyArray<typeof IntakeItem.Type>,
  domainOf: (id: string) => (typeof Classified.Type)["domain"],
  broken: ReadonlyArray<string> = []
) => {
  const handled: Array<string> = []
  const intakes: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are an intake processor")) {
      intakes.push(asked)
      return { items: normalized }
    }
    const classify = /Classify each item into one of these domains: (.+)\.\n\nItems: (.+)/.exec(asked)
    if (classify !== null) {
      const items: Array<{ id: string }> = JSON.parse(classify[2]!)
      return {
        classifications: items.map(({ id }) => ({
          itemId: id,
          domain: domainOf(id),
          confidence: 0.9,
          reasoning: `looks like ${domainOf(id)}`,
          priority: domainOf(id) === "security" ? "critical" : "normal"
        }))
      }
    }
    const role = /You are the (.+) handler\./.exec(asked)?.[1]
    const id = /\nItem: (.+)/.exec(asked)?.[1]
    const content = /\nContent: (.*)/.exec(asked)?.[1]
    if (role !== undefined && id !== undefined) {
      handled.push(`${role} <- ${id}: ${content}`)
      if (broken.includes(id)) return { unexpected: true }
      const escalated = role === "security incident"
      return {
        itemId: id,
        domain: domainOf(id),
        action: escalated ? "paged security" : "replied",
        status: escalated ? "escalated" : "resolved",
        response: `${role} took ${id}`
      }
    }
    const summary = /Summarize the switchboard run over (\d+) items\.\n\nClassifications: .+\nResults: (.+)/.exec(asked)
    if (summary !== null) {
      const results: Array<{ itemId: string; domain: string; status: string }> = JSON.parse(summary[2]!)
      const count = (key: (r: (typeof results)[number]) => string) => {
        const counts: Record<string, number> = {}
        for (const r of results) counts[key(r)] = (counts[key(r)] ?? 0) + 1
        return counts
      }
      return {
        totalProcessed: Number(summary[1]),
        byDomain: count((r) => r.domain),
        byStatus: count((r) => r.status),
        escalations: results.filter((r) => r.status === "escalated").map((r) => ({
          itemId: r.itemId,
          domain: r.domain,
          reason: "needs a human"
        })),
        summary: `${results.length} handled of ${summary[1]}`
      }
    }
    return undefined
  }
  return { answer, handled, intakes }
}

const domainByPrefix = (id: string) =>
  id.startsWith("SEC") ? "security" : id.startsWith("BILL") ? "billing" : id.startsWith("SALE") ? "sales" : "support"

it.effect("dispatches each item to its domain's handler and summarizes the results", () =>
  Effect.gen(function*() {
    const { answer, handled, intakes } = script(
      [item("SEC-1", "my password leaked"), item("BILL-2", "double charge"), item("HELP-3", "cannot log in")],
      domainByPrefix
    )
    const summary = yield* Kit.run(ClassifierSwitchboard, { items: [{ raw: "three messages" }] }, {
      filename: join(directory, "dispatch.sqlite"),
      executionId: "switchboard-dispatch",
      script: answer,
      actions: layer
    })

    // Given items reach intake instead of a fetch command, under the default source.
    expect(intakes[0]).toContain("Source: mixed\nItems: [{\"raw\":\"three messages\"}]")
    // One handler per item, picked by its domain and handed the item's content.
    expect([...handled].sort()).toEqual([
      "billing <- BILL-2: double charge",
      "customer support <- HELP-3: cannot log in",
      "security incident <- SEC-1: my password leaked"
    ])
    expect(summary).toEqual({
      totalProcessed: 3,
      byDomain: { security: 1, billing: 1, support: 1 },
      byStatus: { escalated: 1, resolved: 2 },
      escalations: [{ itemId: "SEC-1", domain: "security", reason: "needs a human" }],
      summary: "3 handled of 3"
    })
  }))

it.effect("drops a failed handler's result and still summarizes", () =>
  Effect.gen(function*() {
    const { answer, handled, intakes } = script(
      [item("SALE-1", "pricing for 50 seats"), item("HELP-2", "reset my 2FA")],
      domainByPrefix,
      ["SALE-1"]
    )
    const summary = yield* Kit.run(ClassifierSwitchboard, { source: "inbox", fetchCmd: "mail list --unread" }, {
      filename: join(directory, "continue-on-fail.sqlite"),
      executionId: "switchboard-continue-on-fail",
      script: answer,
      actions: layer
    })

    expect(intakes[0]).toContain("Source: inbox\nCommand to fetch items: mail list --unread")
    // The broken handler was asked (and re-asked for a correction) and then
    // failed, but the summary counted every item and only the surviving result.
    expect(handled).toContain("sales inquiry <- SALE-1: pricing for 50 seats")
    expect(handled).toContain("customer support <- HELP-2: reset my 2FA")
    expect(summary.totalProcessed).toBe(2)
    expect(summary.byDomain).toEqual({ support: 1 })
    expect(summary.summary).toBe("1 handled of 2")
  }))

it.effect("summarizes an empty intake without asking a handler", () =>
  Effect.gen(function*() {
    const { answer, handled } = script([], domainByPrefix)
    const summary = yield* Kit.run(ClassifierSwitchboard, {}, {
      filename: join(directory, "empty.sqlite"),
      executionId: "switchboard-empty",
      script: answer,
      actions: layer
    })

    expect(handled).toEqual([])
    expect(summary.totalProcessed).toBe(0)
    expect(summary.summary).toBe("0 handled of 0")
  }))
