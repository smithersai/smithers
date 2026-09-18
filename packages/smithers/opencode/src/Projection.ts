/**
 * The pure fold from harness `AgentEvent`s to OpenCode v1 events.
 *
 * One turn is one assistant message. Each frame opens a `step-start` part,
 * streams the model's prose into a `reasoning` part, renders the cell the
 * model wrote as a `cell` tool part whose output is what the cell printed,
 * renders every `ctx.call` as a tool part named after the flow (`ls` as
 * `list`, so OpenCode's rich cards apply), and closes with a `step-finish`
 * part carrying the frame's tokens. A discipline demand is a `demand` tool
 * part. A permission park is `permission.asked`. `Resolved` streams the
 * final answer as a text part and ends the turn: the assistant header gets
 * its finish, the session its tokens, and the status goes idle.
 *
 * Every part id is derived from the assistant message and a sort key
 * (`Ids.part`), so a frame replayed after a park names the same parts and
 * the app updates cards instead of duplicating them. That is also why a
 * park resets the frame counter: the engine re-drives the turn from frame
 * zero and the journal replays what settled.
 *
 * The fold is total. It never throws, and an event it does not understand
 * changes nothing, because the stream consumer runs inside the frame and a
 * projection error would fail the run (composition brief, trap 7).
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type { Schema } from "effect"
import { basename, isAbsolute, join } from "node:path"
import * as Ids from "./Ids.ts"
import * as Protocol from "./Protocol.ts"

/**
 * What the fold needs from its host.
 *
 * @category models
 * @since 1.0.0
 */
export interface Context {
  readonly directory: string
  readonly now: () => number
}

/**
 * What opens a turn.
 *
 * @category models
 * @since 1.0.0
 */
export interface Opened {
  readonly session: Protocol.Session
  readonly userMessageID: string
  readonly assistantMessageID: string
  readonly prompt: string
  readonly agent: string
  readonly model: Protocol.ModelRef
  /** When the assistant message was first created; now, unless a re-opened turn says otherwise. */
  readonly createdAt?: number | undefined
}

/**
 * How a turn ended when no event said so: the driver body's exit.
 *
 * @category models
 * @since 1.0.0
 */
export type Closing =
  | { readonly _tag: "interrupted" }
  | { readonly _tag: "failed"; readonly message: string }

interface CallCard {
  readonly partID: string
  readonly callID: string
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly start: number
}

/**
 * The fold's state between events.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
  readonly session: Protocol.Session
  readonly userMessageID: string
  readonly assistantMessageID: string
  readonly agent: string
  readonly model: Protocol.ModelRef
  readonly createdAt: number
  /** The current frame, zero-based; minus one before the first `turn-opened`. */
  readonly frame: number
  readonly tokens: Protocol.Tokens
  readonly frameTokens: Protocol.Tokens
  readonly reasoning: { readonly partID: string; readonly text: string; readonly start: number } | undefined
  readonly cell:
    | {
      readonly partID: string
      readonly callID: string
      readonly source: string
      readonly calls: number
      readonly edits: number
      readonly start: number
      readonly prints: string
    }
    | undefined
  readonly calls: Readonly<Record<string, CallCard>>
  readonly demandText: Readonly<Record<string, string>>
  /** Whether `resolved` has been folded: the answer is in the timeline. */
  readonly answered: boolean
  /** Whether the frame closed as resolved: the step is finished. */
  readonly resolving: boolean
  readonly closed: boolean
}

/**
 * The fold's answer: the next state and the events to store and publish, in
 * order.
 *
 * @category models
 * @since 1.0.0
 */
export interface Step {
  readonly state: State
  readonly events: ReadonlyArray<Protocol.Emitted>
}

/**
 * The slots a part can occupy inside a frame, in sort order.
 *
 * @category constants
 * @since 1.0.0
 */
export const slots = {
  stepStart: 0x00,
  reasoning: 0x01,
  cell: 0x02,
  call: 0x10,
  demand: 0xe0,
  stepFinish: 0xff
} as const

