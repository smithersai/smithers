import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import type * as Arr from "effect/Array"
import { AgentRuntimeContextSchema, composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { runDurable } from "./Boundary"
import { handleCloudRoleTurn, isCloudRoleTurn, turnHints } from "./cloudRoleTurn"
import type { TurnRequest } from "./cloudRoleTurn"
import { ServerConfig } from "./Config"
import type { ServerConfigShape } from "./Config"
import { DurableStorage, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { ExecutionContext } from "./Environment"
import type { ExecutionContextShape } from "./Environment"
import { StorageFailure, UpstreamUnreachable } from "./Failures"
import type { BodyUnreadable } from "./Failures"
import { fetchWithDeadline, readJsonOrUndefined, readText, Transport } from "./Http"
import type { ValidatedIdentity } from "./identity"
import {
  causeMessage,
  ISOLATION_HEADERS,
  json,
  readBody,
  TRANSCRIPT_TOO_LARGE,
  upstreamFailureMessage,
  upstreamUnreachable,
  withIsolationHeaders
} from "./Responses"

/*
 * The two routes that spend a model credential, and the kill switch over them.
 *
 * Server-side turn cancellation, the workerd-legal way. workerd forbids
 * touching another request's I/O (the old route aborted the turn handler's
 * AbortController cross-request and 500'd), so cancellation state lives in a
 * Durable Object keyed by runId — the one shared, transactional store two
 * requests may both reach. The cancel route only flips that state; the turn
 * handler polls it between NDJSON chunks (each poll is the turn request's own
 * I/O) and aborts ITS OWN upstream fetch when it sees the registration is no
 * longer active.
 *
 * Every registration carries a GENERATION: the cleanup of one turn (a delayed
 * EOF, a late settle) can never touch the continuation leg that re-registered
 * the same runId after it, because the registry only honours the generation
 * it minted for that leg.
 */

/* ------------------------------------------------------------------------ */
/* The registry state machine (pure)                                         */
/* ------------------------------------------------------------------------ */

/** The binding surfaces, as the tests and wrangler see them. */
export type TurnCancelStorage = NativeStorage
export type TurnCancelNamespace = NativeNamespace

type TurnCancelStateName = "active" | "cancelled" | "settled"

interface TurnCancelState {
  readonly state: TurnCancelStateName
  /** Minted at registration; every later call must name it. A pre-generation record never matches. */
  readonly generation?: string
  readonly at: number
  /**
   * The validated login that registered the run, when the deployment has an
   * identity seam. Only the owner may cancel an owned registration; an
   * ownerless one (local dev, no seam) is cancellable by anyone, as before.
   */
  readonly owner?: string
}

/** Internal headers between this Worker and its Durable Object: the login, and the registration's generation. */
export const TURN_OWNER_HEADER = "x-turn-owner"
export const TURN_GENERATION_HEADER = "x-turn-generation"

/** The one persisted key of the registry object. */
const TURN_STATE_KEY = "state"

/**
 * A turn that never settled (its request died before the stream ended) must
 * not hold its runId hostage forever: an "active" registration older than
 * this is treated as settled. Turns are seconds long; ten minutes is far
 * beyond any honest stream.
 */
export const STALE_ACTIVE_MS = 10 * 60 * 1000

export type Registration =
  | { readonly status: "started"; readonly generation: string }
  | { readonly status: "already-running" }
export type CancelOutcome = "cancelled" | "not-found" | "forbidden"

const stateAt = (state: TurnCancelStateName, generation: string, at: number, owner?: string): TurnCancelState => ({
  state,
  generation,
  at,
  ...(owner === undefined ? {} : { owner })
})

const isStale = (current: TurnCancelState | undefined, now: number): boolean =>
  current?.state === "active" && now - current.at > STALE_ACTIVE_MS

const isLive = (current: TurnCancelState | undefined, now: number): current is TurnCancelState =>
  current?.state === "active" && !isStale(current, now)

const matches = (current: TurnCancelState | undefined, generation: string | undefined): boolean =>
  current?.generation !== undefined && generation === current.generation

interface Step<Outcome> {
  readonly outcome: Outcome
  readonly write?: TurnCancelState
}

const registerStep = (current: TurnCancelState | undefined, now: number, owner: string | undefined, generation: string): Step<Registration> =>
  isLive(current, now)
    ? { outcome: { status: "already-running" } }
    : { outcome: { status: "started", generation }, write: stateAt("active", generation, now, owner) }

type CurrentOutcome = { readonly status: "active"; readonly generation: string } | { readonly status: "not-found" | "forbidden" }

/** Resolve the public runId to its live generation, for the owner only. */
const currentStep = (current: TurnCancelState | undefined, now: number, owner: string | undefined): CurrentOutcome => {
  if (!isLive(current, now) || current.generation === undefined) return { status: "not-found" }
  if (current.owner !== undefined && owner !== current.owner) return { status: "forbidden" }
  return { status: "active", generation: current.generation }
}

const cancelStep = (
  current: TurnCancelState | undefined,
  now: number,
  owner: string | undefined,
  generation: string | undefined
): Step<CancelOutcome> => {
  if (!matches(current, generation) || !isLive(current, now)) return { outcome: "not-found" }
  if (current.owner !== undefined && owner !== current.owner) return { outcome: "forbidden" }
  return { outcome: "cancelled", write: stateAt("cancelled", current.generation!, now, current.owner) }
}

const settleStep = (current: TurnCancelState | undefined, now: number, generation: string | undefined): Step<"settled" | "not-found"> => {
  if (current === undefined || !matches(current, generation)) return { outcome: "not-found" }
  return current.state === "settled"
    ? { outcome: "settled" }
    : { outcome: "settled", write: stateAt("settled", current.generation!, now, current.owner) }
}

/** What the state read reports: a stale, absent, or foreign-generation registration is unknown. */
const stateStep = (current: TurnCancelState | undefined, now: number, generation: string | undefined): string =>
  !matches(current, generation) || isStale(current, now) || current === undefined ? "unknown" : current.state

/* ------------------------------------------------------------------------ */
/* The Durable Object                                                        */
/* ------------------------------------------------------------------------ */

/**
 * One registry object per runId. The protocol: POST /register (answers the
 * generation), GET /current (the owner's live generation), POST /cancel,
 * POST /settle, GET /state — the last three scoped by `x-turn-generation`.
 */
export const turnCancelRequest = (request: Request): Effect.Effect<Response, never, DurableStorage> =>
  Effect.gen(function* () {
    const storage = yield* DurableStorage
    const now = yield* Clock.currentTimeMillis
    const owner = request.headers.get(TURN_OWNER_HEADER) ?? undefined
    const generation = request.headers.get(TURN_GENERATION_HEADER) ?? undefined
    const current = yield* storage.get<TurnCancelState>(TURN_STATE_KEY)
    const answer = (body: unknown): Response => Response.json(body)
    const commit = <Outcome>(step: Step<Outcome>) =>
      Effect.as(step.write === undefined ? Effect.void : storage.put(TURN_STATE_KEY, step.write), step.outcome)
    switch (new URL(request.url).pathname) {
      case "/register": {
        const minted = yield* Effect.sync(() => crypto.randomUUID())
        return answer(yield* commit(registerStep(current, now, owner, minted)))
      }
      case "/current":
        return answer(currentStep(current, now, owner))
      case "/cancel":
        return answer({ status: yield* commit(cancelStep(current, now, owner, generation)) })
      case "/settle":
        return answer({ status: yield* commit(settleStep(current, now, generation)) })
      case "/state":
        return answer({ state: stateStep(current, now, generation) })
      default:
        return new Response("not found", { status: 404 })
    }
  }).pipe(
    Effect.catch((failure) => Effect.succeed(Response.json({ status: "error", message: failure.message }, { status: 500 })))
  )

export class TurnCancelRegistry {
  constructor(private readonly ctx: { readonly storage: NativeStorage }) {}

  fetch(request: Request): Promise<Response> {
    return runDurable(turnCancelRequest(request).pipe(Effect.provide(storageLayer(this.ctx.storage))))
  }
}

/* ------------------------------------------------------------------------ */
/* The Worker-side service                                                   */
/* ------------------------------------------------------------------------ */

export interface TurnCancelsShape {
  /** Claim the runId for a turn; a live registration refuses a second one. */
  readonly register: (runId: string, owner?: string) => Effect.Effect<Registration, StorageFailure>
  /** Resolve the runId's live generation for this owner and flip it to cancelled. */
  readonly cancel: (runId: string, owner?: string) => Effect.Effect<CancelOutcome, StorageFailure>
  /** Mark the generation finished so a later cancel answers an honest not-found. Never fails; a failure is logged. */
  readonly settle: (runId: string, generation: string) => Effect.Effect<void>
  /** Whether the generation is no longer active: cancelled, settled, replaced, or unknown. */
  readonly isCancelled: (runId: string, generation: string) => Effect.Effect<boolean, StorageFailure>
}

export class TurnCancels extends Context.Service<TurnCancels, TurnCancelsShape>()("smithers-server/TurnCancels") {}

const REGISTRY_ORIGIN = "https://turn-cancel.internal"
const REGISTRY_SEAM = "The turn registry"
const KNOWN_STATES: ReadonlyArray<string> = ["active", "cancelled", "settled", "unknown"]

const registryHeaders = (owner: string | undefined, generation: string | undefined): Record<string, string> => ({
  ...(owner === undefined ? {} : { [TURN_OWNER_HEADER]: owner }),
  ...(generation === undefined ? {} : { [TURN_GENERATION_HEADER]: generation })
})

const statusOf = (body: unknown): string | undefined =>
  typeof body === "object" && body !== null && "status" in body && typeof body.status === "string" ? body.status : undefined

const invalidAnswer = (operation: string, detail: string): StorageFailure =>
  new StorageFailure({ operation, cause: new Error(detail) })

/** The registry reached through its namespace binding: one subrequest per call. */
const namespacedTurnCancels = (namespace: NativeNamespace): TurnCancelsShape => {
  const call = (runId: string, path: string, init?: RequestInit): Effect.Effect<Response, StorageFailure> =>
    // The stub lookup is synchronous: an id the binding refuses is a bug, not
    // an unreachable registry, and stays a defect.
    Effect.sync(() => namespace.get(namespace.idFromName(runId))).pipe(
      Effect.flatMap((stub) =>
        Effect.tryPromise({
          try: () => stub.fetch(new Request(`${REGISTRY_ORIGIN}${path}`, init)),
          catch: (cause) => new StorageFailure({ operation: `turnCancellation${path}`, cause })
        })
      )
    )
  return {
    register: (runId, owner) =>
      call(runId, "/register", { method: "POST", headers: registryHeaders(owner, undefined) }).pipe(
        // A registry that answers its own 500 (a storage failure) is the
        // registry failing, not a turn already running: the route answers 502.
        Effect.flatMap((response) =>
          response.ok
            ? readJsonOrUndefined(response)
            : Effect.flatMap(readText(response).pipe(Effect.catch(() => Effect.succeed(""))), (detail) =>
              Effect.fail(invalidAnswer("turnCancellation/register", `Registry register returned ${response.status}${detail === "" ? "" : `: ${detail}`}`)))
        ),
        Effect.map((body): Registration => {
          const generation = typeof body === "object" && body !== null && "generation" in body ? body.generation : undefined
          return statusOf(body) === "started" && typeof generation === "string"
            ? { status: "started", generation }
            : { status: "already-running" }
        })
      ),
    cancel: (runId, owner) =>
      Effect.gen(function* () {
        const current = yield* call(runId, "/current", { headers: registryHeaders(owner, undefined) }).pipe(
          Effect.flatMap(readJsonOrUndefined)
        )
        const status = statusOf(current)
        if (status === "forbidden" || status === "not-found") return status
        const generation = typeof current === "object" && current !== null && "generation" in current ? current.generation : undefined
        if (status !== "active" || typeof generation !== "string") {
          return yield* invalidAnswer("turnCancellation/current", "Invalid turn registry current response")
        }
        const cancelled = yield* call(runId, "/cancel", { method: "POST", headers: registryHeaders(owner, generation) }).pipe(
          Effect.flatMap(readJsonOrUndefined)
        )
        const outcome = statusOf(cancelled)
        return outcome === "cancelled" || outcome === "forbidden" ? outcome : "not-found"
      }),
    settle: (runId, generation) =>
      call(runId, "/settle", { method: "POST", headers: registryHeaders(undefined, generation) }).pipe(
        Effect.flatMap((response): Effect.Effect<string, BodyUnreadable | StorageFailure> =>
          response.ok
            ? readText(response)
            : Effect.fail(invalidAnswer("turnCancellation/settle", `Registry settle returned ${response.status}`))
        ),
        Effect.asVoid,
        Effect.catch((failure: BodyUnreadable | StorageFailure) =>
          Effect.sync(() => console.error("turn registry settle failed:", failure.cause)))
      ),
    isCancelled: (runId, generation) =>
      call(runId, "/state", { headers: registryHeaders(undefined, generation) }).pipe(
        Effect.flatMap((response) =>
          Effect.map(readJsonOrUndefined(response), (body) => {
            const state = typeof body === "object" && body !== null && "state" in body ? body.state : undefined
            if (!response.ok || typeof state !== "string" || !KNOWN_STATES.includes(state)) {
              throw invalidAnswer("turnCancellation/state", "Invalid turn registry state response")
            }
            // A replaced registration must not leave its old upstream running.
            return state !== "active"
          })
        ),
        Effect.catchDefect((defect) =>
          defect instanceof StorageFailure ? Effect.fail(defect) : Effect.die(defect)
        )
      )
  }
}

/** The registry: the runId's Durable Object. Bound on every deployment; tests bind the real class over memory. */
export const turnCancelsLayer = (namespace: NativeNamespace): Layer.Layer<TurnCancels> =>
  Layer.succeed(TurnCancels, namespacedTurnCancels(namespace))

/** The 502 a registry that cannot be reached earns on the routes that must talk to it. */
const registryUnreachable = (failure: StorageFailure): Response =>
  upstreamUnreachable(REGISTRY_SEAM, new UpstreamUnreachable({ seam: REGISTRY_SEAM, cause: failure.cause }))

/* ------------------------------------------------------------------------ */
/* The tagged NDJSON pump                                                    */
/* ------------------------------------------------------------------------ */

/** How often the streaming pump re-checks the kill state while the upstream is silent, at first. */
export const CANCEL_POLL_MS = 500
/** The poll backs off during silence up to this interval, and resets when data flows. */
export const CANCEL_POLL_MAX_MS = 5000
/**
 * At most eight minutes of silent monitoring, below the stale registration
 * window and with ample subrequests reserved for auth, inference and cleanup.
 */
export const CANCEL_POLL_LIMIT = 96

/**
 * The poll is a Durable Object subrequest, and a Worker request may only make
 * ~1000 of those — a token-streamed turn delivers far more chunks than that,
 * so polling once per chunk would kill long turns with "Too many subrequests".
 * The poll backs off during silence to CANCEL_POLL_MAX_MS. Also, because
 * workerd's clock only advances on I/O — at least one every
 * CANCEL_POLL_CHUNKS chunks, so a fast stream can never starve the check.
 */
export const CANCEL_POLL_CHUNKS = 64

export const MONITORING_LIMIT_ERROR = "The turn exceeded its cancellation monitoring limit. Try again."
export const MONITORING_LOST_ERROR = "The turn lost cancellation monitoring. Try again."

/**
 * The turn's own view of its lifecycle. `isCancelled` reads the runId's
 * registry — every read is this request's own subrequest, which workerd
 * allows, unlike touching another request's AbortController. `abort` ends the
 * turn's OWN upstream fetch. `settle` marks the turn finished, once.
 */
export interface TurnStreamHooks {
  readonly isCancelled: Effect.Effect<boolean, StorageFailure>
  readonly abort: (reason: string) => Effect.Effect<void>
  readonly settle: Effect.Effect<void>
}

/** One frame or line of the upstream stream, re-tagged for the client. */
const tagLine = (line: string, runId: string, upstreamRunId: string | undefined): { readonly bytes: string; readonly done: boolean } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return { bytes: `${line}\n`, done: false }
  const done = (parsed as { type?: unknown }).type === "done"
  // Upstream-generated approvals can echo the charge id. Keep those
  // correlated with the client's turn as well; unrelated workflow run
  // identities inside cards remain untouched.
  const card = "card" in parsed ? parsed.card : undefined
  if (upstreamRunId !== undefined && typeof card === "object" && card !== null && "payload" in card) {
    const payload = card.payload
    if (typeof payload === "object" && payload !== null && "runId" in payload && payload.runId === upstreamRunId) {
      parsed = { ...parsed, card: { ...card, payload: { ...payload, runId } } }
    }
  }
  return { bytes: `${JSON.stringify({ ...(parsed as object), runId })}\n`, done }
}

type KillReason = "cancelled" | "limit" | "unavailable"

const terminalFrame = (runId: string, reason: KillReason): string =>
  `${JSON.stringify(reason === "cancelled"
    ? { runId, type: "done", reason: "cancelled" }
    : { runId, type: "done", reason: "stop", error: reason === "limit" ? MONITORING_LIMIT_ERROR : MONITORING_LOST_ERROR })}\n`

/**
 * Stamp each upstream frame with the turn's runId. The upstream wire frame
 * carries none (the dev boundary's CloudAgent adds it on publish; this Worker
 * is that boundary for the deployed app), and the client's stream reader
 * drops frames that don't name their turn — an untouched pass-through would
 * be a silent stall. Unparseable lines pass through verbatim.
 *
 * The terminal `done` frame also settles the kill state — here, while the
 * frame is still in the pull, never later: a tool-loop continuation leg
 * re-POSTs the same runId the instant the client reads that frame, and must
 * not meet a stale 409 from a registration the stream lifecycle hadn't
 * settled yet.
 *
 * A server-side kill surfaces between chunks: the pump re-reads the registry
 * before every upstream read and on a timer tick while the upstream is
 * silent, and when the registration is no longer active — or the registry
 * cannot be read, or the monitoring allowance is spent — it aborts ITS OWN
 * upstream fetch (legal — same request context), emits an honest terminal
 * `done` frame, and ends. The turn never completes silently after a kill.
 *
 * The stream's finalizer settles the registry and releases the upstream
 * reader on every exit: the end of the body, the kill, a failed read, and
 * the interruption a client that went away causes (the response boundary
 * interrupts the pump fiber from the ReadableStream's `cancel`).
 */
export const taggedTurnFrames = (
  body: ReadableStream<Uint8Array>,
  runId: string,
  hooks: TurnStreamHooks,
  upstreamRunId?: string
): Stream.Stream<Uint8Array> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let settled = false
  let finished = false
  let ended = false
  // One pending upstream read at a time, held across pulls: a timer tick that
  // wins the race leaves the read in place for the next pull instead of
  // issuing a second read on the same reader (which would throw).
  let pendingRead: ReturnType<typeof reader.read> | undefined
  let lastPollAt = 0
  let chunksSincePoll = CANCEL_POLL_CHUNKS
  let pollInterval = CANCEL_POLL_MS
  let polls = 0

  const settleOnce = Effect.suspend(() => {
    if (settled) return Effect.void
    settled = true
    return hooks.settle
  })

  const releaseUpstream = (reason: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (finished) return Effect.void
      finished = true
      return Effect.promise(() =>
        reader.cancel(reason).catch((error: unknown) => console.error("turn upstream cancel failed:", error))
      )
    })

  // Rate-limited kill check: skipped once the turn has settled (the registry
  // entry is then free for the next leg, and a later "cancelled" on it is not
  // this stream's business) and while neither the clock nor the chunk count
  // says another poll is due.
  const killed: Effect.Effect<KillReason | false> = Effect.gen(function* () {
    if (settled) return false
    const now = yield* Clock.currentTimeMillis
    if (now - lastPollAt < pollInterval && chunksSincePoll < CANCEL_POLL_CHUNKS) return false
    if (polls >= CANCEL_POLL_LIMIT) return "limit"
    polls += 1
    lastPollAt = now
    chunksSincePoll = 0
    const read = yield* Effect.result(hooks.isCancelled)
    if (Result.isFailure(read)) {
      yield* Effect.sync(() => console.error("turn registry state failed:", read.failure.cause))
      return "unavailable"
    }
    return read.success ? "cancelled" : false
  })

  const pull: Effect.Effect<Arr.NonEmptyReadonlyArray<Uint8Array>, Cause.Done<void>> = Effect.gen(function* () {
    if (ended) return yield* Cause.done()
    for (;;) {
      const reason = yield* killed
      if (reason !== false) {
        yield* hooks.abort(reason)
        yield* releaseUpstream(reason)
        yield* settleOnce
        ended = true
        return [encoder.encode(terminalFrame(runId, reason))] as const
      }
      pendingRead ??= reader.read()
      const read = Effect.promise(() => pendingRead!)
      const result = settled
        ? yield* read
        : yield* Effect.raceFirst(read, Effect.sleep(pollInterval).pipe(Effect.as("tick" as const)))
      if (result === "tick") {
        // Keep the pending read alive; force the elapsed poll even as the
        // next wait backs off.
        chunksSincePoll = CANCEL_POLL_CHUNKS
        pollInterval = Math.min(pollInterval * 2, CANCEL_POLL_MAX_MS)
        continue
      }
      pollInterval = CANCEL_POLL_MS
      pendingRead = undefined
      chunksSincePoll += 1
      const { value, done } = result
      if (done) finished = true
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split("\n")
      buffer = done ? "" : (lines.pop() ?? "")
      const out: Array<Uint8Array> = []
      for (const line of lines) {
        if (line.trim() === "") continue
        const tagged = tagLine(line, runId, upstreamRunId)
        if (tagged.done) yield* settleOnce
        out.push(encoder.encode(tagged.bytes))
      }
      if (done) {
        yield* settleOnce
        ended = true
      }
      if (out.length > 0) return out as unknown as Arr.NonEmptyReadonlyArray<Uint8Array>
      if (done) return yield* Cause.done()
    }
  })

  return Stream.fromPull(Effect.succeed(pull)).pipe(
    Stream.ensuring(
      Effect.gen(function* () {
        // Reached without the stream ending on its own terms: the client hung
        // up (the pump fiber was interrupted) or a read failed.
        if (!ended) yield* hooks.abort("client disconnected")
        yield* settleOnce
        yield* releaseUpstream("client disconnected")
      })
    )
  )
}

