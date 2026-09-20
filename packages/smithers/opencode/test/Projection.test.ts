import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Cause, Option } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DemoScript from "../src/DemoScript.ts"
import * as EngineDriver from "../src/EngineDriver.ts"
import * as Health from "../src/Health.ts"
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
    // UPDATE_GOLDEN=1 re-pins the fixture on purpose; a missing fixture fails,
    // so a deleted golden never passes with whatever the code emits.
    if (process.env["UPDATE_GOLDEN"] === "1") writeFileSync(goldenPath, `${rendered}\n`)
    expect(rendered).toBe(readFileSync(goldenPath, "utf8").trimEnd())
    expect(state.closed).toBe(true)
    // The park replays both frames' model steps; the session counts each frame once.
    expect(state.session.tokens.input).toBe(812 + 1240)
  })

  it("reports the last model step's tokens on the assistant message, the way OpenCode does", () => {
    const ctx = { directory, now: clock().now }
    const { emitted, state } = foldAll(scriptEvents(), ctx)
    const headers = emitted
      .filter((event) => event.type === "message.updated")
      .map((event) => event.properties["info"] as Protocol.Message)
      .filter((info): info is Protocol.AssistantMessage => info.role === "assistant")
    // The header before any model step, one per model settlement (four:
    // two frames, replayed once), and the finished header.
    expect(headers.map((header) => header.tokens.input)).toEqual([0, 812, 1240, 812, 1240, 1240])
    const final = headers[headers.length - 1]!
    expect(final.finish).toBe("stop")
    expect(final.tokens).toEqual({ input: 1240, output: 88, reasoning: 0, cache: { read: 0, write: 0 } })
    // What the app's context tooltip computes from the header
    // (packages/app/src/components/session/session-context-metrics.ts:
    // input + output + reasoning + cache.read + cache.write over the model's
    // context limit) is the last step's size, not the turn's sum.
    const total = final.tokens.input + final.tokens.output + final.tokens.reasoning + final.tokens.cache.read +
      final.tokens.cache.write
    expect(Math.round((total / 8192) * 100)).toBe(16)
    // The session and the summary keep the turn's totals, each frame once.
    expect(state.session.tokens).toEqual({ input: 2052, output: 184, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(state.tokens).toEqual(state.session.tokens)
  })

  it("names the same parts when a frame is replayed after a park", () => {
    const ctx = { directory, now: clock().now }
    const { emitted } = foldAll(scriptEvents(), ctx)
    const parts = emitted.filter((event) => event.type === "message.part.updated")
    const ids = new Set(parts.map((event) => (event.properties["part"] as Protocol.Part).id))
    const tools = parts
      .map((event) => event.properties["part"] as Protocol.Part)
      .filter((part): part is Protocol.ToolPart => part.type === "tool")
    // Fifteen cards, the cell card the park leaves open, the final health
    // card, and two visible cell print receipts, each updated across replay.
    expect(ids.size).toBe(15 + 2 + 2)
    expect([...new Set(tools.map((part) => part.tool))].sort()).toEqual([
      "bash",
      "cell",
      "classify",
      "demand",
      "health",
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
    expect(Projection.toolTitle("classify", {})).toBe("ad hoc · 1 state")
    expect(Projection.toolTitle("classify/edit/risk", { states: [1, 2] })).toBe("edit/risk · 2 states")
    expect(Projection.classifyDoor("classify")).toBe("ad hoc")
    expect(Projection.classifyDoor("classify/check/verdict")).toBe("check/verdict")

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
    expect(Projection.permissionPatterns("bash", { command: "  " })).toEqual({
      patterns: [Projection.unnameableBash],
      always: []
    })
    expect(Projection.permissionPatterns("bash", {})).toEqual({ patterns: [Projection.unnameableBash], always: [] })
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

  it("names the program of a script-form bash call, and offers it no always-grant", () => {
    // Every input shape `@smthrs/agent/std/Bash` accepts, and what the person
    // is asked to approve for each. The script form has no first word, so it
    // offers no `always` at all: allowing it covers the one call.
    const hermetic = { mode: "hermetic", script: "node -e 'console.log(1)'", reads: ["src/hello.js"], writes: [] }
    expect(Projection.toolInput(directory, "bash", hermetic)).toEqual({
      command: "bash script: node -e 'console.log(1)'",
      script: "node -e 'console.log(1)'"
    })
    expect(Projection.bashSubject(hermetic)).toEqual({
      command: "bash script: node -e 'console.log(1)'",
      always: []
    })
    expect(Projection.permissionPatterns("bash", Projection.toolInput(directory, "bash", hermetic))).toEqual({
      patterns: ["bash script: node -e 'console.log(1)'"],
      always: []
    })
    expect(Projection.toolTitle("bash", Projection.toolInput(directory, "bash", hermetic)))
      .toBe("bash script: node -e 'console.log(1)'")

    // The interpreter the call names, its arguments, its working directory and
    // its container all reach the card; the program is the last field, because
    // it is the long one.
    const program = { mode: "unhermetic", interpreter: "python3", script: "import sys\nprint(sys.argv)\n", args: ["a"] }
    expect(Projection.toolInput(directory, "bash", { ...program, cwd: "sub", container: "ci" })).toEqual({
      command: "python3 script: import sys (+1 more lines)",
      interpreter: "python3",
      args: ["a"],
      container: "ci",
      cwd: "sub",
      script: "import sys\nprint(sys.argv)\n"
    })
    expect(Projection.bashSubject(program).always).toEqual([])

    // A program too long for one line is clipped, and the card carries it whole.
    const long = { mode: "unhermetic", script: `echo ${"x".repeat(200)}` }
    const clipped = Projection.bashSubject(long)
    expect(clipped.command.length).toBe("bash script: ".length + 123)
    expect(clipped.command.endsWith("...")).toBe(true)
    expect(Projection.toolInput(directory, "bash", long)["script"]).toBe(`echo ${"x".repeat(200)}`)

    // A command line still names its first word, and a container qualifies the
    // grant so allowing `pytest` in a container never allows it on the host.
    expect(Projection.bashSubject({ mode: "unhermetic", command: "pytest -q" })).toEqual({
      command: "pytest -q",
      always: ["pytest *"]
    })
    expect(Projection.bashSubject({ mode: "unhermetic", command: "pytest -q", container: "ci" })).toEqual({
      command: "pytest -q",
      always: ["pytest * in container ci"]
    })

    // An input that names neither, which `Bash.run` refuses as invalid_input,
    // is shown as what it is and grants nothing.
    expect(Projection.bashSubject({ mode: "unhermetic", stdin: "text" })).toEqual({ command: "", always: [] })
    expect(Projection.unnameableBash).toBe("a bash call that names no command")
    expect(Projection.permissionPatterns("bash", { mode: "unhermetic", script: "   " })).toEqual({
      patterns: [Projection.unnameableBash],
      always: []
    })
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
    // The only `Aborted` the harness emits is the interrupt one CellTurn
    // sends from `Effect.onInterrupt`; it carries no provider code, so the
    // dot stays gray and the reason reaches the header verbatim.
    const aborted = Projection.fold(
      ctx,
      start.state,
      new AgentEvents.Aborted({ eventType: "flows.harness.aborted.v1", reason: "Cell frame interrupted" })
    )
    expect(aborted.events.map((event) => event.type).slice(0, 3)).toEqual([
      "session.updated",
      "message.part.updated",
      "message.updated"
    ])
    expect((aborted.events[0]!.properties["info"] as Protocol.Session).title.startsWith("⚪ ")).toBe(true)
    expect((aborted.events[2]!.properties["info"] as Protocol.AssistantMessage).error?.data.message).toBe(
      "Cell frame interrupted"
    )
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

  it("reads a usage limit that ended the run off the provider's code, never off its words", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    /**
     * The closing a refused model call actually reaches the projection as:
     * the driver's own `failedOutcome`, over the `HarnessError`-wrapped
     * `ModelError` the cell controller raises.
     */
    const refused = (code: ModelError["code"], message: string, httpStatus: number): Projection.Closing => {
      const outcome = EngineDriver.failedOutcome(
        "openai:gpt",
        Cause.fail(
          new HarnessError({
            code: "model_failed",
            message: "The cell frame failed",
            cause: new ModelError({ code, message, httpStatus })
          })
        )
      )
      if (outcome._tag !== "failed") throw new Error(`the driver reported ${outcome._tag}`)
      return outcome
    }
    const dotOf = (step: Projection.Step): string =>
      (step.events[0]!.properties["info"] as Protocol.Session).title.slice(0, 2).trim()
    const cardOf = (step: Projection.Step): string => {
      const state = (step.events[1]!.properties["part"] as Protocol.ToolPart).state
      return state.status === "completed" ? state.title : `the health card is ${state.status}`
    }
    // An account at its cap: red, naming the seat the operator has to raise.
    const noQuota = Projection.close(
      ctx,
      start.state,
      refused("quota_exceeded", "You exceeded your current quota, please check your plan and billing details.", 429)
    )
    expect([dotOf(noQuota), cardOf(noQuota)]).toEqual(["🔴", "stopped: openai:gpt is out of quota"])
    // A rate-limit window is the same fault class: a limit stopped the run.
    const limited = Projection.close(ctx, start.state, refused("rate_limited", "Rate limit reached for gpt", 429))
    expect([dotOf(limited), cardOf(limited)]).toEqual(["🔴", "stopped: openai:gpt is rate limited"])
    // A provider that broke is not a usage limit, so there is no limit to
    // name. It is still a run that is over, and the harness code it came
    // wrapped in says which rule ended it.
    const broke = Projection.close(ctx, start.state, refused("provider_internal", "Internal server error", 500))
    expect([dotOf(broke), cardOf(broke)]).toEqual(["🔴", "stopped: the model call failed"])
    expect(broke.state.facts.stoppedBy).toBeUndefined()
    // And the words are not the contract: a refusal whose sentence says "cap"
    // and whose code says otherwise is that same ordinary failure.
    const capInProse = Projection.close(
      ctx,
      start.state,
      refused("provider_internal", "The concurrency cap for this account was hit", 503)
    )
    expect(capInProse.state.facts.stoppedBy).toBeUndefined()
    expect([dotOf(capInProse), cardOf(capInProse)]).toEqual(["🔴", "stopped: the model call failed"])
    // The rule replays the same decision off the facts the projection kept,
    // so a reload and the live stream read the same dot.
    expect(Health.decide(noQuota.state.facts, undefined)).toEqual({
      color: "red",
      reason: "stopped: openai:gpt is out of quota"
    })
    expect(Health.decide(capInProse.state.facts, undefined)).toEqual({
      color: "red",
      reason: "stopped: the model call failed"
    })
  })

  it("types a dead network as the infrastructure and says what to do about it", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    const refused = (code: ModelError["code"], message: string): Projection.Closing => {
      const outcome = EngineDriver.failedOutcome(
        "cerebras:gpt-oss-120b",
        Cause.fail(
          new HarnessError({
            code: "model_failed",
            message: "The cell frame failed",
            cause: new ModelError({ code, message })
          })
        )
      )
      if (outcome._tag !== "failed") throw new Error(`the driver reported ${outcome._tag}`)
      return outcome
    }
    const errorOf = (step: Projection.Step): Protocol.MessageError | undefined => {
      const assistant = step.events.find((event) =>
        event.type === "message.updated" && (event.properties["info"] as Protocol.Message).role === "assistant"
      )
      return (assistant!.properties["info"] as Protocol.AssistantMessage).error
    }
    const dotOf = (step: Projection.Step): string =>
      (step.events[0]!.properties["info"] as Protocol.Session).title.slice(0, 2).trim()
    // What a dead network reaches the projection as. It used to end the turn
    // with this sentence verbatim on the message, which names no fault and
    // nothing to do, and reads as something the person broke.
    const dead = Projection.close(
      ctx,
      start.state,
      refused("transport", "HTTP transport failed: TransportError: [ECONNREFUSED 127.0.0.1:443]")
    )
    expect(dead.state.facts.unreachable).toEqual({
      code: "transport",
      seat: "cerebras:gpt-oss-120b",
      message: "HTTP transport failed: TransportError: [ECONNREFUSED 127.0.0.1:443]"
    })
    const message = (errorOf(dead)!.data as { message: string }).message
    expect(message).toContain("cerebras:gpt-oss-120b could not be reached")
    expect(message).toContain("not anything you did")
    expect(message).toContain("Check that this machine has a network")
    // The provider's own words stay, last, for whoever is reading a log.
    expect(message).toContain("ECONNREFUSED")
    expect(dotOf(dead)).toBe("🔴")
    // The replayed decision reads the same fault off the facts the
    // projection kept, so a reload and the live stream agree.
    expect(Health.decide(dead.state.facts, undefined)).toEqual({
      color: "red",
      reason: "stopped: cerebras:gpt-oss-120b could not be reached"
    })
    // A call that outran its own budget is the same fault class with its own
    // remedy; a request the model rejected is not one at all.
    const slow = Projection.close(ctx, start.state, refused("call_timeout", "The call exceeded 120s"))
    expect(Health.decide(slow.state.facts, undefined).reason).toBe(
      "stopped: cerebras:gpt-oss-120b did not answer in time"
    )
    expect((errorOf(slow)!.data as { message: string }).message).toContain("shorten it")
    const rejected = Projection.close(ctx, start.state, refused("invalid_request", "messages must not be empty"))
    expect(rejected.state.facts.unreachable).toBeUndefined()
    expect(errorOf(rejected)).toEqual({
      name: "UnknownError",
      data: { message: "invalid_request from cerebras:gpt-oss-120b: messages must not be empty" }
    })
  })

  it("keeps the parked cell so an abort of a parked turn settles every open card", () => {
    const ctx = { directory, now: clock().now }
    const events = scriptEvents()
    const parked = foldAll(events.slice(0, events.findIndex((event) => event._tag === "suspended") + 1), ctx)
    // The park resets the frame counter for the replay and leaves the cell of
    // the parked frame open, together with the call the person never answered.
    expect(parked.state.frame).toBe(-1)
    expect(parked.state.cell).toMatchObject({ frame: 1 })
    expect(Object.keys(parked.state.calls).length).toBe(1)
    const stopped = Projection.close(ctx, parked.state, { _tag: "interrupted" })
    const cards = stopped.events
      .map((event) => event.properties["part"] as Protocol.Part | undefined)
      .filter((part): part is Protocol.ToolPart => part?.type === "tool")
    expect(cards.map((part) => [part.tool, part.state.status])).toEqual([
      ["cell", "error"],
      ["bash", "error"],
      ["health", "completed"]
    ])
    // The settled card is the parked frame's own, by id and by the frame it names.
    expect(cards[0]!.id).toBe(Ids.part(assistantMessageID, { frame: 1, slot: Projection.slots.cell, ordinal: 0 }))
    expect(cards[0]!.state).toMatchObject({ error: "interrupted", input: { frame: 2 } })
    expect(stopped.state.cell).toBeUndefined()
    expect(stopped.events.map((event) => event.type).slice(-2)).toEqual(["session.status", "session.idle"])
    expect((stopped.events.at(-2)!.properties["status"] as Protocol.SessionStatus).type).toBe("idle")
    // The replay after the park opens frame zero afresh: the kept cell is dropped.
    const replayed = Projection.fold(ctx, parked.state, events.find((event) => event._tag === "turn-opened")!)
    expect(replayed.state.cell).toBeUndefined()
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
    // Even without prose, a settlement updates the session's totals and the header's context tokens.
    expect(settledWithoutProse.events.map((event) => event.type)).toEqual(["session.updated", "message.updated"])
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
    expect(settledWithProse.events.map((event) => event.type)).toEqual([
      "session.updated",
      "message.updated",
      "message.part.updated"
    ])
    expect((settledWithProse.events[2]!.properties["part"] as Protocol.ReasoningPart).text).toBe("Plain prose")

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
    expect(errorState.status === "error" && errorState.error).toBe("f: The call failed")
    // A failed shell leads with its command: the app's error card shows the
    // words before the first ": " in its header and the rest in its body,
    // so the person reads the command and the reason, not "Failed".
    const shellIdentity = new Cell.CallIdentity({
      session: sessionID,
      frame: 0,
      cell: source.digest,
      ordinal: 1,
      declaration: "d",
      layers: []
    })
    const shellStarted = Projection.fold(
      ctx,
      editFailed.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "bash",
          input: { command: "node test.mjs" },
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
          placement: Option.none(),
          identity: shellIdentity
        })
      })
    )
    const shellFailed = Projection.fold(
      ctx,
      shellStarted.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "bash",
        identity: shellIdentity,
        result: new Cell.CallResult({
          outcome: "failure",
          value: null,
          code: "capability_refused",
          message: "This host pins no trees, so there is no base to run bash against"
        })
      })
    )
    const shellState = (shellFailed.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(shellState.status === "error" && shellState.error).toBe(
      "node test.mjs: This host pins no trees, so there is no base to run bash against (capability_refused)\n" +
        Cell.callFailureHint["capability_refused"]
    )
    expect(shellFailed.state.facts.lastCalls.at(-1)).toMatchObject({ flow: "bash", ok: false })
    // A call with nothing to name it keeps the bare reason.
    const bareIdentity = new Cell.CallIdentity({
      session: sessionID,
      frame: 0,
      cell: source.digest,
      ordinal: 2,
      declaration: "d",
      layers: []
    })
    const bareStarted = Projection.fold(
      ctx,
      shellFailed.state,
      new AgentEvents.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "glob",
          input: {},
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
          placement: Option.none(),
          identity: bareIdentity
        })
      })
    )
    const bareFailed = Projection.fold(
      ctx,
      bareStarted.state,
      new AgentEvents.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "glob",
        identity: bareIdentity,
        result: new Cell.CallResult({ outcome: "failure", value: null, message: "no such file" })
      })
    )
    const bareState = (bareFailed.events[0]!.properties["part"] as Protocol.ToolPart).state
    expect(bareState.status === "error" && bareState.error).toBe("no such file")
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
    expect(codedState.status === "error" && codedState.error.startsWith("true: refused (capability_refused)\n")).toBe(
      true
    )
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
      new AgentEvents.ClaimDemanded({
        eventType: "flows.harness.claim-demanded.v1",
        complete: 0.08,
        overclaims: 0.4,
        invented: 0.9,
        latencyMs: 380,
        demanded: true,
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
      "claim · invented 0.90 (complete 0.08, overclaims 0.40)",
      "read-only · 3/3 · park"
    ])

    // The reading that let a completion through asked the run for nothing, so
    // it renders no card at all.
    expect(
      Projection.fold(
        ctx,
        state,
        new AgentEvents.ClaimDemanded({
          eventType: "flows.harness.claim-demanded.v1",
          complete: 0.95,
          overclaims: 0.02,
          invented: 0.02,
          latencyMs: 300,
          demanded: false,
          currentDigest: "b",
          nextFrame: 2
        })
      ).events
    ).toEqual([])

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
    // This turn applied no `complete` transition, which is what a turn its
    // frame budget ended looks like, so the step's finish is followed by the
    // red dot and its card before the header and the summary.
    expect(thenClosed.events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "session.updated",
      "message.part.updated",
      "message.updated",
      "message.part.updated",
      "session.updated",
      "session.status",
      "session.idle"
    ])
    expect(thenClosed.state.health).toEqual({
      color: "red",
      reason: `stopped: the frame budget of ${Projection.defaultMaxFrames} is exhausted`
    })
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
    expect(Projection.classifyTitle("classify/triage/relevance", { task: "t" }, verdict, 5)).toBe(
      "triage/relevance · 1 state · 3 questions · 212 ms"
    )
    expect(Projection.toolMetadata("classify", verdict)).toEqual({ answers: [verdict.answers], result: verdict })
    const batch = {
      results: [
        { ok: true, state: 1, answers: { yes: { value: false, probability: 0.2 } }, confidence: { yes: 0.6 } },
        { ok: false, state: 2, error: { code: "timeout", message: "slow" } },
        "junk"
      ]
    }
    expect(Projection.classifyOutput(batch)).toBe("1. yes: no (0.80)\n2. timeout: slow\n3. failed: ")
    // A batch times itself, so the card says what the judging took. Before
    // the batch carried its own clock the only number was the gap between the
    // call's start and its settle, which the harness publishes in one tick,
    // and every batched card read about 1 ms.
    expect(Projection.classifyTitle("classify", { states: [1, 2, 3], questions: { yes: {} } }, {
      ...batch,
      latencyMs: 641
    }, 1)).toBe("ad hoc · 3 states · 1 question · 641 ms")
    // A batch from a journal written before it did falls back to the gap.
    expect(Projection.classifyTitle("classify", { states: [1, 2, 3], questions: { yes: {} } }, batch, 40)).toBe(
      "ad hoc · 3 states · 1 question · 40 ms"
    )
    // No answered state: the question count comes from the input.
    const refused = { results: [{ ok: false, state: 1, error: { code: "unreachable", message: "no key" } }] }
    expect(Projection.classifyTitle("classify", { states: [1], questions: { a: {}, b: {} } }, refused, 7)).toBe(
      "ad hoc · 1 state · 2 questions · 7 ms"
    )
    expect(Projection.classifyTitle("classify", {}, refused, 7)).toBe("ad hoc · 1 state · 0 questions · 7 ms")
    expect(Projection.classifyTitle("classify", {}, "text", 3)).toBe("ad hoc · 1 state · 0 questions · 3 ms")
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
      title: "triage/relevance · 1 state · 3 questions · 212 ms",
      output: "1. relevant: yes (0.93) · role: implementation (0.81) · risk: none (0.62)"
    })
    expect(completed.state.status === "completed" && completed.state.metadata["answers"]).toEqual([
      completed.state.status === "completed" && (completed.state.metadata["result"] as { answers: unknown }).answers
    ])
    // Two frames ran twice (the park replays frame zero and one): the summary
    // counts each once. Four Jev calls: the classify call, and the three
    // health evaluations the fold asked for (frame zero's settle, the park,
    // frame one's settle), counted where they are asked.
    expect(state.summary).toMatchObject({ frames: 2, classifyCalls: 1, jevCalls: 4, jevLatencyMs: 212, jevCost: 0 })
    expect(state.summary.calls).toBe(4)
    expect(state.facts.lastCalls.map((call) => call.flow)).toContain("classify/triage/relevance")
    expect(state.facts.lastCalls.map((call) => call.ok)).toContain(true)
    expect(state.facts.lastPrints).toContain("total 16")
    // The replayed demand is the same demand: issued once, listed once.
    expect(state.facts.demands).toEqual(["read-only"])
    expect(state.facts.lastTransition).toBe("complete")
    const summaryID = Ids.part(assistantMessageID, {
      frame: Projection.finalFrame,
      slot: Projection.summarySlot,
      ordinal: 0
    })
    const summary = parts.find((part): part is Protocol.TextPart => part.type === "text" && part.id === summaryID)!
    expect(summary.text).toBe("2 frames · 4 calls · 1 classify · Jev 4 calls · 212 ms · $0.0000")
    expect(summary.id).toBe(
      Ids.part(assistantMessageID, { frame: Projection.finalFrame, slot: Projection.summarySlot, ordinal: 0 })
    )
  })

  it("hands out health facts on a settled cell, a park, and a resume, and folds decisions in", () => {
    const ctx = { directory, now: clock().now, maxFrames: 8 }
    let step = Projection.open(ctx, opened())
    expect(step.state.health).toBeUndefined()
    // The budget the engine arms replaces the one the host was told.
    expect(step.state.facts.maxFrames).toBe(8)
    const armed = Projection.fold(
      ctx,
      step.state,
      new AgentEvents.DisciplineArmed({
        eventType: "flows.harness.discipline-armed.v1",
        readOnlyCap: 3,
        maxFrames: 7,
        approvalChannel: true,
        modelCallMs: 1000,
        repeatCap: 3,
        narrowingCap: 3,
        unmovedCap: 0,
        revalidations: 1,
        unresolvedCap: 3
      })
    )
    expect(armed.events).toEqual([])
    expect(armed.state.facts.maxFrames).toBe(7)
    const triggers: Array<Health.Facts> = []
    for (const event of scriptEvents()) {
      step = Projection.fold(ctx, step.state, event)
      if (step.health !== undefined) triggers.push(step.health)
    }
    // Frame zero settled, frame one parked, then the resume: the journal
    // replays frame zero, which hands out nothing (it settled before), and
    // frame one settles for the first time, under its own frame, with the
    // demand that was in force when it parked.
    expect(triggers.map((facts) => [facts.frame, facts.parked, facts.demandThisFrame])).toEqual([
      [1, "none", false],
      [2, "permission", true],
      [2, "none", true]
    ])
    expect(triggers[0]).toMatchObject({
      task: "Read package.json and tell me the name field.",
      maxFrames: 8,
      framesSinceEdit: 1
    })
    // Two frames read only: the replayed frame zero is not counted again,
    // its calls are not listed again, and its demand is not issued again.
    expect(triggers[2]!.framesSinceEdit).toBe(2)
    expect(triggers[2]!.lastCalls.map((call) => call.flow)).toEqual(["read", "ls", "classify/triage/relevance", "bash"])
    expect(triggers[2]!.demands).toEqual(["read-only"])
    expect(step.state.facts.framesSinceEdit).toBe(2)

    // A decision: the dot lands on the title, the card carries the reason and the answers.
    const evaluation: Health.Evaluation = {
      decision: { color: "yellow", reason: "read-only demanded" },
      answers: undefined,
      latencyMs: 30,
      usage: { inputTokens: 1000, outputTokens: 0 },
      error: undefined,
      code: undefined,
      answered: true
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
    // The call was counted where it was asked, not here: folding its answer
    // adds the time it took and what it cost.
    expect(first.state.summary).toMatchObject({ jevCalls: 0, jevLatencyMs: 30 })
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
    const green = Projection.health(ctx, same.state, triggers[2]!, {
      ...evaluation,
      decision: { color: "green", reason: "done" }
    })
    expect((green.events[0]!.properties["info"] as Protocol.Session).title.startsWith("🟢 ")).toBe(true)
    expect((green.events[1]!.properties["part"] as Protocol.ToolPart).callID).toBe("health_1")
    expect((green.events[1]!.properties["part"] as Protocol.ToolPart).id).toBe(
      Ids.part(assistantMessageID, { frame: 1, slot: Projection.slots.health, ordinal: 1 })
    )
    // An evaluation that never reached the gateway adds no time: the totals
    // stay, and the card says why there is no answer.
    const refused = Projection.health(ctx, green.state, triggers[2]!, {
      decision: { color: "gray", reason: "health unavailable" },
      answers: undefined,
      latencyMs: 2,
      usage: undefined,
      error: "unreachable: set AI_GATEWAY_API_KEY",
      code: "unreachable",
      answered: false
    })
    expect(refused.state.summary.jevLatencyMs).toBe(green.state.summary.jevLatencyMs)
    expect((refused.events[1]!.properties["part"] as Protocol.ToolPart).state).toMatchObject({
      title: "health unavailable",
      output: "unreachable: set AI_GATEWAY_API_KEY"
    })
    // A decision that reaches a closed turn changes nothing.
    const closed = Projection.close(ctx, green.state, { _tag: "interrupted" })
    expect(Projection.health(ctx, closed.state, triggers[0]!, evaluation).events).toEqual([])
    // A follow-up turn starts from the color the title carries.
    const next = Projection.open(ctx, { ...opened(), session: { ...session, title: "🟢 Kept" } })
    expect(next.state.health).toEqual({ color: "green", reason: "" })
    expect((next.events[2]!.properties["info"] as Protocol.Session).title).toBe("🟢 Kept")
  })

  it("keeps the color a finished session earned: the reply clears the park and the answer decides last", () => {
    const ctx = { directory, now: clock().now, maxFrames: 8 }
    const events = scriptEvents()
    let step = Projection.open(ctx, opened())
    const triggers: Array<Health.Facts> = []
    for (const event of events) {
      step = Projection.fold(ctx, step.state, event)
      if (step.health !== undefined) triggers.push(step.health)
    }
    // The live drive's three red sessions: the permission was answered, the
    // run finished, and `parked` was still "permission" on the facts, so
    // every later decision short-circuited red before it read an answer.
    let parked = Projection.open(ctx, opened()).state
    for (const event of events) {
      parked = Projection.fold(ctx, parked, event).state
      if (event._tag === "permission-required") break
    }
    expect(parked.facts.parked).toBe("permission")
    const answered = Projection.replied(parked)
    expect(answered.state.facts.parked).toBe("none")
    expect(answered.events).toEqual([])
    expect(answered.health).toMatchObject({ parked: "none", frame: 2 })
    // A reply to a session that is not parked asks nothing and changes nothing.
    expect(Projection.replied(answered.state).state).toBe(answered.state)
    expect(Projection.replied(answered.state).health).toBeUndefined()

    // The answers the last evaluation gave decide the turn's final color, so
    // a finished run ends on the color its last state earned rather than on
    // whatever it was parked on.
    const evaluation: Health.Evaluation = {
      decision: { color: "red", reason: "waiting for approval" },
      answers: {
        progress: { value: 4, label: "done", probabilities: { done: 0.89 }, confidence: 0.89 },
        stuck: { value: true, probability: 0.69 },
        needsHuman: { value: false, probability: 0.12 }
      },
      latencyMs: 300,
      usage: { inputTokens: 900, outputTokens: 0 },
      error: undefined,
      code: undefined,
      answered: true
    }
    let judged = Projection.open(ctx, opened())
    const decided = Projection.health(ctx, judged.state, triggers[0]!, evaluation)
    expect(decided.state.health?.color).toBe("red")
    expect(decided.state.answers).toBe(evaluation.answers)
    let finishing = decided.state
    for (const event of events) finishing = Projection.fold(ctx, finishing, event).state
    expect(finishing.closed).toBe(true)
    expect(finishing.health).toEqual({ color: "green", reason: "done" })
    expect(finishing.session.title.startsWith("🟢 ")).toBe(true)
    // The final decision is the rule re-read over the turn's own last facts,
    // not another gateway call: the three health evaluations the fold asked
    // for and the one classify call, and nothing for the last reading.
    expect(finishing.summary.jevCalls).toBe(4)
    // A turn nothing ever judged still ends with a color, because the rule
    // has one without Jev: the harness handed a completion back, nothing is
    // parked and no demand is outstanding. It says `answered` rather than the
    // `done` nobody said.
    judged = Projection.open(ctx, opened())
    let unjudged = judged.state
    for (const event of events) unjudged = Projection.fold(ctx, unjudged, event).state
    expect(unjudged.health).toEqual({ color: "green", reason: Health.answeredReason })
    expect(unjudged.session.title.startsWith("🟢 ")).toBe(true)
  })

  it("counts every Jev call the run made: the health evaluations, the classify calls, and the completion brake", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    const frame = Projection.fold(ctx, start.state, scriptEvents()[0]!)
    // The brake asks Jev once per completion attempt and reports how long it
    // took. It is the run's most expensive question and the footer used to
    // leave it out entirely.
    const read = (demanded: boolean, nextFrame: number) =>
      new AgentEvents.ClaimDemanded({
        eventType: "flows.harness.claim-demanded.v1",
        complete: 0.9,
        overclaims: 0.1,
        invented: 0.05,
        latencyMs: 412,
        usage: { inputTokens: 10_000, outputTokens: 0 },
        demanded,
        currentDigest: "d",
        nextFrame
      })
    const passed = Projection.fold(ctx, frame.state, read(false, 1))
    expect(passed.events).toEqual([])
    expect(passed.state.summary).toMatchObject({ jevCalls: 1, jevLatencyMs: 412 })
    expect(passed.state.summary.jevCost).toBeCloseTo(0.00042, 8)
    // The journal replays the same reading after a park: one call, counted once.
    const replayed = Projection.fold(ctx, passed.state, read(false, 1))
    expect(replayed.state.summary).toMatchObject({ jevCalls: 1, jevLatencyMs: 412 })
    expect(replayed.state.summary.jevCost).toBeCloseTo(0.00042, 8)
    const handedBack = Projection.fold(ctx, replayed.state, read(true, 2))
    expect(handedBack.state.summary).toMatchObject({ jevCalls: 2, jevLatencyMs: 824 })
    expect(handedBack.state.summary.jevCost).toBeCloseTo(0.00084, 8)
    expect(handedBack.state.facts.demands).toEqual(["claim"])
    // Every health evaluation is counted where the fold asks for it, so a slow
    // answer that lands after the turn ended is still one of the calls the
    // footer reports: a live drive's footer said three where the gateway log
    // said four.
    let settling = handedBack.state
    let asked: Projection.Step = handedBack
    for (const event of scriptEvents()) {
      asked = Projection.fold(ctx, settling, event)
      settling = asked.state
      if (asked.health !== undefined) break
    }
    const settled = asked
    expect(settled.health).toBeDefined()
    // The two brake readings, the classify call the demo cell makes, and the
    // health evaluation this settlement asked for.
    expect(settled.state.summary.jevCalls).toBe(4)
    // A gateway that answered 401 took the call, so its time is the run's: the
    // turn that failed on it used to print "Jev 0 calls · 0 ms".
    const refused = Projection.health(ctx, settled.state, settled.health!, {
      decision: { color: "gray", reason: "health unavailable: The gateway answered 401" },
      answers: undefined,
      latencyMs: 96,
      usage: undefined,
      error: "refused: The gateway answered 401",
      code: "refused",
      answered: true
    })
    expect(refused.state.summary.jevCalls).toBe(4)
    expect(refused.state.summary.jevLatencyMs).toBe(settled.state.summary.jevLatencyMs + 96)
    expect(refused.state.summary.jevCost).toBe(settled.state.summary.jevCost)
    expect(refused.state.answers).toBeUndefined()
    // A request that never reached the gateway spent no time there.
    const unreachable = Projection.health(ctx, refused.state, settled.health!, {
      decision: { color: "gray", reason: Health.noGatewayKey },
      answers: undefined,
      latencyMs: 1,
      usage: undefined,
      error: `unreachable: ${Health.noGatewayKey}`,
      code: "unreachable",
      answered: false
    })
    expect(unreachable.state.summary.jevCalls).toBe(4)
    expect(unreachable.state.summary.jevLatencyMs).toBe(refused.state.summary.jevLatencyMs)
  })

  it("ends a run the harness killed red, naming the rule that killed it, live and on a reload", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    /** The closing the driver builds from a harness failure, the way the sink hands it over. */
    const killed = (code: HarnessError["code"], message: string): Projection.Closing => {
      const outcome = EngineDriver.failedOutcome(
        "cerebras:gpt-oss-120b",
        Cause.fail(new HarnessError({ code, message }))
      )
      if (outcome._tag !== "failed") throw new Error(`the driver reported ${outcome._tag}`)
      return outcome
    }
    const dotOf = (step: Projection.Step): string =>
      (step.events[0]!.properties["info"] as Protocol.Session).title.slice(0, 2).trim()
    const cardOf = (step: Projection.Step): string => {
      const state = (step.events[1]!.properties["part"] as Protocol.ToolPart).state
      return state.status === "completed" ? state.title : `the health card is ${state.status}`
    }
    // The measured lie: a claim the brake refused left the session idle under
    // a gray dot reading `failed`, which is the same dot a missing gateway key
    // writes. The operator read "Jev was down" over a run Jev had stopped.
    const unproven = Projection.close(
      ctx,
      start.state,
      killed(
        "claim_unproven",
        "A completion the run's own record does not support (overclaimed): complete 0.08, overclaims 0.89."
      )
    )
    expect([dotOf(unproven), cardOf(unproven)]).toEqual(["🔴", "stopped: the run reported work it never recorded"])
    expect(unproven.state.facts.endedBy).toEqual({ code: "claim_unproven" })
    // The words are still the header's, verbatim, so the sentence a person
    // acts on is not paraphrased by the dot.
    const header = unproven.events.find((event) =>
      event.type === "message.updated" && (event.properties["info"] as Protocol.Message).role === "assistant"
    )!.properties["info"] as Protocol.AssistantMessage
    expect(header.error?.data.message).toContain("complete 0.08, overclaims 0.89")
    // Every other rule the harness stops a run on reads the same way.
    const cap = Projection.close(ctx, start.state, killed("read_only_cap", "12 frames, no write"))
    expect([dotOf(cap), cardOf(cap)]).toEqual(["🔴", "stopped: the run read for too many frames without writing"])
    const unjudged = Projection.close(ctx, start.state, killed("completion_unjudged", "The gateway answered 503"))
    expect([dotOf(unjudged), cardOf(unjudged)]).toEqual(["🔴", "stopped: nothing could judge the completion"])
    // A body that failed with nothing typed in it is still a run that is over.
    const bare = Projection.close(ctx, start.state, { _tag: "failed", message: "boom" })
    expect([dotOf(bare), cardOf(bare)]).toEqual(["🔴", "stopped: the turn failed"])
    // A reload reads the dot back off the facts, so the stream and the
    // history agree about a session nobody is watching any more.
    expect(Health.decide(unproven.state.facts, undefined)).toEqual({
      color: "red",
      reason: "stopped: the run reported work it never recorded"
    })
    // The operator's own Stop stays gray: nothing about it is theirs to fix.
    const stopped = Projection.close(ctx, start.state, { _tag: "interrupted" })
    expect([dotOf(stopped), cardOf(stopped)]).toEqual(["⚪", "interrupted"])
  })

  it("ends a run its frame budget ended red, and a run that finished on its last frame green", () => {
    const ctx = { directory, now: clock().now, maxFrames: 2 }
    const opening = Projection.open(ctx, opened())
    /** One frame, then the transition the run applied, then the turn's close. */
    const drive = (transition: Cell.Transition): Projection.State => {
      let state = opening.state
      for (
        const event of [
          scriptEvents()[0]!,
          new AgentEvents.TransitionApplied({ eventType: "flows.harness.transition-applied.v1", transition }),
          new AgentEvents.TurnClosed({
            eventType: "flows.harness.turn-closed.v1",
            stopReason: "stop",
            outcome: "resolved"
          }),
          new AgentEvents.Resolved({
            eventType: "flows.harness.resolved.v1",
            message: ModelRequest.Message.assistant("whatever the harness handed back", { stopReason: "stop" })
          })
        ]
      ) state = Projection.fold(ctx, state, event).state
      return state
    }
    // The measured lie: the budget notice is the whole answer, and the dot
    // was green over it because the final reading forced `lastTransition` to
    // `complete`. The run answered nothing.
    const spent = drive(new Cell.Continue({}))
    expect(Projection.budgetEnded(spent)).toBe(true)
    expect(spent.health).toEqual({ color: "red", reason: "stopped: the frame budget of 2 is exhausted" })
    expect(spent.session.title.startsWith("🔴 ")).toBe(true)
    expect(spent.facts.endedBy).toEqual({ code: Health.frameBudget, maxFrames: 2 })
    // The same frame count, the same notice-shaped answer, and a run that
    // did say it was done: green, because the difference is the transition
    // and not the sentence.
    const finished = drive(new Cell.Complete({ output: "the name field is smithers" }))
    expect(Projection.budgetEnded(finished)).toBe(false)
    expect(finished.health).toEqual({ color: "green", reason: Health.answeredReason })
    // The loop also checks the budget at the top of a frame, where it emits
    // the answer and returns without closing the turn. The body then exits
    // `completed` and the sink closes it with a fixed sentence, which is a
    // spent budget and not a failure.
    let atTop = opening.state
    for (
      const event of [
        scriptEvents()[0]!,
        new AgentEvents.Resolved({
          eventType: "flows.harness.resolved.v1",
          message: ModelRequest.Message.assistant("The frame budget of 2 is exhausted.", { stopReason: "stop" })
        })
      ]
    ) atTop = Projection.fold(ctx, atTop, event).state
    expect(atTop.closed).toBe(false)
    const closed = Projection.close(ctx, atTop, { _tag: "failed", message: "The turn ended without an answer" })
    expect(closed.state.health).toEqual({ color: "red", reason: "stopped: the frame budget of 2 is exhausted" })
  })

  it("names what ended a turn that was already red, on the resolve and on the close", () => {
    const ctx = { directory, now: clock().now, maxFrames: 2 }
    /** The reason every `health` card a step emitted carries. */
    const reasons = (step: Projection.Step): Array<string> =>
      step.events.flatMap((event) => {
        if (event.type !== "message.part.updated") return []
        const part = event.properties["part"] as Protocol.Part
        return part.type === "tool" && part.tool === "health" && part.state.status === "completed"
          ? [String(part.state.metadata["reason"])]
          : []
      })
    /** A turn parked on a permission: red, reading the park, which is what the live drive left. */
    const parked = (): Projection.State => {
      let state = Projection.open(ctx, opened()).state
      for (
        const event of [
          scriptEvents()[0]!,
          new AgentEvents.PermissionRequired({
            eventType: "flows.harness.permission-required.v1",
            request: DemoScript.script({ sessionID, messageID: assistantMessageID, prompt: "p" }).segments
              .flatMap((segment) => segment._tag === "permission" ? [segment.request] : [])[0]!
          })
        ]
      ) state = Projection.fold(ctx, state, event).state
      return Projection.decided(ctx, state, { color: "red", reason: "waiting for approval" }, undefined).state
    }
    expect(parked().health).toEqual({ color: "red", reason: "waiting for approval" })
    // The budget runs out while the card is open. The dot stays red, which is
    // right, and the reason must say what ended the run and not what it was
    // waiting for: the card is gone and nobody is being waited on.
    let spending = parked()
    let resolved: Projection.Step = { state: spending, events: [] }
    for (
      const event of [
        new AgentEvents.TransitionApplied({
          eventType: "flows.harness.transition-applied.v1",
          transition: new Cell.Continue({})
        }),
        new AgentEvents.TurnClosed({
          eventType: "flows.harness.turn-closed.v1",
          stopReason: "stop",
          outcome: "resolved"
        }),
        new AgentEvents.Resolved({
          eventType: "flows.harness.resolved.v1",
          message: ModelRequest.Message.assistant("The frame budget of 2 is exhausted.", { stopReason: "stop" })
        })
      ]
    ) {
      resolved = Projection.fold(ctx, spending, event)
      spending = resolved.state
    }
    expect(reasons(resolved)).toEqual(["stopped: the frame budget of 2 is exhausted"])
    // The same short-circuit masked every other terminal reason a red turn
    // could end on: a seat out of quota, and a harness that stopped the run.
    const quota = Projection.close(ctx, parked(), {
      _tag: "failed",
      message: "out of quota",
      provider: { seat: "cerebras:gpt-oss-120b", providerID: "cerebras", code: "quota_exceeded", message: "no quota" }
    })
    expect(reasons(quota)).toEqual(["stopped: cerebras:gpt-oss-120b is out of quota"])
    const refused = Projection.close(ctx, parked(), {
      _tag: "failed",
      message: "the run reported work it never recorded",
      harness: { code: "claim_unproven" }
    })
    expect(reasons(refused)).toEqual(["stopped: the run reported work it never recorded"])
  })

  it("gives a turn that finishes in one frame a color, because a resolved turn needs no answers to have one", () => {
    const ctx = { directory, now: clock().now }
    let state = Projection.open(ctx, opened()).state
    for (
      const event of [
        scriptEvents()[0]!,
        new AgentEvents.TransitionApplied({
          eventType: "flows.harness.transition-applied.v1",
          transition: new Cell.Complete({ output: "smithers" })
        }),
        new AgentEvents.TurnClosed({
          eventType: "flows.harness.turn-closed.v1",
          stopReason: "stop",
          outcome: "resolved"
        }),
        new AgentEvents.Resolved({
          eventType: "flows.harness.resolved.v1",
          message: ModelRequest.Message.assistant("smithers", { stopReason: "stop" })
        })
      ]
    ) state = Projection.fold(ctx, state, event).state
    // The turn ends before the frame's evaluation ever answers, so there are
    // no answers to read. It used to keep no dot at all, which an operator
    // cannot read as anything.
    expect(state.answers).toBeUndefined()
    expect(state.closed).toBe(true)
    expect(state.health).toEqual({ color: "green", reason: "answered" })
    expect(state.session.title.startsWith("🟢 ")).toBe(true)
  })

  it("shows that a read-only demand can be answered by completing the current request", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, { ...opened(), prompt: "Reply with only the letter A." })
    const step = Projection.fold(
      ctx,
      start.state,
      new AgentEvents.ReadOnlyDemandIssued({
        eventType: "flows.harness.read-only-demand-issued.v1",
        streak: 6,
        cap: 6,
        nextFrame: 6
      })
    )
    const card = step.events[0]!.properties["part"] as Protocol.ToolPart
    if (card.state.status !== "completed") throw new Error(`the demand card is ${card.state.status}`)
    expect(card.state.title).toBe("read-only · 6/6")
    expect(card.state.output).toContain("If the request is already answerable, complete it")
    expect(card.state.output).toContain("without inventing edits or commands")
    expect(card.state.output).toContain("Otherwise make the required change or justify more reading")
    expect(card.state.output).not.toContain("must write")
  })

  it("reviews an answer-only completion without alleging unrecorded work when invented is low", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, { ...opened(), prompt: "Reply with only the letter A." })
    const frame = Projection.fold(ctx, start.state, scriptEvents()[0]!)
    const completed = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Complete({ output: "A" })
      })
    )
    // These are the actual readings on the answer-only request in the live
    // browser trace. The demand must not turn low completion into an
    // allegation that a command or result was invented.
    const bounced = Projection.fold(
      ctx,
      completed.state,
      new AgentEvents.ClaimDemanded({
        eventType: "flows.harness.claim-demanded.v1",
        complete: 0.27,
        overclaims: 0.20,
        invented: 0.14,
        latencyMs: 412,
        demanded: true,
        currentDigest: "d",
        nextFrame: 1
      })
    )
    const card = bounced.events[0]!.properties["part"] as Protocol.ToolPart
    if (card.state.status !== "completed") throw new Error(`the demand card is ${card.state.status}`)
    expect(card.state.title).toBe("claim · invented 0.14 (complete 0.27, overclaims 0.20)")
    expect(card.state.output).toContain("Completion review")
    expect(card.state.output).toContain("current request")
    expect(card.state.output).toContain("requested format")
    expect(card.state.output).toContain("A purely conversational answer needs no file edit, command, or check")
    expect(card.state.output).not.toContain("Unrecorded claim")
    expect(card.state.output).not.toContain("this completion reports a command")
    expect(card.state.output).toMatch(/The completion this demand handed back:\n\nA$/)
  })

  it("puts the completion the brake refused in the transcript, under the three probabilities it read", () => {
    const ctx = { directory, now: clock().now }
    const start = Projection.open(ctx, opened())
    const frame = Projection.fold(ctx, start.state, scriptEvents()[0]!)
    const answer = "The name field is smithers-orchestrator. I read it out of package.json."
    const completed = Projection.fold(
      ctx,
      frame.state,
      new AgentEvents.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Complete({ output: answer })
      })
    )
    expect(completed.state.lastCompletion).toBe(answer)
    const bounced = Projection.fold(
      ctx,
      completed.state,
      new AgentEvents.ClaimDemanded({
        eventType: "flows.harness.claim-demanded.v1",
        complete: 0.21,
        overclaims: 0.96,
        invented: 0.94,
        latencyMs: 412,
        demanded: true,
        currentDigest: "d",
        nextFrame: 1
      })
    )
    const card = bounced.events[0]!.properties["part"] as Protocol.ToolPart
    const state = card.state
    if (state.status !== "completed") throw new Error(`the demand card is ${state.status}`)
    // The card used to be titled `claim` and nothing else, and a collapsed
    // card is its title: the only mark the brake left was one word. `invented`
    // leads because it can refuse the completion after its review allowance.
    expect(state.title).toBe("claim · invented 0.94 (complete 0.21, overclaims 0.96)")
    expect(state.input["description"]).toBe("claim · invented 0.94 (complete 0.21, overclaims 0.96)")
    // And the answer it refused was only ever in opencode.sqlite, so a
    // correct answer the brake bounced was gone as far as a person was
    // concerned. It is in the transcript now, word for word.
    expect(state.output).toContain(answer)
    expect(state.output).toContain("Completion review")
    // A reading that let the completion through writes no card at all.
    expect(
      Projection.fold(
        ctx,
        completed.state,
        new AgentEvents.ClaimDemanded({
          eventType: "flows.harness.claim-demanded.v1",
          complete: 0.9,
          overclaims: 0.1,
          invented: 0.05,
          latencyMs: 4,
          demanded: false,
          currentDigest: "d",
          nextFrame: 1
        })
      ).events
    ).toEqual([])
    // A demand with no completion behind it says the same thing without one.
    expect(Projection.claimText(undefined)).not.toContain("handed back")
  })

  it("keeps the color the run had when one health deadline is missed, and goes gray when three are", () => {
    const ctx = { directory, now: clock().now }
    const facts: Health.Facts = { ...Projection.open(ctx, opened()).state.facts, frame: 1 }
    const evaluation = (extra: Partial<Health.Evaluation> = {}): Health.Evaluation => ({
      decision: { color: "green", reason: "progressing" },
      answers: undefined,
      latencyMs: 40,
      usage: undefined,
      error: undefined,
      code: undefined,
      answered: true,
      ...extra
    })
    const timedOut = evaluation({
      decision: { color: "gray", reason: "health unavailable: Health did not answer within 1500 ms" },
      error: "timeout: Health did not answer within 1500 ms",
      code: "timeout",
      answered: false
    })
    const green = Projection.health(ctx, Projection.open(ctx, opened()).state, facts, evaluation())
    expect(green.state.health?.color).toBe("green")
    // The measured flicker: one call over its deadline in four of sixteen
    // turns repainted a working run gray, which reads as "health is
    // unavailable" over a run that was fine. The measurement is missing, the
    // color the run had is not.
    const missedOnce = Projection.health(ctx, green.state, facts, timedOut)
    expect(missedOnce.events).toEqual([])
    expect(missedOnce.state.health?.color).toBe("green")
    expect(missedOnce.state.missedDeadlines).toBe(1)
    const missedTwice = Projection.health(ctx, missedOnce.state, facts, timedOut)
    expect(missedTwice.events).toEqual([])
    expect(missedTwice.state.missedDeadlines).toBe(2)
    // Three in a row is not a blip, and the dot says exactly that rather than
    // keeping a color nothing has confirmed for three frames.
    const missedThrice = Projection.health(ctx, missedTwice.state, facts, timedOut)
    expect(missedThrice.state.health).toEqual({
      color: "gray",
      reason: "health unavailable: Jev missed its 1500 ms deadline 3 times running"
    })
    // An answer clears the streak.
    const answered = Projection.health(ctx, missedThrice.state, facts, evaluation())
    expect(answered.state.missedDeadlines).toBe(0)
    expect(answered.state.health?.color).toBe("green")
    // Every other transport failure is the gateway saying it cannot serve
    // this, which is unavailability, and paints gray on the first one.
    const refused = Projection.health(
      ctx,
      answered.state,
      facts,
      evaluation({
        decision: { color: "gray", reason: "health unavailable: The gateway answered 401" },
        error: "refused: The gateway answered 401",
        code: "refused"
      })
    )
    expect(refused.state.health?.color).toBe("gray")
    // A deadline missed before anything ever decided has no color to keep.
    const first = Projection.health(ctx, Projection.open(ctx, opened()).state, facts, timedOut)
    expect(first.state.health?.color).toBe("gray")
  })

  it("adopts the stored title and archive stamp, and nothing else", () => {
    const ctx: Projection.Context = { directory, now: clock().now }
    const { state } = Projection.open(ctx, opened())
    // The store holds what the turn wrote: nothing to adopt, the same state.
    expect(Projection.adopt(state, { ...state.session, tokens: { ...Protocol.noTokens, input: 9 } })).toBe(state)
    // A rename: the title, and only the title.
    const renamed = Projection.adopt(state, { ...state.session, title: "🔴 Renamed", cost: 5 })
    expect(renamed.session).toEqual({ ...state.session, title: "🔴 Renamed" })
    expect(Projection.sessionNow(renamed, 2000).title).toBe("🔴 Renamed")
    // A decision after the rename dots the new title, once.
    const marked = Projection.decided(ctx, renamed, { color: "green", reason: "ok" }, undefined)
    expect(marked.state.session.title).toBe("🟢 Renamed")
    // An archive: the stamp lands, the title loses its dot on the next decision.
    const archived = Projection.adopt(marked.state, {
      ...marked.state.session,
      title: "Renamed",
      time: { ...marked.state.session.time, archived: 1234 }
    })
    expect(archived.session.time.archived).toBe(1234)
    expect(archived.session.title).toBe("Renamed")
    const still = Projection.decided(ctx, archived, { color: "red", reason: "stuck" }, undefined)
    expect(still.state.session.title).toBe("Renamed")
    expect(still.state.session.time.archived).toBe(1234)
    // An un-archive: the stamp goes.
    const restored = Projection.adopt(still.state, { ...still.state.session, time: { created: 1000, updated: 1000 } })
    expect(restored.session.time).not.toHaveProperty("archived")
    expect(restored.session.time).toEqual({ created: 1000, updated: still.state.session.time.updated })
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
    // The park replays both frames; the cost counts each frame once.
    expect(state.cost).toBeCloseTo(((812 + 1240) * 1 + (96 + 88) * 2) / 1_000_000)
    const sessions = emitted.filter((event) => event.type === "session.updated")
      .map((event) => event.properties["info"] as Protocol.Session)
    // Every model settlement updates the session's tokens and cost.
    expect(sessions.length).toBeGreaterThanOrEqual(5)
    expect(sessions[sessions.length - 1]!.cost).toBeCloseTo(state.cost)
    expect(sessions[sessions.length - 1]!.tokens.input).toBe(812 + 1240)
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
      title: "ad hoc · 2 states"
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
