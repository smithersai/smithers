import { Capability, Permission } from "@smthrs/capability"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  AnthropicMessages,
  Evaluator,
  EvaluatorBackup,
  Framing,
  Model,
  ModelError,
  ModelEvent,
  ModelRequest,
  OpenAIChatCompletions,
  OpenAIResponses,
  Pricing,
  type Protocol
} from "../src/index.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum, maximum })))

type Event = ModelEvent.ModelEvent
const encoder = new TextEncoder()

// =============================================================================
// SSE wire construction
// =============================================================================

// Text a model can emit that a framer or a JSON decoder could mistake for
// framing: multi-byte and astral characters, a lone surrogate, NUL, the SSE
// field names and terminators, the `[DONE]` sentinel, a BOM and U+2028.
const AdversarialText = Schema.Union([
  Schema.String.pipe(Schema.check(Schema.isMaxLength(12))),
  Schema.Literals([
    "",
    "naïve café",
    "😀👍🏽",
    "\ud800",
    "\u0000",
    "\n\ndata: [DONE]\n\n",
    "\r\n",
    "event: error\ndata: {}",
    "[DONE]",
    "﻿",
    "  ",
    ": comment",
    "\"}\\"
  ])
])

const WireStyle = Schema.Struct({
  eol: Schema.Literals(["\n", "\r\n"]),
  eventNames: Schema.Boolean,
  comments: Schema.Boolean,
  // One JSON document spread over several `data:` lines.
  multiline: Schema.Boolean,
  done: Schema.Boolean
})
type WireStyle = typeof WireStyle.Type

type Frame = Readonly<Record<string, unknown>> & { readonly type?: string }

/** One SSE record per frame, each ending with its blank line. */
const records = (frames: ReadonlyArray<Frame>, style: WireStyle): ReadonlyArray<string> =>
  frames.map((frame, index) => {
    const lines: Array<string> = []
    if (style.comments && index % 2 === 0) lines.push(": keep-alive")
    if (style.eventNames && frame.type !== undefined) lines.push(`event: ${frame.type}`)
    const json = style.multiline ? JSON.stringify(frame, null, 1) : JSON.stringify(frame)
    for (const line of json.split("\n")) lines.push(`data: ${line}`)
    return lines.join(style.eol) + style.eol + style.eol
  })

const trailer = (style: WireStyle): string => style.done ? `data: [DONE]${style.eol}${style.eol}` : ""

/** Cuts the bytes at arbitrary offsets; repeated offsets give empty chunks. */
const split = (bytes: Uint8Array, cuts: ReadonlyArray<number>, bytewise: boolean): ReadonlyArray<Uint8Array> => {
  if (bytewise) return Array.from(bytes, (_, index) => bytes.subarray(index, index + 1))
  const offsets = [...cuts.map((cut) => cut % (bytes.byteLength + 1)), bytes.byteLength].sort((a, b) => a - b)
  const chunks: Array<Uint8Array> = []
  let start = 0
  for (const offset of offsets) {
    chunks.push(bytes.subarray(start, offset))
    start = offset
  }
  return chunks
}

const Cuts = Schema.Array(intBetween(0, 100_000)).pipe(Schema.check(Schema.isMaxLength(12)))

// =============================================================================
// One scripted turn, rendered in each provider's dialect
// =============================================================================

const ThinkingMode = Schema.Literals([
  "absent",
  // Anthropic's unsigned placeholder: `signature: ""` and never a real one.
  "unsigned",
  "empty-signature-delta",
  "signed-late",
  "signed-start",
  "redacted"
])

const Script = Schema.Struct({
  texts: Schema.Array(AdversarialText).pipe(Schema.check(Schema.isMaxLength(4))),
  thinking: ThinkingMode,
  thoughts: Schema.Array(AdversarialText).pipe(Schema.check(Schema.isMaxLength(3))),
  tool: Schema.Union([Schema.Undefined, Schema.Struct({ q: AdversarialText, n: intBetween(-5, 5) })]),
  argCuts: Schema.Array(intBetween(0, 400)).pipe(Schema.check(Schema.isMaxLength(4))),
  input: intBetween(0, 50_000),
  cacheRead: Schema.Union([Schema.Undefined, Schema.Null, intBetween(0, 50_000)]),
  cacheWrite: Schema.Union([Schema.Undefined, Schema.Null, intBetween(0, 50_000)]),
  output: intBetween(1, 9_000)
})
type Script = typeof Script.Type

const argumentsOf = (script: Script): string | undefined =>
  script.tool === undefined ? undefined : JSON.stringify(script.tool)

/** The tool arguments cut at UTF-16 offsets, so a cut can fall inside a surrogate pair. */
const argumentFragments = (script: Script): ReadonlyArray<string> => {
  const json = argumentsOf(script)
  if (json === undefined) return []
  const offsets = [...script.argCuts.map((cut) => cut % (json.length + 1)), json.length].sort((a, b) => a - b)
  const fragments: Array<string> = []
  let start = 0
  for (const offset of offsets) {
    fragments.push(json.slice(start, offset))
    start = offset
  }
  return fragments
}

