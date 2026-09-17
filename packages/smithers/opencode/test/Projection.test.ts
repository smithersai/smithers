import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

const directory = "/repo"
const sessionID = "ses_ffffffffeffe00000000000000"
const userMessageID = "msg_0000000010010000000000000a"
const assistantMessageID = "msg_0000000010020000000000000b"

const session: Protocol.Session = {
  id: sessionID,
  slug: "quiet-harbor",
  projectID: "p",
  directory,
  path: "",
  title: "New session - 2026",
  version: "test",
  agent: "smithers",
  model: { id: "demo", providerID: "scripted" },
  cost: 0,
  tokens: Protocol.noTokens,
  time: { created: 1000, updated: 1000 }
}

const clock = () => {
  let now = 1000
  return { now: () => (now += 1), reset: () => (now = 1000) }
}

const opened = (): Projection.Opened => ({
  session,
  userMessageID,
  assistantMessageID,
  prompt: "Read package.json and tell me the name field.",
  agent: "smithers",
  model: { providerID: "scripted", modelID: "demo" }
})

/** Every event of the demo script, in the order a once-answered turn emits them. */
const scriptEvents = (): Array<AgentEvent.AgentEvent> => {
  const script = DemoScript.script({ sessionID, messageID: assistantMessageID, prompt: "p" })
  const out: Array<AgentEvent.AgentEvent> = []
  for (const segment of script.segments) {
    if (segment._tag === "events") out.push(...segment.events)
    else {
      out.push(
        new AgentEvents.PermissionRequired({
          eventType: "flows.harness.permission-required.v1",
          request: segment.request
        }),
        new AgentEvents.Suspended({
          eventType: "flows.harness.suspended.v1",
          reason: { code: "permission-required", message: "park" } as never
        }),
        ...segment.allowed
      )
    }
  }
  return out
}

const foldAll = (events: ReadonlyArray<AgentEvent.AgentEvent>, ctx: Projection.Context) => {
  let step = Projection.open(ctx, opened())
  const emitted: Array<Protocol.Emitted> = [...step.events]
  for (const event of events) {
    step = Projection.fold(ctx, step.state, event)
    emitted.push(...step.events)
  }
  return { state: step.state, emitted }
}

