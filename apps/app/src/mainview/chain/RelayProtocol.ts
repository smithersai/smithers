import { ModelError, ModelEvent, ModelRequest, Protocol } from "@smthrs/model"
import { Effect, Schema } from "effect"

/*
 * The wire the browser chain speaks to the Worker's model relay
 * (`/api/model/stream`).
 *
 * The relay is a thin, session-gated forwarder onto the SAME managed-inference
 * endpoint `/api/agent/turn` already uses: the Smithers chat Worker, which owns
 * the Cerebras key, prices the turn, and meters it durably onto the signed-in
 * user's account. So the protocol on this wire is that Worker's own contract —
 * a JSON request body of `{ instructions, messages }` and a newline-delimited
 * JSON response of `delta` / `tool_call` / `error` / `done` frames — not a
 * provider-native API. Speaking the upstream's real protocol is what lets the
 * relay stay a forwarder instead of becoming a second translation layer with
 * its own bugs.
 *
 * Only sealed author calls travel here: `@smthrs/chain`'s ModelAuthor sends a
 * system prefix plus one user message with `tools: []` and
 * `toolChoice: "none"`, and the relay refuses anything carrying tools. A
 * request that declares tools therefore fails HERE, with a local reason,
 * rather than as an opaque 400 from the boundary.
 */

const ChatMessage = Schema.Union([
  Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    content: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("function_call"),
    call_id: Schema.String,
    name: Schema.String,
    arguments: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.String
  })
])

type ChatMessage = typeof ChatMessage.Type

/** The relay request body: exactly the chat Worker's `/chat` contract. */
export const Body = Schema.Struct({
  instructions: Schema.optional(Schema.String),
  messages: Schema.Array(ChatMessage)
})

export type Body = typeof Body.Type

/*
 * Frames are read permissively — one open struct rather than a discriminated
 * union — so an upstream that adds a field or a frame type streams on instead
 * of failing the turn. `stepEvent` below is where meaning is assigned.
 */
const ChatFrame = Schema.Struct({
  type: Schema.String,
  kind: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String)
})

type ChatFrame = typeof ChatFrame.Type

/**
 * What the adapter carries between frames: which content blocks are open, so
 * a start is emitted exactly once and a halt can close them.
 */
export interface State {
  readonly text: boolean
  readonly thinking: boolean
  readonly settled: boolean
}

/** The single block id per kind — the upstream streams one block of each. */
const TEXT_ID = "text"
const THINKING_ID = "thinking"

const invalidRequest = (message: string): ModelError.ModelError =>
  new ModelError.ModelError({ code: "invalid_request", message })

const messageItems = (
  message: ModelRequest.Message
): ReadonlyArray<ChatMessage> | ModelError.ModelError => {
  if (message.role === "tool") {
    if (message.content.length === 0) {
      return invalidRequest("A tool message carried no results the relay can send")
    }
    return message.content.map((part) => ({
      type: "function_call_output" as const,
      call_id: part.toolCallId,
      output: part.content
    }))
  }
  // Thinking is never replayed: the upstream owns its own reasoning and
  // accepts no signature to echo back.
  const parts: ReadonlyArray<ModelRequest.AssistantContentPart> = message.content
  const text = parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
  const items: Array<ChatMessage> = []
  // Blank content cannot ride the wire: the upstream rejects it, and catching
  // it here makes the reason local instead of an opaque 400 from the boundary.
  if (text.trim() !== "") items.push({ role: message.role, content: text })
  if (message.role === "assistant") {
    for (const part of parts) {
      if (part.type !== "tool-call") continue
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: part.arguments
      })
    }
  }
  if (items.length === 0) {
    return invalidRequest(`A ${message.role} message carried no content the relay can send`)
  }
  return items
}

const fromRequest = (request: ModelRequest.ModelRequest): Effect.Effect<Body, ModelError.ModelError> =>
  Effect.suspend(() => {
    if (request.tools.length > 0) {
      return Effect.fail(
        invalidRequest("The model relay serves sealed author calls only — no tools.")
      )
    }
    const messages: Array<ChatMessage> = []
    for (const message of request.messages) {
      const items = messageItems(message)
      if (items instanceof ModelError.ModelError) return Effect.fail(items)
      messages.push(...items)
    }
    if (messages.length === 0) {
      return Effect.fail(invalidRequest("A relay request must carry at least one message"))
    }
    const instructions = request.system.map((part) => part.text).join("\n")
    return Effect.succeed({
      ...(instructions === "" ? {} : { instructions }),
      messages
    })
  })

/**
 * `tool_limit` is deliberately NOT `stop`: the upstream refused to run another
 * leg, so the turn is unfinished. Reporting it as a clean stop would let a
 * truncated answer pass as a complete one.
 */
