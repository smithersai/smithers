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
 * the parked execution. An abort answers every pending card `reject` on the
 * stream, then interrupts the driver, whose exit closes the projection. A
 * rename or an archive from the app is applied on the same queue as the
 * turn's own writes and folded into the open turn, so a title set mid-turn
 * is what the turn's next `session.updated` carries. At boot the driver
 * re-drives every turn that was open when the process last stopped, and the
 * projection of each is re-opened so the replay updates the cards the app
 * already shows.
 *
 * Health runs beside the fold: when a folded event hands out facts, an
 * evaluation is forked on its own fiber with the `Evaluator` the host
 * installed, and its decision comes back through the same queue, so the
 * title dot and the health card land in order with the cards. The decision
 * is recorded in the store. A slow or failed evaluation never touches the
 * turn: the deadline is inside `Health.evaluate`, and a decision that
 * arrives after the turn ended is recorded and otherwise dropped.
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Context, Deferred, Effect, Layer, Option, Queue, Schedule, Schema, Scope } from "effect"
import * as Driver from "./Driver.ts"
import * as Events from "./Events.ts"
import * as Health from "./Health.ts"
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
  /** The parts as sent; a text part's `id` is echoed back so the app confirms the part it already shows. */
  readonly parts: ReadonlyArray<
    { readonly id?: string | undefined; readonly type: string; readonly text?: string | undefined }
  >
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
  /** The frame budget the health state reports. */
  readonly maxFrames?: number | undefined
  /** The seat's price, for the cost on the session and the message. */
  readonly pricing?: Projection.Pricing | undefined
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
  /**
   * Applies the app's edit to a session (`PATCH /session/:id`: a rename, an
   * archive) in order with the turn's own writes, and folds it into the
   * open turn, so the turn's next `session.updated` carries it. `None` when
   * the session does not exist.
   */
  readonly update: (
    sessionID: string,
    edit: (session: Protocol.Session) => Protocol.Session
  ) => Effect.Effect<Option.Option<Protocol.Session>, Store.StoreError>
  /** The status of every session that is not idle. */
  readonly status: () => Effect.Effect<Record<string, Protocol.SessionStatus>>
  /**
   * Resolves once the session has no open turn. `POST /session/:id/message`,
   * the synchronous prompt route the TUI uses, answers with the finished
   * message, so it waits here for the turn it just opened. A session that
   * is already idle resolves at once.
   */
  readonly settled: (sessionID: string) => Effect.Effect<void>
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
    // The run summary is a synthetic text part: the person never read it as an answer.
    const text = message.parts.flatMap((part) => part.type === "text" && part.synthetic !== true ? [part.text] : [])
      .join("").trim()
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
 * The id of the user message's text part: the id the app sent with its
 * first text part, so the optimistic part it already shows is confirmed
 * rather than doubled, else one derived from the message.
 *
 * @category conversions
 * @since 1.0.0
 */
export const userPartID = (userMessageID: string, parts: PromptInput["parts"]): string =>
  parts.find((part) => part.type === "text" && typeof part.id === "string")?.id ??
    Ids.part(userMessageID, { frame: 0, slot: 0, ordinal: 0 })

