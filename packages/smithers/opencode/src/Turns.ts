/**
 * One turn per prompt: the composition of the driver, the projection, the
 * store, and the hub.
 *
 * A prompt on an idle session opens a turn (the projection writes the user
 * message, the assistant header, and the busy status), forks the driver, and
 * folds every harness event it reports into OpenCode events that are stored
 * and then published, in that order, so the stream never says something the
 * history route does not. A prompt on a busy session is stored as a user
 * message and steered into the running turn. A permission answer is
 * published as `permission.replied` and handed to the driver, which resumes
 * the parked execution. An abort interrupts the driver, whose exit closes
 * the projection.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Driver from "./Driver.ts"
import * as Events from "./Events.ts"
import * as Ids from "./Ids.ts"
import * as Projection from "./Projection.ts"
import type * as Protocol from "./Protocol.ts"
import * as Store from "./Store.ts"

/**
 * What the app sends on `POST /session/:id/prompt_async`.
 *
 * @category models
 * @since 1.0.0
 */
export interface PromptInput {
  readonly sessionID: string
  readonly messageID?: string | undefined
  readonly agent?: string | undefined
  readonly model?: Protocol.ModelRef | undefined
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string | undefined }>
}

/**
 * The failures a turn request reports.
 *
 * @category errors
 * @since 1.0.0
 */
export class TurnsError extends Schema.TaggedError<TurnsError>()("@smthrs/opencode/TurnsError", {
  code: Schema.Literals(["unknown_session", "unknown_permission", "empty_prompt"]),
  message: Schema.String
}) {}

/**
 * How turns are configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly directory: string
  /** The agent name a turn runs as when the app names none. */
  readonly agent: string
  /** The model a turn runs on when the app names none. */
  readonly model: Protocol.ModelRef
}

/**
 * What the composition does.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly prompt: (input: PromptInput) => Effect.Effect<void, TurnsError | Store.StoreError>
  readonly abort: (sessionID: string) => Effect.Effect<boolean>
  readonly permission: (input: Driver.PermissionInput) => Effect.Effect<void, TurnsError | Store.StoreError>
  /** The status of every session that is not idle. */
  readonly status: () => Effect.Effect<Record<string, Protocol.SessionStatus>>
}

/**
 * The turns service.
 *
 * @category services
 * @since 1.0.0
 */
export class Turns extends Context.Service<Turns, Service>()("@smthrs/opencode/Turns") {}

/**
 * The text of a prompt's parts, joined.
 *
 * @category conversions
 * @since 1.0.0
 */
export const promptText = (parts: PromptInput["parts"]): string =>
  parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n")