const stopReasonOf = (reason: string | undefined): ModelRequest.StopReason =>
  reason === "stop" ? "stop" : reason === "tool_call" ? "tool-calls" : "unknown"

const settle = (
  state: State,
  reason: string | undefined
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } => {
  if (state.settled) return { state, events: [] }
  return {
    state: { text: false, thinking: false, settled: true },
    events: [
      ...closing(state),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: stopReasonOf(reason) })
    ]
  }
}

const closing = (state: State): ReadonlyArray<ModelEvent.ModelEvent> => [
  ...(state.thinking ? [ModelEvent.ModelEvent.ThinkingEnd({ type: "thinking-end", id: THINKING_ID })] : []),
  ...(state.text ? [ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: TEXT_ID })] : [])
]

const stepEvent = (
  state: State,
  frame: ChatFrame
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError.ModelError => {
  if (state.settled) return { state, events: [] }
  if (frame.type === "delta" && frame.text !== undefined && frame.text !== "") {
    if (frame.kind === "reasoning") {
      return {
        state: { ...state, thinking: true },
        events: [
          ...(state.thinking
            ? []
            : [ModelEvent.ModelEvent.ThinkingStart({ type: "thinking-start", id: THINKING_ID })]),
          ModelEvent.ModelEvent.ThinkingDelta({
            type: "thinking-delta",
            id: THINKING_ID,
            text: frame.text
          })
        ]
      }
    }
    return {
      state: { ...state, text: true },
      events: [
        ...(state.text ? [] : [ModelEvent.ModelEvent.TextStart({ type: "text-start", id: TEXT_ID })]),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: TEXT_ID, text: frame.text })
      ]
    }
  }
  if (frame.type === "tool_call") {
    const id = frame.id ?? frame.call_id
    if (id === undefined || frame.name === undefined) {
      return new ModelError.ModelError({
        code: "invalid_provider_output",
        message: "The relay emitted a tool call without an id or name"
      })
    }
    // The upstream frames a tool call whole, so start/delta/end are one frame.
    const args = frame.arguments ?? "{}"
    return {
      state,
      events: [
        ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id, name: frame.name }),
        ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id, arguments: args }),
        ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id, arguments: args })
      ]
    }
  }
  if (frame.type === "error") {
    const message = frame.message ?? "The model relay reported a failure"
    return new ModelError.ModelError({
      code: ModelError.isContextOverflow(frame.code, message) ? "context_overflow" : "provider_internal",
      message,
      ...(frame.code === undefined ? {} : { providerCode: frame.code })
    })
  }
  if (frame.type === "done") {
    if (frame.error !== undefined && frame.error !== "") {
      return new ModelError.ModelError({ code: "provider_internal", message: frame.error })
    }
    return settle(state, frame.reason)
  }
  return { state, events: [] }
}

const step = Effect.fn("RelayProtocol.step")((
  state: State,
  frame: ChatFrame
): Effect.Effect<readonly [State, ReadonlyArray<ModelEvent.ModelEvent>], ModelError.ModelError> =>
  Effect.suspend(() => {
    const result = stepEvent(state, frame)
    return result instanceof ModelError.ModelError
      ? Effect.fail(result)
      : Effect.succeed([result.state, result.events] as const)
  })
)

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.String) }))
)

/**
 * The relay answers a failure in the Worker's own envelope
 * (`{ status: "error", message }`), so its sentence — "sign in", "not in the
 * allowlist", the turn ceiling — is what reaches the user.
 */
const classifyError = (status: number, body: string): ModelError.ModelError => {
  const decoded = decodeErrorBody(body)
  const message = (decoded._tag === "Some" ? decoded.value.message : undefined) ??
    `The model relay refused the request with HTTP ${status}`
  const code: ModelError.ModelErrorCode = status === 401 || status === 403
    ? "authentication"
    : status === 402
    ? "quota_exceeded"
    : status === 429
    ? "rate_limited"
    : status === 501 || status === 503 || status >= 500
    ? "provider_internal"
    : ModelError.isContextOverflow(undefined, message)
    ? "context_overflow"
    : "invalid_request"
  return new ModelError.ModelError({ code, message, httpStatus: status })
}

/** The Worker model relay's protocol. */
export const protocol: Protocol.Protocol<Body, string, ChatFrame, State> = Protocol.make({
  id: "smithers-relay",
  // Deferred tool loading is an OpenAI-native extension; this wire has none.
  supportsDeferred: () => false,
  body: { schema: Body, from: fromRequest },
  stream: {
    event: Schema.fromJsonString(ChatFrame),
    initial: () => ({ text: false, thinking: false, settled: false }),
    step,
    onHalt: closing,
    terminal: (frame) => frame.type === "done"
  },
  classifyError
})