const totalInput = (script: Script): number => script.input + (script.cacheRead ?? 0) + (script.cacheWrite ?? 0)

const SIGNATURE = "sig_real"

const anthropicFrames = (script: Script): ReadonlyArray<Frame> => {
  const frames: Array<Frame> = [{
    type: "message_start",
    message: {
      id: "msg_fuzz",
      usage: {
        input_tokens: script.input,
        ...(script.cacheRead === undefined ? {} : { cache_read_input_tokens: script.cacheRead }),
        ...(script.cacheWrite === undefined ? {} : { cache_creation_input_tokens: script.cacheWrite }),
        output_tokens: 1
      }
    }
  }]
  if (script.thinking === "redacted") {
    frames.push(
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_stop", index: 0 }
    )
  } else if (script.thinking !== "absent") {
    frames.push({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "",
        signature: script.thinking === "signed-start" ? SIGNATURE : ""
      }
    })
    for (const thinking of script.thoughts) {
      frames.push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } })
    }
    if (script.thinking === "empty-signature-delta" || script.thinking === "signed-late") {
      frames.push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: script.thinking === "signed-late" ? SIGNATURE : "" }
      })
    }
    frames.push({ type: "content_block_stop", index: 0 })
  }
  frames.push({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
  for (const text of script.texts) {
    frames.push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })
  }
  frames.push({ type: "content_block_stop", index: 1 })
  if (script.tool !== undefined) {
    frames.push({
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "call_fuzz", name: "lookup", input: {} }
    })
    for (const partial_json of argumentFragments(script)) {
      frames.push({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json } })
    }
    frames.push({ type: "content_block_stop", index: 2 })
  }
  frames.push(
    {
      type: "message_delta",
      delta: { stop_reason: script.tool === undefined ? "end_turn" : "tool_use" },
      usage: { output_tokens: script.output }
    },
    { type: "message_stop" }
  )
  return frames
}

/** OpenAI sends a choice-less usage chunk after the finish; Cerebras folds usage into the finish. */
const chatFrames = (script: Script, dialect: "openai" | "cerebras"): ReadonlyArray<Frame> => {
  const usage = {
    prompt_tokens: totalInput(script),
    completion_tokens: script.output,
    total_tokens: totalInput(script) + script.output,
    ...(typeof script.cacheRead === "number" ? { prompt_tokens_details: { cached_tokens: script.cacheRead } } : {})
  }
  const frames: Array<Frame> = script.texts.map((content) => ({
    id: "chatcmpl_fuzz",
    choices: [{ index: 0, delta: { role: "assistant", content } }]
  }))
  if (script.tool !== undefined) {
    frames.push({
      id: "chatcmpl_fuzz",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_fuzz", function: { name: "lookup", arguments: "" } }] }
      }]
    })
    for (const fragment of argumentFragments(script)) {
      frames.push({
        id: "chatcmpl_fuzz",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }]
      })
    }
  }
  const finish = {
    id: "chatcmpl_fuzz",
    choices: [{ index: 0, delta: {}, finish_reason: script.tool === undefined ? "stop" : "tool_calls" }]
  }
  if (dialect === "cerebras") frames.push({ ...finish, usage })
  else frames.push(finish, { id: "chatcmpl_fuzz", choices: [], usage })
  return frames
}

const responsesFrames = (script: Script): ReadonlyArray<Frame> => {
  const frames: Array<Frame> = [{ type: "response.created", response: { id: "resp_fuzz" } }]
  for (const delta of script.texts) frames.push({ type: "response.output_text.delta", item_id: "msg_1", delta })
  if (script.texts.length > 0) {
    frames.push({ type: "response.output_text.done", item_id: "msg_1", text: script.texts.join("") })
  }
  if (script.tool !== undefined) {
    frames.push({
      type: "response.output_item.added",
      item_id: "fc_1",
      item: { type: "function_call", id: "fc_1", call_id: "call_fuzz", name: "lookup", arguments: "" }
    })
    for (const delta of argumentFragments(script)) {
      frames.push({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta })
    }
    frames.push({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: argumentsOf(script) })
  }
  frames.push({
    type: "response.completed",
    response: {
      id: "resp_fuzz",
      usage: {
        input_tokens: totalInput(script),
        ...(typeof script.cacheRead === "number" ? { input_tokens_details: { cached_tokens: script.cacheRead } } : {}),
        output_tokens: script.output,
        total_tokens: totalInput(script) + script.output
      }
    }
  })
  return frames
}

// =============================================================================
// Protocol drivers
// =============================================================================

const streamRequest = ModelRequest.ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

