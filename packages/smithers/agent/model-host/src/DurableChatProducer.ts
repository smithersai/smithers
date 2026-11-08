/**
 * Commits model frames to the durable Go turn journal under a fenced grant.
 *
 * @since 1.0.0-rc.0
 */

import type { ModelStep } from "@smthrs/agent"

import { type Model, ModelError } from "@smthrs/model"
import { AgentTurnJournal, ContextPreflight, type DocsPages, type NativeAgent } from "@smthrs/rpc"
import { Duration, Effect } from "effect"
import { inertCallbackTransport } from "./CallbackTransport.ts"
import type {
  CallbackAttempt,
  CallbackTransport,
  CallbackTransportObserver,
  ObservedCallbackTransport
} from "./CallbackTransport.ts"
import { runContextPreflight } from "./ContextPreflight.ts"
import { createHostDiagnostics } from "./HostDiagnostics.vibe"
import type { HostDiagnosticFields, HostDiagnostics } from "./HostDiagnostics.vibe"
import { apiCaller, runHostTurn, sourceLister, sourceReader } from "./HostTools.ts"
import { CommitRefused, ProducerUnreachable, ProviderStartRefused, ReceiptMismatch } from "./ModelHostError.vibe"
import type { ProducerError } from "./ModelHostError.vibe"
import type { ModelTurnOptions } from "./ModelTurnHost.vibe"

// performance.now() belongs to this host process. A distinct identity prevents
// comparing receipts from a producer restart as though they shared a clock.
const preflightClock = `host monotonic:${crypto.randomUUID()}`

/**
 * One short-lived capability for an already accepted chat turn.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface DurableChatGrant {
  readonly turnId: string
  readonly ownerId: number
  readonly repositoryId?: number
  readonly runId: string
  readonly legId: string
  readonly generation: number
  readonly token: string
  readonly cursor: AgentTurnJournal.AgentTurnCursor
  readonly expiresAt: string
  readonly request: NativeAgent.StartAgentTurnRequest
  /** Trusted install origin for API forwarding when the callback uses a private listener. */
  readonly installOrigin?: string
  readonly producerBaseUrl: string
  /** The mirrored repository the turn's author may read; absent until Source is ready for them. */
  readonly source?: { readonly repository: string }
  /** Backend-verified Active-main Markdown; never taken from the browser request. */
  readonly agentInstructions?: string
  /**
   * Host-only public API authority for the current producer generation.
   * The author's login addresses private cards; the bearer is never model input.
   */
  readonly api?: { readonly author: string; readonly token: string }
}

type CommitReply = Extract<AgentTurnJournal.AgentTurnJournalReply, { readonly status: "committed" | "duplicate" }>

/**
 * How long one journal callback attempt may go unanswered.
 *
 * A hosted guest reaches its journal through the sandbox's egress proxy, and
 * nothing below this host bounds that call: `fetch` has no default deadline.
 * Production turn 2d851bdd attempted its first commit 1 ms after its first
 * provider event, and the guest's own records show that one attempt still
 * `pending` half an hour later with no socket for it in the guest's table at
 * all; turn 7e5fc00f spent 1 h 19 m there and committed nothing. An unanswered
 * callback is a transport fault whatever its cause, and a fault has to end the
 * attempt — an unbounded one spends the person's whole turn in silence and
 * produces neither output nor a receipt.
 *
 * A healthy callback is a loopback-shaped round trip: the fastest production
 * turns commit 300–500 batches in 30–60 s, and provider-start answered in
 * 424 ms under the worst conditions this investigation saw. 15 s is therefore
 * two orders of magnitude of headroom, and an attempt that exceeds it is
 * retried once on a new request before the turn fails.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const CHAT_CALLBACK_DEADLINE_MS = 15_000

// An attempt reports its phase once, however many readers ask: the failure the
// host answers the API with and the record in the guest's own log are the same
// reading, not two that could disagree. An observer that watched nothing
// reports nothing, so no failure carries an empty transport field.
const phaseOnce = (attempt: CallbackAttempt): () => HostDiagnosticFields => {
  let reported: HostDiagnosticFields | undefined
  return () => (reported ??= attempt.fields())
}

const phaseField = (phase: () => HostDiagnosticFields): { transport?: HostDiagnosticFields } => {
  const transport = phase()
  return Object.keys(transport).length === 0 ? {} : { transport }
}

const unreachable = (step: ProducerUnreachable["step"], phase: () => HostDiagnosticFields) => (): ProducerUnreachable =>
  new ProducerUnreachable({ step, message: "chat producer request failed", ...phaseField(phase) })

/**
 * Bounds one callback attempt, request and answer together.
 *
 * The attempt is built against a signal of this bound's own, which the
 * expiring deadline aborts: that closes the request's socket, so the retry
 * asks for a connection of its own instead of queueing behind a dead one. The
 * signal rather than the fiber's interruption is what carries the bound,
 * because `fetch` resolves as soon as headers arrive — a journal that answers
 * its status and then stops sending the receipt leaves a second unbounded wait
 * on the same socket, and interrupting that read alone would end the turn
 * while leaking the connection.
 */