/* ------------------------------------------------------------------------ */
/* Settlement                                                                */
/* ------------------------------------------------------------------------ */

/**
 * One settlement per turn, whoever asks first: the done frame, the kill, the
 * client hanging up, an upstream that never answered. It runs as work the
 * platform keeps alive past the response (`waitUntil`), because the client
 * that disconnected is not waiting for it; every caller still waits for the
 * one settlement to finish, so a continuation leg never races it.
 */
const sharedSettlement = (
  ctx: ExecutionContextShape,
  settle: Effect.Effect<void>
): Effect.Effect<Effect.Effect<void>> =>
  Effect.map(Deferred.make<void>(), (done) => {
    let started = false
    return Effect.suspend(() => {
      if (!started) {
        started = true
        return Effect.andThen(ctx.waitUntil(settle.pipe(Effect.ensuring(Deferred.succeed(done, undefined)))), Deferred.await(done))
      }
      return Deferred.await(done)
    })
  })

/* ------------------------------------------------------------------------ */
/* The chat upstream                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Where managed inference lives, and how this Worker authenticates to it.
 *
 * Both model-spending routes — the turn path and the browser chain's relay —
 * call the SAME upstream with the SAME credentials, so there is one place that
 * decides what a Smithers-authenticated inference request looks like. The
 * upstream owns the provider key, prices the turn against the rate card, and
 * meters it durably; nothing downstream of here has to reproduce any of that.
 *
 * Wave 13 (D-2): a session-validated call is metered onto the USER's own
 * billing account — the chat worker attributes the charge to the vouched login
 * (complimentary: cost recorded, $0 debited), so the user's receipt shows the
 * usage and their balance never moves. The token pair is the chat worker's
 * trusted-caller door; a client can never inject it, because this header set is
 * BUILT here and the caller's own headers are never forwarded. Without the
 * configured token the call still runs — metering then attributes to the
 * deployment account, exactly as before that path existed.
 */
