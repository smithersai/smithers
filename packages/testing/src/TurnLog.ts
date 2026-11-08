/**
 * Count and trace the turns a model double serves.
 *
 * A test that drives an install out of process cannot see which model turns
 * the install asked for. A turn log records each one as it is dispatched: its
 * name (the scripted step that answered it, or what the test names it), its
 * model, its message count, and optionally every message's text. `summary`
 * counts them by kind and name; `ModelServer` serves it at
 * `GET /__testing/turns`. With a file, each entry is also appended to it as
 * one JSON line, so the trace survives the server as test evidence.
 *
 * An entry never holds a request header, so it never holds a credential.
 *
 * @since 1.0.0
 */

import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import type { ModelRequest } from "@smthrs/model/ModelRequest"
import { NodeHost } from "@smthrs/platform-node"
import { Effect, Ref, Semaphore, Stream } from "effect"
import * as ScriptedModel from "./ScriptedModel.vibe"

/**
 * What a logged turn was.
 *
 * `refused` is an evaluation the evaluator failed.
 *
 * @category models
 * @since 1.0.0
 */
export type Kind = "chat" | "evaluation" | "refused"

/**
 * One logged turn.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  /** 1 for the first turn, counting every kind. */
  readonly n: number
  /** When the turn was dispatched, as an ISO 8601 instant. */
  readonly at: string
  readonly kind: Kind
  /** The turn's name. */
  readonly step: string
  readonly [field: string]: unknown
}

/**
 * The turns served so far, counted.
 *
 * @category models
 * @since 1.0.0
 */
export interface Summary {
  readonly total: number
  readonly chat: number
  readonly evaluation: number
  readonly refused: number
  /** Turns by name. */
  readonly steps: Readonly<Record<string, number>>
}

/**
 * A turn log.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnLog {
  /** Records a chat turn: its model, its message count and, when the log keeps them, its messages. */
  readonly chat: (
    request: ModelRequest,
    step: string,
    detail?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void>
  /** Records any other turn. */
  readonly record: (kind: Kind, step: string, detail?: Readonly<Record<string, unknown>>) => Effect.Effect<void>
  readonly entries: () => Effect.Effect<ReadonlyArray<Entry>>
  readonly summary: () => Effect.Effect<Summary>
}

/**
 * What a turn log is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** A file each entry is appended to as one JSON line. */
  readonly file?: string | undefined
  /** Keep every message's text on each chat entry, as `messages`; off by default. */
  readonly messages?: boolean | undefined
}

/**
 * Builds an empty turn log.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options = {}): Effect.Effect<TurnLog> =>
  Effect.gen(function*() {
    const state = yield* Ref.make<ReadonlyArray<Entry>>([])
    const publication = yield* NodeHost.AtomicFileSystem.ownerPrivate
    const serial = yield* Semaphore.make(1)
    const record: TurnLog["record"] = (kind, step, detail = {}) =>
      serial.withPermits(1)(Effect.gen(function*() {
        const entries = yield* Ref.get(state)
        const entry: Entry = { ...detail, n: entries.length + 1, at: new Date().toISOString(), kind, step }
        if (options.file !== undefined) {
          yield* publication.append(options.file, `${JSON.stringify(entry)}\n`).pipe(Effect.orDie)
        }
        yield* Ref.set(state, [...entries, entry])
      }))
    const chat: TurnLog["chat"] = (request, step, detail = {}) =>
      record("chat", step, {
        model: request.modelId,
        messageCount: request.messages.length,
        ...(options.messages === true ? { messages: ScriptedModel.transcript(request) } : {}),
        ...detail
      })
    const entries = () => Ref.get(state)
    const summary = () =>
      Effect.map(Ref.get(state), (all): Summary => {
        const steps: Record<string, number> = {}
        for (const entry of all) steps[entry.step] = (steps[entry.step] ?? 0) + 1
        const count = (kind: Kind) => all.filter((entry) => entry.kind === kind).length
        return {
          total: all.length,
          chat: count("chat"),
          evaluation: count("evaluation"),
          refused: count("refused"),
          steps
        }
      })
    return { chat, record, entries, summary }
  })

/**
 * Wraps a model so each turn is logged under `step(request)` when it is
 * dispatched.
 *
 * @category constructors
 * @since 1.0.0
 */
export const model = (
  inner: Model.Model,
  options: { readonly log: TurnLog; readonly step: (request: ModelRequest) => string }
): Model.Model =>
  Model.make({
    ...(inner.providerName === undefined ? {} : { providerName: inner.providerName }),
    stream: (request) =>
      Stream.unwrap(options.log.chat(request, options.step(request)).pipe(Effect.as(inner.stream(request))))
  })

/**
 * Wraps an evaluator so each evaluation is logged under its question ids:
 * `evaluation` with its answers, or `refused` with the failure's message.
 *
 * @category constructors
 * @since 1.0.0
 */
export const evaluator = (inner: Evaluator.Evaluator, options: { readonly log: TurnLog }): Evaluator.Evaluator => ({
  evaluate: (request) => {
    const step = Object.keys(request.questions).join(",") || "empty"
    return inner.evaluate(request).pipe(
      Effect.tap((response) => options.log.record("evaluation", step, { answers: response.answers })),
      Effect.tapError((error) => options.log.record("refused", step, { error: error.message }))
    )
  }
})