const bounded = <A, E, R>(
  attempt: (signal: AbortSignal) => Effect.Effect<A, E, R>,
  step: ProducerUnreachable["step"],
  deadlineMillis: number,
  onTimeout: () => void,
  transport: () => HostDiagnosticFields
): Effect.Effect<A, E | ProducerUnreachable, R> =>
  Effect.suspend(() => {
    const deadline = new AbortController()
    return Effect.timeoutOrElse(Effect.suspend(() => attempt(deadline.signal)), {
      duration: Duration.millis(deadlineMillis),
      orElse: () =>
        Effect.suspend(() => {
          onTimeout()
          deadline.abort()
          return Effect.fail(
            new ProducerUnreachable({
              step,
              message: `chat producer ${step} did not answer within its deadline`,
              ...phaseField(transport)
            })
          )
        })
    })
  })

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const invalidReceipt = () => new ReceiptMismatch({ message: "chat producer commit returned an invalid receipt" })

const commitReply = (
  response: Response,
  phase: () => HostDiagnosticFields
): Effect.Effect<CommitReply, CommitRefused | ReceiptMismatch | ProducerUnreachable> =>
  response.ok
    ? Effect.tryPromise({ try: () => response.text(), catch: unreachable("commit", phase) }).pipe(
      Effect.flatMap((text) => Effect.try({ try: () => JSON.parse(text) as unknown, catch: invalidReceipt })),
      Effect.flatMap((body) => {
        const parsed = AgentTurnJournal.AgentTurnJournalReplySchema.safeParse(body)
        return parsed.success && (parsed.data.status === "committed" || parsed.data.status === "duplicate")
          ? Effect.succeed(parsed.data)
          : Effect.fail(invalidReceipt())
      })
    )
    : Effect.fail(
      new CommitRefused({ status: response.status, message: `chat producer commit refused (${response.status})` })
    )

