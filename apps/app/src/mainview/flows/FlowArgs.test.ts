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
  test("runs.trace.select preserves the source, node and optional recorded sequence", () => {
    for (const seq of [undefined, 0, 17]) {
      const input = { sourceCard: "flow-run-source", runId: "run-1", nodeId: "frame-2", ...(seq === undefined ? {} : { seq }) }
      roundTrip("runs.trace.select", input, `sourceCard=flow-run-source run-1 frame-2${seq === undefined ? "" : ` ${seq}`}`, input)
    }
    roundTrip("runs.trace.select", { runId: "run-1", nodeId: "frame-2", seq: 17 }, "run-1 frame-2 17", { runId: "run-1", nodeId: "frame-2", seq: 17 })
  })

  test("runs.steer carries a message that holds spaces", () => {
    roundTrip("runs.steer", { runId: "run-1", body: "focus on the failing test" }, "run-1 focus on the failing test", {
      runId: "run-1",
      body: "focus on the failing test"
    })
  })

  test("model.assign carries the seat and the name, and `default` is a name", () => {
    roundTrip("model.assign", { seat: "explainer", recordId: "default" }, "explainer default", { seat: "explainer", recordId: "default" })
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
      "model.assign",
      "runs.steer",
    ]
    expect(named.filter((name) => !declared.has(name))).toEqual([])
  })

  test("a misspelled flow name is not a FlowName", () => {
    const good: FlowName = "repo.select"
    // @ts-expect-error the plural is not a flow: this is the mistake the union exists to refuse.
    const bad: FlowName = "repos.select"
    expect([good, bad] as ReadonlyArray<string>).toEqual(["repo.select", "repos.select"])
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


test("opening a diff file preserves a frame id and a path containing spaces", () => {
  const input = { cardId: "diff-frame", path: "src/my file.ts" }
  expect(payloadFor("files.open-diff", flowArgs("files.open-diff", input))).toEqual({ payload: input })
})


test("repository detail buttons preserve typed issue and PR targets", () => {
  for (const flow of ["issues.view", "prs.view"] as const) {
    expect(payloadFor(flow, flowArgs(flow, { number: 3, repo: "practice:smithersai/hello-server" }))).toEqual({ payload: { number: 3, repo: "practice:smithersai/hello-server" } })
  }
})

test("issue detail preserves the tracker even when native and GitHub numbers collide", () => {
  for (const source of ["github", "smithers-cloud"] as const) {
    roundTrip("issues.view", { number: 1, repo: "will/flows", source }, `1 will/flows --source ${source}`, { number: 1, repo: "will/flows", source })
  }
  roundTrip("issues.view", { number: 1, source: "github" }, "1 --source github", { number: 1, source: "github" })
  roundTrip("issues.view", { number: 1, repo: "will/flows" }, "1 will/flows", { number: 1, repo: "will/flows" })
  expect(payloadFor("issues.view", "will/flows --source github")).toHaveProperty("error")
})

 test("Wiki heading buttons retain their card scope", () => {
  roundTrip("wiki.heading", { line: "5", cardId: "wiki-open-plans" }, "5 wiki-open-plans", { line: "5", cardId: "wiki-open-plans" })
  roundTrip("wiki.heading", { line: "5" }, "5", { line: "5" })
})

test("import issue action keeps the repository after the default filter", () => {
 const args = flowArgs("issues.list", {repo: "acme/web"})
 expect(args).toBe("open acme/web")
 expect(payloadFor("issues.list", args)).toMatchObject({payload: {filter:"open",repo:"acme/web"}})
})

test("manual setup work preserves source identity and multiline instructions across all command doors", () => {
  const work = { cardId: "setup:repo:issues", operation: "run", manual: { stepId: "fix", prompt: "Preserve old APIs.\nAdd a regression test.", subject: { source: "smithers-cloud", kind: "issue", number: 42 } } } as const
  roundTrip("setup.run", work, JSON.stringify(work), work)
  const edit = { cardId: work.cardId, stepId: "fix", field: "prompt", value: work.manual.prompt } as const
  roundTrip("setup.work", edit, JSON.stringify(edit), edit)
})