/**
 * The frame key the final answer sorts under: after every real frame.
 *
 * @category constants
 * @since 1.0.0
 */
export const finalFrame = 0xffff

/**
 * The tool name a flow renders as. `ls` becomes `list`; every other flow
 * keeps its name, which is what OpenCode's cards for `read`, `edit`, `write`,
 * `bash`, `grep`, `glob` and `apply_patch` expect.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolName = (flowName: string): string => flowName === "ls" ? "list" : flowName

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

/**
 * The input OpenCode's card for a flow reads, from the input the cell wrote.
 * Paths become absolute because the cards relativize them to the project.
 *
 * @param directory the served directory
 * @param flowName the flow the cell called
 * @param input the call input as the cell wrote it
 * @category conversions
 * @since 1.0.0
 */
export const toolInput = (directory: string, flowName: string, input: Schema.Json): Record<string, unknown> => {
  const raw: Record<string, unknown> = isRecord(input) ? input : { input }
  const absolute = (value: unknown): string => {
    const path = asString(value) ?? "."
    return isAbsolute(path) ? path : join(directory, path)
  }
  const optional = (key: string, value: unknown): Record<string, unknown> => value === undefined ? {} : { [key]: value }
  switch (flowName) {
    case "read":
      return {
        filePath: absolute(raw["path"]),
        ...optional("offset", raw["offset"]),
        ...optional("limit", raw["limit"])
      }
    case "ls":
      return { path: absolute(raw["path"]) }
    case "glob":
      return { pattern: asString(raw["pattern"]) ?? "", path: absolute(raw["root"]) }
    case "grep":
      return {
        pattern: asString(raw["pattern"]) ?? "",
        path: absolute(raw["root"]),
        ...(Array.isArray(raw["globs"]) ? { include: raw["globs"].join(",") } : {})
      }
    case "edit":
      return {
        filePath: absolute(raw["path"]),
        oldString: asString(raw["oldString"]) ?? "",
        newString: asString(raw["newString"]) ?? ""
      }
    case "write":
      return { filePath: absolute(raw["path"]), content: asString(raw["content"]) ?? "" }
    case "bash":
      return { command: asString(raw["command"]) ?? "", ...optional("description", raw["description"]) }
    default:
      return raw
  }
}

/**
 * The title of a call card: the one thing the reader needs to tell this call
 * from the next.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolTitle = (flowName: string, input: Record<string, unknown>): string => {
  switch (flowName) {
    case "read":
    case "edit":
    case "write":
      return basename(asString(input["filePath"]) ?? "")
    case "ls":
      return asString(input["path"]) ?? ""
    case "glob":
    case "grep":
      return asString(input["pattern"]) ?? ""
    case "bash":
      return asString(input["command"]) ?? ""
    default:
      return flowName
  }
}

/**
 * A settled call's value as the text a card shows.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolOutput = (flowName: string, value: Schema.Json): string => {
  const record: Record<string, unknown> = isRecord(value) ? value : {}
  switch (flowName) {
    case "read":
      return asString(record["content"]) ?? Cell.renderText(value)
    case "bash": {
      const stdout = asString(record["stdout"]) ?? ""
      const stderr = asString(record["stderr"]) ?? ""
      return stderr === "" ? stdout : `${stdout}${stdout === "" ? "" : "\n"}${stderr}`
    }
    case "ls":
      return Array.isArray(record["entries"])
        ? record["entries"].map((entry) => isRecord(entry) ? asString(entry["name"]) ?? "" : "").join("\n")
        : Cell.renderText(value)
    case "glob":
      return Array.isArray(record["paths"]) ? record["paths"].join("\n") : Cell.renderText(value)
    case "edit":
      return asString(record["hunk"]) ?? Cell.renderText(value)
    case "write":
      return `Wrote ${String(record["bytesWritten"] ?? 0)} bytes to ${asString(record["path"]) ?? ""}`
    default:
      return Cell.renderText(value)
  }
}

/**
 * The structured metadata a card gets beside its output. `bash` mirrors
 * OpenCode's `{output, exit}` so the shell card reads its exit code.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toolMetadata = (flowName: string, value: Schema.Json): Record<string, unknown> => {
  const record: Record<string, unknown> = isRecord(value) ? value : {}
  if (flowName === "bash") {
    return {
      output: toolOutput(flowName, value),
      exit: typeof record["exitCode"] === "number" ? record["exitCode"] : 0,
      truncated: record["stdoutTruncated"] === true || record["stderrTruncated"] === true,
      result: value
    }
  }
  return { result: value }
}

/**
 * The permission card's patterns and `always` rule for a parked call.
 *
 * @category conversions
 * @since 1.0.0
 */