/**
 * Writes exact, hash-checked batches for one producer generation.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class DurableChatProducer {
  private cursor: AgentTurnJournal.AgentTurnCursor
  private readonly callbackBaseUrl: string
  private readonly grant: DurableChatGrant
  private readonly fetchImpl: NativeAgent.FetchLike
  private readonly diagnostics: HostDiagnostics
  private readonly deadlineMillis: number
  private readonly transport: CallbackTransport

  constructor(
    callbackBaseUrl: string,
    grant: DurableChatGrant,
    fetchImpl: NativeAgent.FetchLike = fetch.bind(globalThis),
    diagnostics: HostDiagnostics = createHostDiagnostics({ turnId: grant.turnId }),
    deadlineMillis: number = CHAT_CALLBACK_DEADLINE_MS,
    transport: CallbackTransport = inertCallbackTransport
  ) {
    this.callbackBaseUrl = callbackBaseUrl
    this.grant = grant
    this.fetchImpl = fetchImpl
    this.diagnostics = diagnostics
    this.deadlineMillis = deadlineMillis
    this.transport = transport
    this.cursor = AgentTurnJournal.AgentTurnCursorSchema.parse(grant.cursor)
  }

  providerStarted(): Effect.Effect<void, ProducerUnreachable | ProviderStartRefused> {
    const url = new URL("/internal/chat/provider-started", this.callbackBaseUrl)
    url.searchParams.set("turnId", this.grant.turnId)
    url.searchParams.set("generation", String(this.grant.generation))
    return Effect.gen({ self: this }, function*() {
      // A callback this guest attempted is not the same fact as a connection a
      // worker observed: one says the host reached its own request, the other
      // only that something opened a tunnel.
      const settle = yield* this.diagnostics.begin("chat_callback", { step: "provider_started" })
      const probe = this.transport.begin()
      const phase = phaseOnce(probe)
      let status = 0
      let timedOut = false
      return yield* bounded(
        (deadlineSignal) =>
          Effect.tryPromise({
            try: (signal) =>
              probe.run(() =>
                this.fetchImpl(url, {
                  method: "POST",
                  // The fiber's interruption cancels a turn; the bound's own
                  // signal ends an attempt that overran. Either closes this
                  // request.
                  signal: AbortSignal.any([signal, deadlineSignal]),
                  headers: { authorization: `Bearer ${this.grant.token}` }
                })
              ),
            catch: unreachable("provider_started", phase)
          }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => {
                status = response.status
              })
            ),
            Effect.flatMap((response) =>
              response.ok ? Effect.void : Effect.fail(
                new ProviderStartRefused({
                  status: response.status,
                  message: `chat provider start refused (${response.status})`
                })
              )
            )
          ),
        "provider_started",
        this.deadlineMillis,
        () => {
          timedOut = true
        },
        phase
      ).pipe(
        // The record carries why the attempt ended, so a reader of the guest's
        // own log tells a bound that fired from a status the journal answered,
        // and reads the phase that bound fired in from the dispatcher's own
        // records rather than inferring it.
        Effect.onExit((exit) =>
          Effect.sync(() =>
            settle({
              status,
              ...(exit._tag === "Failure" ? { failed: true } : {}),
              ...(timedOut ? { timedOut: true } : {}),
              ...phase()
            })
          )
        )
      )
    })
  }

  writePreflight(
    phase: "started" | "completed",
    result: ContextPreflight.ContextPreflightResult
  ): Effect.Effect<void, ProducerError | ModelError.ModelError> {
    return Effect.gen({ self: this }, function*() {
      const at = performance.now()
      const pages: Array<ContextPreflight.ContextPreflightResult> = []
      let current: ContextPreflight.ContextPreflightResult = { ...result, candidates: [], context: [] }
      const frame: ContextPreflight.ContextPreflightFrame = {
        runId: this.grant.runId,
        type: "context.preflight",
        phase,
        at,
        clock: preflightClock,
        page: { index: Number.MAX_SAFE_INTEGER - 1, total: Number.MAX_SAFE_INTEGER },
        result: current
      }
      const bytes = (value: unknown) =>
        new TextEncoder().encode(AgentTurnJournal.agentTurnJournalDigestInput("batch", value)).byteLength
      // Canonical sizes use the journal's own encoding. Worst-case cursor
      // digits and per-item digest prefixes conservatively cover all overhead.
      const overhead = bytes({
        version: 1,
        runId: this.grant.runId,
        legId: this.grant.legId,
        batch: Number.MAX_SAFE_INTEGER,
        from: Number.MAX_SAFE_INTEGER,
        previousHash: this.cursor.hash,
        hash: this.cursor.hash,
        frames: [frame]
      })
      if (overhead > 96 * 1024) {
        return yield* Effect.fail(
          new ModelError.ModelError({
            code: "invalid_provider_output",
            message: "preflight metadata exceeds journal limit"
          })
        )
      }
      let size = overhead
      for (const field of ["candidates", "context"] as const) {
        for (const item of result[field]) {
          const cost = bytes(item) + 1
          if (overhead + cost > 96 * 1024) {
            return yield* Effect.fail(
              new ModelError.ModelError({
                code: "invalid_provider_output",
                message: "preflight item exceeds journal limit"
              })
            )
          }
          if (size + cost > 96 * 1024) {
            pages.push(current)
            current = { ...result, candidates: [], context: [] }
            size = overhead
          }
          current = { ...current, [field]: [...current[field], item] }
          size += cost
        }
      }
      pages.push(current)
      // Finish preparing every page before the first write. A refused page
      // cannot authorize provider start or the following answer request.
      for (const [index, value] of pages.entries()) {
        yield* this.write({
          runId: this.grant.runId,
          type: "context.preflight",
          phase,
          at,
          clock: preflightClock,
          page: { index, total: pages.length },
          result: value
        })
      }
    })
  }

  write(frame: NativeAgent.AgentTurnFrame): Effect.Effect<void, ProducerError> {
    return Effect.suspend(() => this.commit(frame))
  }

  private commit(frame: NativeAgent.AgentTurnFrame): Effect.Effect<void, ProducerError> {
    const expected = this.cursor
    const body = JSON.stringify({
      turnId: this.grant.turnId,
      generation: this.grant.generation,
      expected,
      frames: [frame]
    })
    const invoke = Effect.gen({ self: this }, function*() {
      const settle = yield* this.diagnostics.begin("chat_callback", { step: "commit", batch: expected.batch + 1 })
      const probe = this.transport.begin()
      const phase = phaseOnce(probe)
      let status = 0
      let timedOut = false
      // The deadline covers the receipt as well as the response: a journal
      // that sends headers and then stops wedges a turn exactly as a journal
      // that never answers does, and the bound's signal closes that socket
      // rather than ending the turn around a half-read response.
      return yield* bounded(
        (deadlineSignal) =>
          Effect.tryPromise({
            try: (signal) =>
              probe.run(() =>
                this.fetchImpl(new URL("/internal/chat/commit", this.callbackBaseUrl), {
                  method: "POST",
                  signal: AbortSignal.any([signal, deadlineSignal]),
                  headers: { "content-type": "application/json", authorization: `Bearer ${this.grant.token}` },
                  body
                })
              ),
            catch: unreachable("commit", phase)
          }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => {
                status = response.status
              })
            ),
            Effect.flatMap((response) => commitReply(response, phase))
          ),
        "commit",
        this.deadlineMillis,
        () => {
          timedOut = true
        },
        phase
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            settle({
              status,
              ...(exit._tag === "Failure" ? { failed: true } : {}),
              ...(timedOut ? { timedOut: true } : {}),
              ...phase()
            })
          )
        )
      )
    })
    return invoke.pipe(
      // Retry only a lost transport receipt, on the identical cursor and body.
      // Refusals and malformed receipts stop immediately; the durable owner
      // decides whether another attempt is authorized. A journal that
      // already took this batch answers `duplicate`, so a bound that fired on
      // an answer in flight cannot write it twice. Past the retry the turn
      // fails with a named transport failure, which the host boundary turns
      // into a terminal receipt — the person sees a failure instead of silence.
      Effect.catchTag("ProducerUnreachable", () => invoke),
      Effect.flatMap((reply) =>
        Effect.tryPromise({
          try: async () => {
            const expectedHash = await sha256Hex(AgentTurnJournal.agentTurnJournalDigestInput("batch", {
              version: 1,
              runId: expected.runId,
              legId: expected.legId,
              batch: expected.batch + 1,
              from: expected.position + 1,
              previousHash: expected.hash,
              frames: [frame]
            }))
            if (
              reply.batch.runId !== expected.runId || reply.batch.legId !== expected.legId ||
              reply.batch.batch !== expected.batch + 1 || reply.batch.from !== expected.position + 1 ||
              reply.batch.previousHash !== expected.hash || reply.batch.hash !== expectedHash ||
              reply.cursor.hash !== reply.batch.hash ||
              reply.cursor.batch !== reply.batch.batch ||
              reply.cursor.position !== reply.batch.from + reply.batch.frames.length - 1
            ) {
              throw new Error("receipt mismatch")
            }
            this.cursor = reply.cursor
          },
          catch: () => new ReceiptMismatch({ message: "chat producer receipt did not extend the committed cursor" })
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() =>
              this.diagnostics.record("chat_callback", "refused", {
                step: "commit",
                batch: expected.batch + 1,
                failed: true
              })
            )
          )
        )
      )
    )
  }
}

/** The observer a turn gets when its host composition supplies none: no phase, no runtime. */
const unobserved: CallbackTransportObserver = () => ({ ...inertCallbackTransport, runtime: {}, close: () => {} })

