import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Ids from "../src/Ids.ts"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

const ctx = { directory: "/repo", now: () => 1000 }
const assistantMessageID = "msg_0000000010020000000000000b"
const open = () =>
  Projection.open(ctx, {
    session: {
      id: "ses_patch",
      slug: "patch",
      projectID: "p",
      directory: "/repo",
      path: "",
      title: "Patch",
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
    prompt: "Apply a patch",
    agent: "smithers",
    model: { providerID: "scripted", modelID: "demo" }
  })

const identity = new Cell.CallIdentity({
  session: "ses_patch",
  frame: 0,
  cell: "cell",
  ordinal: 0,
  declaration: "d",
  layers: []
})

const started = (patch: string) =>
  new AgentEvents.CellCallStarted({
    eventType: "flows.harness.cell-call-started.v1",
    call: new Cell.Call({
      flowName: "apply_patch",
      input: { input: patch },
      capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity
    })
  })

const settled = (result: Cell.CallResult) =>
  new AgentEvents.CellCallSettled({
    eventType: "flows.harness.cell-call-settled.v1",
    flowName: "apply_patch",
    identity,
    result
  })

describe("visible submitted patches", () => {
  it.each(["", "plain", String.fromCharCode(96).repeat(5)])(
    "shows the exact submitted patch and settled result in safe text, including %j",
    (content) => {
      const patch = `*** Begin Patch\n*** Add File: example.md\n+${content}\n*** End Patch`
      const result = new Cell.CallResult({
        outcome: "success",
        value: {
          output: "Success. Updated the following files:\nA example.md",
          added: ["example.md"],
          modified: [],
          deleted: []
        }
      })
      const saved = new Map<string, Protocol.Part>()
      let state = open().state
      let initialID: string | undefined
      for (let replay = 0; replay < 2; replay++) {
        state = Projection.fold(ctx, state, started(patch)).state
        const projected = Projection.fold(ctx, state, settled(result))
        state = projected.state
        for (const event of projected.events) {
          if (event.type !== "message.part.updated") continue
          const part = event.properties["part"] as Protocol.Part
          saved.set(part.id, part)
        }
        const texts = [...saved.values()].filter((part): part is Protocol.TextPart => part.type === "text")
        expect(texts).toHaveLength(1)
        const text = texts[0]!
        expect(text.synthetic).toBe(true)
        expect(text.text).toContain("Submitted patch")
        expect(text.text).toContain(patch)
        expect(text.text).toContain(Projection.toolOutput("apply_patch", result.value))
        const fences = text.text.split("\n").filter((line) => /^`{3,}(?:text)?$/.test(line))
        expect(fences).toHaveLength(4)
        expect(fences[0]!.replace(/text$/, "").length).toBeGreaterThan(content.match(/`+/)?.[0].length ?? 0)
        expect(fences[1]).toBe(fences[0]!.replace(/text$/, ""))
        expect(fences[3]).toBe(fences[2]!.replace(/text$/, ""))
        const tool = [...saved.values()].find((part): part is Protocol.ToolPart => part.type === "tool")!
        expect(tool.tool).toBe("apply_patch")
        expect(text.id > tool.id).toBe(true)
        expect(text.id < Ids.part(assistantMessageID, { frame: 0, slot: Projection.slots.call, ordinal: 1 })).toBe(true)
        expect(initialID ?? text.id).toBe(text.id)
        initialID = text.id
      }
      expect(saved.size).toBe(2)
      expect(state.summary.calls).toBe(1)
    }
  )

  it("shows a failed patch as a submitted attempt beside its actual error", () => {
    const patch = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"
    const running = Projection.fold(ctx, open().state, started(patch))
    const projected = Projection.fold(
      ctx,
      running.state,
      settled(
        new Cell.CallResult({
          outcome: "failure",
          code: "flow_failed",
          message: "not_found: File missing.txt does not exist",
          value: null
        })
      )
    )
    const text = projected.events.map((event) => event.properties["part"] as Protocol.Part)
      .find((part): part is Protocol.TextPart => part.type === "text")
    expect(text?.text).toContain(patch)
    expect(text?.text).toContain("File missing.txt does not exist")
    expect(text?.text).toContain("not_found")
    expect(text?.text).not.toContain("Success")
  })

  it("keeps a malformed patch invocation readable without inventing patch text", () => {
    const call = started("").call
    const running = Projection.fold(
      ctx,
      open().state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({ ...call, input: {} })
      })
    )
    const projected = Projection.fold(
      ctx,
      running.state,
      settled(
        new Cell.CallResult({
          outcome: "failure",
          message: "input is required",
          value: null
        })
      )
    )
    const text = projected.events.map((event) => event.properties["part"] as Protocol.Part)
      .find((part): part is Protocol.TextPart => part.type === "text")
    expect(text?.text).toContain("Submitted patch")
    expect(text?.text).toContain("input is required")
    expect(text?.text).not.toContain("*** Begin Patch")
  })
})
