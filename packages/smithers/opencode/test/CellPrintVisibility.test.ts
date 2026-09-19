import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import { expect, it } from "vitest"
import * as Ids from "../src/Ids.ts"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

const ctx = { directory: "/repo", now: () => 1000 }
const assistantMessageID = "msg_0000000010020000000000000b"
const open = () =>
  Projection.open(ctx, {
    session: {
      id: "ses_print",
      slug: "print",
      projectID: "p",
      directory: "/repo",
      path: "",
      title: "Print",
      version: "test",
      agent: "smithers",
      model: { id: "demo", providerID: "scripted" },
      cost: 0,
      tokens: Protocol.noTokens,
      time: { created: 1000, updated: 1000 }
    },
    userMessageID: "msg_user",
    userPartID: "prt_user",
    assistantMessageID,
    prompt: "Print the classification results",
    agent: "smithers",
    model: { providerID: "scripted", modelID: "demo" }
  })

const source = Cell.source("ctx.print('first'); ctx.print('second')")
const produced = new AgentEvents.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source, blocks: 1 })
const printed = (text: string) =>
  new AgentEvents.CellPrinted({
    eventType: "flows.harness.cell-printed.v1",
    cell: source.digest,
    text
  })

it("renders cumulative cell prints as one safe text part after the cell across replay", () => {
  const text = `first\n${String.fromCharCode(96).repeat(5)}\nsecond`
  let state = { ...open().state, frame: 0 }
  const saved = new Map<string, Protocol.Part>()
  let initialID: string | undefined
  for (let replay = 0; replay < 2; replay++) {
    const cell = Projection.fold(ctx, state, produced)
    state = cell.state
    const cellPart = cell.events[0]!.properties["part"] as Protocol.ToolPart
    expect(Projection.fold(ctx, state, printed("")).events).toEqual([])
    for (const buffer of ["first", text]) {
      const visible = Projection.fold(ctx, state, printed(buffer))
      state = visible.state
      expect(visible.events).toHaveLength(1)
      const part = visible.events[0]!.properties["part"] as Protocol.TextPart
      saved.set(part.id, part)
      expect(part.type).toBe("text")
      expect(part.synthetic).toBe(true)
      expect(part.text).toContain("Cell output")
      expect(part.text).toContain(buffer)
      expect(part.id > cellPart.id).toBe(true)
      expect(part.id < Ids.part(assistantMessageID, { frame: 0, slot: Projection.slots.call, ordinal: 0 })).toBe(true)
      expect(initialID ?? part.id).toBe(part.id)
      initialID = part.id
    }
    const settled = Projection.fold(
      ctx,
      state,
      new AgentEvents.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
      })
    )
    expect(settled.events[0]!.properties["part"]).toMatchObject({ type: "tool", state: { output: text } })
    state = settled.state
  }
  expect(saved.size).toBe(1)
  const part = [...saved.values()][0] as Protocol.TextPart
  const fences = part.text.split("\n").filter((line) => /^`{6,}(?:text)?$/.test(line))
  expect(fences).toHaveLength(2)
  expect(fences[1]).toBe(fences[0]!.replace(/text$/, ""))
  expect(state.facts.lastPrints).toBe(text)
})

it("does not invent a visible cell for an orphan print event", () => {
  const projected = Projection.fold(ctx, open().state, printed("orphan"))
  expect(projected.events).toEqual([])
  expect(projected.state.facts.lastPrints).toBe("orphan")
})