/**
 * Runs commands on the host until the model answers and durably commits each
 * projected frame. Documentation comes from the pages the host bundles.
 * `observeTransport` is the host's callback observer; without one, a failed
 * callback carries no transport phase.
 *
 * @category runners
 * @since 1.0.0-rc.0
 */
export const runDurableChatTurn = (
  model: Model.Model,
  grant: DurableChatGrant,
  options: ModelTurnOptions,
  callbackBaseUrl: string = grant.producerBaseUrl,
  fetchImpl: NativeAgent.FetchLike = fetch.bind(globalThis),
  preflight?: {
    readonly input: ContextPreflight.ContextPreflightInput
    readonly model: Model.Model
    readonly options: ModelTurnOptions
  },
  docs?: ReadonlyArray<DocsPages.DocsPage>,
  diagnostics: HostDiagnostics = createHostDiagnostics({ turnId: grant.turnId }),
  observeTransport: CallbackTransportObserver = unobserved
): Effect.Effect<void, Model.ModelFailure | ProducerError, ModelStep.Requirements> =>
  // The runtime's records for this turn's callbacks, observed for exactly as
  // long as the turn runs: an attempt that ends without an answer reports the
  // phase it reached, so an operator reading the guest's own log tells a
  // request the dispatcher never took from one whose connection never came up
  // from one whose bytes the journal already has.
  Effect.acquireUseRelease(
    Effect.sync(() => observeTransport(callbackBaseUrl)),
    (observer) => runTurn(model, grant, options, callbackBaseUrl, fetchImpl, observer, preflight, docs, diagnostics),
    (observer) => Effect.sync(() => observer.close())
  )