/**
 * Runs a protocol the way a route does: bounded SSE framing, the protocol's
 * event codec, its state machine up to the terminal event, then `onHalt`.
 */
const driver = <Body, Wire, State>(protocol: Protocol.Protocol<Body, string, Wire, State>) => {
  const decode = Schema.decodeUnknownEffect(protocol.stream.event)
  const direct = (frames: ReadonlyArray<string>, halt = true) =>
    Effect.gen(function*() {
      let state = protocol.stream.initial(streamRequest)
      const events: Array<Event> = []
      for (const frame of frames) {
        const event = yield* decode(frame)
        const [next, emitted] = yield* protocol.stream.step(state, event)
        state = next
        events.push(...emitted)
        if (protocol.stream.terminal?.(event) === true) break
      }
      if (halt) events.push(...(protocol.stream.onHalt?.(state) ?? []))
      return events
    })
  const frame = (chunks: ReadonlyArray<Uint8Array>) => Stream.runCollect(Framing.sse.frame(Stream.fromIterable(chunks)))
  return {
    direct,
    frame,
    framed: (chunks: ReadonlyArray<Uint8Array>, halt = true) =>
      Effect.flatMap(frame(chunks), (frames) => direct(frames, halt))
  }
}

const anthropic = driver(AnthropicMessages.protocol)
const chat = driver(OpenAIChatCompletions.protocol)
const responses = driver(OpenAIResponses.protocol)

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const textOf = (events: ReadonlyArray<Event>): string =>
  ModelEvent.settledMessage(events).message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")

const toolArguments = (events: ReadonlyArray<Event>): ReadonlyArray<string> =>
  ModelEvent.settledMessage(events).message.content.flatMap((part) =>
    part.type === "tool-call" ? [`${part.id}:${part.name}:${part.arguments}`] : []
  )

const settles = (events: ReadonlyArray<Event>): number => events.filter((event) => event.type === "settle").length

/** Every tool call that started has ended exactly once, after its deltas. */
const toolCallsClosed = (events: ReadonlyArray<Event>): boolean => {
  const open = new Set<string>()
  const closed = new Set<string>()
  for (const event of events) {
    if (event.type === "tool-call-start") {
      if (open.has(event.id) || closed.has(event.id)) return false
      open.add(event.id)
    } else if (event.type === "tool-call-delta") {
      if (!open.has(event.id)) return false
    } else if (event.type === "tool-call-end") {
      if (!open.delete(event.id)) return false
      closed.add(event.id)
    }
  }
  return open.size === 0
}

/** Every text and thinking block that started has ended exactly once, after its deltas. */
const blocksClosed = (events: ReadonlyArray<Event>): boolean => {
  const open = new Set<string>()
  for (const event of events) {
    if (event.type === "text-start" || event.type === "thinking-start") {
      if (open.has(event.id)) return false
      open.add(event.id)
    } else if (event.type === "text-delta" || event.type === "thinking-delta") {
      if (!open.has(event.id)) return false
    } else if (event.type === "text-end" || event.type === "thinking-end") {
      if (!open.delete(event.id)) return false
    }
  }
  return open.size === 0
}