export const permissionPatterns = (
  flowName: string,
  input: Record<string, unknown>
): { readonly patterns: Array<string>; readonly always: Array<string> } => {
  if (flowName === "bash") {
    const command = asString(input["command"]) ?? ""
    const word = command.trim().replace(/\s[\s\S]*$/, "")
    return { patterns: [command], always: [word === "" ? "*" : `${word} *`] }
  }
  const subject = toolTitle(flowName, input)
  return { patterns: [subject === "" ? "*" : subject], always: ["*"] }
}

const callID = (identity: { readonly frame: number; readonly cell: string; readonly ordinal: number }): string =>
  `call_${identity.frame}_${identity.cell.slice(0, 8)}_${identity.ordinal}`

const addTokens = (a: Protocol.Tokens, b: Protocol.Tokens): Protocol.Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write }
})

const tokensOf = (usage: ModelEvent.Usage): Protocol.Tokens => ({
  input: usage.inputTokens ?? 0,
  output: usage.outputTokens ?? 0,
  reasoning: usage.reasoningTokens ?? 0,
  cache: { read: usage.cachedInputTokens ?? 0, write: usage.cacheWriteTokens ?? 0 }
})

/**
 * The prose of an assistant message: its text content with fenced code
 * blocks removed, which is what the model said around the cell it wrote.
 *
 * @category conversions
 * @since 1.0.0
 */
export const prose = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("")
    .replace(/```[\s\S]*?```/g, "")
    .trim()

/**
 * The final answer of a resolved turn.
 *
 * @category conversions
 * @since 1.0.0
 */
export const answerText = (message: ModelRequest.AssistantMessage): string =>
  message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")

/**
 * Splits streamed text into the deltas the app receives, at word boundaries
 * and at most `size` characters each.
 *
 * @category conversions
 * @since 1.0.0
 */
export const chunks = (text: string, size = 24): Array<string> => {
  const out: Array<string> = []
  let current = ""
  for (const word of text.split(/(?<=\s)/)) {
    if (current.length > 0 && current.length + word.length > size) {
      out.push(current)
      current = ""
    }
    current += word
  }
  if (current.length > 0) out.push(current)
  return out
}

const base = (state: State): Pick<Protocol.PartBase, "sessionID" | "messageID"> => ({
  sessionID: state.session.id,
  messageID: state.assistantMessageID
})

const partEvent = (part: Protocol.Part, time: number): Protocol.Emitted => ({
  type: "message.part.updated",
  properties: { sessionID: part.sessionID, part, time }
})

const deltaEvent = (state: State, partID: string, field: string, delta: string): Protocol.Emitted => ({
  type: "message.part.delta",
  properties: { sessionID: state.session.id, messageID: state.assistantMessageID, partID, field, delta }
})

const assistantHeader = (
  state: State,
  ctx: Context,
  extra: Partial<Protocol.AssistantMessage> = {}
): Protocol.AssistantMessage => ({
  id: state.assistantMessageID,
  sessionID: state.session.id,
  role: "assistant",
  time: { created: state.createdAt },
  parentID: state.userMessageID,
  modelID: state.model.modelID,
  providerID: state.model.providerID,
  mode: state.agent,
  agent: state.agent,
  path: { cwd: ctx.directory, root: ctx.directory },
  cost: 0,
  tokens: state.tokens,
  ...extra
})

