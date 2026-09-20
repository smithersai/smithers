/**
 * A driver that replays a recorded turn instead of running a model.
 *
 * The script is a list of segments: plain event runs, and permission parks.
 * A park emits `permission-required` and `suspended`, reports the body's
 * exit as `suspended`, and waits for the answer. `once` and `always` re-drive
 * the session with the `allowed` continuation, `reject` with the `rejected`
 * one, and the rest of the script follows either. That is the shape the
 * durable engine produces (composition brief section 8): the body exits on
 * a park, and a resume runs the body again from frame zero.
 *
 * Every event is delayed by a few milliseconds so the hosted app renders a
 * turn the way it renders a live one. Tests pass `delay: 0`.
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { Deferred, type Duration, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as Driver from "./Driver.ts"
import type * as Protocol from "./Protocol.ts"

/**
 * One run of events, or one park.
 *
 * @category models
 * @since 1.0.0
 */
export type Segment =
  | { readonly _tag: "events"; readonly events: ReadonlyArray<AgentEvent.AgentEvent> }
  | {
    readonly _tag: "permission"
    readonly request: AgentEvents.PermissionRequired["request"]
    readonly allowed: ReadonlyArray<AgentEvent.AgentEvent>
    readonly rejected: ReadonlyArray<AgentEvent.AgentEvent>
  }

/**
 * A recorded turn.
 *
 * @category models
 * @since 1.0.0
 */
export interface Script {
  readonly segments: ReadonlyArray<Segment>
}

/**
 * How the driver is built.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The turn to replay, or a function of the prompt that chooses one. */
  readonly script: Script | ((input: Driver.StartInput) => Script)
  /** The pause between events. Forty milliseconds by default. */
  readonly delay?: Duration.Input | undefined
}

interface Running {
  readonly sink: Driver.Sink
  /** The next segment to play. */
  cursor: number
  /** The permission the session is parked on, what answers it, and what follows each answer. */
  parked:
    | {
      readonly id: string
      readonly reply: Deferred.Deferred<Protocol.PermissionReply>
      readonly allowed: ReadonlyArray<AgentEvent.AgentEvent>
      readonly rejected: ReadonlyArray<AgentEvent.AgentEvent>
    }
    | undefined
  fiber: Fiber.Fiber<void> | undefined
  readonly script: Script
  readonly steered: Array<string>
}

/**
 * Builds the driver.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<Driver.Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    /** Where every play is forked: a disposed driver plays nothing on. */
    const scope = yield* Scope.Scope
    const sessions = new Map<string, Running>()
    const delay = options.delay ?? "40 millis"

    const emit = (run: Running, events: ReadonlyArray<AgentEvent.AgentEvent>) =>
      Effect.forEach(events, (event) => Effect.andThen(Effect.sleep(delay), run.sink.event(event)), { discard: true })

    /** Plays segments from the cursor until the script ends or parks. */
    const play = (sessionID: string, run: Running): Effect.Effect<void> =>
      Effect.gen(function*() {
        while (run.cursor < run.script.segments.length) {
          const segment = run.script.segments[run.cursor]!
          if (segment._tag === "events") {
            yield* emit(run, segment.events)
            run.cursor += 1
            continue
          }
          const reply = yield* Deferred.make<Protocol.PermissionReply>()
          run.parked = { id: segment.request.requestId, reply, allowed: segment.allowed, rejected: segment.rejected }
          yield* emit(run, [
            new AgentEvents.PermissionRequired({
              eventType: "flows.harness.permission-required.v1",
              request: segment.request
            }),
            new AgentEvents.Suspended({
              eventType: "flows.harness.suspended.v1",
              reason: new EngineLike.SuspendReason({
                code: "permission-required",
                message: `Permission required: ${segment.request.capability.action}`
              })
            })
          ])
          return
        }
        sessions.delete(sessionID)
      })

    /** Forks one drive of the body and reports its exit through the sink. */
    const drive = (sessionID: string, run: Running): Effect.Effect<void> =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkIn(
          play(sessionID, run).pipe(
            Effect.onExit((exit) => {
              run.fiber = undefined
              if (Exit.isSuccess(exit)) {
                return run.sink.closed(run.parked === undefined ? { _tag: "completed" } : { _tag: "suspended" })
              }
              sessions.delete(sessionID)
              return run.sink.closed({ _tag: "interrupted" })
            })
          ),
          scope
        )
        run.fiber = fiber
        // An interrupted drive is an exit like any other: the sink already heard about it.
        yield* Fiber.await(fiber)
      })

    const start: Driver.Service["start"] = (input, sink) =>
      Effect.gen(function*() {
        if (sessions.has(input.sessionID)) {
          return yield* new Driver.DriverError({ code: "busy", message: `Session ${input.sessionID} is busy` })
        }
        const script = typeof options.script === "function" ? options.script(input) : options.script
        const run: Running = { sink, cursor: 0, parked: undefined, fiber: undefined, script, steered: [] }
        sessions.set(input.sessionID, run)
        yield* drive(input.sessionID, run)
      })

    const interrupt: Driver.Service["interrupt"] = (sessionID) =>
      Effect.gen(function*() {
        const run = sessions.get(sessionID)
        if (run === undefined) return false
        if (run.fiber !== undefined) {
          yield* Fiber.interrupt(run.fiber)
          return true
        }
        sessions.delete(sessionID)
        yield* run.sink.closed({ _tag: "interrupted" })
        return true
      })

    const permission: Driver.Service["permission"] = (input) =>
      Effect.gen(function*() {
        const run = sessions.get(input.sessionID)
        if (run === undefined) {
          return yield* new Driver.DriverError({
            code: "unknown_session",
            message: `Session ${input.sessionID} has no running turn`
          })
        }
        const parked = run.parked
        if (parked === undefined || parked.id !== input.permissionID) {
          return yield* new Driver.DriverError({
            code: "unknown_permission",
            message: `Permission ${input.permissionID} is not pending`
          })
        }
        run.parked = undefined
        run.cursor += 1
        yield* Deferred.succeed(parked.reply, input.response)
        const continuation = input.response === "reject" ? parked.rejected : parked.allowed
        const resumed: Running = {
          ...run,
          script: { segments: [{ _tag: "events", events: continuation }, ...run.script.segments.slice(run.cursor)] },
          cursor: 0
        }
        sessions.set(input.sessionID, resumed)
        // The script has nothing durable to record, so the answer is safe the
        // moment the park is cleared; the replay itself is the resume.
        return drive(input.sessionID, resumed)
      })

    const steer: Driver.Service["steer"] = (sessionID, text) =>
      Effect.sync(() => {
        const run = sessions.get(sessionID)
        if (run === undefined) return false
        run.steered.push(text)
        return true
      })

    const resumeOnBoot: Driver.Service["resumeOnBoot"] = () => Effect.void

    return { start, interrupt, permission, steer, resumeOnBoot }
  })

/**
 * The scripted driver as a layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<Driver.Driver> => Layer.effect(Driver.Driver, make(options))
