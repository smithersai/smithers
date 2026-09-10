import { describe, expect, test } from "bun:test"
import { flowArgs } from "./FlowArgs"
import type { FlowInput, FlowWithInput } from "./FlowArgs"
import { FLOW_NAMES } from "./FlowName"
import type { FlowName } from "./FlowName"
import { payloadFor } from "./SlashPayload"

/*
 * The button door's contract: what a card hands over comes back out of the
 * flow's own grammar unchanged. Every case here is a value the cards used to
 * interpolate into a template literal — a path, a label, a steer message, a
 * template name, a filter query — and the ones holding a space are the ones
 * that used to arrive as something else.
 */

/** The input, the line it must produce, and the payload the grammar must give back. */
const roundTrip = <N extends FlowWithInput>(name: N, input: FlowInput[N], line: string, payload: Record<string, unknown>): void => {
  expect(flowArgs(name, input)).toBe(line)
  expect(payloadFor(name, line)).toEqual({ payload })
}

describe("flowArgs — one serialisation, and the grammar gives the values back", () => {
  test("target.select carries a label that holds a space", () => {
    roundTrip("target.select", { repoId: "repo-1", label: "//pkg:a b" }, "repo-1 //pkg:a b", { repoId: "repo-1", label: "//pkg:a b" })
  })

  test("target.select without a label selects the repository's table", () => {
    roundTrip("target.select", { repoId: "repo-1" }, "repo-1", { repoId: "repo-1" })
  })

  test("target.filter carries a query that holds a space", () => {
    roundTrip("target.filter", { repoId: "repo-1", query: "app tests" }, "repo-1 query=app tests", { repoId: "repo-1", query: "app tests" })
  })

  test("target.filter clears a facet given blank rather than dropping it", () => {
    roundTrip("target.filter", { repoId: "repo-1", query: "" }, "repo-1 query=", { repoId: "repo-1", query: "" })
  })

  test("runs.steer carries a message that holds spaces", () => {
    roundTrip("runs.steer", { runId: "run-1", body: "focus on the failing test" }, "run-1 focus on the failing test", {
      runId: "run-1",
      body: "focus on the failing test"
    })
  })

  test("change.pins carries both pins", () => {
    roundTrip("change.pins", { changeId: "ch-1", from: "parent", to: "current" }, "ch-1 parent current", {
      changeId: "ch-1",
      from: "parent",
      to: "current"
    })
  })

  test("change.diff carries a path that holds a space", () => {
    roundTrip("change.diff", { changeId: "ch-1", from: "parent", to: "current", path: "src/my notes.md" }, "ch-1 parent current src/my notes.md", {
      changeId: "ch-1",
      from: "parent",
      to: "current",
      path: "src/my notes.md"
    })
  })

  test("change.diff without pins is the change's own diff", () => {
    roundTrip("change.diff", { changeId: "ch-1" }, "ch-1", { changeId: "ch-1" })
  })

  test("change.resolve carries a conflicted path that holds a space", () => {
    roundTrip("change.resolve", { changeId: "ch-1", path: "docs/my guide.md" }, "ch-1 docs/my guide.md", {
      changeId: "ch-1",
      path: "docs/my guide.md"
    })
  })

  test("workspace.template carries a name that holds a space, and one that holds --name", () => {
    roundTrip("workspace.template", { snapshotId: "snap-1", workspaceId: "ws-1", name: "rc 2" }, "snap-1 ws-1 --name rc 2", {
      snapshotId: "snap-1",
      workspaceId: "ws-1",
      name: "rc 2"
    })
    roundTrip("workspace.template", { snapshotId: "snap-1", workspaceId: "ws-1", name: "rc --name 2" }, "snap-1 ws-1 --name rc --name 2", {
      snapshotId: "snap-1",
      workspaceId: "ws-1",
      name: "rc --name 2"
    })
  })

  test("form.set carries a value that holds a space, and clears the field when it is blank", () => {
    roundTrip("form.set", { cardId: "card-1", field: "message", value: "two words" }, "card-1 message two words", {
      cardId: "card-1",
      field: "message",
      value: "two words"
    })
    roundTrip("form.set", { cardId: "card-1", field: "message", value: "" }, "card-1 message", {
      cardId: "card-1",
      field: "message",
      value: ""
    })
  })
})

describe("FlowName — the seam's names are the registry's names", () => {
  test("every flow with a typed input is a declared flow", () => {
    const declared = new Set<string>(FLOW_NAMES)
    const named: ReadonlyArray<FlowWithInput> = [
      "change.diff",
      "change.pins",
      "change.resolve",
      "form.set",
      "runs.steer",
      "target.filter",
      "target.select",
      "workspace.template"
    ]
    expect(named.filter((name) => !declared.has(name))).toEqual([])
  })

  test("a misspelled flow name is not a FlowName", () => {
    const good: FlowName = "target.select"
    // @ts-expect-error the plural is not a flow: this is the mistake the union exists to refuse.
    const bad: FlowName = "targets.select"
    expect([good, bad] as ReadonlyArray<string>).toEqual(["target.select", "targets.select"])
  })

  test("a flow's input is not another flow's input", () => {
    // @ts-expect-error change.pins takes both pins; `to` is not optional.
    const pins: FlowInput["change.pins"] = { changeId: "ch-1", from: "parent" }
    expect(pins.changeId).toBe("ch-1")
  })
})

test("source-qualified flow input preserves arbitrary JSON", () => {
  const input = { requestExecutionId: "native  id", message: "sourceCard=literal  spaces" }
  roundTrip("flow.run", { name: "coding/vibe", sourceCard: "source-card", input },
    `sourceCard=source-card coding/vibe ${JSON.stringify(input)}`, { name: "coding/vibe", sourceCard: "source-card", input })
  expect(payloadFor("flow.list", "sourceCard=source-card")).toEqual({ payload: { sourceCard: "source-card" } })
})