const sessionEvent = (session: Protocol.Session): Protocol.Emitted => ({
  type: "session.updated",
  properties: { sessionID: session.id, info: session }
})

const statusEvent = (sessionID: string, status: Protocol.SessionStatus): Protocol.Emitted => ({
  type: "session.status",
  properties: { sessionID, status }
})

const cellTitle = (cell: NonNullable<State["cell"]>, frame: number): string =>
  `frame ${frame + 1} · ${cell.calls} call${cell.calls === 1 ? "" : "s"} · ${
    cell.edits === 0 ? "read-only" : `${cell.edits} edit${cell.edits === 1 ? "" : "s"}`
  }`

const finishReasoning = (state: State, ctx: Context, text?: string): Step => {
  if (state.reasoning === undefined) return { state, events: [] }
  const part: Protocol.ReasoningPart = {
    ...base(state),
    id: state.reasoning.partID,
    type: "reasoning",
    text: text ?? state.reasoning.text,
    time: { start: state.reasoning.start, end: ctx.now() }
  }
  return { state: { ...state, reasoning: undefined }, events: [partEvent(part, ctx.now())] }
}

const stepFinish = (state: State, ctx: Context, reason: string): Protocol.Emitted =>
  partEvent(
    {
      ...base(state),
      id: Ids.part(state.assistantMessageID, { frame: state.frame, slot: slots.stepFinish, ordinal: 0 }),
      type: "step-finish",
      reason,
      cost: 0,
      tokens: state.frameTokens
    },
    ctx.now()
  )

const endTurn = (
  state: State,
  ctx: Context,
  header: Partial<Protocol.AssistantMessage>
): Step => {
  const now = ctx.now()
  const session: Protocol.Session = {
    ...state.session,
    tokens: addTokens(state.session.tokens, state.tokens),
    time: { ...state.session.time, updated: now }
  }
  const next: State = { ...state, session, closed: true }
  return {
    state: next,
    events: [
      { type: "message.updated", properties: { sessionID: session.id, info: assistantHeader(next, ctx, header) } },
      sessionEvent(session),
      statusEvent(session.id, { type: "idle" }),
      { type: "session.idle", properties: { sessionID: session.id } }
    ]
  }
}

const resolvedTurn = (state: State, ctx: Context): Step =>
  endTurn(state, ctx, { finish: "stop", time: { created: state.createdAt, completed: ctx.now() } })

const demandCard = (
  state: State,
  ctx: Context,
  frame: number,
  ordinal: number,
  title: string,
  text: string
): Step => {
  const partID = Ids.part(state.assistantMessageID, { frame, slot: slots.demand, ordinal })
  const now = ctx.now()
  const part: Protocol.ToolPart = {
    ...base(state),
    id: partID,
    type: "tool",
    callID: `demand_${frame}_${ordinal}`,
    tool: "demand",
    state: { status: "completed", input: {}, output: text, title, metadata: {}, time: { start: now, end: now } }
  }
  return { state: { ...state, demandText: { ...state.demandText, [partID]: text } }, events: [partEvent(part, now)] }
}

/**
 * The demand kinds, in the order their cards sort inside a frame.
 *
 * @category constants
 * @since 1.0.0
 */
export const demandOrdinals = {
  "read-only": 0,
  repeat: 1,
  narrowed: 2,
  unmoved: 3,
  unresolved: 4,
  "narrow-only": 5
} as const

