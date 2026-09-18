import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import type * as Health from "../src/Health.ts"
import * as Ids from "../src/Ids.ts"
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
  userPartID: Ids.part(userMessageID, { frame: 0, slot: 0, ordinal: 0 }),
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
    expect(ids.size).toBe(15 + 1)
    expect([...new Set(tools.map((part) => part.tool))].sort()).toEqual([
      "bash",
      "cell",
      "classify",
      "demand",
      "list",
      "read"
    ])
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
    expect(Projection.toolTitle("classify", {})).toBe("1 state")
    expect(Projection.toolTitle("classify/edit/risk", { states: [1, 2] })).toBe("2 states")

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
    expect(Projection.permissionPatterns("clock", {})).toEqual({ patterns: ["clock"], always: ["*"] })
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
    // An interrupt turns the dot gray (a title and a health card), then the
    // header, the run summary, the session, and the idle status follow.
    expect(interrupted.events.map((event) => event.type)).toEqual([
      "session.updated",
      "message.part.updated",
      "message.updated",
      "message.part.updated",
      "session.updated",
      "session.status",
      "session.idle"
    ])
    expect((interrupted.events[0]!.properties["info"] as Protocol.Session).title.startsWith("⚪ ")).toBe(true)
    expect((interrupted.events[1]!.properties["part"] as Protocol.ToolPart).state).toMatchObject({
      title: "interrupted"
    })
    const header = interrupted.events[2]!.properties["info"] as Protocol.AssistantMessage
    expect(header.error).toEqual({ name: "MessageAbortedError", data: { message: "The turn was interrupted" } })
    expect(interrupted.events[3]!.properties["part"]).toMatchObject({ type: "text", synthetic: true })
    expect(Projection.close(ctx, interrupted.state, { _tag: "failed", message: "x" }).events).toEqual([])
    expect(Projection.fold(ctx, interrupted.state, scriptEvents()[0]!).events).toEqual([])
    const withReasoning = Projection.fold(
      ctx,
      Projection.fold(ctx, start.state, scriptEvents()[0]!).state,
      scriptEvents()[1]!
    )
    const failed = Projection.close(ctx, withReasoning.state, { _tag: "failed", message: "boom" })
    expect(failed.events.map((event) => event.type).slice(0, 4)).toEqual([
      "message.part.updated",
      "session.updated",
      "message.part.updated",
      "message.updated"
    ])
    expect((failed.events[3]!.properties["info"] as Protocol.AssistantMessage).error).toEqual({
      name: "UnknownError",
      data: { message: "boom" }
    })
    const aborted = Projection.fold(
      ctx,
      start.state,
      new AgentEvents.Aborted({ eventType: "flows.harness.aborted.v1", reason: "quota" })
    )
    expect(aborted.events.map((event) => event.type).slice(0, 3)).toEqual([
      "session.updated",
      "message.part.updated",
      "message.updated"
    ])
    expect((aborted.events[2]!.properties["info"] as Protocol.AssistantMessage).error?.data.message).toBe("quota")
    // A discipline cap that ended the run is red, with the reason on the card.
    const capped = Projection.fold(
      ctx,
      start.state,
      new AgentEvents.Aborted({ eventType: "flows.harness.aborted.v1", reason: "The read-only cap ended the run" })
    )
    expect((capped.events[0]!.properties["info"] as Protocol.Session).title.startsWith("🔴 ")).toBe(true)
    expect((capped.events[1]!.properties["part"] as Protocol.ToolPart).state).toMatchObject({
      title: "stopped: The read-only cap ended the run"
    })
    // A turn stopped mid-call: the open cell and the open call read as errors
    // carrying why, so nothing stays running in the stream or after a reload.
    const events = scriptEvents()
    const midCall = events.slice(0, events.findIndex((event) => event._tag === "cell-call-started") + 1)
    const running = foldAll(midCall, ctx)
    expect(running.state.cell).toBeDefined()
    expect(Object.keys(running.state.calls).length).toBe(1)
    const stopped = Projection.close(ctx, running.state, { _tag: "interrupted" })
    const cards = stopped.events
      .map((event) => event.properties["part"] as Protocol.Part | undefined)
      .filter((part): part is Protocol.ToolPart => part?.type === "tool")
    expect(cards.map((part) => [part.tool, part.state.status])).toEqual([
      ["cell", "error"],
      ["read", "error"],
      ["health", "completed"]
    ])
    expect(cards[0]!.state).toMatchObject({ error: "interrupted", metadata: { outcome: "interrupted" } })
    expect(cards[1]!.state).toMatchObject({ error: "interrupted" })
    expect(stopped.state.cell).toBeUndefined()
    expect(stopped.state.calls).toEqual({})
    const died = Projection.close(ctx, running.state, { _tag: "failed", message: "the seat refused" })
    expect((died.events[1]!.properties["part"] as Protocol.ToolPart).state).toMatchObject({ error: "the seat refused" })
    // A refused key is the app's own ProviderAuthError; other refusals keep the composed message.
    const errorOf = (step: Projection.Step): Protocol.MessageError | undefined => {
      const assistant = step.events.find((event) =>
        event.type === "message.updated" && (event.properties["info"] as Protocol.Message).role === "assistant"
      )
      return (assistant!.properties["info"] as Protocol.AssistantMessage).error
    }
    const badKey = Projection.close(ctx, start.state, {
      _tag: "failed",
      message: "authentication (HTTP 401) from openai:gpt: Incorrect API key provided",
      provider: {
        seat: "openai:gpt",
        providerID: "openai",
        code: "authentication",
        status: 401,
        message: "Incorrect API key provided"
      }
    })
    expect(errorOf(badKey)).toEqual({
      name: "ProviderAuthError",
      data: { providerID: "openai", message: "authentication (HTTP 401) from openai:gpt: Incorrect API key provided" }
    })
    const noCredit = Projection.close(ctx, start.state, {
      _tag: "failed",
      message: "quota_exceeded (HTTP 429) from openai:gpt: no credits",
      provider: { seat: "openai:gpt", providerID: "openai", code: "quota_exceeded", status: 429, message: "no credits" }
    })
    expect(errorOf(noCredit)).toEqual({
      name: "UnknownError",
      data: { message: "quota_exceeded (HTTP 429) from openai:gpt: no credits" }
    })
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
    expect(settledWithoutProse.events.map((event) => event.type)).toEqual(["session.updated"])
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
    expect((settledWithProse.events[1]!.properties["part"] as Protocol.ReasoningPart).text).toBe("Plain prose")

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

    // The answer may arrive before the frame's close (the recorded turn once
    // did) or after it (the engine): the turn ends once both have.
    const answer = new AgentEvents.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant("early", { stopReason: "stop" })
    })
    const closeResolved = new AgentEvents.TurnClosed({
      eventType: "flows.harness.turn-closed.v1",
      stopReason: "stop",
      outcome: "resolved"
    })
    const answeredFirst = Projection.fold(ctx, frame.state, answer)
    expect(answeredFirst.state.closed).toBe(false)
    expect(answeredFirst.events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "message.part.delta",
      "message.part.updated"
    ])
    const thenClosed = Projection.fold(ctx, answeredFirst.state, closeResolved)
    expect(thenClosed.state.closed).toBe(true)
    expect(thenClosed.events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "message.updated",
      "message.part.updated",
      "session.updated",
      "session.status",
      "session.idle"
    ])
    const closedFirst = Projection.fold(ctx, frame.state, closeResolved)
    expect(closedFirst.state.closed).toBe(false)
    expect(closedFirst.events.map((event) => event.type)).toEqual(["message.part.updated"])
    expect(Projection.fold(ctx, closedFirst.state, answer).state.closed).toBe(true)

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
      "message.part.updated",
      "session.updated",
      "session.status",
      "session.idle"
    ])
  })
})