export const chatUpstreamHeaders = (
  config: ServerConfigShape,
  runId: string,
  session: ValidatedIdentity | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: config.chatOrigin ?? "https://smithers.sh",
    "x-smithers-run-id": runId
  }
  if (config.chatAuthToken !== undefined) {
    headers.authorization = `Bearer ${Redacted.value(config.chatAuthToken)}`
  }
  if (session !== undefined && config.chatProductServiceToken !== undefined) {
    headers["x-smithers-service-token"] = Redacted.value(config.chatProductServiceToken)
    headers["x-user-login"] = session.login
  }
  return headers
}

const MODEL_SEAM = "The model service"

/* ------------------------------------------------------------------------ */
/* The turn route                                                            */
/* ------------------------------------------------------------------------ */

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
  typeof value === "object" &&
  value !== null &&
  "runId" in value &&
  typeof value.runId === "string" &&
  value.runId !== "" &&
  "messages" in value &&
  Array.isArray(value.messages) &&
  "instructions" in value &&
  typeof value.instructions === "string" &&
  (!("tools" in value) || Array.isArray(value.tools)) &&
  (!("context" in value) ||
    value.context === undefined ||
    AgentRuntimeContextSchema.safeParse(value.context).success)

/** The turn request, or the refusal its body earns. Read once: the router reads it before the gate decides. */
export const readStartTurn = (request: Request): Effect.Effect<TurnRequest | Response> =>
  Effect.map(readBody(request, TRANSCRIPT_TOO_LARGE), (body) => {
    if (body instanceof Response) return body
    if (!isStartTurnRequest(body)) {
      return json(400, {
        status: "error",
        message: "Body must be { runId, messages, instructions } with optional tools and context."
      })
    }
    // The hints (tier, purpose, role) are read leniently: an unknown value is
    // dropped here, never refused (cloudRoleTurn.ts turnHints).
    return {
      runId: body.runId,
      messages: body.messages,
      instructions: body.instructions,
      ...(body.tools === undefined ? {} : { tools: body.tools }),
      ...(body.context === undefined ? {} : { context: body.context }),
      ...turnHints(body)
    } as const
  })