/**
 * Opens a turn: the user message and its text part, the session with its
 * title set from the first prompt, the assistant header, and the busy
 * status.
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = (ctx: Context, opened: Opened): Step => {
  const now = ctx.now()
  const titled = opened.session.title.startsWith("New session")
    ? opened.prompt.replace(/\s+/g, " ").trim().slice(0, 60)
    : opened.session.title
  const session: Protocol.Session = {
    ...opened.session,
    title: titled === "" ? opened.session.title : titled,
    agent: opened.agent,
    model: { id: opened.model.modelID, providerID: opened.model.providerID },
    time: { ...opened.session.time, updated: now }
  }
  const state: State = {
    session,
    userMessageID: opened.userMessageID,
    assistantMessageID: opened.assistantMessageID,
    agent: opened.agent,
    model: opened.model,
    createdAt: opened.createdAt ?? now,
    frame: -1,
    tokens: Protocol.noTokens,
    frameTokens: Protocol.noTokens,
    reasoning: undefined,
    cell: undefined,
    calls: {},
    demandText: {},
    answered: false,
    resolving: false,
    closed: false
  }
  const user: Protocol.UserMessage = {
    id: opened.userMessageID,
    sessionID: session.id,
    role: "user",
    time: { created: now },
    agent: opened.agent,
    model: opened.model
  }
  const userText: Protocol.TextPart = {
    id: Ids.part(opened.userMessageID, { frame: 0, slot: 0, ordinal: 0 }),
    sessionID: session.id,
    messageID: opened.userMessageID,
    type: "text",
    text: opened.prompt
  }
  return {
    state,
    events: [
      { type: "message.updated", properties: { sessionID: session.id, info: user } },
      partEvent(userText, now),
      sessionEvent(session),
      statusEvent(session.id, { type: "busy" }),
      { type: "message.updated", properties: { sessionID: session.id, info: assistantHeader(state, ctx) } }
    ]
  }
}

/**
 * Folds one harness event.
 *
 * @category combinators
 * @since 1.0.0
 */