describe("Projection: classify, health, cost, and the run summary", () => {
  const verdict = {
    answers: {
      relevant: { value: true, probability: 0.93 },
      role: { value: "implementation", probabilities: { implementation: 0.81, fixture: 0.19 }, confidence: 0.81 },
      risk: { value: 0.4, label: "none", probabilities: { none: 0.62, low: 0.38 }, confidence: 0.62 }
    },
    confidence: { relevant: 0.86, role: 0.81, risk: 0.62 },
    latencyMs: 212
  }

  it("renders a classify verdict, a batch, and the odd shapes", () => {
    expect(Projection.isClassify("classify")).toBe(true)
    expect(Projection.isClassify("classify/edit/risk")).toBe(true)
    expect(Projection.isClassify("read")).toBe(false)
    expect(Projection.toolName("classify/triage/relevance")).toBe("classify")
    expect(Projection.classifyOutput(verdict)).toBe(
      "1. relevant: yes (0.93) · role: implementation (0.81) · risk: none (0.62)"
    )
    expect(Projection.classifyTitle({ task: "t" }, verdict, 5)).toBe("1 state · 3 questions · 212 ms")
    expect(Projection.toolMetadata("classify", verdict)).toEqual({ answers: [verdict.answers], result: verdict })
    const batch = {
      results: [
        { ok: true, state: 1, answers: { yes: { value: false, probability: 0.2 } }, confidence: { yes: 0.6 } },
        { ok: false, state: 2, error: { code: "timeout", message: "slow" } },
        "junk"
      ]
    }
    expect(Projection.classifyOutput(batch)).toBe("1. yes: no (0.80)\n2. timeout: slow\n3. failed: ")
    expect(Projection.classifyTitle({ states: [1, 2, 3], questions: { yes: {} } }, batch, 40)).toBe(
      "3 states · 1 question · 40 ms"
    )
    // No answered state: the question count comes from the input.
    const refused = { results: [{ ok: false, state: 1, error: { code: "unreachable", message: "no key" } }] }
    expect(Projection.classifyTitle({ states: [1], questions: { a: {}, b: {} } }, refused, 7)).toBe(
      "1 state · 2 questions · 7 ms"
    )
    expect(Projection.classifyTitle({}, refused, 7)).toBe("1 state · 0 questions · 7 ms")
    expect(Projection.classifyTitle({}, "text", 3)).toBe("1 state · 0 questions · 3 ms")
    expect(Projection.toolMetadata("classify", refused)).toEqual({
      answers: [{ error: { code: "unreachable", message: "no key" } }],
      result: refused
    })
    expect(Projection.classifyOutput({ answers: { b: { value: false } } })).toBe("1. b: no (1.00)")
    expect(Projection.summaryLine({ frames: 1, calls: 1, classifyCalls: 0, jevCalls: 1, jevLatencyMs: 9, jevCost: 0 }))
      .toBe("1 frame · 1 call · 0 classify · Jev 1 call · 9 ms · $0.0000")
    expect(Projection.classifyOutput("text")).toBe("1. ")
    expect(Projection.classifyOutput({ answers: { odd: "plain", choice: { value: "b" }, score: { value: 1 } } }))
      .toBe("1. odd: plain · choice: b (0.00) · score: 1 (0.00)")
    expect(Projection.classifyOutput({ results: [{ error: "x" }, { ok: false, error: {} }] })).toBe(
      "1. failed: \n2. failed: "
    )
    expect(Projection.classifyOutput({ answers: { error: { value: true, probability: 1 } } })).toBe(
      "1. error: yes (1.00)"
    )
    expect(Projection.classifyEntries({ results: [{ answers: { a: 1 } }, { error: { code: "empty" } }] })).toEqual([
      { answers: { a: 1 } },
      { error: { code: "empty" } }
    ])
    expect(Projection.toolOutput("classify", verdict)).toContain("relevant: yes")
  })

  it("folds a classify call into the card, the counters, and the health facts", () => {
    const ctx = { directory, now: clock().now }
    const { emitted, state } = foldAll(scriptEvents(), ctx)
    const parts = emitted
      .filter((event) => event.type === "message.part.updated")
      .map((event) => event.properties["part"] as Protocol.Part)
    const classify = parts.filter((part): part is Protocol.ToolPart => part.type === "tool" && part.tool === "classify")
    const completed = classify.find((part) => part.state.status === "completed")!
    expect(completed.state).toMatchObject({
      title: "1 state · 3 questions · 212 ms",
      output: "1. relevant: yes (0.93) · role: implementation (0.81) · risk: none (0.62)"
    })
    expect(completed.state.status === "completed" && completed.state.metadata["answers"]).toEqual([
      completed.state.status === "completed" && (completed.state.metadata["result"] as { answers: unknown }).answers
    ])
    // Two frames ran twice (the park replays frame zero and one): the summary counts what the app saw.
    expect(state.summary).toMatchObject({ frames: 4, classifyCalls: 2, jevCalls: 2, jevLatencyMs: 424, jevCost: 0 })
    expect(state.summary.calls).toBe(7)
    expect(state.facts.lastCalls.map((call) => call.flow)).toContain("classify/triage/relevance")
    expect(state.facts.lastCalls.map((call) => call.ok)).toContain(true)
    expect(state.facts.lastPrints).toContain("total 16")
    expect(state.facts.demands).toEqual(["read-only", "read-only"])
    expect(state.facts.lastTransition).toBe("complete")
    const summary = parts.find((part): part is Protocol.TextPart => part.type === "text" && part.synthetic === true)!
    expect(summary.text).toBe("4 frames · 7 calls · 2 classify · Jev 2 calls · 424 ms · $0.0000")
    expect(summary.id).toBe(
      Ids.part(assistantMessageID, { frame: Projection.finalFrame, slot: Projection.summarySlot, ordinal: 0 })
    )
  })

  it("hands out health facts on a settled cell, a park, and a resume, and folds decisions in", () => {
    const ctx = { directory, now: clock().now, maxFrames: 8 }
    let step = Projection.open(ctx, opened())
    expect(step.state.health).toBeUndefined()
    const triggers: Array<Health.Facts> = []
    for (const event of scriptEvents()) {
      step = Projection.fold(ctx, step.state, event)
      if (step.health !== undefined) triggers.push(step.health)
    }
    // Frame zero settled, frame one parked, then the replay: frame zero and frame one settled.
    expect(triggers.map((facts) => [facts.frame, facts.parked, facts.demandThisFrame])).toEqual([
      [1, "none", false],
      [2, "permission", true],
      [1, "none", false],
      [2, "none", true]
    ])
    expect(triggers[0]).toMatchObject({
      task: "Read package.json and tell me the name field.",
      maxFrames: 8,
      framesSinceEdit: 1
    })
    // The replayed frames read only, so the count keeps climbing.
    expect(triggers[3]!.framesSinceEdit).toBe(3)
    expect(triggers[3]!.lastCalls.length).toBeGreaterThan(0)

    // A decision: the dot lands on the title, the card carries the reason and the answers.
    const evaluation: Health.Evaluation = {
      decision: { color: "yellow", reason: "read-only demanded" },
      answers: undefined,
      latencyMs: 30,
      usage: { inputTokens: 1000, outputTokens: 0 },
      error: undefined
    }
    const opened2 = Projection.open(ctx, opened())
    const first = Projection.health(ctx, opened2.state, triggers[0]!, evaluation)
    expect(first.events.map((event) => event.type)).toEqual(["session.updated", "message.part.updated"])
    expect((first.events[0]!.properties["info"] as Protocol.Session).title).toBe(
      "🟡 Read package.json and tell me the name field."
    )
    const card = first.events[1]!.properties["part"] as Protocol.ToolPart
    expect(card).toMatchObject({ tool: "health", callID: "health_0" })
    // The card sorts under the frame it judged, not the frame that was open when it landed.
    expect(card.id).toBe(Ids.part(assistantMessageID, { frame: 0, slot: Projection.slots.health, ordinal: 0 }))
    expect(card.state).toMatchObject({
      status: "completed",
      title: "read-only demanded",
      output: "no answers",
      input: { color: "yellow" }
    })
    expect(first.state.summary).toMatchObject({ jevCalls: 1, jevLatencyMs: 30 })
    expect(first.state.summary.jevCost).toBeCloseTo(0.000042)
    // The same color again: the reason is kept, nothing is emitted.
    const same = Projection.health(ctx, first.state, triggers[0]!, {
      ...evaluation,
      decision: { color: "yellow", reason: "still" }
    })
    expect(same.events).toEqual([])
    expect(same.state.health).toEqual({ color: "yellow", reason: "still" })
    expect(same.state.healthCards).toBe(1)
    // A new color: the title changes, a second card follows.
    const green = Projection.health(ctx, same.state, triggers[3]!, {
      ...evaluation,
      decision: { color: "green", reason: "done" }
    })
    expect((green.events[0]!.properties["info"] as Protocol.Session).title.startsWith("🟢 ")).toBe(true)
    expect((green.events[1]!.properties["part"] as Protocol.ToolPart).callID).toBe("health_1")
    expect((green.events[1]!.properties["part"] as Protocol.ToolPart).id).toBe(
      Ids.part(assistantMessageID, { frame: 1, slot: Projection.slots.health, ordinal: 1 })
    )
    // A decision that reaches a closed turn changes nothing.
    const closed = Projection.close(ctx, green.state, { _tag: "interrupted" })
    expect(Projection.health(ctx, closed.state, triggers[0]!, evaluation).events).toEqual([])
    // A follow-up turn starts from the color the title carries.
    const next = Projection.open(ctx, { ...opened(), session: { ...session, title: "🟢 Kept" } })
    expect(next.state.health).toEqual({ color: "green", reason: "" })
    expect((next.events[2]!.properties["info"] as Protocol.Session).title).toBe("🟢 Kept")
  })

  it("carries the seat's cost when a price is known, and the tokens either way", () => {
    const pricing: Projection.Pricing = { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.5 }
    expect(
      Projection.costOf({
        input: 1_000_000,
        output: 500_000,
        reasoning: 500_000,
        cache: { read: 1_000_000, write: 1_000_000 }
      }, pricing)
    )
      .toBeCloseTo(1 + 2 + 0.5 + 1)
    expect(Projection.costOf(Protocol.noTokens, undefined)).toBe(0)
    expect(
      Projection.costOf({ input: 0, output: 0, reasoning: 0, cache: { read: 1_000_000, write: 1_000_000 } }, {
        inputPerMillion: 3,
        outputPerMillion: 1
      })
    ).toBeCloseTo(6)
    const ctx = { directory, now: clock().now, pricing }
    const { emitted, state } = foldAll(scriptEvents(), ctx)
    expect(state.cost).toBeCloseTo(((812 + 1240) * 2 * 1 + (96 + 88) * 2 * 2) / 1_000_000)
    const sessions = emitted.filter((event) => event.type === "session.updated")
      .map((event) => event.properties["info"] as Protocol.Session)
    // Every model settlement updates the session's tokens and cost.
    expect(sessions.length).toBeGreaterThanOrEqual(5)
    expect(sessions[sessions.length - 1]!.cost).toBeCloseTo(state.cost)
    expect(sessions[sessions.length - 1]!.tokens.input).toBe((812 + 1240) * 2)
    const header = emitted.filter((event) => event.type === "message.updated")
      .map((event) => event.properties["info"] as Protocol.Message)
      .find((info) => info.role === "assistant" && info.finish === "stop") as Protocol.AssistantMessage
    expect(header.cost).toBeCloseTo(state.cost)
    const finishes = emitted.map((event) => event.properties["part"] as Protocol.Part | undefined)
      .filter((part): part is Protocol.StepFinishPart => part?.type === "step-finish")
    expect(finishes[0]!.cost).toBeCloseTo((812 + 96 * 2) / 1_000_000)
  })

  it("reads the harness facts the demo turn lacks: mutations, transitions, and parks", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    const frame = Projection.fold(ctx, start.state, scriptEvents()[0]!)
    const mutated = Projection.fold(
      ctx,
      { ...frame.state, facts: { ...frame.state.facts, framesSinceEdit: 3 } },
      new AgentEvents.MutationObserved({
        eventType: "flows.harness.mutation-observed.v1",
        basis: "observed",
        mutated: true,
        digest: "d",
        paths: 1,
        declaredWrites: 1
      })
    )
    expect(mutated.state.facts.framesSinceEdit).toBe(0)
    expect(mutated.state.editedThisFrame).toBe(true)
    const unmoved = Projection.fold(
      ctx,
      mutated.state,
      new AgentEvents.MutationObserved({
        eventType: "flows.harness.mutation-observed.v1",
        basis: "observed",
        mutated: false,
        digest: "d",
        paths: 1,
        declaredWrites: 0
      })
    )
    expect(unmoved.state).toBe(mutated.state)
    const parkedTransition = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Park({ reason: "waiting-input", message: "?" })
      })
    )
    expect(parkedTransition.state.facts.lastTransition).toBe("park")
    const suspendedOnInput = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.Suspended({
        eventType: "flows.harness.suspended.v1",
        reason: { code: "waiting-input", message: "?" } as never
      })
    )
    expect(suspendedOnInput.health?.parked).toBe("question")
    const suspendedOnQuota = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.Suspended({
        eventType: "flows.harness.suspended.v1",
        reason: { code: "waiting-quota", message: "?" } as never
      })
    )
    expect(suspendedOnQuota.health?.parked).toBe("quota")
    // A print outside a cell still feeds the health state.
    const printed = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.CellPrinted({ eventType: "flows.harness.cell-printed.v1", cell: "c", text: "x".repeat(3000) })
    )
    expect(printed.state.facts.lastPrints.length).toBe(Projection.healthTextCap)
    // An edit that succeeded counts as this frame's edit; a failed call is summarized by its code.
    const source = Cell.source("edit")
    const produced = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source, blocks: 1 })
    )
    const identity = new Cell.CallIdentity({
      session: sessionID,
      frame: 0,
      cell: source.digest,
      ordinal: 0,
      declaration: "d",
      layers: []
    })
    const started = Projection.fold(
      ctx,
      produced.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "edit",
          input: { path: "f", oldString: "a", newString: "b" },
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(),
          identity
        })
      })
    )
    const edited = Projection.fold(
      ctx,
      started.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "edit",
        identity,
        result: new Cell.CallResult({ outcome: "success", value: { hunk: "@@" } })
      })
    )
    expect(edited.state.editedThisFrame).toBe(true)
    expect(edited.state.facts.lastCalls.at(-1)).toEqual({ flow: "edit", ok: true, summary: "f" })
    // The frame that edited resets the count when its cell settles.
    const settledAfterEdit = Projection.fold(
      ctx,
      { ...edited.state, facts: { ...edited.state.facts, framesSinceEdit: 5 } },
      new AgentEvents.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: source.digest,
        outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
      })
    )
    expect(settledAfterEdit.health?.framesSinceEdit).toBe(0)
    const failed = Projection.fold(
      ctx,
      started.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "edit",
        identity,
        result: new Cell.CallResult({ outcome: "failure", value: null, message: "no such file" })
      })
    )
    expect(failed.state.editedThisFrame).toBe(false)
    expect(failed.state.facts.lastCalls.at(-1)).toEqual({
      flow: "edit",
      ok: false,
      summary: "flow_failed: no such file"
    })
    // A call whose title is empty is summarized by its output.
    const bashIdentity = new Cell.CallIdentity({
      session: sessionID,
      frame: 0,
      cell: source.digest,
      ordinal: 1,
      declaration: "d",
      layers: []
    })
    const bashStarted = Projection.fold(
      ctx,
      produced.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "bash",
          input: {},
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(),
          identity: bashIdentity
        })
      })
    )
    const bashSettled = Projection.fold(
      ctx,
      bashStarted.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "bash",
        identity: bashIdentity,
        result: new Cell.CallResult({ outcome: "success", value: { stdout: "out", stderr: "", exitCode: 0 } })
      })
    )
    expect(bashSettled.state.facts.lastCalls.at(-1)).toEqual({ flow: "bash", ok: true, summary: "out" })
    // A classify call whose value carries no latency is timed by the card.
    const classifyIdentity = new Cell.CallIdentity({
      session: sessionID,
      frame: 0,
      cell: source.digest,
      ordinal: 2,
      declaration: "d",
      layers: []
    })
    const classifyStarted = Projection.fold(
      ctx,
      produced.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "classify",
          input: { states: [1, 2], questions: { q: { type: "boolean", instructions: "?" } } },
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(),
          identity: classifyIdentity
        })
      })
    )
    expect((classifyStarted.events[0]!.properties["part"] as Protocol.ToolPart).state).toMatchObject({
      title: "2 states"
    })
    const classifySettled = Projection.fold(
      ctx,
      classifyStarted.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "classify",
        identity: classifyIdentity,
        result: new Cell.CallResult({ outcome: "success", value: { results: [] } })
      })
    )
    expect(classifySettled.state.summary.jevLatencyMs).toBeGreaterThan(0)
    const classifyRefused = Projection.fold(
      ctx,
      classifyStarted.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "classify",
        identity: classifyIdentity,
        result: new Cell.CallResult({
          outcome: "failure",
          value: null,
          message: "unreachable: no key",
          code: "flow_failed"
        })
      })
    )
    expect(classifyRefused.state.summary.jevLatencyMs).toBe(0)
    expect((classifyRefused.events[0]!.properties["part"] as Protocol.ToolPart).state.status).toBe("error")
  })
})