const runTurn = (
  model: Model.Model,
  grant: DurableChatGrant,
  options: ModelTurnOptions,
  callbackBaseUrl: string,
  fetchImpl: NativeAgent.FetchLike,
  observer: ObservedCallbackTransport,
  preflight:
    | {
      readonly input: ContextPreflight.ContextPreflightInput
      readonly model: Model.Model
      readonly options: ModelTurnOptions
    }
    | undefined,
  docs: ReadonlyArray<DocsPages.DocsPage> | undefined,
  diagnostics: HostDiagnostics
): Effect.Effect<void, Model.ModelFailure | ProducerError, ModelStep.Requirements> =>
  Effect.gen(function*() {
    const producer = new DurableChatProducer(
      callbackBaseUrl,
      grant,
      fetchImpl,
      diagnostics,
      CHAT_CALLBACK_DEADLINE_MS,
      observer
    )
    const write = (frame: NativeAgent.AgentTurnFrame) => producer.write(frame)
    // The guest's own runtime build, as its transport observer names it,
    // written before this turn's first callback. Why a commit attempt never
    // put a socket on the wire is still open, and its one untested variable is
    // the build the guest runs — which fixes the HTTP stack this fetch goes
    // through. A stalled turn is read from this log while its sandbox is still
    // alive, so the answer has to already be in the same log rather than raced
    // for afterwards once the turn ends and the sandbox is deleted. Version
    // strings only, and written when the turn runs rather than when its Effect
    // is built, so one record means one turn.
    diagnostics.record("host_runtime", "start", observer.runtime)
    // Shared prompt admission must never degrade to a transcript-only answer
    // while the authorized host context provider is unavailable.
    if (grant.request.sharedConversation === true && preflight === undefined) {
      return yield* Effect.fail(
        new ModelError.ModelError({
          code: "invalid_provider_output",
          message: "shared conversation preflight is unavailable"
        })
      )
    }
    // Selected content is only supplied by the trusted provider; a renderer
    // cannot pass its own selection or private transcript through this path.
    const { selectedContext: _untrustedSelection, ...request } = grant.request
    let prepared: DurableChatGrant = { ...grant, request }
    if (preflight !== undefined) {
      const decoded = ContextPreflight.ContextPreflightInputSchema.safeParse(preflight.input)
      if (!decoded.success) {
        return yield* Effect.fail(
          new ModelError.ModelError({ code: "invalid_provider_output", message: "context preflight input is invalid" })
        )
      }
      // Prove durable step writes before spending on either model. A failed
      // start receipt never permits the selector or answer request.
      yield* producer.writePreflight("started", {
        context: [],
        candidates: decoded.data.candidates.filter((candidate) =>
          !decoded.data.wikiOnly || candidate.item.kind === "page"
        ).map((candidate) => candidate.item),
        model: preflight.options.modelId,
        durationMs: 0
      })
      yield* producer.providerStarted()
      const answer = yield* runContextPreflight(decoded.data, preflight.model, preflight.options)
      yield* producer.writePreflight("completed", answer.result)
      prepared = {
        ...grant,
        request: { ...request, messages: answer.messages, selectedContext: answer.selectedContext }
      }
    }
    if (preflight === undefined) yield* producer.providerStarted()
    {
      const transport = {
        read: sourceReader(callbackBaseUrl, grant, fetchImpl),
        list: sourceLister(callbackBaseUrl, grant, fetchImpl),
        api: apiCaller(callbackBaseUrl, grant, fetchImpl),
        docs
      }
      yield* runHostTurn(model, prepared, options, write, transport, diagnostics)
      return
    }
  })