/**
 * Builds the composition.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options
): Effect.Effect<Service, never, Driver.Driver | Store.Store | Events.Events | Evaluator.Evaluator | Scope.Scope> =>
  Effect.gen(function*() {
    const driver = yield* Driver.Driver
    const store = yield* Store.Store
    const hub = yield* Events.Events
    const evaluator = yield* Evaluator.Evaluator
    /** Where every fiber the composition starts is forked: the drives, the steers, the answers, and the health evaluations end with it. */
    const scope = yield* Scope.Scope
    const ctx: Projection.Context = {
      directory: options.directory,
      now: () => Date.now(),
      maxFrames: options.maxFrames,
      pricing: options.pricing
    }
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
        (event) => Effect.andThen(whileLocked(store.apply(event)), hub.publish(event)),
        { discard: true }
      )

    /**
     * Applies a step: keeps its state until the turn ends, then stores and
     * publishes its events, and forks a health evaluation when the step
     * hands out facts. A store failure is logged, never thrown.
     */
    const apply = (sessionID: string, step: Projection.Step): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (step.state.closed) states.delete(sessionID)
        else states.set(sessionID, step.state)
        yield* emit(step.events).pipe(
          Effect.catchCause((cause) => Effect.logError({ message: "The turn could not be stored", cause }))
        )
        if (step.health !== undefined && !step.state.closed) {
          yield* Effect.forkIn(evaluateHealth(sessionID, step.state.assistantMessageID, step.health), scope)
        }
      })

    /**
     * One health evaluation on its own fiber: the decision is queued behind
     * whatever the fold is doing, so the title and the card land in order.
     */
    const evaluateHealth = (sessionID: string, messageID: string, facts: Health.Facts): Effect.Effect<void> =>
      Health.evaluate(facts).pipe(
        Effect.provideService(Evaluator.Evaluator, evaluator),
        Effect.flatMap((evaluation) =>
          Effect.asVoid(Queue.offer(jobs, { _tag: "health", sessionID, messageID, facts, evaluation }))
        )
      )

    /** Records a decision, whether or not the turn is still open. */
    const record = (job: HealthJob, at: number): Effect.Effect<void> =>
      store.putHealth({
        type: Health.recordType,
        sessionID: job.sessionID,
        messageID: job.messageID,
        frame: job.facts.frame,
        at,
        color: job.evaluation.decision.color,
        reason: job.evaluation.decision.reason,
        answers: job.evaluation.answers,
        latencyMs: job.evaluation.latencyMs,
        usage: job.evaluation.usage,
        error: job.evaluation.error,
        state: Health.toState(job.facts)
      }).pipe(
        Effect.catchCause((cause) => Effect.logError({ message: "The health decision could not be stored", cause }))
      )

    /**
     * One edit from the app (a rename, an archive), in order with the turn's
     * own writes: the edit is applied to the session as the store holds it
     * now, folded into the open turn's state so every `session.updated` the
     * turn emits from here carries it, then stored and published. The
     * answer, or the store failure, goes back to the route.
     */
    const edit = (job: Update): Effect.Effect<void> =>
      whileLocked(store.getSession(job.sessionID)).pipe(
        Effect.flatMap((stored) =>
          Option.isNone(stored) ? Effect.succeed(stored) : Effect.gen(function*() {
            const edited = job.edit(stored.value)
            const state = states.get(job.sessionID)
            if (state !== undefined) states.set(job.sessionID, Projection.adopt(state, edited))
            yield* emit([{ type: "session.updated", properties: { sessionID: job.sessionID, info: edited } }])
            return Option.some(edited)
          })
        ),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(job.result, exit))
      )

    /**
     * The `reject` for every card the person never answered, which is also
     * what takes each one out of the store. A card is moot once the turn is
     * over, and the app takes a card down on `permission.replied` alone, so a
     * request left pending at the close keeps a card on screen for a session
     * that reads idle and answers 404 when it is clicked.
     */
    const mootCards = (sessionID: string): Effect.Effect<Array<Protocol.Emitted>> =>
      Effect.map(Effect.orDie(store.listPermissions(sessionID)), (pending) =>
        pending.map((request) => ({
          type: "permission.replied",
          properties: { sessionID, requestID: request.id, reply: "reject" }
        })))

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
        else if (job._tag === "update") yield* edit(job)
        else if (job._tag === "emit") {
          yield* emit(job.events).pipe(
            Effect.catchCause((cause) => Effect.logError({ message: "The event could not be stored", cause }))
          )
        } else if (state !== undefined && job._tag === "event") {
          yield* apply(job.sessionID, Projection.fold(ctx, state, job.event))
        } else if (state !== undefined && job._tag === "close") {
          // The moot cards go down with the close, not only at the abort,
          // because a frame that parks a moment after the Stop writes its
          // request after the abort has already swept, and that card would
          // outlive the turn on a session the app reads as idle.
          const closed = Projection.close(ctx, state, job.closing)
          yield* apply(job.sessionID, {
            ...closed,
            events: [...closed.events, ...yield* mootCards(job.sessionID)]
          })
        } else if (job._tag === "health") {
          yield* record(job, ctx.now())
          if (state !== undefined && state.assistantMessageID === job.messageID) {
            yield* apply(job.sessionID, Projection.health(ctx, state, job.facts, job.evaluation))
          }
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
                ? { _tag: "failed", message: outcome.message, provider: outcome.provider }
                : { _tag: "failed", message: "The turn ended without an answer" }
            })
          )
    })

    /**
     * Opens a turn for a stored prompt: the projection writes the header and
     * the busy status, and the driver is forked with a sink for the session.
     */
    const open = (
      session: Protocol.Session,
      userMessageID: string,
      partID: string,
      text: string,
      agent: string,
      model: Protocol.ModelRef,
      userCreatedAt?: number
    ): Effect.Effect<void, Store.StoreError> =>
      Effect.gen(function*() {
        // The answer's id, and so the execution id, is derived from the
        // prompt's: a prompt the app retries runs the same execution, which
        // the engine answers from its row.
        const assistantMessageID = Ids.reply(userMessageID)
        // The tail is the conversation before this prompt: the prompt itself
        // is the task, and a retried prompt is already stored.
        const tail = history((yield* store.listMessages(session.id)).filter((m) => m.info.id !== userMessageID))
        yield* commit({
          _tag: "open",
          sessionID: session.id,
          step: Projection.open(ctx, {
            session,
            userMessageID,
            userPartID: partID,
            assistantMessageID,
            prompt: text,
            agent,
            model,
            userCreatedAt
          })
        })
        const sink = sinkFor(session.id)
        yield* Effect.forkIn(
          driver.start(
            { sessionID: session.id, messageID: assistantMessageID, prompt: text, history: tail, agent, model },
            sink
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError({ message: "The turn could not start", cause }).pipe(
                Effect.andThen(sink.closed({ _tag: "failed", message: "The turn could not start" }))
              )
            )
          ),
          scope
        )
      })

    /**
     * Steers a prompt into the running turn. When the driver has no turn to
     * take it (the turn ended between the status check and the steer, as it
     * does when the person types right after Stop), the prompt is not
     * dropped: it opens the next turn once the projection has closed.
     */
    const steerOrOpen = (
      session: Protocol.Session,
      userMessageID: string,
      partID: string,
      text: string,
      agent: string,
      model: Protocol.ModelRef
    ): Effect.Effect<void, Store.StoreError> =>
      Effect.gen(function*() {
        if (yield* driver.steer(session.id, text)) return
        while (states.has(session.id)) yield* Effect.sleep(steerRetryDelay)
        yield* open(session, userMessageID, partID, text, agent, model)
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
        const partID = userPartID(userMessageID, input.parts)
        const agent = input.agent ?? options.agent
        const model = input.model ?? options.model
        const stored = yield* store.getMessage(userMessageID)
        if (Option.isSome(stored)) {
          // A retry of a prompt already taken: stored once, steered once, and
          // answered once. Only an answer the session lost (idle, no finish)
          // runs again, as the same execution.
          if (states.has(input.sessionID)) return
          const answer = yield* store.getMessage(Ids.reply(userMessageID))
          if (Option.isSome(answer) && answer.value.role === "assistant" && answer.value.finish !== undefined) return
          return yield* open(session.value, userMessageID, partID, text, agent, model, stored.value.time.created)
        }
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
                    id: partID,
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
          // Forked into the composition's scope: the queue's write waits for
          // the frame's own transaction, and the app expects the prompt route
          // to answer at once.
          yield* Effect.forkIn(
            steerOrOpen(session.value, userMessageID, partID, text, agent, model).pipe(
              Effect.catchCause((cause) => Effect.logError({ message: "The prompt could not open a turn", cause }))
            ),
            scope
          )
          return
        }
        yield* open(session.value, userMessageID, partID, text, agent, model)
      })

    /**
     * Interrupts the driver; when the driver has nothing to interrupt but a
     * turn is open (the driver has not registered it yet, or lost it), the
     * projection is closed anyway so the app does not stay busy.
     */
    const abort: Service["abort"] = (sessionID) =>
      Effect.gen(function*() {
        // The card goes down at once, so the app does not keep a question the
        // person has already answered with Stop. The close sweeps again, for
        // the request a frame that parks just after the Stop writes.
        const moot = yield* mootCards(sessionID)
        if (moot.length > 0) yield* commit({ _tag: "emit", sessionID, events: moot })
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
        // The row says a card is open; this process's own turn is what can act
        // on the answer. A second server started over the same directory reads
        // the same rows and would take the row down, publish the reply on its
        // own hub, and hand the answer to a driver with no turn to resume,
        // leaving the parked turn on the other server busy for good. A row
        // without an open turn here is not this server's to answer.
        if (!states.has(input.sessionID)) {
          return yield* new TurnsError({
            code: "unknown_permission",
            message:
              `Permission ${input.permissionID} belongs to no turn this server is running; another server may be serving this directory`
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
        yield* Effect.forkIn(
          driver.permission(input).pipe(
            Effect.catchCause((cause) => Effect.logError({ message: "The permission could not be answered", cause }))
          ),
          scope
        )
      })

    const update: Service["update"] = (sessionID, edit) =>
      Effect.gen(function*() {
        const result = yield* Deferred.make<Option.Option<Protocol.Session>, Store.StoreError>()
        yield* Queue.offer(jobs, { _tag: "update", sessionID, edit, result })
        return yield* Deferred.await(result)
      })

    const settled: Service["settled"] = (sessionID) =>
      Effect.gen(function*() {
        while (states.has(sessionID)) yield* Effect.sleep(settleRetryDelay)
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
          const userMessageID = assistant?.parentID ?? Ids.make("message")
          yield* commit({
            _tag: "open",
            sessionID: input.sessionID,
            step: Projection.open(ctx, {
              session: session.value,
              userMessageID,
              userPartID: userPartID(userMessageID, []),
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

    // A turn this boot re-opened may be parked on a permission. Its card is
    // not re-published here: nothing is listening yet, and the buffer is not
    // what a fresh stream reads. `Routes` tells each stream what is open as
    // it connects, which reaches the client that has to answer.
    yield* driver.resumeOnBoot(reopen).pipe(
      Effect.catchCause((cause) => Effect.logError({ message: "Open turns could not be resumed", cause }))
    )

    return { prompt, abort, permission, update, status, settled }
  })

/**
 * The composition as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<Turns, never, Driver.Driver | Store.Store | Events.Events | Evaluator.Evaluator> =>
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

/**
 * How long a prompt the running turn could not take waits between looks at
 * whether the projection has closed, before it opens the next turn.
 *
 * @category constants
 * @since 1.0.0
 */
export const steerRetryDelay = "25 millis"

/**
 * How long `settled` waits between looks at the open turn. The synchronous
 * prompt route holds a request for the length of a turn, so the cost of a
 * look is one map read per session per interval.
 *
 * @category constants
 * @since 1.0.0
 */
export const settleRetryDelay = "25 millis"

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

/** An edit from the app, answered once it is stored. */
interface Update {
  readonly _tag: "update"
  readonly sessionID: string
  readonly edit: (session: Protocol.Session) => Protocol.Session
  readonly result: Deferred.Deferred<Option.Option<Protocol.Session>, Store.StoreError>
  readonly done?: Deferred.Deferred<void> | undefined
}

/** A health decision coming back from its fiber. */
interface HealthJob {
  readonly _tag: "health"
  readonly sessionID: string
  readonly messageID: string
  readonly facts: Health.Facts
  readonly evaluation: Health.Evaluation
  readonly done?: Deferred.Deferred<void> | undefined
}

type Job = Open | Event | Close | Emit | Update | HealthJob

/**
 * Retries a store call while the database is held by another writer, on
 * the `storeRetryDelay` and `storeRetries` schedule.
 *
 * @category combinators
 * @since 1.0.0
 */
export const whileLocked = <A>(effect: Effect.Effect<A, Store.StoreError>): Effect.Effect<A, Store.StoreError> =>
  Effect.retry(effect, { while: isLocked, schedule: Schedule.spaced(storeRetryDelay), times: storeRetries })

/**
 * Whether a store failure is the database being held by another writer,
 * which is the one failure a later attempt can succeed at.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isLocked = (error: Store.StoreError): boolean => {
  // `effect/sql` wraps the driver's failure as `SqlError { reason }`, and
  // `String(cause)` renders only the outer message, never the lock.
  const reason = (error.cause as { readonly reason?: LockReason } | undefined)?.reason
  if (reason?._tag === "LockTimeoutError") return true
  return /database is locked|SQLITE_BUSY/i.test(String(reason?.cause?.message ?? reason?.message ?? error.cause))
}

/** The shape of an `SqlError` reason, as far as the lock predicate reads it. */
interface LockReason {
  readonly _tag?: unknown
  readonly message?: unknown
  readonly cause?: { readonly message?: unknown } | undefined
}
