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
 * the projection. At boot the driver re-drives every turn that was open
 * when the process last stopped, and the projection of each is re-opened
 * so the replay updates the cards the app already shows.
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Context, Deferred, Effect, Layer, Option, Queue, Schedule, Schema, type Scope } from "effect"
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
 * How much of the conversation a follow-up carries into its turn, in
 * characters.
 *
 * @category constants
 * @since 1.0.0
 */
export const historyCap = 4096

/**
 * The conversation tail a follow-up prompt carries: every user prompt and
 * every final answer so far, oldest first, cut from the front to
 * `historyCap` characters. `undefined` when the session has no history.
 *
 * @category conversions
 * @since 1.0.0
 */
export const history = (messages: ReadonlyArray<Store.MessageWithParts>, cap = historyCap): string | undefined => {
  const lines: Array<string> = []
  for (const message of messages) {
    const text = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim()
    if (text === "") continue
    lines.push(`${message.info.role === "user" ? "Person" : "Assistant"}: ${text}`)
  }
  if (lines.length === 0) return undefined
  const joined = lines.join("\n\n")
  return joined.length <= cap ? joined : `[earlier turns omitted]\n${joined.slice(joined.length - cap)}`
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
): Effect.Effect<Service, never, Driver.Driver | Store.Store | Events.Events | Scope.Scope> =>
  Effect.gen(function*() {
    const driver = yield* Driver.Driver
    const store = yield* Store.Store
    const hub = yield* Events.Events
    const ctx: Projection.Context = { directory: options.directory, now: () => Date.now() }
    const states = new Map<string, Projection.State>()

    /**
     * One event, stored then published. The engine holds a write transaction
     * for the length of a step, and a store write that lands inside it finds
     * the database locked, so the write waits and retries until the step
     * commits; only then is the event published, so the stream never says
     * something the history route does not.
     */
    const emit = (events: ReadonlyArray<Protocol.Emitted>) =>
      Effect.forEach(
        events,
        (event) =>
          Effect.andThen(
            Effect.retry(store.apply(event), {
              while: isLocked,
              schedule: Schedule.spaced(storeRetryDelay),
              times: storeRetries
            }),
            hub.publish(event)
          ),
        { discard: true }
      )

    /**
     * Applies a step: keeps its state until the turn ends, then stores and
     * publishes its events. A store failure is logged, never thrown.
     */
    const apply = (sessionID: string, step: Projection.Step): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (step.state.closed) states.delete(sessionID)
        else states.set(sessionID, step.state)
        yield* emit(step.events).pipe(
          Effect.catchCause((cause) => Effect.logError({ message: "The turn could not be stored", cause }))
        )
      })

    /**
     * The projection runs on a fiber of its own, fed in order by a queue.
     * The driver's sink runs inside the engine's frame, which holds the
     * write transaction the store needs, so a write from there would either
     * find the database locked or wait on a step that is waiting on it.
     */
    const jobs = yield* Queue.make<Job>()
    /** The sink of a turn the app already has the answer of: nothing to fold. */
    const inert: Driver.Sink = { event: () => Effect.void, closed: () => Effect.void }
    const pump = Effect.forever(
      Effect.gen(function*() {
        const job = yield* Queue.take(jobs)
        const state = states.get(job.sessionID)
        if (job._tag === "open") yield* apply(job.sessionID, job.step)
        else if (job._tag === "emit") {
          yield* emit(job.events).pipe(
            Effect.catchCause((cause) => Effect.logError({ message: "The event could not be stored", cause }))
          )
        } else if (state !== undefined && job._tag === "event") {
          yield* apply(job.sessionID, Projection.fold(ctx, state, job.event))
        } else if (state !== undefined && job._tag === "close") {
          yield* apply(job.sessionID, Projection.close(ctx, state, job.closing))
        }
        if (job.done !== undefined) yield* Deferred.succeed(job.done, undefined)
      })
    )
    yield* Effect.forkScoped(pump)

    /** Queues a job and waits until the pump has applied it. */
    const commit = (job: Job): Effect.Effect<void> =>
      Effect.gen(function*() {
        const done = yield* Deferred.make<void>()
        yield* Queue.offer(jobs, { ...job, done })
        yield* Deferred.await(done)
      })

    const sinkFor = (sessionID: string): Driver.Sink => ({
      event: (event) => Effect.asVoid(Queue.offer(jobs, { _tag: "event", sessionID, event })),
      closed: (outcome) =>
        outcome._tag === "suspended"
          ? Effect.void
          : Effect.asVoid(
            Queue.offer(jobs, {
              _tag: "close",
              sessionID,
              closing: outcome._tag === "interrupted"
                ? { _tag: "interrupted" }
                : outcome._tag === "failed"
                ? { _tag: "failed", message: outcome.message }
                : { _tag: "failed", message: "The turn ended without an answer" }
            })
          )
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
          yield* commit({
            _tag: "emit",
            sessionID: input.sessionID,
            events: [
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
            ]
          })
          // Forked: the queue's write waits for the frame's own transaction,
          // and the app expects the prompt route to answer at once.
          yield* Effect.forkDetach(driver.steer(input.sessionID, text))
          return
        }
        const assistantMessageID = Ids.make("message")
        const tail = history(yield* store.listMessages(input.sessionID))
        yield* commit({
          _tag: "open",
          sessionID: input.sessionID,
          step: Projection.open(ctx, {
            session: session.value,
            userMessageID,
            assistantMessageID,
            prompt: text,
            agent,
            model
          })
        })
        const sink = sinkFor(input.sessionID)
        yield* Effect.forkDetach(
          driver.start(
            { sessionID: input.sessionID, messageID: assistantMessageID, prompt: text, history: tail, agent, model },
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
        // A card the person never answered is moot once the turn is over.
        const pending = yield* Effect.orDie(store.listPermissions(sessionID))
        yield* Effect.orDie(Effect.forEach(pending, (request) => store.deletePermission(request.id), { discard: true }))
        if (yield* driver.interrupt(sessionID)) return true
        if (!states.has(sessionID)) return false
        yield* commit({ _tag: "close", sessionID, closing: { _tag: "interrupted" } })
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
        yield* commit({
          _tag: "emit",
          sessionID: input.sessionID,
          events: [{
            type: "permission.replied",
            properties: { sessionID: input.sessionID, requestID: input.permissionID, reply: input.response }
          }]
        })
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

    /**
     * Re-opens the projection of a turn the driver found open at boot. A
     * turn whose answer was already stored is left alone: its sink ignores
     * everything.
     */
    const reopen = (input: Driver.StartInput): Effect.Effect<Driver.Sink, Store.StoreError> =>
      Effect.gen(function*() {
        const session = yield* store.getSession(input.sessionID)
        if (Option.isNone(session)) return inert
        const header = yield* store.getMessage(input.messageID)
        const assistant = Option.isSome(header) && header.value.role === "assistant" ? header.value : undefined
        if (assistant?.finish !== undefined) return inert
        if (!states.has(input.sessionID)) {
          yield* commit({
            _tag: "open",
            sessionID: input.sessionID,
            step: Projection.open(ctx, {
              session: session.value,
              userMessageID: assistant?.parentID ?? Ids.make("message"),
              assistantMessageID: input.messageID,
              prompt: input.prompt,
              agent: input.agent ?? options.agent,
              model: input.model ?? options.model,
              createdAt: assistant?.time.created
            })
          })
        }
        return sinkFor(input.sessionID)
      })

    yield* driver.resumeOnBoot(reopen).pipe(
      Effect.catchCause((cause) => Effect.logError({ message: "Open turns could not be resumed", cause }))
    )

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

/**
 * How long a store write waits between attempts while the engine holds the
 * database, and how many times it tries: a step's transaction spans a model
 * call, so the wait covers one.
 *
 * @category constants
 * @since 1.0.0
 */
export const storeRetryDelay = "20 millis"

/**
 * How many times a store write is retried while the database is locked.
 *
 * @category constants
 * @since 1.0.0
 */
export const storeRetries = 6_000

interface Open {
  readonly _tag: "open"
  readonly sessionID: string
  readonly step: Projection.Step
  readonly done?: Deferred.Deferred<void> | undefined
}

interface Event {
  readonly _tag: "event"
  readonly sessionID: string
  readonly event: AgentEvent.AgentEvent
  readonly done?: Deferred.Deferred<void> | undefined
}

interface Close {
  readonly _tag: "close"
  readonly sessionID: string
  readonly closing: Projection.Closing
  readonly done?: Deferred.Deferred<void> | undefined
}

/** Events that belong to no projection state: a steered prompt, a permission answer. */
interface Emit {
  readonly _tag: "emit"
  readonly sessionID: string
  readonly events: ReadonlyArray<Protocol.Emitted>
  readonly done?: Deferred.Deferred<void> | undefined
}

type Job = Open | Event | Close | Emit

/**
 * Whether a store failure is the database being held by another writer,
 * which is the one failure a later attempt can succeed at.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isLocked = (error: Store.StoreError): boolean =>
  /database is locked|LockTimeoutError/.test(String(error.cause))