/**
 * Builds the composition.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options
): Effect.Effect<Service, never, Driver.Driver | Store.Store | Events.Events> =>
  Effect.gen(function*() {
    const driver = yield* Driver.Driver
    const store = yield* Store.Store
    const hub = yield* Events.Events
    const ctx: Projection.Context = { directory: options.directory, now: () => Date.now() }
    const states = new Map<string, Projection.State>()

    const emit = (events: ReadonlyArray<Protocol.Emitted>) =>
      Effect.forEach(events, (event) => Effect.andThen(store.apply(event), hub.publish(event)), { discard: true })

    /**
     * Stores and publishes a step, and keeps its state until the turn ends.
     * A store failure is logged, never thrown into the run.
     */
    const commit = (sessionID: string, step: Projection.Step): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (step.state.closed) states.delete(sessionID)
        else states.set(sessionID, step.state)
        yield* emit(step.events).pipe(
          Effect.catchCause((cause) => Effect.logError({ message: "The turn could not be stored", cause }))
        )
      })

    const sinkFor = (sessionID: string): Driver.Sink => ({
      event: (event) =>
        Effect.suspend(() => {
          const state = states.get(sessionID)
          return state === undefined ? Effect.void : commit(sessionID, Projection.fold(ctx, state, event))
        }),
      closed: (outcome) =>
        Effect.suspend(() => {
          const state = states.get(sessionID)
          if (state === undefined || outcome._tag === "suspended") return Effect.void
          const closing: Projection.Closing = outcome._tag === "interrupted"
            ? { _tag: "interrupted" }
            : outcome._tag === "failed"
            ? { _tag: "failed", message: outcome.message }
            : { _tag: "failed", message: "The turn ended without an answer" }
          return commit(sessionID, Projection.close(ctx, state, closing))
        })
    })

    const prompt: Service["prompt"] = (input) =>
      Effect.gen(function*() {
        const session = yield* store.getSession(input.sessionID)
        if (Option.isNone(session)) {
          return yield* new TurnsError({ code: "unknown_session", message: `Session ${input.sessionID} not found` })
        }
        const text = promptText(input.parts)
        if (text.trim() === "") {
          return yield* new TurnsError({ code: "empty_prompt", message: "The prompt has no text" })
        }
        const userMessageID = input.messageID ?? Ids.make("message")
        const agent = input.agent ?? options.agent
        const model = input.model ?? options.model
        if (states.has(input.sessionID)) {
          const now = ctx.now()
          const user: Protocol.UserMessage = {
            id: userMessageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: now },
            agent,
            model
          }
          yield* emit([
            { type: "message.updated", properties: { sessionID: input.sessionID, info: user } },
            {
              type: "message.part.updated",
              properties: {
                sessionID: input.sessionID,
                part: {
                  id: Ids.part(userMessageID, { frame: 0, slot: 0, ordinal: 0 }),
                  sessionID: input.sessionID,
                  messageID: userMessageID,
                  type: "text",
                  text
                },
                time: now
              }
            }
          ])
          yield* driver.steer(input.sessionID, text)
          return
        }
        const assistantMessageID = Ids.make("message")
        yield* commit(
          input.sessionID,
          Projection.open(ctx, {
            session: session.value,
            userMessageID,
            assistantMessageID,
            prompt: text,
            agent,
            model
          })
        )
        const sink = sinkFor(input.sessionID)
        yield* Effect.forkDetach(
          driver.start(
            { sessionID: input.sessionID, messageID: assistantMessageID, prompt: text, agent, model },
            sink
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError({ message: "The turn could not start", cause }).pipe(
                Effect.andThen(sink.closed({ _tag: "failed", message: "The turn could not start" }))
              )
            )
          )
        )
      })

    /**
     * Interrupts the driver; when the driver has nothing to interrupt but a
     * turn is open (the driver has not registered it yet, or lost it), the
     * projection is closed anyway so the app does not stay busy.
     */
    const abort: Service["abort"] = (sessionID) =>
      Effect.gen(function*() {
        if (yield* driver.interrupt(sessionID)) return true
        const state = states.get(sessionID)
        if (state === undefined) return false
        yield* commit(sessionID, Projection.close(ctx, state, { _tag: "interrupted" }))
        return true
      })

    const permission: Service["permission"] = (input) =>
      Effect.gen(function*() {
        const pending = yield* store.listPermissions(input.sessionID)
        if (!pending.some((request) => request.id === input.permissionID)) {
          return yield* new TurnsError({
            code: "unknown_permission",
            message: `Permission ${input.permissionID} is not pending`
          })
        }
        yield* emit([{
          type: "permission.replied",
          properties: { sessionID: input.sessionID, requestID: input.permissionID, reply: input.response }
        }])
        yield* Effect.forkDetach(
          driver.permission(input).pipe(
            Effect.catchCause((cause) => Effect.logError({ message: "The permission could not be answered", cause }))
          )
        )
      })

    const status: Service["status"] = () =>
      Effect.sync(() => {
        const out: Record<string, Protocol.SessionStatus> = {}
        for (const sessionID of states.keys()) out[sessionID] = { type: "busy" }
        return out
      })

    return { prompt, abort, permission, status }
  })

/**
 * The composition as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<Turns, never, Driver.Driver | Store.Store | Events.Events> =>
  Layer.effect(Turns, make(options))