export type TurnServices = Transport | ServerConfig | TurnCancels | ExecutionContext

/**
 * One turn: registered under its runId, forwarded to the chat upstream with a
 * server-owned charge id, and streamed back re-tagged. The client's own
 * disconnect is fiber interruption (the native adapter wires the request's
 * signal to it): before the response exists it aborts the upstream fetch and
 * settles the registration; once the response is streaming, the pump fiber
 * observes it through the body's `cancel` and settles from its finalizer.
 */
export const handleTurn = (
  request: Request,
  session?: ValidatedIdentity,
  parsed?: TurnRequest
): Effect.Effect<Response, never, TurnServices> =>
  Effect.gen(function* () {
    const body = parsed ?? (yield* readStartTurn(request))
    if (body instanceof Response) return body
    // A cloud role (librarian, flows) is answered here on Cerebras, never upstream.
    if (isCloudRoleTurn(body)) return yield* handleCloudRoleTurn(body, ISOLATION_HEADERS)
    const cancels = yield* TurnCancels
    // The registry is the cross-isolate authority on duplicate turns.
    const registered = yield* Effect.result(cancels.register(body.runId, session?.login))
    if (Result.isFailure(registered)) {
      yield* Effect.sync(() => console.error("turn registry register failed:", registered.failure.cause))
      return registryUnreachable(registered.failure)
    }
    const registration = registered.success
    if (registration.status !== "started") {
      return json(409, { status: "error", message: "That Smithers turn is already running." })
    }
    const generation = registration.generation
    const ctx = yield* ExecutionContext
    const settle = yield* sharedSettlement(ctx, cancels.settle(body.runId, generation))
    const config = yield* ServerConfig
    // The turn's OWN upstream fetch, which a kill observed between chunks aborts.
    const upstream = new AbortController()
    // The caller's id correlates frames and cancellation only. Every
    // inference request needs a server-owned charge id, including retries:
    // reusing a client id must never hide a second provider invocation.
    const upstreamRunId = crypto.randomUUID()
    const forward = fetchWithDeadline(
      MODEL_SEAM,
      config.chatUrl,
      {
        method: "POST",
        signal: upstream.signal,
        headers: chatUpstreamHeaders(config, upstreamRunId, session),
        body: JSON.stringify({
          messages: body.messages,
          // The hidden runtime context renders server-side into the
          // instructions — same composition as the native/dev CloudAgent.
          instructions: composeAgentInstructions(body.instructions, body.context),
          // The tool-loop contract (Wave 3b): the one tool spec rides every
          // turn; the upstream emits tool_call frames the client answers
          // with function_call_output continuation items in `messages`.
          ...(body.tools === undefined ? {} : { tools: body.tools }),
          // The model hints ride the wire as the native CloudAgent sends them;
          // the upstream maps them to a model or answers on its default.
          ...(body.tier === undefined ? {} : { tier: body.tier }),
          ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
          ...(body.role === undefined ? {} : { role: body.role })
        })
      },
      config.upstreamTimeoutMs
    )
    return yield* Effect.gen(function* () {
      const fetched = yield* Effect.result(forward)
      if (Result.isFailure(fetched)) {
        yield* settle
        const failure = fetched.failure
        if (failure._tag === "UpstreamTimeout") return upstreamUnreachable(MODEL_SEAM, failure)
        return json(502, {
          status: "error",
          message: `Smithers Cloud chat is unreachable: ${causeMessage(failure.cause)}`
        })
      }
      const response = fetched.success
      if (!response.ok || response.body === null) {
        yield* settle
        const detail = yield* readText(response).pipe(Effect.catch(() => Effect.succeed("")))
        return json(response.ok ? 502 : response.status, {
          status: "error",
          message: response.ok
            ? "The model service accepted the turn and then sent no answer at all. Nothing was charged."
            : upstreamFailureMessage(response.status, detail, response.headers.get("retry-after"))
        })
      }
      // Stream the upstream NDJSON through with the run tagged on every frame so
      // the client can match it to its turn; a terminal frame, a kill observed
      // between chunks, or a closed connection settles the registry entry. The
      // pump runs in its own fiber from here: the response outlives this one.
      const hooks: TurnStreamHooks = {
        isCancelled: cancels.isCancelled(body.runId, generation),
        abort: (reason) => Effect.sync(() => upstream.abort(reason)),
        settle
      }
      const readable = yield* Stream.toReadableStreamEffect(taggedTurnFrames(response.body, body.runId, hooks, upstreamRunId))
      return withIsolationHeaders(
        new Response(readable, {
          status: 200,
          headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" }
        })
      )
    }).pipe(
      // The client went away before the response existed: the fetch is
      // already aborted by the interruption; the registration must not hold
      // the runId hostage.
      Effect.onInterrupt(() => settle)
    )
  })

