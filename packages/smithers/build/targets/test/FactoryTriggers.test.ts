/**
 * `Smithers.Factory`'s `triggers`: repository flows bound to events with
 * `@smthrs/triggers`' `Trigger.bind`, projected into `.smithers/factory.json`
 * as a plugin manifest's `contributes.triggers` (ruling FLOW-10), the rows a
 * host that receives a push or a pull request matches.
 */
import { Action, Flow } from "@smthrs/flow"
import { On, Trigger } from "@smthrs/triggers"
import { describe, expect, it } from "vitest"
import * as Factory from "../src/Factory.ts"
import type * as FlowCatalog from "../src/FlowCatalog.ts"

const step = Action.make("gate/step", { payload: {} })
const Gate = Flow.make("gate", { payload: {}, body: () => step.call({}) })
const Nested = Flow.make("bench/gate", { payload: {}, body: () => step.call({}) })

const row = (id: string, kind: FlowCatalog.Row["kind"]): FlowCatalog.Row => ({
  id,
  description: `Describes ${id}.`,
  summary: null,
  featured: false,
  kind,
  path: `.smithers/flows/${id}/flow.${kind}`,
  capabilities: [],
  model: null,
  modelInvocable: false
})

const triggers = {
  "gate-main": Trigger.bind({ flow: Gate, on: On.push({ branches: ["main"] }) }),
  "gate-pull-request": Trigger.bind({ flow: Gate, on: On.pullRequest() })
}

describe("Smithers.Factory triggers", () => {
  it("projects each binding as a manifest row under apiVersion 1, in declaration order", () => {
    const text = Factory.renderProjection(Factory.Factory({ summary: "S.", triggers }), [row("gate", "ts")])
    const json = JSON.parse(text)
    expect(Object.keys(json)[0]).toBe("apiVersion")
    expect(json.apiVersion).toBe(1)
    expect(json.contributes).toEqual({
      triggers: [
        { on: "github.push", flow: "gate", title: "gate-main", branches: ["main"] },
        { on: "github.pull_request", flow: "gate", title: "gate-pull-request" }
      ]
    })
    const parsed = Factory.parseProjection(text)
    expect(typeof parsed === "string" ? parsed : parsed.contributes).toEqual(json.contributes)
  })

  it("leaves apiVersion and contributes out when nothing is bound", () => {
    for (const factory of [Factory.Factory({ summary: "S." }), Factory.Factory({ summary: "S.", triggers: {} })]) {
      const text = Factory.renderProjection(factory, [])
      expect(text).not.toContain("apiVersion")
      expect(text).not.toContain("contributes")
    }
  })

  it("refuses a binding whose flow is no flow.ts one directory under the flows root", () => {
    const render = (flows: Record<string, Trigger.Binding>, catalog: ReadonlyArray<FlowCatalog.Row>) => () =>
      Factory.renderProjection(Factory.Factory({ summary: "S.", triggers: flows }), catalog)
    expect(render(triggers, [])).toThrow(
      /triggers\["gate-main"\] binds the flow "gate", which is no discovered flow.ts/
    )
    expect(render(triggers, [row("gate", "mdx")])).toThrow(/binds the flow "gate"/)
    expect(render({ nested: Trigger.bind({ flow: Nested, on: On.manual() }) }, [row("bench/gate", "ts")])).toThrow(
      /binds the flow "bench\/gate"/
    )
  })

  it("refuses a triggers value that is not a record of ids to bindings", () => {
    const declare = (value: unknown) => () =>
      Factory.Factory({ summary: "S.", triggers: value as Record<string, Trigger.Binding> })
    expect(declare([])).toThrow(/Factory triggers must be a record/)
    expect(declare(null)).toThrow(/Factory triggers must be a record/)
    expect(declare({ "Gate Main": triggers["gate-main"] })).toThrow(/Factory triggers key "Gate Main"/)
    expect(declare({ gate: { flow: "gate" } })).toThrow(/Factory triggers\["gate"\]/)
    const many = Object.fromEntries(
      Array.from({ length: Factory.maximumTriggers + 1 }, (_, index) => [`t${index}`, triggers["gate-main"]])
    )
    expect(declare(many)).toThrow(/more than 64 bindings/)
  })
})