export const fold = (ctx: Context, state: State, event: AgentEvent.AgentEvent): Step => {
  if (state.closed) return { state, events: [] }
  switch (event._tag) {
    case "turn-opened": {
      const frame = state.frame + 1
      const next: State = { ...state, frame, frameTokens: Protocol.noTokens, reasoning: undefined, cell: undefined }
      const part: Protocol.StepStartPart = {
        ...base(next),
        id: Ids.part(next.assistantMessageID, { frame, slot: slots.stepStart, ordinal: 0 }),
        type: "step-start"
      }
      return { state: next, events: [partEvent(part, ctx.now())] }
    }
    case "model-delta": {
      const delta = event.delta
      if (delta.type !== "text-delta" && delta.type !== "thinking-delta") return { state, events: [] }
      const events: Array<Protocol.Emitted> = []
      let reasoning = state.reasoning
      if (reasoning === undefined) {
        const now = ctx.now()
        reasoning = {
          partID: Ids.part(state.assistantMessageID, { frame: state.frame, slot: slots.reasoning, ordinal: 0 }),
          text: "",
          start: now
        }
        events.push(
          partEvent({ ...base(state), id: reasoning.partID, type: "reasoning", text: "", time: { start: now } }, now)
        )
      }
      events.push(deltaEvent(state, reasoning.partID, "text", delta.text))
      return { state: { ...state, reasoning: { ...reasoning, text: reasoning.text + delta.text } }, events }
    }
    case "model-settled": {
      const frameTokens = tokensOf(event.usage)
      const next: State = { ...state, frameTokens, tokens: addTokens(state.tokens, frameTokens) }
      const text = prose(event.message)
      if (next.reasoning === undefined && text === "") return { state: next, events: [] }
      if (next.reasoning === undefined) {
        const now = ctx.now()
        const partID = Ids.part(next.assistantMessageID, { frame: next.frame, slot: slots.reasoning, ordinal: 0 })
        return {
          state: next,
          events: [
            partEvent({ ...base(next), id: partID, type: "reasoning", text, time: { start: now, end: now } }, now)
          ]
        }
      }
      return finishReasoning(next, ctx, text)
    }
    case "model-retried":
      return {
        state,
        events: [
          statusEvent(state.session.id, {
            type: "retry",
            attempt: event.attempt,
            message: `Model call retried (${event.code})`,
            next: ctx.now() + event.delayMillis
          })
        ]
      }
    case "cell-produced": {
      const finished = finishReasoning(state, ctx)
      const now = ctx.now()
      const cell = {
        partID: Ids.part(state.assistantMessageID, { frame: state.frame, slot: slots.cell, ordinal: 0 }),
        callID: `cell_${state.frame}_${event.cell.digest.slice(0, 8)}`,
        source: event.cell.text,
        calls: 0,
        edits: 0,
        start: now,
        prints: ""
      }
      const part: Protocol.ToolPart = {
        ...base(state),
        id: cell.partID,
        type: "tool",
        callID: cell.callID,
        tool: "cell",
        state: {
          status: "running",
          input: { frame: state.frame + 1, source: cell.source },
          title: `frame ${state.frame + 1}`,
          time: { start: now }
        }
      }
      return { state: { ...finished.state, cell }, events: [...finished.events, partEvent(part, now)] }
    }
    case "cell-call-started": {
      const identity = event.call.identity
      const key = callID(identity)
      const existing = state.calls[key]
      const now = existing?.start ?? ctx.now()
      const input = toolInput(ctx.directory, event.call.flowName, event.call.input)
      const card: CallCard = {
        partID: Ids.part(state.assistantMessageID, {
          frame: identity.frame,
          slot: slots.call,
          ordinal: identity.ordinal
        }),
        callID: key,
        tool: toolName(event.call.flowName),
        input,
        start: now
      }
      const edits = ["edit", "write", "apply_patch"].includes(event.call.flowName) ? 1 : 0
      const cell = state.cell === undefined
        ? undefined
        : { ...state.cell, calls: state.cell.calls + 1, edits: state.cell.edits + edits }
      const part: Protocol.ToolPart = {
        ...base(state),
        id: card.partID,
        type: "tool",
        callID: card.callID,
        tool: card.tool,
        state: { status: "running", input, title: toolTitle(event.call.flowName, input), time: { start: now } }
      }
      return {
        state: { ...state, cell, calls: { ...state.calls, [key]: card } },
        events: [partEvent(part, ctx.now())]
      }
    }
    case "cell-call-settled": {
      const key = callID(event.identity)
      const card = state.calls[key]
      if (card === undefined) return { state, events: [] }
      const now = ctx.now()
      const result = event.result
      const part: Protocol.ToolPart = {
        ...base(state),
        id: card.partID,
        type: "tool",
        callID: card.callID,
        tool: card.tool,
        state: result.outcome === "success"
          ? {
            status: "completed",
            input: card.input,
            output: toolOutput(event.flowName, result.value),
            title: toolTitle(event.flowName, card.input),
            metadata: toolMetadata(event.flowName, result.value),
            time: { start: card.start, end: now }
          }
          : {
            status: "error",
            input: card.input,
            error: `${result.message ?? "The call failed"}${result.code === undefined ? "" : ` (${result.code})`}${
              result.code === undefined ? "" : `\n${Cell.callFailureHint[result.code]}`
            }`,
            metadata: { code: result.code ?? Cell.defaultCallFailureCode, result: result.value },
            time: { start: card.start, end: now }
          }
      }
      const { [key]: _settled, ...calls } = state.calls
      return { state: { ...state, calls }, events: [partEvent(part, now)] }
    }
    case "cell-printed":
      return state.cell === undefined
        ? { state, events: [] }
        : { state: { ...state, cell: { ...state.cell, prints: event.text } }, events: [] }
    case "cell-settled": {
      if (state.cell === undefined) return { state, events: [] }
      const now = ctx.now()
      const cell = state.cell
      const input = { frame: state.frame + 1, source: cell.source }
      const outcome = event.outcome
      const part: Protocol.ToolPart = {
        ...base(state),
        id: cell.partID,
        type: "tool",
        callID: cell.callID,
        tool: "cell",
        state: outcome._tag === "settled"
          ? {
            status: "completed",
            input,
            output: cell.prints,
            title: cellTitle(cell, state.frame),
            metadata: { transition: outcome.transition._tag, calls: cell.calls, edits: cell.edits },
            time: { start: cell.start, end: now }
          }
          : {
            status: "error",
            input,
            error: outcome._tag === "raised" ? `${outcome.name}: ${outcome.message}` : outcome.message,
            metadata: { outcome: outcome._tag, output: cell.prints, calls: cell.calls, edits: cell.edits },
            time: { start: cell.start, end: now }
          }
      }
      return { state: { ...state, cell: undefined }, events: [partEvent(part, now)] }
    }
    case "read-only-demand-issued":
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals["read-only"],
        `read-only · ${event.streak}/${event.cap}`,
        `The last ${event.streak} frames only read (cap ${event.cap}). The next frame must write, justify the reading, or park.`
      )
    case "read-only-demanded": {
      const partID = Ids.part(state.assistantMessageID, {
        frame: event.nextFrame,
        slot: slots.demand,
        ordinal: demandOrdinals["read-only"]
      })
      const issued = state.demandText[partID] ??
        `The last ${event.streak} frames only read (cap ${event.cap}).`
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals["read-only"],
        `read-only · ${event.streak}/${event.cap} · ${event.nextAction}`,
        `${issued}\nAnswered: ${event.nextAction}.`
      )
    }
    case "repeat-demanded":
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals.repeat,
        `repeat · ${event.frames}/${event.cap}`,
        `${event.frames} frames repeated observations the run already had (cap ${event.cap}). Do something new.`
      )
    case "narrowed-demanded":
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals.narrowed,
        `narrowed · ${event.flow}`,
        `The completion rests on ${event.flow} ${event.narrower}, a narrowing of ${event.broader} that was never re-run over the changed tree. Re-run the broader check.`
      )
    case "unmoved-demanded":
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals.unmoved,
        "unmoved",
        `The tree is unchanged since the run opened (${
          event.openedDigest.slice(0, 8)
        }). Complete with an edit, or say no change was needed.`
      )
    case "unresolved-demanded":
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals.unresolved,
        `unresolved · ${event.flow}`,
        `${event.flow} ${event.failed} failed and was replaced by ${event.instead}. Resolve the failure or re-run it.`
      )
    case "narrow-only-demanded":
      return demandCard(
        state,
        ctx,
        event.nextFrame,
        demandOrdinals["narrow-only"],
        `narrow-only · ${event.flow}`,
        `${event.flow} ${event.check} covers ${event.targets.join(", ")} alone. Run a broader check.`
      )
    case "permission-required": {
      const request = event.request
      const meta: Record<string, unknown> = request.meta
      const flowName = asString(meta["flow"]) ?? request.capability.action
      const input = toolInput(ctx.directory, flowName, (meta["input"] ?? {}) as Schema.Json)
      const identity = isRecord(meta["identity"]) ? meta["identity"] : undefined
      const known = identity !== undefined && typeof identity["frame"] === "number" &&
        typeof identity["cell"] === "string" && typeof identity["ordinal"] === "number"
      const call = known
        ? {
          frame: identity["frame"] as number,
          cell: identity["cell"] as string,
          ordinal: identity["ordinal"] as number
        }
        : undefined
      const id = Ids.isKind("permission", request.requestId) ? request.requestId : `per_${request.requestId}`
      const events: Array<Protocol.Emitted> = []
      let calls = state.calls
      const key = call === undefined ? id : callID(call)
      if (call !== undefined) {
        const now = ctx.now()
        const card: CallCard = {
          partID: Ids.part(state.assistantMessageID, { frame: call.frame, slot: slots.call, ordinal: call.ordinal }),
          callID: key,
          tool: toolName(flowName),
          input,
          start: now
        }
        calls = { ...calls, [key]: card }
        events.push(
          partEvent(
            {
              ...base(state),
              id: card.partID,
              type: "tool",
              callID: card.callID,
              tool: card.tool,
              state: { status: "running", input, title: toolTitle(flowName, input), time: { start: now } }
            },
            now
          )
        )
      }
      const { patterns, always } = permissionPatterns(flowName, input)
      const permission: Protocol.PermissionRequest = {
        id,
        sessionID: state.session.id,
        permission: flowName,
        patterns,
        metadata: { ...input, tier: request.tier, capability: request.capability },
        always,
        tool: { messageID: state.assistantMessageID, callID: key }
      }
      events.push({ type: "permission.asked", properties: { ...permission } })
      return { state: { ...state, calls }, events }
    }
    case "suspended":
      // The engine re-drives the turn from frame zero after the park; the
      // journal replays what settled, and the derived part ids make the
      // replay an update of the same cards.
      return { state: { ...state, frame: -1, reasoning: undefined, cell: undefined }, events: [] }
    case "resolved": {
      // The answer and the frame's close arrive in either order: the
      // recorded turn says the answer first, the engine says the close
      // first. The turn ends once both have been folded.
      const finished = finishReasoning(state, ctx)
      const text = answerText(event.message)
      const now = ctx.now()
      const partID = Ids.part(state.assistantMessageID, { frame: finalFrame, slot: slots.stepStart, ordinal: 0 })
      const events: Array<Protocol.Emitted> = [
        ...finished.events,
        partEvent({ ...base(state), id: partID, type: "text", text: "", time: { start: now } }, now),
        ...chunks(text).map((delta) => deltaEvent(state, partID, "text", delta)),
        partEvent({ ...base(state), id: partID, type: "text", text, time: { start: now, end: ctx.now() } }, ctx.now())
      ]
      const answered: State = { ...finished.state, answered: true }
      if (!answered.resolving) return { state: answered, events }
      const ended = resolvedTurn(answered, ctx)
      return { state: ended.state, events: [...events, ...ended.events] }
    }
    case "turn-closed": {
      switch (event.outcome) {
        case "continue":
          return { state, events: [stepFinish(state, ctx, "tool-calls")] }
        case "resolved": {
          const resolving: State = { ...state, resolving: true }
          if (!resolving.answered) return { state: resolving, events: [stepFinish(state, ctx, "stop")] }
          const ended = resolvedTurn(resolving, ctx)
          return { state: ended.state, events: [stepFinish(state, ctx, "stop"), ...ended.events] }
        }
        case "aborted": {
          const ended = endTurn(state, ctx, {
            finish: "error",
            time: { created: state.createdAt, completed: ctx.now() },
            error: { name: "UnknownError", data: { message: `The turn stopped: ${event.stopReason}` } }
          })
          return { state: ended.state, events: [stepFinish(state, ctx, "error"), ...ended.events] }
        }
        case "suspended":
          return { state, events: [] }
      }
    }
    case "aborted":
      return close(ctx, state, { _tag: "failed", message: event.reason })
    default:
      return { state, events: [] }
  }
}

/**
 * Ends a turn the stream did not end: an interrupt takes the consumer down
 * with the frame and no `Aborted` reaches it (composition brief section 10),
 * and a failed body exits with a cause instead of an event.
 *
 * @category combinators
 * @since 1.0.0
 */
export const close = (ctx: Context, state: State, closing: Closing): Step => {
  if (state.closed) return { state, events: [] }
  const finished = finishReasoning(state, ctx)
  const error: Protocol.MessageError = closing._tag === "interrupted"
    ? { name: "MessageAbortedError", data: { message: "The turn was interrupted" } }
    : { name: "UnknownError", data: { message: closing.message } }
  const ended = endTurn(finished.state, ctx, {
    finish: "error",
    time: { created: state.createdAt, completed: ctx.now() },
    error
  })
  return { state: ended.state, events: [...finished.events, ...ended.events] }
}