describe("@smthrs/model SSE decoding is invariant under byte and chunk fragmentation", () => {
  it("Anthropic, OpenAI, Cerebras and Responses streams yield the same events at every chunk boundary", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({ script: Script, style: WireStyle, cuts: Cuts, bytewise: Schema.Boolean })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ script, style, cuts, bytewise }) =>
          Effect.gen(function*() {
            const expectedText = script.texts.join("")
            const expectedCalls = script.tool === undefined ? [] : [`call_fuzz:lookup:${argumentsOf(script)}`]
            const dialects = [
              { run: anthropic, frames: anthropicFrames(script) },
              { run: chat, frames: chatFrames(script, "openai") },
              { run: chat, frames: chatFrames(script, "cerebras") },
              { run: responses, frames: responsesFrames(script) }
            ]
            const settled: Array<ReturnType<typeof ModelEvent.settledMessage>> = []
            for (const { run, frames } of dialects) {
              const bytes = encoder.encode(records(frames, style).join("") + trailer(style))
              // The reference never met a framer: the JSON documents, stepped in order.
              const reference = yield* run.direct(frames.map((frame) => JSON.stringify(frame)))
              const whole = yield* run.framed([bytes])
              const fragmented = yield* run.framed(split(bytes, cuts, bytewise))
              if (!same(whole, reference) || !same(fragmented, reference)) return false

              // What the model said survives the wire exactly.
              if (textOf(fragmented) !== expectedText) return false
              if (!same(toolArguments(fragmented), expectedCalls)) return false
              if (settles(fragmented) !== 1 || !toolCallsClosed(fragmented)) return false
              settled.push(ModelEvent.settledMessage(fragmented))
            }

            const [fromAnthropic, fromOpenAI, fromCerebras, fromResponses] = settled
            const stopReason = script.tool === undefined ? "stop" : "tool-calls"
            for (const turn of [fromAnthropic!, fromOpenAI!, fromCerebras!, fromResponses!]) {
              // Every dialect normalizes to one accounting: input includes cache reads and writes.
              if (turn.usage.inputTokens !== totalInput(script) || turn.usage.outputTokens !== script.output) {
                return false
              }
              if (turn.usage.totalTokens !== totalInput(script) + script.output) return false
              if (turn.usage.cachedInputTokens !== (script.cacheRead ?? undefined)) return false
              if (turn.message.stopReason !== stopReason) return false
            }
            // Folding usage into the finish chunk settles the same turn as a trailing usage chunk.
            return same(fromOpenAI!.message, fromCerebras!.message) && same(fromOpenAI!.usage, fromCerebras!.usage)
          }),
        { seed, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  it("a stream cut at any byte decodes exactly its complete events and never a partial one", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      script: Script,
      style: WireStyle,
      cuts: Cuts,
      bytewise: Schema.Boolean,
      truncateAt: intBetween(0, 100_000)
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ script, style, cuts, bytewise, truncateAt }) =>
          Effect.gen(function*() {
            const dialects = [
              { run: anthropic, frames: anthropicFrames(script) },
              { run: chat, frames: chatFrames(script, "openai") },
              { run: chat, frames: chatFrames(script, "cerebras") },
              { run: responses, frames: responsesFrames(script) }
            ]
            for (const { run, frames } of dialects) {
              const encoded = records(frames, style).map((record) => encoder.encode(record))
              const bytes = encoder.encode(records(frames, style).join("") + trailer(style))
              const cut = truncateAt % (bytes.byteLength + 1)
              const prefix = bytes.subarray(0, cut)

              // An event is whole once its blank line arrived. With CRLF the
              // blank line's own CR already ends it, one byte early.
              let end = 0
              let certain = 0
              let possible = 0
              for (const record of encoded) {
                end += record.byteLength
                if (end <= cut) certain += 1
                if (end - 1 <= cut) possible += 1
              }
              const delivered = yield* run.frame(split(prefix, cuts, bytewise))
              const documents = frames.map((frame) => JSON.stringify(JSON.parse(JSON.stringify(frame))))
              if (delivered.length < certain || delivered.length > possible) return false
              // Each delivered frame is a whole event's JSON, in order.
              for (let index = 0; index < delivered.length; index++) {
                if (JSON.stringify(JSON.parse(delivered[index]!)) !== documents[index]) return false
              }

              const events = yield* run.framed(split(prefix, cuts, bytewise))
              if (!same(events, yield* run.direct(delivered))) return false
              // Interruption closes every open tool call and settles nothing by itself.
              if (!toolCallsClosed(events)) return false
              if (delivered.length < frames.length - 1 && settles(events) > 0 && run === anthropic) return false
              if (settles(events) === 0 && ModelEvent.settledMessage(events).message.stopReason !== "aborted") {
                return false
              }
              // The text so far is a prefix of the text of the whole turn.
              if (!script.texts.join("").startsWith(textOf(events))) return false
            }
            return true
          }),
        { seed: seed + 1, executions: pureExecutions }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("the framer holds its record budget at every chunk boundary and never splits a UTF-8 sequence", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      payloads: Schema.Array(AdversarialText).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(6))),
      style: WireStyle,
      cuts: Cuts,
      bytewise: Schema.Boolean,
      budget: intBetween(1, 160)
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ payloads, style, cuts, bytewise, budget }) =>
          Effect.gen(function*() {
            const frames = payloads.map((text) => ({ text }))
            const encoded = records(frames, { ...style, done: false })
            const bytes = encoder.encode(encoded.join("") + trailer(style))
            const limited = Framing.makeSse({ maxRecordBytes: budget, maxResponseBytes: 1 << 20 })
            const collect = (chunks: ReadonlyArray<Uint8Array>) =>
              Effect.result(Stream.runCollect(limited.frame(Stream.fromIterable(chunks))))
            const whole = yield* collect([bytes])
            const fragmented = yield* collect(split(bytes, cuts, bytewise))

            // The verdict is a property of the bytes, never of how they were cut.
            if (Result.isSuccess(whole) !== Result.isSuccess(fragmented)) return false
            // An SSE record counts each of its lines with one LF, without the blank line.
            const recordBytes = (record: string): number =>
              record.split(style.eol).filter((line) => line !== "").reduce(
                (total, line) => total + encoder.encode(line).byteLength + 1,
                0
              )
            const largest = Math.max(...encoded.map(recordBytes), style.done ? recordBytes("data: [DONE]") : 0)
            if (Result.isSuccess(whole) !== (largest <= budget)) return false
            if (Result.isFailure(whole) || Result.isFailure(fragmented)) {
              // A budget failure is typed and never quotes the response.
              const failure = Result.isFailure(fragmented) ? fragmented.failure : undefined
              return failure instanceof ModelError.ModelError && failure.code === "invalid_provider_output" &&
                payloads.every((text) => text.length < 3 || !failure.message.includes(text))
            }
            if (!same(whole.success, fragmented.success)) return false
            return same(whole.success.map((frame) => JSON.parse(frame)), frames)
          }),
        { seed: seed + 2, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/model Anthropic interrupted streams and unsigned thinking (#4727)", () => {
  const lower = (message: ModelRequest.Message) =>
    AnthropicMessages.protocol.body.from(
      ModelRequest.ModelRequest.make({
        modelId: "claude-sonnet-4-5",
        system: [],
        messages: [ModelRequest.Message.user("Think"), message, ModelRequest.Message.user("Go on")],
        tools: [],
        params: ModelRequest.GenerationParams.make()
      }),
      { native: true }
    )

  it("message_start usage survives any interruption, and an empty-signature thinking block is never replayed", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      script: Script,
      style: WireStyle,
      cuts: Cuts,
      delivered: intBetween(0, 64)
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ script, style, cuts, delivered }) =>
          Effect.gen(function*() {
            const frames = anthropicFrames(script)
            // The stream stops after `count` whole events, mid-way through the next one.
            const count = delivered % (frames.length + 1)
            const encoded = records(frames, style)
            const partial = count < frames.length ? encoded[count]!.slice(0, Math.ceil(encoded[count]!.length / 2)) : ""
            const bytes = encoder.encode(encoded.slice(0, count).join("") + partial.trimEnd())
            const events = yield* anthropic.framed(split(bytes, cuts, false))
            const complete = count === frames.length
            const turn = ModelEvent.settledMessage(events)

            // --- usage -------------------------------------------------------
            if (count === 0) {
              if (events.length !== 0) return false
            } else {
              // Input and cache counts are billed from `message_start`, so they
              // are the first event and survive a call that never settles.
              const first = events[0]!
              if (first.type !== "usage" || first.inputTokens !== totalInput(script)) return false
              if (first.cachedInputTokens !== (script.cacheRead ?? undefined)) return false
              if (first.cacheWriteTokens !== (script.cacheWrite ?? undefined)) return false
              if (first.outputTokens !== 1 || first.totalTokens !== totalInput(script) + 1) return false
              if (turn.usage.inputTokens !== totalInput(script)) return false
              // Output only grows, and the total is always input plus output.
              let output = 0
              for (const event of events) {
                if (event.type !== "usage") continue
                if (event.inputTokens !== totalInput(script) || (event.outputTokens ?? 0) < output) return false
                if (event.totalTokens !== totalInput(script) + (event.outputTokens ?? 0)) return false
                output = event.outputTokens ?? 0
              }
              const finalOutput = count >= frames.length - 1 ? script.output : 1
              if (turn.usage.outputTokens !== finalOutput) return false
            }

            // --- settlement --------------------------------------------------
            if (settles(events) !== (complete ? 1 : 0)) return false
            if (!complete && turn.message.stopReason !== "aborted") return false
            if (complete && events.at(-1)?.type !== "settle") return false
            // `onHalt` closed every block the interruption left open.
            if (!blocksClosed(events) || !toolCallsClosed(events)) return false

            // --- thinking ----------------------------------------------------
            const starts = events.filter((event) => event.type === "thinking-start")
            const signed = script.thinking === "signed-late" || script.thinking === "signed-start"
            for (const start of starts) {
              // The empty placeholder never reaches an event as a signature.
              if (start.signature === "") return false
              if (!signed && script.thinking !== "redacted" && start.signature !== undefined) return false
            }
            const thinking = turn.message.content.filter((part) => part.type === "thinking")
            if (thinking.some((part) => part.signature === "")) return false

            // An interrupted turn is omitted whole from the next request.
            const aborted = JSON.stringify((yield* lower(turn.message)).messages)
            if (!complete && (aborted.includes("thinking") || aborted.includes("call_fuzz"))) return false

            // Replayed as a turn that ran out of tokens, only a block that
            // arrived with a real signature is sent back as thinking.
            const replayed = yield* lower(
              new ModelRequest.AssistantMessage({
                role: "assistant",
                content: turn.message.content,
                stopReason: "length"
              })
            )
            type WireBlock = { readonly type: string; readonly thinking?: string; readonly signature?: string }
            const wire = JSON.parse(JSON.stringify(replayed.messages)) as ReadonlyArray<{
              readonly content: string | ReadonlyArray<WireBlock>
            }>
            const blocks = wire.flatMap((message) => typeof message.content === "string" ? [] : message.content)
            const sent = blocks.filter((block) => block.type === "thinking")
            if (JSON.stringify(replayed).includes("\"signature\":\"\"")) return false
            const signedParts = thinking.filter((part) =>
              part.signature !== undefined && !part.signature.startsWith("redacted:")
            )
            if (sent.length !== signedParts.length) return false
            if (!signed && sent.length > 0) return false
            for (const block of sent) {
              if (block.signature !== SIGNATURE) return false
              // A signed block replays the thinking it signed, whole.
              if (script.thinking === "signed-late" && block.thinking !== script.thoughts.join("")) return false
            }
            if (complete && signed && sent.length !== 1) return false
            if (complete && script.thinking === "redacted") {
              if (blocks.filter((block) => block.type === "redacted_thinking").length !== 1) return false
            }
            return true
          }),
        { seed: seed + 3, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/model EvaluatorError.permission", () => {
  const request: Evaluator.Request = {
    state: { evidence: "tests passed" },
    questions: { accepted: Evaluator.BooleanQuestion.of({ instructions: "Is the evidence sufficient?" }) }
  }
  const answers = { accepted: { type: "boolean", probability: 0.9 } } as const
  const SECRET = "sk-secret-provider-detail"

  it("is the kernel's own failure exactly when a grant was refused, survives the journal, and never reaches a backup", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      failure: Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("denied"), reason: AdversarialText }),
        Schema.Struct({
          _tag: Schema.Literal("required"),
          requestId: AdversarialText,
          tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
          meta: Schema.Record(Schema.Literals(["cwd", "note"]), AdversarialText)
        }),
        Schema.Struct({ _tag: Schema.Literal("model"), code: ModelError.ModelErrorCode })
      ]),
      modelId: Schema.Literals(["gpt-6.1-sol", "google/gemini-3-flash", "claude-fable-5-2", "模型/judge"]),
      path: Schema.Literals(["seat", "backup"])
    }))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ failure, modelId, path }) =>
          Effect.gen(function*() {
            const capability = Capability.make("model:call", modelId)
            const cause = failure._tag === "denied"
              ? Permission.PermissionDenied.new({ capability, reason: failure.reason })
              : failure._tag === "required"
              ? Permission.PermissionRequired.new({
                requestId: failure.requestId,
                capability,
                tier: failure.tier,
                meta: failure.meta
              })
              : new ModelError.ModelError({ code: failure.code, message: SECRET })
            const model = Model.make({ stream: () => Stream.fail(cause) })
            const primary = path === "backup"
              ? EvaluatorBackup.fromModel(model, modelId)
              : yield* Effect.service(Evaluator.Evaluator).pipe(
                Effect.provide(Evaluator.layerFromSeat({ modelId, model }))
              )

            let backupCalls = 0
            const backup = Evaluator.Evaluator.of({
              evaluate: () => {
                backupCalls += 1
                return Effect.succeed({ answers, latencyMs: 1 })
              }
            })
            const error = yield* Effect.flip(primary.evaluate(request))
            const fallback = yield* Effect.result(EvaluatorBackup.withFallback(primary, backup).evaluate(request))

            const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(Evaluator.EvaluatorError)(error))) as unknown
            const decoded = Schema.decodeUnknownSync(Evaluator.EvaluatorError)(encoded)
            // A provider's own words never reach the judge's failure.
            if (JSON.stringify(encoded).includes(SECRET) || error.message.includes(SECRET)) return false
            if (decoded.code !== error.code || decoded.message !== error.message) return false

            if (cause instanceof ModelError.ModelError) {
              // Only a permission failure carries `permission`.
              if (error.permission !== undefined || decoded.permission !== undefined) return false
              const expected = cause.code === "rate_limited" || cause.code === "quota_exceeded"
                ? "refused"
                : cause.code === "authentication"
                ? "unconfigured"
                : "unreachable"
              if (error.code !== expected) return false
              // An outage is the backup's to answer; a setup fault never is.
              const answered = expected !== "unconfigured"
              return Result.isSuccess(fallback) === answered && backupCalls === (answered ? 1 : 0)
            }

            // A refused or pending grant is a setup fault, not an outage.
            if (error.code !== "unconfigured" || Evaluator.faults[error.code] !== "policy") return false
            if (error.message !== Permission.formatError(cause) || error.usage !== undefined) return false
            const carried = error.permission
            if (carried === undefined || carried._tag !== cause._tag) return false
            if (
              !same(
                Schema.encodeSync(Permission.PermissionError)(carried),
                Schema.encodeSync(Permission.PermissionError)(cause)
              )
            ) {
              return false
            }
            // The journal round trip keeps the class an attended host matches on.
            const restored = decoded.permission
            if (cause instanceof Permission.PermissionRequired) {
              if (!(restored instanceof Permission.PermissionRequired)) return false
              if (restored.requestId !== cause.requestId || restored.tier !== cause.tier) return false
              if (!same(restored.meta, cause.meta) || !same(restored.capability, cause.capability)) return false
            } else {
              if (!(restored instanceof Permission.PermissionDenied)) return false
              if (restored.reason !== cause.reason || !same(restored.capability, cause.capability)) return false
            }
            // The backup holds another credential; it is never asked to answer a refused call.
            if (backupCalls !== 0 || Result.isSuccess(fallback)) return false
            return fallback.failure.code === "unconfigured" && fallback.failure.permission?._tag === cause._tag
          }),
        { seed: seed + 4, executions: ioExecutions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/model token and cost accounting", () => {
  const Rate = Schema.Literals([0, 0.075, 0.3, 1.25, 3, 15, 75])
  const Rates = Schema.Struct({ input: Rate, cacheRead: Rate, cacheWrite: Rate, output: Rate })
  const Tokens = intBetween(0, 2_000_000)
  const Counters = Schema.Struct({ uncached: Tokens, read: Tokens, write: Tokens, output: Tokens })
  const usageOf = (counters: typeof Counters.Type): ModelEvent.Usage => ({
    inputTokens: counters.uncached + counters.read + counters.write,
    outputTokens: counters.output,
    cachedInputTokens: counters.read,
    cacheWriteTokens: counters.write
  })
  const close = (left: number, right: number): boolean =>
    Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))

  it("Pricing is linear and monotone in every token class and never prices malformed usage low", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      rates: Rates,
      base: Counters,
      extra: Counters,
      moved: Tokens,
      malformed: Schema.Literals([
        "negative-input",
        "negative-output",
        "nan",
        "infinite",
        "cache-exceeds-input",
        "no-input",
        "no-output"
      ]),
      reported: Schema.Literals(["absent", "zero", "quarter", "negative", "nan", "infinite"])
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rates, base, extra, moved, malformed, reported: reportedKind }) =>
          Effect.sync(() => {
            const reported = {
              absent: undefined,
              zero: 0,
              quarter: 0.25,
              negative: -1,
              nan: Number.NaN,
              infinite: Number.POSITIVE_INFINITY
            }[reportedKind]
            const usage = usageOf(base)
            const more = usageOf({
              uncached: base.uncached + extra.uncached,
              read: base.read + extra.read,
              write: base.write + extra.write,
              output: base.output + extra.output
            })
            const weight = Pricing.weigh(usage, rates)
            if (!Number.isFinite(weight) || weight < 0) return false
            // The weighted sum is each class times its rate.
            const expected = base.uncached * rates.input + base.read * rates.cacheRead +
              base.write * rates.cacheWrite + base.output * rates.output
            if (!close(weight, expected)) return false
            // More tokens of any class never cost less, and two calls cost what one combined call costs.
            if (Pricing.weigh(more, rates) < weight) return false
            if (!close(Pricing.weigh(more, rates), weight + Pricing.weigh(usageOf(extra), rates))) return false
            if (Pricing.costUsd(more, rates) < Pricing.costUsd(usage, rates)) return false
            if (!close(Pricing.costUsd(usage, rates), weight / 1_000_000)) return false

            // Serving input from the cache moves cost with the sign of the rate difference.
            const shift = Math.min(moved, base.uncached)
            const cached = usageOf({ ...base, uncached: base.uncached - shift, read: base.read + shift })
            if (!close(Pricing.weigh(cached, rates), weight + shift * (rates.cacheRead - rates.input))) return false
            if (rates.cacheRead <= rates.input && Pricing.weigh(cached, rates) > weight + 1e-6) return false

            // A long-context card prices the whole call once the prompt reaches its threshold.
            const longContext = {
              input: rates.input * 2,
              cacheRead: rates.cacheRead,
              cacheWrite: rates.cacheWrite,
              output: rates.output * 1.5
            }
            const card = { ...rates, longContextFrom: 200_000, longContext } as Pricing.Price
            const applied = usage.inputTokens! >= 200_000 ? longContext : rates
            if (!close(Pricing.costUsd(usage, card), Pricing.weigh(usage, applied) / 1_000_000)) return false
            if (Pricing.costUsd(more, card) < Pricing.costUsd(usage, card)) return false

            // Malformed usage is NaN, never a low price.
            const broken: ModelEvent.Usage = malformed === "negative-input"
              ? { ...usage, inputTokens: -1 - base.uncached }
              : malformed === "negative-output"
              ? { ...usage, outputTokens: -1 - base.output }
              : malformed === "nan"
              ? { ...usage, cachedInputTokens: Number.NaN }
              : malformed === "infinite"
              ? { ...usage, outputTokens: Number.POSITIVE_INFINITY }
              : malformed === "cache-exceeds-input"
              ? { ...usage, cachedInputTokens: usage.inputTokens! + 1 }
              : malformed === "no-input"
              ? { outputTokens: usage.outputTokens }
              : { inputTokens: usage.inputTokens }
            if (!Number.isNaN(Pricing.weigh(broken, rates)) || !Number.isNaN(Pricing.costUsd(broken, rates))) {
              return false
            }
            const table = { "fuzz-model": rates }
            if (Pricing.cost(broken, "fuzz-model", { table }) !== undefined) return false
            if (Pricing.cost(usage, "unpriced-model", { table }) !== undefined) return false

            // A valid reported charge wins; an invalid one falls back to the rate card.
            const valid = reported !== undefined && Number.isFinite(reported) && reported >= 0
            const billed = Pricing.cost(
              { ...usage, ...(reported === undefined ? {} : { costUsd: reported }) },
              "fuzz-model",
              {
                table
              }
            )
            if (billed === undefined) return false
            if (valid) return billed.costSource === "reported" && billed.costUsd === reported
            if (billed.costSource !== "estimated" || !close(billed.costUsd, Pricing.costUsd(usage, rates))) return false
            // A seat or gateway spelling and a dated snapshot resolve to the same card.
            return ["openai:fuzz-model", "gateway/fuzz-model", "fuzz-model-20261123", " fuzz-model "].every((id) =>
              same(Pricing.cost(usage, id, { table }), Pricing.cost(usage, "fuzz-model", { table }))
            )
          }),
        { seed: seed + 5, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  it("every priced model's cost is finite, non-negative and monotone in output and cached-input tokens", async () => {
    const ids = Object.keys(Pricing.table)
    const arb = Arbitrary.schema(Schema.Struct({
      model: intBetween(0, ids.length - 1),
      base: Counters,
      extraOutput: Tokens,
      at: Schema.Literals([Date.UTC(2026, 0, 1), Date.UTC(2026, 10, 23), Date.UTC(2027, 5, 1), Date.UTC(2030, 0, 1)])
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ model, base, extraOutput, at }) =>
          Effect.sync(() => {
            const id = ids[model]!
            const usage = usageOf(base)
            const priced = Pricing.cost(usage, id, { at })
            if (priced === undefined || priced.costSource !== "estimated") return false
            if (!Number.isFinite(priced.costUsd) || priced.costUsd < 0) return false
            const longer = Pricing.cost({ ...usage, outputTokens: base.output + extraOutput }, id, { at })
            if (longer === undefined || longer.costUsd < priced.costUsd) return false
            // A cache read is never billed above the same tokens read fresh.
            const fresh = Pricing.cost({ ...usage, cachedInputTokens: 0 }, id, { at })
            if (fresh === undefined || fresh.costUsd < priced.costUsd) return false
            // A seat spelling of a bare model id prices as that model.
            return /[/:]/.test(id) || same(Pricing.cost(usage, `seat:${id}`, { at }), priced)
          }),
        { seed: seed + 6, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  it("settledMessage keeps the latest reading of each counter and a retry discards the failed try's usage", async () => {
    const Count = Schema.Union([Schema.Undefined, intBetween(0, 100_000)])
    const Step = Schema.Union([
      Schema.Struct({
        type: Schema.Literal("usage"),
        inputTokens: Count,
        outputTokens: Count,
        reasoningTokens: Count,
        cachedInputTokens: Count,
        cacheWriteTokens: Count,
        totalTokens: Count,
        costUsd: Schema.Union([Schema.Undefined, Schema.Literals([0, 0.001, 2.5])])
      }),
      Schema.Struct({ type: Schema.Literal("retry") }),
      Schema.Struct({ type: Schema.Literal("text"), text: AdversarialText })
    ])
    const arb = Arbitrary.schema(Schema.Array(Step).pipe(Schema.check(Schema.isMaxLength(14))))
    const fields = [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "totalTokens",
      "costUsd"
    ] as const
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (steps) =>
          Effect.sync(() => {
            const events: Array<Event> = []
            let expected: Partial<Record<typeof fields[number], number>> = {}
            let text = ""
            for (const step of steps) {
              if (step.type === "usage") {
                events.push(ModelEvent.ModelEvent.Usage(Object.fromEntries(
                  fields.flatMap((field) => step[field] === undefined ? [] : [[field, step[field]]])
                )))
                // A counter the provider left out is not a zero: the earlier reading stands.
                for (const field of fields) if (step[field] !== undefined) expected[field] = step[field]
              } else if (step.type === "retry") {
                events.push(
                  ModelEvent.ModelEvent.Retry({ type: "retry", attempt: 1, code: "transport", delayMillis: 0 })
                )
                expected = {}
                text = ""
              } else {
                events.push({ type: "text-delta", id: "t", text: step.text })
                text += step.text
              }
              const folded = ModelEvent.settledMessage(events)
              for (const field of fields) if (folded.usage[field] !== expected[field]) return false
              if (textOf(events) !== text || folded.message.stopReason !== "aborted") return false
            }
            // Folding is a function of the events alone.
            return same(ModelEvent.settledMessage(events), ModelEvent.settledMessage([...events]))
          }),
        { seed: seed + 7, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })
})