/* ------------------------------------------------------------------------ */
/* The model relay                                                           */
/* ------------------------------------------------------------------------ */

/*
 * The chain backend's model relay (DESIGN.md §14, D1) — and, since the browser
 * chain became the only backend, the one route a chat turn spends a model on.
 *
 * The browser runs the real @smthrs/model request/stream machinery against this
 * path and the relay forwards it, unchanged, to the SAME managed-inference
 * upstream `/api/agent/turn` uses (`chatUpstreamHeaders` above). That upstream
 * owns the metered provider keys, authorizes the balance BEFORE calling the
 * provider, and enqueues the turn's authoritative usage onto the durable
 * metering queue, so the relay inherits per-user metering rather than
 * reproducing it. The one provider credential this Worker does hold is the
 * free Cerebras key (CEREBRAS_API_KEY), spent only by the command recommender
 * (recommend.ts) and the cloud role turns (cloudRoleTurn.ts), never by this
 * relay.
 *
 * The router gates the route before any of this runs: anonymous callers get
 * 401, non-allowlisted ones 403, and the per-login turn ceiling applies — all
 * of it decided before a single upstream byte is spent.
 */

const isModelStreamBody = (value: unknown): value is { readonly messages: ReadonlyArray<unknown> } =>
  typeof value === "object" &&
  value !== null &&
  "messages" in value &&
  Array.isArray((value as { readonly messages?: unknown }).messages) &&
  (value as { readonly messages: ReadonlyArray<unknown> }).messages.length > 0