describe("Projection", () => {
  it("folds the demo turn to the golden event list", () => {
    const ctx = { directory, now: clock().now }
    const { emitted, state } = foldAll(scriptEvents(), ctx)
    const goldenPath = join(import.meta.dirname, "fixtures", "projection.golden.json")
    const rendered = JSON.stringify(emitted, null, 2)
    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(goldenPath)) writeFileSync(goldenPath, `${rendered}\n`)
    expect(rendered).toBe(readFileSync(goldenPath, "utf8").trimEnd())
    expect(state.closed).toBe(true)
    expect(state.session.tokens.input).toBe(812 + 1240 + 812 + 1240)
  })

  it("names the same parts when a frame is replayed after a park", () => {
    const ctx = { directory, now: clock().now }
    const { emitted } = foldAll(scriptEvents(), ctx)
    const parts = emitted.filter((event) => event.type === "message.part.updated")
    const ids = new Set(parts.map((event) => (event.properties["part"] as Protocol.Part).id))
    const tools = parts
      .map((event) => event.properties["part"] as Protocol.Part)
      .filter((part): part is Protocol.ToolPart => part.type === "tool")
    expect(ids.size).toBe(13 + 1)
    expect([...new Set(tools.map((part) => part.tool))].sort()).toEqual(["bash", "cell", "demand", "list", "read"])
    const ordered = [...ids].sort()
    expect([...ids]).toEqual(expect.arrayContaining(ordered))
    const byMessage = parts.map((event) => (event.properties["part"] as Protocol.Part).id).filter((id) =>
      id > userMessageID
    )
    expect([...new Set(byMessage)].sort()).toEqual([...new Set(byMessage)].sort())
  })

  it("renders the cards the app reads: inputs, titles, outputs, metadata, patterns", () => {
    expect(Projection.toolName("ls")).toBe("list")
    expect(Projection.toolName("bash")).toBe("bash")
    expect(Projection.toolInput(directory, "read", { path: "a.txt", offset: 2, limit: 3 })).toEqual({
      filePath: "/repo/a.txt",
      offset: 2,
      limit: 3
    })
    expect(Projection.toolInput(directory, "read", { path: "/abs/a.txt" })).toEqual({ filePath: "/abs/a.txt" })
    expect(Projection.toolInput(directory, "ls", {})).toEqual({ path: "/repo" })
    expect(Projection.toolInput(directory, "glob", { pattern: "*.ts", root: "src" })).toEqual({
      pattern: "*.ts",
      path: "/repo/src"
    })
    expect(Projection.toolInput(directory, "glob", {})).toEqual({ pattern: "", path: "/repo" })
    expect(Projection.toolInput(directory, "grep", { pattern: "x", globs: ["*.ts", "*.js"] })).toEqual({
      pattern: "x",
      path: "/repo",
      include: "*.ts,*.js"
    })
    expect(Projection.toolInput(directory, "grep", {})).toEqual({ pattern: "", path: "/repo" })
    expect(Projection.toolInput(directory, "edit", { path: "f", oldString: "a", newString: "b" })).toEqual({
      filePath: "/repo/f",
      oldString: "a",
      newString: "b"
    })
    expect(Projection.toolInput(directory, "edit", { path: "f" })).toEqual({
      filePath: "/repo/f",
      oldString: "",
      newString: ""
    })
    expect(Projection.toolInput(directory, "write", { path: "f", content: "c" })).toEqual({
      filePath: "/repo/f",
      content: "c"
    })
    expect(Projection.toolInput(directory, "write", {})).toEqual({ filePath: "/repo", content: "" })
    expect(Projection.toolInput(directory, "bash", { command: "ls", description: "d" })).toEqual({
      command: "ls",
      description: "d"
    })
    expect(Projection.toolInput(directory, "bash", {})).toEqual({ command: "" })
    expect(Projection.toolInput(directory, "classify", { states: [] })).toEqual({ states: [] })
    expect(Projection.toolInput(directory, "classify", "raw")).toEqual({ input: "raw" })

    expect(Projection.toolTitle("read", { filePath: "/repo/a.txt" })).toBe("a.txt")
    expect(Projection.toolTitle("edit", {})).toBe("")
    expect(Projection.toolTitle("ls", { path: "/repo" })).toBe("/repo")
    expect(Projection.toolTitle("ls", {})).toBe("")
    expect(Projection.toolTitle("glob", { pattern: "*" })).toBe("*")
    expect(Projection.toolTitle("grep", {})).toBe("")
    expect(Projection.toolTitle("bash", { command: "ls" })).toBe("ls")
    expect(Projection.toolTitle("bash", {})).toBe("")
    expect(Projection.toolTitle("classify", {})).toBe("classify")

    expect(Projection.toolOutput("read", { content: "c" })).toBe("c")
    expect(Projection.toolOutput("read", { other: 1 })).toBe(`{"other":1}`)
    expect(Projection.toolOutput("bash", { stdout: "o", stderr: "" })).toBe("o")
    expect(Projection.toolOutput("bash", { stdout: "o", stderr: "e" })).toBe("o\ne")
    expect(Projection.toolOutput("bash", { stderr: "e" })).toBe("e")
    expect(Projection.toolOutput("bash", "x")).toBe("")
    expect(Projection.toolOutput("ls", { entries: [{ name: "a" }, "b", { kind: "file" }] })).toBe("a\n\n")
    expect(Projection.toolOutput("ls", { entries: "x" })).toBe(`{"entries":"x"}`)
    expect(Projection.toolOutput("glob", { paths: ["a", "b"] })).toBe("a\nb")
    expect(Projection.toolOutput("glob", {})).toBe("{}")
    expect(Projection.toolOutput("edit", { hunk: "h" })).toBe("h")
    expect(Projection.toolOutput("edit", {})).toBe("{}")
    expect(Projection.toolOutput("write", { bytesWritten: 3, path: "f" })).toBe("Wrote 3 bytes to f")
    expect(Projection.toolOutput("write", {})).toBe("Wrote 0 bytes to ")
    expect(Projection.toolOutput("grep", { matches: [] })).toBe(`{"matches":[]}`)
    expect(Projection.toolOutput("grep", "text")).toBe("text")

    expect(Projection.toolMetadata("bash", { stdout: "o", stderr: "", exitCode: 2, stdoutTruncated: true })).toEqual({
      output: "o",
      exit: 2,
      truncated: true,
      result: { stdout: "o", stderr: "", exitCode: 2, stdoutTruncated: true }
    })
    expect(Projection.toolMetadata("bash", null)).toEqual({ output: "", exit: 0, truncated: false, result: null })
    expect(Projection.toolMetadata("read", { content: "c" })).toEqual({ result: { content: "c" } })

    expect(Projection.permissionPatterns("bash", { command: "ls -la" })).toEqual({
      patterns: ["ls -la"],
      always: ["ls *"]
    })
    expect(Projection.permissionPatterns("bash", { command: "  " })).toEqual({ patterns: ["  "], always: ["*"] })
    expect(Projection.permissionPatterns("bash", {})).toEqual({ patterns: [""], always: ["*"] })
    expect(Projection.permissionPatterns("edit", { filePath: "/repo/f" })).toEqual({ patterns: ["f"], always: ["*"] })
    expect(Projection.permissionPatterns("classify", {})).toEqual({ patterns: ["classify"], always: ["*"] })
    expect(Projection.permissionPatterns("edit", {})).toEqual({ patterns: ["*"], always: ["*"] })

    expect(Projection.prose(ModelRequest.Message.assistant("Hi\n```js\ncode\n```\nthere"))).toBe("Hi\n\nthere")
    const thought = ModelRequest.Message.assistant([{ type: "thinking", text: "hm" }, { type: "text", text: "said" }])
    expect(Projection.prose(thought)).toBe("said")
    expect(Projection.answerText(thought)).toBe("said")
    expect(Projection.chunks("")).toEqual([])
    expect(Projection.chunks("one two three four five six seven", 10)).toEqual([
      "one two ",
      "three ",
      "four five ",
      "six seven"
    ])
    expect(Projection.chunks("averyveryverylongword", 5)).toEqual(["averyveryverylongword"])
  })

  it("keeps a title the app already set, and titles a fresh session from the prompt", () => {
    const ctx = { directory, now: clock().now }
    const kept = Projection.open(ctx, { ...opened(), session: { ...session, title: "Mine" } })
    expect(kept.state.session.title).toBe("Mine")
    const blank = Projection.open(ctx, { ...opened(), prompt: "   " })
    expect(blank.state.session.title).toBe("New session - 2026")
    const titled = Projection.open(ctx, opened())
    expect(titled.state.session.title).toBe("Read package.json and tell me the name field.")
    expect(titled.events.map((event) => event.type)).toEqual([
      "message.updated",
      "message.part.updated",
      "session.updated",
      "session.status",
      "message.updated"
    ])
  })

  it("closes an interrupted or failed turn once, and ignores events after the end", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    const interrupted = Projection.close(ctx, start.state, { _tag: "interrupted" })
    expect(interrupted.events.map((event) => event.type)).toEqual([
      "message.updated",
      "session.updated",
      "session.status",
      "session.idle"
    ])
    const header = interrupted.events[0]!.properties["info"] as Protocol.AssistantMessage
    expect(header.error).toEqual({ name: "MessageAbortedError", data: { message: "The turn was interrupted" } })
    expect(Projection.close(ctx, interrupted.state, { _tag: "failed", message: "x" }).events).toEqual([])
    expect(Projection.fold(ctx, interrupted.state, scriptEvents()[0]!).events).toEqual([])
    const withReasoning = Projection.fold(
      ctx,
      Projection.fold(ctx, start.state, scriptEvents()[0]!).state,
      scriptEvents()[1]!
    )
    const failed = Projection.close(ctx, withReasoning.state, { _tag: "failed", message: "boom" })
    expect(failed.events[0]!.type).toBe("message.part.updated")
    expect((failed.events[1]!.properties["info"] as Protocol.AssistantMessage).error).toEqual({
      name: "UnknownError",
      data: { message: "boom" }
    })
    const aborted = Projection.fold(
      ctx,
      start.state,
      new AgentEvents.Aborted({ eventType: "flows.harness.aborted.v1", reason: "quota" })
    )
    expect((aborted.events[0]!.properties["info"] as Protocol.AssistantMessage).error?.data.message).toBe("quota")
  })

  it("handles the events outside the demo turn", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    const frame = Projection.fold(ctx, start.state, scriptEvents()[0]!)
    const thinking = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: { type: "thinking-delta", id: "t", text: "hm" }
      })
    )
    expect(thinking.events.map((event) => event.type)).toEqual(["message.part.updated", "message.part.delta"])
    const ignoredDelta = Projection.fold(
      ctx,
      thinking.state,
      new AgentEvents.ModelDelta({ eventType: "flows.harness.model-delta.v1", delta: { type: "text-start", id: "t" } })
    )
    expect(ignoredDelta.events).toEqual([])
    const retried = Projection.fold(
      ctx,
      thinking.state,
      new AgentEvents.ModelRetried({
        eventType: "flows.harness.model-retried.v1",
        attempt: 2,
        code: "rate_limited",
        delayMillis: 50
      })
    )
    expect(retried.events[0]!.properties["status"]).toMatchObject({ type: "retry", attempt: 2 })
    const settledWithoutProse = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant("```js\nx\n```"),
        usage: {},
        durationMillis: 1
      })
    )
    expect(settledWithoutProse.events).toEqual([])
    const settledWithProse = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant("Plain prose"),
        usage: { inputTokens: 1 },
        durationMillis: 1
      })
    )
    expect((settledWithProse.events[0]!.properties["part"] as Protocol.ReasoningPart).text).toBe("Plain prose")

    const source = Cell.source("throw new Error('x')")
    const produced = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source, blocks: 1 })
    )
    const orphanSettled = Projection.fold(
      ctx,
      produced.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "read",
        identity: new Cell.CallIdentity({
          session: sessionID,
          frame: 0,
          cell: source.digest,
          ordinal: 9,
          declaration: "d",
          layers: []
        }),
        result: new Cell.CallResult({ outcome: "success", value: {} })
      })
    )
    expect(orphanSettled.events).toEqual([])
    const editStarted = Projection.fold(
      ctx,
      produced.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "edit",
          input: { path: "f", newString: "n" },
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: sessionID,
            frame: 0,
            cell: source.digest,
            ordinal: 0,
            declaration: "d",
            layers: []
          })
        })
      })
    )
    expect(editStarted.state.cell?.edits).toBe(1)
    const editFailed = Projection.fold(
      ctx,
      editStarted.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "edit",
        identity: new Cell.CallIdentity({
          session: sessionID,
          frame: 0,
          cell: source.digest,
          ordinal: 0,
          declaration: "d",
          layers: []
        }),
        result: new Cell.CallResult({ outcome: "failure", value: null })
      })
    )
    const errorState = (editFailed.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(errorState.status).toBe("error")
    expect(errorState.status === "error" && errorState.error).toBe("The call failed")
    const raised = Projection.fold(
      ctx,
      editFailed.state,
      new AgentEvents.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Raised({ name: "Error", message: "x" })
      })
    )
    const raisedState = (raised.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(raisedState.status === "error" && raisedState.error).toBe("Error: x")
    expect(raisedState.status === "error" && raisedState.metadata?.["edits"]).toBe(1)
    const rejected = Projection.fold(
      ctx,
      produced.state,
      new AgentEvents.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Rejected({ code: "no_cell", message: "no cell" })
      })
    )
    const rejectedState = (rejected.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(rejectedState.status === "error" && rejectedState.error).toBe("no cell")
    const twoEdits = { ...produced.state, cell: { ...produced.state.cell!, calls: 3, edits: 2 } }
    const settledTwo = Projection.fold(
      ctx,
      twoEdits,
      new AgentEvents.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
      })
    )
    const twoState = (settledTwo.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(twoState.status === "completed" && twoState.title).toBe("frame 1 · 3 calls · 2 edits")
    const beforeCell = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "bash",
          input: { command: "true" },
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: sessionID,
            frame: 0,
            cell: "nocell",
            ordinal: 0,
            declaration: "d",
            layers: []
          })
        })
      })
    )
    expect(beforeCell.state.cell).toBeUndefined()
    const coded = Projection.fold(
      ctx,
      beforeCell.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "bash",
        identity: new Cell.CallIdentity({
          session: sessionID,
          frame: 0,
          cell: "nocell",
          ordinal: 0,
          declaration: "d",
          layers: []
        }),
        result: new Cell.CallResult({ outcome: "failure", value: null, message: "refused", code: "capability_refused" })
      })
    )
    const codedState = (coded.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(codedState.status === "error" && codedState.error.startsWith("refused (capability_refused)\n")).toBe(true)
    const oneEdit = { ...produced.state, cell: { ...produced.state.cell!, calls: 1, edits: 1 } }
    const settledOne = Projection.fold(
      ctx,
      oneEdit,
      new AgentEvents.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
      })
    )
    const settledState = (settledOne.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(settledState.status === "completed" && settledState.title).toBe("frame 1 · 1 call · 1 edit")

    // Without a cell open, prints and settlements change nothing.
    expect(
      Projection.fold(
        ctx,
        frame.state,
        new AgentEvents.CellPrinted({ eventType: "flows.harness.cell-printed.v1", cell: "c", text: "t" })
      ).events
    ).toEqual([])
    expect(
      Projection.fold(
        ctx,
        frame.state,
        new AgentEvents.CellSettled({
          eventType: "flows.harness.cell-settled.v1",
          cell: "c",
          outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
        })
      ).events
    ).toEqual([])

    // Every demand kind renders a card.
    const demands: Array<AgentEvent.AgentEvent> = [
      new AgentEvents.RepeatDemanded({
        eventType: "flows.harness.repeat-demanded.v1",
        frames: 2,
        cap: 2,
        nextFrame: 1
      }),
      new AgentEvents.NarrowedDemanded({
        eventType: "flows.harness.narrowed-demanded.v1",
        flow: "bash",
        broader: "pytest",
        narrower: "pytest -k x",
        broaderDigest: "a",
        currentDigest: "b",
        nextFrame: 1
      }),
      new AgentEvents.UnmovedDemanded({
        eventType: "flows.harness.unmoved-demanded.v1",
        openedDigest: "abcdef0123",
        currentDigest: "abcdef0123",
        nextFrame: 1
      }),
      new AgentEvents.UnresolvedDemanded({
        eventType: "flows.harness.unresolved-demanded.v1",
        flow: "bash",
        failed: "pytest",
        instead: "ls",
        currentDigest: "b",
        nextFrame: 1
      }),
      new AgentEvents.NarrowOnlyDemanded({
        eventType: "flows.harness.narrow-only-demanded.v1",
        flow: "bash",
        check: "pytest a",
        targets: ["a"],
        currentDigest: "b",
        nextFrame: 1
      }),
      new AgentEvents.ReadOnlyDemanded({
        eventType: "flows.harness.read-only-demanded.v1",
        streak: 3,
        cap: 3,
        nextFrame: 4,
        nextAction: "park"
      })
    ]
    let state = frame.state
    const titles: Array<string> = []
    for (const demand of demands) {
      const step = Projection.fold(ctx, state, demand)
      state = step.state
      const toolState = (step.events[0]!.properties["part"] as Protocol.ToolPart).state
      titles.push(toolState.status === "completed" ? toolState.title : "")
    }
    expect(titles).toEqual([
      "repeat · 2/2",
      "narrowed · bash",
      "unmoved",
      "unresolved · bash",
      "narrow-only · bash",
      "read-only · 3/3 · park"
    ])

    // A permission without a call identity still asks, without a card.
    const script = DemoScript.script({ sessionID, messageID: assistantMessageID, prompt: "p" })
    const park = script.segments[1]
    if (park?._tag !== "permission") throw new Error("the demo script parks")
    const bare = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.PermissionRequired({
        eventType: "flows.harness.permission-required.v1",
        request: { ...park.request, requestId: "bare", meta: { flow: "bash", input: { command: "rm -rf x" } } } as never
      })
    )
    expect(bare.events.map((event) => event.type)).toEqual(["permission.asked"])
    expect(bare.events[0]!.properties["id"]).toBe("per_bare")
    expect(bare.events[0]!.properties["tool"]).toEqual({ messageID: assistantMessageID, callID: "per_bare" })
    const noMeta = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.PermissionRequired({
        eventType: "flows.harness.permission-required.v1",
        request: { ...park.request, requestId: "per_x", meta: {} } as never
      })
    )
    expect(noMeta.events[0]!.properties["permission"]).toBe("proc:spawn")

    // Steering and the unknown are no-ops; a suspended close is a no-op.
    expect(
      Projection.fold(
        ctx,
        frame.state,
        new AgentEvents.SteeringDrained({ eventType: "flows.harness.steering-drained.v1", messages: [] })
      ).events
    ).toEqual([])
    const suspendedClose = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.TurnClosed({
        eventType: "flows.harness.turn-closed.v1",
        stopReason: "stop",
        outcome: "suspended"
      })
    )
    expect(suspendedClose.events).toEqual([])
    const abortedClose = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.TurnClosed({
        eventType: "flows.harness.turn-closed.v1",
        stopReason: "length",
        outcome: "aborted"
      })
    )
    expect(abortedClose.events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "message.updated",
      "session.updated",
      "session.status",
      "session.idle"
    ])
  })
})