const hasTools = (value: object): boolean =>
  "tools" in value &&
  Array.isArray((value as { readonly tools?: unknown }).tools) &&
  ((value as { readonly tools: ReadonlyArray<unknown> }).tools.length > 0)

export const handleModelStream = (
  request: Request,
  session: ValidatedIdentity | undefined
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const body = yield* readBody(request, TRANSCRIPT_TOO_LARGE)
    if (body instanceof Response) return body
    if (!isModelStreamBody(body)) {
      return json(400, { status: "error", message: "Body must carry a non-empty messages array." })
    }
    // The sealed-step law, enforced at the boundary: the author call carries no
    // tools, so a tool-bearing request has no business on this relay.
    if (hasTools(body)) {
      return json(400, { status: "error", message: "The model relay serves sealed author calls only — no tools." })
    }
    /*
     * The run id is minted HERE, never read from the caller. Upstream derives
     * the charge's idempotency key from it, so a client that could choose it
     * could replay one receipt and take every later call for free.
     */
    const runId = crypto.randomUUID()
    const config = yield* ServerConfig
    const fetched = yield* Effect.result(
      fetchWithDeadline(
        MODEL_SEAM,
        config.chatUrl,
        {
          method: "POST",
          headers: chatUpstreamHeaders(config, runId, session),
          body: JSON.stringify(body)
        },
        config.upstreamTimeoutMs
      )
    )
    if (Result.isFailure(fetched)) {
      const failure = fetched.failure
      if (failure._tag === "UpstreamTimeout") return upstreamUnreachable(MODEL_SEAM, failure)
      return json(502, {
        status: "error",
        message: `The model service is unreachable: ${causeMessage(failure.cause)}`
      })
    }
    const response = fetched.success
    if (!response.ok || response.body === null) {
      const detail = yield* readText(response).pipe(Effect.catch(() => Effect.succeed("")))
      return json(response.ok ? 502 : response.status, {
        status: "error",
        message: response.ok
          ? "The model service accepted the request and then sent no answer at all."
          : upstreamFailureMessage(response.status, detail, response.headers.get("retry-after"))
      })
    }
    return withIsolationHeaders(
      new Response(response.body, {
        status: 200,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/x-ndjson",
          "cache-control": "no-store"
        }
      })
    )
  })

/* ------------------------------------------------------------------------ */
/* The kill route                                                            */
/* ------------------------------------------------------------------------ */

/**
 * workerd-legal kill: never touch the turn request's I/O from here — just
 * flip the registry state. The turn's own streaming pump observes the
 * registration is no longer active between chunks, aborts its own upstream
 * fetch, then ends the stream with an honest terminal frame.
 */
export const handleCancel = (
  request: Request,
  session: ValidatedIdentity | undefined
): Effect.Effect<Response, never, TurnCancels> =>
  Effect.gen(function* () {
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const runId = typeof body === "object" && body !== null && "runId" in body ? body.runId : undefined
    if (typeof runId !== "string" || runId === "") {
      return json(400, { status: "error", message: "runId is required." })
    }
    const cancels = yield* TurnCancels
    const outcome = yield* Effect.result(cancels.cancel(runId, session?.login))
    if (Result.isFailure(outcome)) {
      yield* Effect.sync(() => console.error("turn registry cancel failed:", outcome.failure.cause))
      return registryUnreachable(outcome.failure)
    }
    if (outcome.success === "forbidden") {
      return json(403, { status: "error", message: "That turn belongs to a different account." })
    }
    return json(200, { status: outcome.success })
  })
