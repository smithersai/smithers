/**
 * One control-plane launch, run as one durable agent session.
 *
 * This is the production `ControlExecutor`. `ControlLive.run` resolves the
 * executor through `Effect.serviceOption`, and until this module existed
 * nothing provided one, so every accepted run stayed `pending` forever. What it
 * does is take a stored plan, find the flow's descriptor and prompt body in the
 * registry, resolve the flow's declared seat through {@link SeatResolver}, and
 * run {@link module:Agent} as the body of one durable flow execution whose id
 * is the control run id.
 *
 * The session is the adapter, not the agent. Everything about how a frame is
 * built, sealed, and replayed belongs to `Agent`; what belongs here is the
 * control-plane half — status fencing, the resume bridge, the approval gate,
 * and the journal trail.
 *
 * What the composition declares, because the spec says a host must:
 *
 * - **Explicit sandbox limits.** `Options.limits` is required; an unlimited
 *   QuickJS cell can hang the frame, so there is no default-unlimited path.
 * - **A resolved context window.** `Seat.contextWindowTokens` comes back from
 *   the host's `SeatResolver`, so compaction is armed instead of silently
 *   disabled at zero. `SeatResolver.contextWindowTokensFor` is the catalog for
 *   known models.
 * - **Steering from the durable queue.** The `Steering.Source` is
 *   `@smthrs/harness/Notifications` over the same journal-backed queue
 *   `Control.steer` admits into, so an operator steer reaches the loop at the
 *   next frame boundary.
 * - **Approval through control.** The `ask` flow is gated in the `authorize`
 *   hook — before the durable boundary opens — by registering an in-run
 *   approval token (`ControlRuntime.registerApproval`) and failing with an
 *   encoded `Permission.PermissionRequired`, which the controller turns into
 *   a real durable park. `Control.approve` resolves the token and installs
 *   the grant; the resumed attempt re-asks against the grant store as it now
 *   stands and proceeds. The park is decided outside the activity on purpose:
 *   a requirement raised inside one would be journaled and replayed forever.
 *
 * Run-status writes stay fenced: the executor waits for the control plane's
 * own `running` transition before the engine starts, writes
 * `waiting-approval` when the execution parks, and writes the terminal status
 * when it settles. Resumption is event-driven — the executor follows the
 * journal for the control plane's resume events and re-drives the parked
 * engine execution.
 *
 * Prior art: Effect's workflow runtime (register/execute/poll/resume), adapted
 * by `@smthrs/engine`, and OpenCode's scope-owned background session driver.
 * These are upstream designs, not paths in this repository.
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { LaunchFailed, PersistenceError } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalPayload, Envelope, PlanCard, RunStatus } from "@smthrs/control/ControlSchema"
import * as Digest from "@smthrs/core/Digest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, Flow, FlowRuntime, WaitFor } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import * as CellTurn from "@smthrs/harness/CellTurn"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as HarnessError from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Transcript from "@smthrs/harness/Transcript"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { Agent } from "./Agent.ts"
import type * as Budget from "./Budget.ts"
import { agentOutcome } from "./internal/AgentOutcome.ts"
import { failureJson } from "./internal/FailureJson.ts"
import { failureSummary } from "./internal/FailureSummary.ts"
import type * as QuotaPolicy from "./QuotaPolicy.ts"
import { contextWindowResolver, SeatResolver } from "./SeatResolver.ts"
import * as StandardFlows from "./StandardFlows.ts"

/**
 * Everything the host decides about the composition.
 *
 * `limits` is required on purpose: the composition never runs a cell without
 * an explicit memory and step budget. `flows` is the host's executable
 * catalog — filesystem, shell, memory — while the durable wait and the
 * control-wired approval are composed here, because they belong to the
 * engine and the control plane rather than to the host.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Age at which an unanswered resume delegation may be adopted by another
   * host. Defaults to `Ownership.heartbeatStaleAfter`; the cutoff is inclusive.
   */
  readonly abandonedParkAfter?: Duration.Duration | undefined
  /** Refuse resume delegation for a run routed to another workspace host. */
  readonly canExecute?: ((runId: string) => Effect.Effect<boolean>) | undefined
  /** Host executable-flow sources composed into every run's catalog. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** Runs rendered markdown children; the host closes over their runtime dependencies. */
  readonly promptRunner?: CellCalls.PromptRunner | undefined
  /** The explicit sandbox budget every cell runs under. Never unlimited. */
  readonly limits: Sandbox.Limits
  /** Required quota park/retry policy for every model call in the run. */
  readonly quotaPolicy: Layer.Layer<QuotaPolicy.QuotaClassifier>
  /** Builds the run-local spending policy from the plan that was approved. */
  readonly budget: (envelope: Envelope) => Layer.Layer<Budget.Budget, Budget.ConfigurationError>
  /** Stable system teaching placed ahead of the cell contract. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly maxFrames?: number | undefined
  /**
   * Consecutive read-only frames a task run may spend before the controller
   * demands an edit or a justification, and twice that before it stops the
   * run. Defaults to `CellTurn.defaultReadOnlyFrames`.
   *
   * @since 1.0.0-rc.0
   */
  readonly readOnlyCap?: number | undefined
  /**
   * Wall-clock milliseconds one model call may spend before the boundary
   * interrupts it and re-issues it. Defaults to `CellTurn.defaultModelCallMs`;
   * zero disarms it.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Consecutive repeat-observation frames a run may spend before the
   * controller names the repetition and redirects it. Defaults to
   * `CellTurn.defaultRepeatFrames`; zero disarms it.
   */
  readonly repeatCap?: number | undefined
  /**
   * Completions a run may have bounced for narrowed evidence before the
   * controller stops naming the check it skipped. Defaults to
   * `CellTurn.defaultNarrowingDemands`; zero disarms it.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Completions a run may have bounced for an unmoved tree before the
   * controller stops naming it. Defaults to `CellTurn.defaultUnmovedDemands`;
   * zero disarms it.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Completions a run may have bounced for a failing check it replaced rather
   * than answered. Defaults to `CellTurn.defaultUnresolvedDemands`; zero
   * disarms it.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Whether a human answers this executor's runs, which is what makes a cell's
   * `park` transition honorable.
   *
   * The executor wires an approval gate on every run, but a gate is not an
   * answerer: a benchmark, a cron, and a CI lane all register approvals that
   * nobody will ever decide. So the host says. It defaults to false, and a run
   * that claims false has its `park` transitions refused and answered in-frame
   * rather than left waiting on an operator who is not there.
   */
  readonly approvalChannel?: boolean | undefined
  /**
   * The reasoning effort agent seats run at when their flow declares none.
   *
   * The flow's own `effort:` frontmatter wins; this is the host's default
   * beneath it, and the built-in default is `high` — an unset effort is not
   * neutral, it is near-zero thinking (the first SWE-bench runs recorded ~20
   * reasoning tokens per call while the same model under the Codex CLI ran
   * at medium and resolved four times as many instances).
   *
   * @since 1.0.0-rc.0
   */
  readonly reasoningEffort?: ModelRequest.ReasoningEffort | undefined
}

const sourceId = JournalEvent.SourceId.make("/control/executor")

/**
 * The agent trail's own producer, separate from the executor's lifecycle
 * events.
 *
 * The trail supplies its own producer sequences ({@link traceIdentity}) while
 * `control.run.*` and `control.approval.requested` allocate theirs from the
 * journal's floor. Sharing one producer would mix the two schemes in one
 * sequence space: the floor is `MAX(source_seq) + 1`, so it would jump to a
 * derived identity plus one, and a later derived identity could name a
 * sequence a lifecycle event had already taken. Two producers keep each
 * scheme's numbers to itself.
 */
const trailSourceId = JournalEvent.SourceId.make("/control/executor/trail")

/**
 * Payload fields a replayed event does not reproduce.
 *
 * `at` is stamped when the executor recorded the event, and `durationMillis`
 * is measured around a step the engine serves from its record on the way back,
 * so both differ between the attempt that first produced an event and the
 * attempt that replays it. They describe the observation rather than the
 * event, so the identity below is derived without them and the first
 * attempt's values are the ones that stand.
 */
const observationOnly = new Set(["at", "durationMillis"])

/**
 * The producer identity of one journaled agent event.
 *
 * A resumed attempt replays its whole prefix and re-publishes every event in
 * it, so without an identity of their own those events were journaled again:
 * the auto-allocated sequence never collided, the dedup index never fired, and
 * a projection summing `control.agent.model-settled` usage over-counted a
 * run's tokens once per park. This is the identity that lets
 * `UNIQUE (run_id, source_id, source_seq)` answer, and it has to hold for a
 * resumed attempt that DIVERGES rather than only for one that repeats.
 *
 * The material is where the event sits and what it says: the frame, its
 * ordinal within that frame, the cell that frame produced, the event type, and
 * the event's own payload minus {@link observationOnly}. A replayed event
 * regenerates all five, so it regenerates the identity and the index refuses
 * it. An event produced after divergence differs in at least one of them, so
 * it derives a different identity and is admitted normally: the approved
 * `ask` writes `cell-call-settled` where the parked attempt wrote
 * `permission-required`, at the same ordinal of the same frame, and the two
 * do not collide. A running count across the incarnation cannot make that
 * distinction, which is why one was tried and rejected.
 *
 * The identity hashes the payload that is journaled. When {@link trace}
 * replaces an oversized field, the deterministic marker carries the digest of
 * the full value, so two different omitted values still produce different
 * identity material without canonicalizing the full value a second time here.
 *
 * Truncation is to 48 bits, comfortably inside the safe-integer range the
 * journal allocates in, and the birthday bound over a run's thousands of
 * events is around 1e-9. The failure it bounds is a dropped duplicate, never a
 * rewritten row: the first observation of an identity is the one that stands.
 *
 * @category projections
 * @since 0.1.0
 */
export const traceIdentity = (
  frame: number,
  ordinal: number,
  cell: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>
): JournalEvent.SourceSeq => {
  const material = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !observationOnly.has(key))
  )
  const digest = Digest.digest(CanonicalJson.stringify({ cell, eventType, frame, material, ordinal }))
  return JournalEvent.SourceSeq.make(Number.parseInt(digest.slice(0, 12), 16))
}

/**
 * The largest free-text or value field one trail record carries.
 *
 * Completion outputs are bounded inside both cell settlements and applied
 * transitions, preserving the containing outcome and transition tags.
 *
 * The trail is a durable journal row, and a cell may read a multi-megabyte
 * file into one result. Bounding the field limits both that row's storage and
 * the canonicalization and hashing work paid for every event identity.
 *
 * @category projections
 * @since 1.0.0-rc.0
 */
export const maxTracedBytes = 65_536

const traceEncoder = new TextEncoder()

const tracedField = <A extends Schema.Json | string>(value: A): A | {
  readonly truncated: true
  readonly bytes: number
  readonly digest: string
} => {
  const canonical = CanonicalJson.stringify(value)
  const bytes = traceEncoder.encode(typeof value === "string" ? value : canonical).byteLength
  return bytes <= maxTracedBytes
    ? value
    : { truncated: true, bytes, digest: Digest.digest(canonical) }
}

const tracedTransition = (transition: Cell.Transition) =>
  transition._tag === "complete" ? { ...transition, output: tracedField(transition.output) } : transition

/**
 * Why a parked run is being taken up, which decides whether the hosting guard
 * applies to it.
 *
 * `claimed` is an operator's own `Control.resume` or a steer's wake: the plane
 * that asked has ALREADY claimed the control row (`ControlLive.runMutation`
 * and the steer wake both call `ControlRuntime.resume` before they journal),
 * and a wedged run is by definition one nobody is driving. Guarding it would
 * turn the operator's remedy into a claimed row nothing re-drives.
 *
 * `delegated` is the approval seam, where the decision may have been taken in
 * any process holding the control database and the run belongs to whichever
 * one parked it. `requestedAtMs` is the age of the durable delegation, and only
 * the durable follower has one: a process that has just decided an approval
 * knows nothing about the host from having decided it.
 */
type Uptake =
  | { readonly _tag: "claimed" }
  | { readonly _tag: "delegated"; readonly requestedAtMs?: number | undefined }

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")

/**
 * The journal projection of one agent event.
 *
 * The executor consumes the harness stream itself, so without this the whole
 * transcript — what the model said, the cell it produced, the flows that cell
 * called, and why a frame was rejected — existed only for the duration of the
 * run and a settled run could not be read back at all. Model deltas are the
 * one omission: they are the token-by-token prefix of `model-settled`, and
 * journaling them would multiply a run's event count by its token count for
 * no information the settlement does not already carry.
 *
 * `undefined` means "not journaled".
 *
 * @category projections
 * @since 0.1.0
 */
export const trace = (
  event: AgentEvent.AgentEvent
): { readonly eventType: Transcript.ControlEventType; readonly payload: unknown } | undefined => {
  switch (event._tag) {
    case "model-delta":
      return undefined
    case "model-retried":
      // The delay is journaled with the attempt because it cannot be
      // recovered from the timestamps: every retry of one sealed step is
      // written when that step settles, so a run that backed off for half a
      // minute and one that did not back off at all produce the same
      // timestamps. A wave report reads the schedule off this field.
      return {
        eventType: "control.agent.model-retried",
        payload: { attempt: event.attempt, code: event.code, delayMillis: event.delayMillis }
      }
    case "discipline-armed":
      // The positive record of what this run armed, written before any of it
      // can fire. A run that never completes still proves its arming here.
      return {
        eventType: "control.agent.discipline-armed",
        payload: {
          readOnlyCap: event.readOnlyCap,
          maxFrames: event.maxFrames,
          approvalChannel: event.approvalChannel,
          // The one budget a report can grade after the fact without any
          // further instrumentation: `control.agent.model-settled` already
          // journals `durationMillis` per call, so the pair says both what the
          // run promised and what every call it made actually spent.
          modelCallMs: event.modelCallMs,
          // Armed for the same reason and journaled the same way: a wave that
          // records no repeat demand must be able to say whether the control
          // was armed and never needed, or never armed at all.
          repeatCap: event.repeatCap,
          // The one control that acts on a completion rather than on a stall,
          // so a wave's report can say whether the run that finished was ever
          // asked about the evidence it finished on.
          narrowingCap: event.narrowingCap,
          // The two controls that judge what a completion is *about* rather
          // than how it was verified: whether the run changed anything at all,
          // and whether it answered the check that told it something was
          // broken. Journaled with the rest so a wave can tell "armed and never
          // needed" from "never armed".
          unmovedCap: event.unmovedCap,
          unresolvedCap: event.unresolvedCap,
          calls: event.calls,
          memoryBytes: event.memoryBytes,
          steps: event.steps,
          timeMs: event.timeMs,
          callMs: event.callMs,
          totalMs: event.totalMs
        }
      }
    case "turn-opened":
      return {
        eventType: "control.agent.turn-opened",
        payload: { seat: event.seat, contextDigest: event.contextDigest }
      }
    case "model-settled":
      return {
        eventType: "control.agent.model-settled",
        payload: {
          text: tracedField(assistantText(event.message)),
          usage: event.usage,
          // Wall-clock for this one sealed call. A run's total time was
          // already derivable from event stamps; per-call latency was not,
          // and it is the number a speed comparison actually needs.
          durationMillis: event.durationMillis
        }
      }
    case "cell-produced":
      return {
        eventType: "control.agent.cell-produced",
        payload: { language: event.cell.language, digest: event.cell.digest, text: tracedField(event.cell.text) }
      }
    case "cell-call-started":
      // The input is bounded for the same reason the result is. A `write` call
      // carries the whole file it is about to write, so the record that opens
      // the call is as large as the one that settles it.
      return {
        eventType: "control.agent.cell-call-started",
        payload: { flowName: event.call.flowName, input: tracedField(event.call.input) }
      }
    case "cell-call-settled":
      return {
        eventType: "control.agent.cell-call-settled",
        payload: {
          flowName: event.flowName,
          outcome: event.result.outcome,
          // A failure message is free text a handler chose, and a compiler or
          // test runner writes megabytes of it.
          message: event.result.message === undefined ? undefined : tracedField(event.result.message),
          value: tracedField(event.result.value)
        }
      }
    case "cell-printed":
      // The whole of the REPL mode's context channel. Journaled with the cell
      // that produced it so a transcript projection can rebuild a resumed run's
      // window without re-running anything.
      return {
        eventType: "control.agent.cell-printed",
        payload: { cell: event.cell, text: tracedField(event.text) }
      }
    case "cell-settled":
      return {
        eventType: "control.agent.cell-settled",
        payload: {
          outcome: event.outcome._tag === "settled"
            ? { ...event.outcome, transition: tracedTransition(event.outcome.transition) }
            : event.outcome
        }
      }
    case "transition-applied":
      return {
        eventType: "control.agent.transition-applied",
        payload: { transition: tracedTransition(event.transition) }
      }
    case "mutation-observed":
      // Written for every frame, not only for the ones that trip a control.
      // `basis` travels with it because a `declared` answer is paperwork and an
      // `observed` one is a fact about the tree, and a reader reconstructing a
      // run must not have to guess which it is holding.
      return {
        eventType: "control.agent.mutation-observed",
        payload: {
          basis: event.basis,
          mutated: event.mutated,
          digest: event.digest,
          paths: event.paths,
          declaredWrites: event.declaredWrites
        }
      }
    case "checkpoint-minted":
      // The store's own name for the tree travels with the id, because the
      // frame that reads against a checkpoint is usually not the frame that
      // pinned it: a journal holding only the reading could not say which tree
      // it was a reading of, and a fails-before proof is exactly that claim.
      return {
        eventType: "control.agent.checkpoint-minted",
        payload: { id: event.id, ref: event.ref, cell: event.cell, ordinal: event.ordinal }
      }
    case "read-only-demanded":
      return {
        eventType: "control.agent.read-only-demanded",
        payload: {
          streak: event.streak,
          cap: event.cap,
          nextFrame: event.nextFrame,
          nextAction: event.nextAction
        }
      }
    case "repeat-demanded":
      // Journaled at issuance, not at its answer: what answers this demand is
      // the shape of the next frame's calls, and `cell-call-started` already
      // writes those one at a time.
      return {
        eventType: "control.agent.repeat-demanded",
        payload: { frames: event.frames, cap: event.cap, nextFrame: event.nextFrame }
      }
    case "narrowed-demanded":
      // The two inputs and the two digests travel together because the whole
      // judgement is in the pair: without the digests a reader cannot tell a
      // stale broad check from a current one, and without the inputs it cannot
      // tell whether the narrowing was real. A grader reading this back can
      // second-guess the demand without replaying the run.
      return {
        eventType: "control.agent.narrowed-demanded",
        payload: {
          flow: event.flow,
          broader: event.broader,
          narrower: event.narrower,
          broaderDigest: event.broaderDigest,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "unmoved-demanded":
      // Both digests, because the judgement is the comparison: a reader with
      // only one of them cannot tell an unmoved tree from a measurement that
      // never happened, and the pair reconciles directly against the run's own
      // `mutation-observed` record.
      return {
        eventType: "control.agent.unmoved-demanded",
        payload: {
          openedDigest: event.openedDigest,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "unresolved-demanded":
      // The failing check and the reading that displaced it travel together
      // for the same reason the narrowing pair does: either one alone is
      // unremarkable, and the demand is entirely about the two of them.
      return {
        eventType: "control.agent.unresolved-demanded",
        payload: {
          flow: event.flow,
          failed: event.failed,
          instead: event.instead,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "vacuous-verification-observed":
      // The stored check travels with the identity the controller matched it
      // by, because the whole judgement is that this exact call had already
      // been watched passing: a reader with only the text cannot tell an exact
      // reuse from a command that merely reads like one, and the signature
      // reconciles the row directly against the run's own
      // `cell-call-settled` record.
      return {
        eventType: "control.agent.vacuous-verification-observed",
        payload: {
          flow: event.flow,
          check: event.check,
          signature: event.signature,
          nextFrame: event.nextFrame
        }
      }
    case "suspended":
      return { eventType: "control.agent.suspended", payload: { reason: event.reason } }
    case "compaction-settled":
      return {
        eventType: "control.agent.compaction-settled",
        payload: { replacedPrefixDigest: event.replacedPrefixDigest }
      }
    case "turn-closed":
      return {
        eventType: "control.agent.turn-closed",
        payload: { stopReason: event.stopReason, outcome: event.outcome }
      }
    case "permission-required":
      return { eventType: "control.agent.permission-required", payload: { request: event.request } }
    case "aborted":
      return { eventType: "control.agent.aborted", payload: { reason: event.reason } }
    case "resolved":
      return { eventType: "control.agent.resolved", payload: { text: tracedField(assistantText(event.message)) } }
    default:
      return { eventType: `control.agent.${event._tag}`, payload: {} }
  }
}

/**
 * Resolves the reasoning effort one run's model calls request.
 *
 * The flow's `effort:` frontmatter wins, then the host's configured default,
 * then `high`. The frontmatter value is validated against the effort
 * vocabulary and an unrecognised spelling falls through rather than failing
 * the launch: effort is a tuning knob, not a contract.
 */
const effortFor = (
  descriptor: { readonly frontmatter: Readonly<Record<string, unknown>> },
  host: ModelRequest.ReasoningEffort | undefined
): ModelRequest.ReasoningEffort => {
  const declared = descriptor.frontmatter["effort"]
  if (typeof declared === "string" && Schema.is(ModelRequest.ReasoningEffort)(declared)) {
    return declared
  }
  return host ?? "high"
}

/** The envelope an in-run ask approval binds to: the ask flow, nothing else. */
const askEnvelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }

interface AskInput {
  readonly question: string
  readonly options?: ReadonlyArray<string> | undefined
}

/**
 * The identity of one ask, derived from its run and whole input. Including the
 * run id prevents a grant for a byte-identical question in one run from
 * answering it in another, while remaining stable across this run's park and
 * resumed attempt. The raw call input and its decoded form digest identically
 * — both are plain JSON and canonical serialization sorts keys.
 */
const askIdentity = (
  runId: string,
  input: unknown
): { readonly digest: string; readonly requestId: string } => {
  const digest = Digest.digest(CanonicalJson.stringify({ input, runId }))
  return { digest, requestId: `ask/${runId}/${digest}` }
}

/**
 * Parses a run envelope's formatted capabilities, dropping every entry the
 * capability grammar cannot name. Dropping an unparseable entry narrows
 * authority — the fail-closed direction — because an empty envelope grants
 * nothing.
 *
 * The bare `*` a markdown-declared flow carries when its frontmatter names no
 * `capabilities:` is part of the grammar itself: `Capability.parsePattern`
 * expands it to `*:**`, so nothing here special-cases it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const patterns = (capabilities: ReadonlyArray<string>): ReadonlyArray<Capability.CapabilityPattern> =>
  capabilities.flatMap((formatted) => {
    const parsed = Capability.parsePattern(formatted)
    return Option.isSome(parsed) ? [parsed.value] : []
  })

/**
 * Renders the prompt-flow body and its decoded input into the task the run is
 * admitted with. An absent or empty input adds nothing.
 */
const prompt = (text: string, input: unknown): string => {
  const rendered = input == null ? "null" : JSON.stringify(input, null, 2)
  return rendered === "null" || rendered === "{}"
    ? text.trim()
    : `${text.trim()}\n\nInput:\n${rendered}`
}

/**
 * The failure the engine persists as this flow's settlement.
 *
 * `agent/run` declares `error: Schema.Unknown`, and `Schema.toCodecJson`
 * reads that as "any JSON value". Every real agent failure is an `Error`
 * instance instead — a `HarnessError` wrapping a `ModelError`, a
 * `SeatUnresolved` — so the codec rejected every one of them, `engine-store`
 * degraded the settlement into a projection, and it said so in a second WARN
 * stack beside the run's own `An agent run failed` (release validation observation
 * N1: two stack traces for one billing refusal).
 *
 * The rendering is the package's one failure serializer, shared with the
 * action and the budget boundaries so a nested `Error` reads the same in every
 * durable record rather than only in this one.
 *
 * @category conversions
 * @since 1.0.0
 */
export const settlementFailure = (error: unknown): unknown => failureJson(error)

/**
 * The one durable flow every agent run executes. Its plan-time body is inert;
 * the behaviour is the `execute` registered by {@link make}, and the
 * execution id is the control run id.
 */
const agentFlow = Flow.make("agent/run", {
  payload: { runId: Schema.String, planId: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/**
 * Waits for ControlLive to publish its running transition before a driver
 * starts the engine. Keeping the bounded retry here makes the publication race
 * deterministic to exercise without coupling it to a particular scheduler.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForRunning = (
  status: (runId: string) => Effect.Effect<RunStatus, unknown>,
  runId: string,
  attempts: number,
  retryDelay: Effect.Effect<void> = Effect.sleep(Duration.millis(10))
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const current = yield* status(runId)
    if (current === "running") {
      // The running row is written inside ControlLive's admission transaction.
      // Cross the same asynchronous retry boundary once more so that
      // transaction can commit before the engine opens its own durable
      // transaction.
      yield* retryDelay
      return true
    }
    if (current === "accepted" && attempts > 0) {
      yield* retryDelay
      return yield* waitForRunning(status, runId, attempts - 1, retryDelay)
    }
    if (current === "accepted") {
      return yield* Effect.fail(
        new LaunchFailed({
          runId,
          message: "The accepted run was not published as running before its driver admission budget expired"
        })
      )
    }
    return false
  })

/**
 * Polls a durable execution until it is published as parked. A missing poll is
 * a still-live execution, so retries are bounded before a resume is attempted.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForParked = (
  poll: () => Effect.Effect<Option.Option<{ readonly _tag: string }>, unknown>,
  attempts: number
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const result = yield* poll()
    if (Option.isNone(result)) {
      if (attempts <= 0) return false
      yield* Effect.sleep(Duration.millis(10))
      return yield* waitForParked(poll, attempts - 1)
    }
    return result.value._tag === "Suspended"
  })

const recoverCause = <A>(
  cause: Cause.Cause<unknown>,
  message: string,
  fallback: A,
  annotations: Readonly<Record<string, unknown>>
): Effect.Effect<A> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.annotateLogs(
      Effect.logWarning(message).pipe(Effect.as(fallback)),
      { ...annotations, cause: Cause.pretty(cause) }
    )

/**
 * Keeps a control cancellation durable even when its engine interrupt fails.
 *
 * @category helpers
 * @since 0.1.0
 */
export const preserveDriverInterrupt = <R>(
  interrupt: () => Effect.Effect<void, unknown, R>
): Effect.Effect<void, never, R> =>
  interrupt().pipe(
    Effect.catchCause((cause) => recoverCause(cause, "The engine interrupt could not be delivered", undefined, {}))
  )

/**
 * Translates a failed driver registration into the executor's launch error.
 *
 * @category helpers
 * @since 0.1.0
 */
export const registerDriver = (
  register: () => Effect.Effect<void, unknown>,
  runId: string
): Effect.Effect<void, LaunchFailed> =>
  register().pipe(
    Effect.mapError((cause) =>
      new LaunchFailed({
        runId,
        message: "The run driver could not be registered for cancellation",
        cause
      })
    )
  )

/**
 * Re-throws a cancelled driver while logging a non-interrupt engine failure.
 *
 * @category helpers
 * @since 0.1.0
 */
export const settleDriverFailure = <E, R>(
  cause: Cause.Cause<unknown>,
  runId: string,
  writeFailed: (detail: string) => Effect.Effect<void, E, R>
): Effect.Effect<void, E, R> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.andThen(
      Effect.annotateLogs(
        Effect.logError("An accepted agent run could not start on the engine"),
        { runId, cause: Cause.pretty(cause) }
      ),
      writeFailed(Cause.pretty(cause))
    )

/**
 * Records a cancellation on the engine row, whichever process owns the run.
 *
 * This is the durable half of `Control.cancel`. Interruption is a fiber
 * operation and fibers are process-local, so a cancel that only interrupted
 * would reach nothing when a second `flows` process, the UI, or a gateway asked
 * — the engine row's `cancel_requested_at_ms` is what the owning driver's
 * cancel poll reads, and it is first-writer-wins, so a repeat is harmless.
 *
 * `NotFound` is `unknown` rather than a failure: an engine that never heard of
 * the run has nothing to record, and the control plane's own interrupt and
 * journal entry are still the whole answer for a run this composition launched
 * nothing for.
 *
 * @category helpers
 * @since 0.1.0
 */
export const requestCancel = (
  input: ControlExecutor.CancelRequest
): Effect.Effect<ControlExecutor.CancelRecord, PersistenceError, RunStore.RunStore> =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const at = yield* Clock.currentTimeMillis
    const failure = (runId: string) => (cause: unknown) =>
      new PersistenceError({
        operation: "AgentSession.requestCancel",
        message: `The engine could not record a cancellation for ${runId}`,
        cause
      })
    // A completed round can have a live handoff successor. Resolve membership
    // and record intent in one engine-store write transaction; neither a stale
    // control row nor a read of just the predecessor decides terminality.
    const outcome = yield* runs.requestCancelLineage(input.runId, at).pipe(Effect.mapError(failure(input.runId)))
    if (outcome._tag === "Terminal") return { _tag: "Terminal", status: outcome.status } as const
    if (outcome._tag === "NotFound") return "unknown"
    // The store already distinguishes the write that recorded the request from
    // the one that found it recorded, and the control plane needs that
    // difference: `Control.cancel` runs with `replay: false`, so every repeat
    // re-executes, and attributing each one journals a fresh
    // `control.run.cancel-requested` for a cancellation that happened once.
    return outcome._tag === "AlreadyRequested" ? "already-requested" : "recorded"
  })

/**
 * Reads current-round lifecycle and the requested run's ancestry from the
 * engine services captured by the host. The existing engine transaction keeps
 * these reads coherent; the SQLite adapter holds a writer lock only for the
 * scoped reads, without executing or waiting on the run.
 *
 * Control metadata is read separately. This is not a cross-database snapshot
 * or a revisioned read projection. A later trampoline round supplies lifecycle
 * and waiting state, while parent and round ordinal still name `runId`.
 *
 * @category queries
 * @since 0.1.0
 */
export const readExecution = (
  runId: string
): Effect.Effect<
  ControlExecutor.ExecutionObservation,
  PersistenceError,
  RunStore.RunStore | DurableEngineState.DurableEngineState
> =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    // The current round, its waiting reason and parent edge must come from
    // one snapshot. Completion/handoff can otherwise split these three reads.
    return yield* state.transaction(Effect.gen(function*() {
      const row = yield* runs.latestRound(runId).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeed(Option.none<RunStore.RunRow>())
            : Effect.fail(
              new PersistenceError({
                operation: "read engine execution",
                message: `Cannot read engine execution ${runId}`,
                cause: error
              })
            )
        )
      )
      if (Option.isNone(row)) return { _tag: "Missing" } as const
      const waiting = yield* state.waiting(row.value.runId)
      const reason = Option.isSome(waiting) ? waiting.value.reason : undefined
      const current = row.value
      const identity = current.runId === runId ? current : yield* runs.get(runId).pipe(
        Effect.mapError((cause) =>
          new PersistenceError({
            operation: "read engine execution",
            message: `Cannot read engine identity ${runId}`,
            cause
          })
        )
      )
      return {
        _tag: "Observed",
        status: current.status === "pending"
          ? "accepted"
          : current.status === "suspended"
          ? reason === "approval" ? "waiting-approval" : "parked"
          : current.status,
        waitingReason: current.status === "suspended" ? reason : undefined,
        parentRunId: identity.parentRunId ?? (yield* state.runParents(identity.runId))[0]?.parentId,
        lineageId: identity.lineageId ?? current.lineageId ?? undefined,
        // Older lineage roots have null columns; membership was established by
        // latestRound, so they remain round zero of that lineage.
        roundOrdinal: identity.roundOrdinal ?? (current.runId === runId ? undefined : 0)
      } as const
    }))
  }).pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
    const failure = Cause.squash(cause)
    return Effect.fail(
      failure instanceof PersistenceError ? failure : new PersistenceError({
        operation: "read engine execution",
        message: `Cannot read engine observation ${runId}`,
        cause: failure
      })
    )
  }))

/** The deferred name a `WaitFor` wait point is recorded under. */
const waitPointName = (signal: string): string => `WaitFor/${signal}`

/**
 * Completes the `WaitFor` wait point a run is parked on with a signal's
 * payload.
 *
 * The wait point is read off the run's own waiting row rather than derived from
 * the flow, because the engine writes the deferred's token there when it parks
 * (`WaitFor.layer` annotates `reason: "event"` with the token). That makes the
 * bridge flow-agnostic: it completes whatever wait point the parked run
 * actually declared, through the ordinary `DurableDeferred.succeed` path every
 * other resolver uses, and the engine's own `scheduleResume` re-drives the run.
 *
 * The three answers are distinct on purpose. `delivered` completed a wait
 * point. `no-match` means the run IS parked and is waiting for something else —
 * a different signal name, an approval, a timer — which `Control.signal`
 * refuses rather than recording a delivery nothing consumes. `unknown` means
 * this executor can see no open wait point at all, which is not the same as
 * knowing there is none: another process may own the run, or it may not have
 * parked yet, and the recorded message is what a later start replays.
 *
 * @category helpers
 * @since 0.1.0
 */
export const deliverSignal = (
  input: ControlExecutor.Signal
): Effect.Effect<
  ControlExecutor.SignalDelivery,
  PersistenceError,
  DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const control = yield* Effect.serviceOption(ControlRuntime)
    let token = input.token ?? null
    if (token === null) {
      const waiting = yield* state.waiting(input.runId)
      if (Option.isNone(waiting)) return "unknown" as const
      const row = waiting.value
      if (row.reason !== "event" || row.token === null) return "no-match" as const
      token = row.token
    }
    const parsed = yield* Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(token).pipe(
      Effect.mapError((cause) =>
        new PersistenceError({
          operation: "AgentSession.deliverSignal",
          message: `The wake token recorded for ${input.runId} is not a durable deferred token`,
          cause
        })
      )
    )
    if (parsed.deferredName !== waitPointName(input.signal.name)) return "no-match" as const
    // First binding wins in control.db. A crash before or after completion
    // retries this exact token; the command can never move to a later wait.
    if (input.commandId !== undefined) {
      if (Option.isNone(control)) {
        return yield* new PersistenceError({
          operation: "AgentSession.deliverSignal",
          message: "Durable signal admission requires ControlRuntime"
        })
      }
      token = yield* control.value.bindSignal(input.commandId, token)
      if (token === null) return "no-match" as const
    }
    const bound = yield* Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(token).pipe(Effect.orDie)
    const completionMatches = (row: DurableEngineState.DeferredRow): boolean => {
      const exit = row.exit as Exit.Exit<unknown, unknown>
      return Exit.isExit(exit) && Exit.isSuccess(exit) &&
        CanonicalJson.stringify(exit.value) === CanonicalJson.stringify(input.signal.payload)
    }
    const previous = yield* state.deferred(bound)
    if (Option.isSome(previous)) return completionMatches(previous.value) ? "delivered" as const : "no-match" as const
    const engine = yield* FlowRuntime.FlowRuntime
    const outcome = yield* engine.deferredDoneIfWaiting(WaitFor.deferred(input.signal.name), {
      flowName: bound.flowName,
      executionId: bound.executionId,
      deferredName: bound.deferredName,
      reason: "event",
      token,
      exit: Exit.succeed(input.signal.payload)
    })
    // Completion rechecks the concrete token in the engine transaction. A
    // competing resolver may have won; the durable stored result is the proof.
    const completed = yield* state.deferred(bound)
    if (Option.isSome(completed)) return completionMatches(completed.value) ? "delivered" as const : "no-match" as const
    return outcome === "NotWaiting" ? "no-match" as const : "unknown" as const
  })

/**
 * Reconciles a bounded rotating page of admitted signal commands.
 *
 * The host runs this at startup and every 250 ms. A command without a
 * concrete wait stays pending; a bound command always retries its original
 * token, including after the run has settled but acknowledgment was lost.
 * Legacy payload-only messages are not replayed because their application
 * identity cannot be recovered safely.
 *
 * @category helpers
 * @since 0.1.0
 */
export const drainRecordedSignals: Effect.Effect<
  void,
  never,
  ControlRuntime | DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
> = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const commands = yield* runtime.pendingSignals
  yield* Effect.forEach(commands, (command) =>
    Effect.gen(function*() {
      const current = yield* runtime.getRun(command.runId)
      if (
        command.token === null &&
        (current.status === "completed" || current.status === "failed" || current.status === "cancelled")
      ) {
        yield* runtime.settleSignal(command.commandId, "terminal")
        return
      }
      const delivery = yield* deliverSignal(command)
      if (delivery !== "unknown") {
        yield* runtime.settleSignal(command.commandId, delivery === "delivered" ? "delivered" : "rejected")
      }
    }).pipe(Effect.catchCause((cause) =>
      Effect.logWarning("Pending signal delivery failed", { commandId: command.commandId, cause: Cause.pretty(cause) })
    )), { discard: true })
}).pipe(
  Effect.catchCause((cause) =>
    Effect.annotateLogs(
      Effect.logWarning("Recorded signals could not be replayed at executor start"),
      { cause: Cause.pretty(cause) }
    )
  )
)

/** Everything the executor captures at construction and re-provides per run. */
type Services =
  | Agent
  | ControlRuntime
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | FlowRuntime.FlowRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue
  | Registry.Registry
  | RunStore.RunStore
  | SeatResolver

/**
 * Constructs the production executor.
 *
 * Must be built in a scope: the scope owns the registered agent flow, every
 * forked run driver, and the resume bridge that follows the journal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<ControlExecutor.Service, never, Services | Scope.Scope> =>
  Effect.gen(function*() {
    const abandonedParkAfterMs = Duration.toMillis(options.abandonedParkAfter ?? Ownership.heartbeatStaleAfter)
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const registry = yield* Registry.Registry
    // A host registers native modules through the existing executable catalog.
    // Prompt-only compositions retain their current admission behavior.
    const executables = yield* Effect.serviceOption(Executable.Catalog)
    const engine = yield* FlowRuntime.FlowRuntime
    const seats = yield* SeatResolver
    const agent = yield* Agent
    const engineRuns = yield* RunStore.RunStore
    const scope = yield* Effect.scope
    const services = yield* Effect.context<Services>()

    const emit = (
      runId: string,
      eventType: string,
      payload: unknown
    ): Effect.Effect<void, unknown> =>
      // Unfenced: a session is a client of the runs it traces, not their
      // owner — its records are first-writer-wins admissions on the run's
      // journal.
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId,
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )

    /**
     * Emits one agent-trace event on the journal's lossy channel, under the
     * identity {@link traceIdentity} derived for it.
     *
     * The channel matters more than it looks. A trace event is telemetry, not
     * lifecycle state, and the executor emits it from inside the harness
     * stream's own consumer — so a durable emit deadlocks: the write joins the
     * single writer's transaction queue behind the engine transaction that the
     * harness frame is still inside, while the frame cannot proceed until the
     * consumer accepts the event. Runs stalled silently at 0% CPU a few frames
     * in. `emitLossy` queues instead of joining the transaction, which is the
     * documented channel for exactly this.
     *
     * The explicit sequence rides the same channel. It used to send the emit
     * through a preflight SELECT before admission, which reintroduced that
     * deadlock from the other side, and `emitLossy` now settles an explicit
     * identity from memory or admits it optimistically, leaving the unique
     * index to refuse the duplicate at the insert. `dedupe: "identity"` is
     * this producer saying the sequence is derived from the event: the
     * observation metadata that differs between a first attempt and a replay
     * must not be read as two different events.
     */
    const trail = (
      runId: string,
      sourceSeq: JournalEvent.SourceSeq,
      eventType: string,
      payload: unknown
    ): Effect.Effect<void, unknown> =>
      journal.emitLossy(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: trailSourceId,
          sourceSeq,
          dedupe: "identity",
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )

    /**
     * Decides one ask before its durable boundary opens. An unresolved ask
     * registers its token, publishes the exact approval payload an operator
     * replays through `smithers approve`, and parks the run with an encoded
     * `PermissionRequired`; a resolved one lets the activity run and read the
     * decision.
     */
    const authorize =
      (runId: string, instance: FlowRuntime.FlowInstance["Service"]) =>
      (call: Cell.Call): Effect.Effect<void, HarnessError.HarnessError> =>
        Effect.gen(function*() {
          if (call.flowName !== StandardFlows.askFlow.name) return
          const input = call.input as unknown as AskInput
          const identity = askIdentity(runId, call.input)
          const target = {
            _tag: "Node" as const,
            runId,
            requestId: identity.requestId,
            digest: identity.digest,
            envelope: askEnvelope
          }
          const token = yield* runtime.registerApproval(target).pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError.HarnessError({
                  code: "engine_failed",
                  message: "The approval request could not be registered with the control plane",
                  cause
                })
            )
          )
          if (token._tag !== "Pending") return
          const payload: ApprovalPayload = {
            target,
            scope: "run",
            idempotencyKey: `approve:${identity.requestId}`
          }
          yield* emit(runId, "control.approval.requested", {
            runId,
            requestId: identity.requestId,
            question: input.question,
            payload
          }).pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError.HarnessError({
                  code: "engine_failed",
                  message: "The approval request could not be journaled",
                  cause
                })
            )
          )
          // Classify the park before taking it. Without this the engine derived
          // the reason from durable state and an in-run `ask` — which arms no
          // clock — parked under `event`, the reason `Control.steer` treats as
          // "waiting for something to arrive" and therefore wakes on a message.
          // `approval` is what the run is actually waiting for, and the request
          // id is the token a wake handler matches (engine-store issue #31).
          // The annotation cannot go stale: a round that parks here ends, and
          // the resumed round runs under an instance of its own. The instance
          // travels down from the registered handler rather than through a map
          // the handler writes: the body is forked with `startImmediately`, so a
          // map written after the fork is not yet written when the body's first
          // ask reaches this line, and the park then took the derived `event`
          // reason instead of `approval`.
          yield* Effect.provideService(
            FlowRuntime.annotateWaiting({ reason: "approval", token: identity.requestId }),
            FlowRuntime.FlowInstance,
            instance
          )
          return yield* Effect.fail(
            new HarnessError.HarnessError({
              code: "engine_failed",
              message: `Approval required: ${input.question}`,
              cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
                new Permission.PermissionRequired({
                  code: "permission_required",
                  requestId: identity.requestId,
                  runId,
                  // No action in the capability vocabulary names a human
                  // decision; the request carries the question in `meta` and
                  // the model seat's own action as the closest formal claim.
                  capability: Capability.make("model:call", `ask/${identity.digest}`),
                  tier: "irreversible",
                  meta: { question: input.question }
                })
              )
            })
          )
        })

    /**
     * Answers from the decision itself, not from a scan of unrelated grants.
     * A pending or unreadable answer is not an implicit denial or approval.
     */
    const asker = (runId: string): StandardFlows.Asker => ({
      ask: (input) =>
        Effect.gen(function*() {
          const identity = askIdentity(runId, input)
          const token = yield* runtime.registerApproval({
            _tag: "Node",
            runId,
            requestId: identity.requestId,
            digest: identity.digest,
            envelope: askEnvelope
          }).pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError.HarnessError({
                  code: "engine_failed",
                  message: `The approval decision could not be read for run ${runId}`,
                  cause
                })
            )
          )
          if (token._tag === "Pending") {
            return yield* new HarnessError.HarnessError({
              code: "engine_failed",
              message: "The ask has no approval decision yet"
            })
          }
          const approved = token._tag === "Approved"
          return { answer: approved ? "approved" : "denied", approved }
        })
    })

    /**
     * The fence each run this session parked was parked under.
     *
     * `RunSummary.parkedBy` is the durable half; this is the half only the
     * parking process can hold. A fence is minted per claim, so a fence this
     * map still holds and the row still names is proof that THIS incarnation
     * parked THAT execution — which is the only thing that distinguishes the
     * host of a parked run from any other process that can see it, since a
     * park releases the owner columns on both rows (triage B-15).
     */
    const parkFences = new Map<string, string>()

    /** Whether a status leaves the run parked rather than driving or ending it. */
    const parks = (status: RunStatus): boolean => status === "parked" || status === "waiting-approval"

    /**
     * Writes one fenced status transition and its journal record.
     *
     * A terminal `failed` carries the rendered cause. Before it did, the
     * cause went only to `Effect.logWarning`, so a failed run was
     * undiagnosable from its own journal: three of the five first SWE-bench
     * benchmark runs ended `control.run.failed {runId, status}` and nothing
     * else, and the log line was long gone. The journal is the record a
     * `smithers status` diagnosis reads, so the reason a run died belongs in it.
     */
    const writeStatus = (runId: string, status: RunStatus, detail?: string) =>
      Effect.gen(function*() {
        const fence = yield* runtime.claimFence(runId)
        yield* runtime.writeStatus(runId, fence, status)
        if (parks(status)) parkFences.set(runId, fence)
        else parkFences.delete(runId)
        yield* emit(
          runId,
          `control.run.${status}`,
          detail === undefined ? { runId, status } : { runId, status, cause: detail.slice(0, 4096) }
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.annotateLogs(
              Effect.logWarning("An agent run lifecycle event could not be journaled"),
              { runId, status, cause: Cause.pretty(cause) }
            )
          )
        )
      })

    /**
     * Settles the control-plane status from one execution attempt's exit. A
     * suspension surfaces as an interrupt-only cause — the engine parked the
     * frame — and every re-executed attempt settles again, so the resumed
     * run writes its own terminal status.
     */
    const settle = (
      runId: string,
      suspended: boolean,
      exit: Exit.Exit<unknown, unknown>,
      waitingReason?: string
    ) =>
      Exit.isSuccess(exit)
        ? writeStatus(runId, "completed")
        // Flow suspension deliberately interrupts the user body. Process
        // shutdown and Control.cancel do too, but neither sets the durable
        // execution's suspension bit; reporting those as an approval wait
        // would leave a cancelled run looking resumable.
        : Cause.hasInterruptsOnly(exit.cause)
        ? suspended
          ? writeStatus(runId, waitingReason === "approval" ? "waiting-approval" : "parked")
          // Cancellation and process shutdown both close the execution scope.
          // The control operation owns cancellation's terminal write, while a
          // shutdown must leave the run reclaimable rather than misreport it
          // as a model failure.
          : Effect.void
        : Effect.andThen(
          Effect.annotateLogs(Effect.logWarning("An agent run failed"), {
            runId,
            cause: Cause.pretty(exit.cause)
          }),
          Effect.suspend(() => {
            const detail = failureSummary(settlementFailure(Cause.squash(exit.cause)))
            const cause = Cause.pretty(exit.cause)
            return writeStatus(runId, "failed", detail === undefined ? cause : `${detail}\n${cause}`)
          })
        )

    const approvedExecution = (
      runId: string,
      card: PlanCard,
      descriptor: Descriptor.FlowDescriptor
    ): Effect.Effect<string, LaunchFailed> =>
      Effect.suspend(() => {
        const expected = card.executionDigest
        if (expected === undefined || Descriptor.executionDigest(descriptor) !== expected) {
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: `Flow ${card.flowId} changed or has no approved executable identity; ` +
                "create and approve a new plan before running it",
              cause: { flowId: card.flowId }
            })
          )
        }
        return Effect.succeed(expected)
      })

    const approvedSeat = (
      runId: string,
      card: PlanCard,
      descriptor: Descriptor.FlowDescriptor
    ): Effect.Effect<string, LaunchFailed> =>
      Effect.suspend(() => {
        // Validate the same executable fields at launch and on every resume.
        // An identified prompt without a seat cannot be run by another host.
        if (Option.isNone(descriptor.model)) {
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: `Flow ${card.flowId} declares no model seat: add a \`model:\` line to ` +
                `its frontmatter, then run \`smithers doctor\` to see which provider keys this project has`,
              cause: { flowId: card.flowId }
            })
          )
        }
        return Effect.succeed(descriptor.model.value)
      })

    const approvedModule = (
      runId: string,
      card: PlanCard,
      executionDigest: string
    ): Effect.Effect<Executable.Executable, LaunchFailed> =>
      Effect.suspend(() => {
        const catalog = Option.getOrUndefined(executables)
        const executable = catalog?.executables.find((entry) => entry.descriptor.name === card.flowId)
        if (executable === undefined || Descriptor.executionDigest(executable.descriptor) !== executionDigest) {
          const refusal = catalog?.refused.find((entry) => entry.flow === card.flowId)
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: refusal?.message ??
                `Flow ${card.flowId} has no registered executable matching its approved identity`,
              cause: refusal ?? { flowId: card.flowId }
            })
          )
        }
        if (!card.envelope.flows.includes(executable.delegate)) {
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: `Flow ${card.flowId} delegates to ${executable.delegate}, outside the approved flow envelope`,
              cause: { flowId: card.flowId, delegate: executable.delegate }
            })
          )
        }
        return Effect.succeed(executable)
      })

    /** One agent run, executed as the whole of one durable flow execution. */
    const body = (
      payload: { readonly runId: string; readonly planId: string },
      instance: FlowRuntime.FlowInstance["Service"]
    ) =>
      Effect.gen(function*() {
        // Check before opening any model or cell boundary. A new hash alone
        // would turn old settlements into misses and repeat their side effects.
        let after: JournalEvent.Seq | undefined
        for (;;) {
          const page = yield* journal.entries({
            runId: JournalEvent.RunId.make(payload.runId),
            limit: 1_000,
            ...(after === undefined ? {} : { after })
          })
          yield* Effect.fromResult(Transcript.validateJournal(page.entries))
          if (!page.hasMore) break
          after = page.entries.at(-1)!.seq
        }
        const plan = yield* runtime.getPlan(payload.planId)
        const card = plan.card
        const descriptor = yield* registry.get(card.flowId)
        const executionDigest = yield* approvedExecution(payload.runId, card, descriptor)
        // The launch already validated the seat and body; re-validation here
        // guards a registry that changed between acceptance and execution.
        const flowBody = yield* registry.loadBody(card.flowId, executionDigest)
        if (flowBody._tag !== "Prompt") {
          const executable = yield* approvedModule(payload.runId, card, executionDigest)
          const input = yield* Schema.decodeUnknownEffect(Schema.Json)(plan.decodedInput)
          // One ordinary durable child retains the module's native topology,
          // action outputs, waits and replay. The existing session continues
          // to own control admission, cancellation and settlement.
          return yield* executable.flow.execute({ input }, {
            executionId: Digest.digest(Digest.canonical(["control/module", payload.runId, executionDigest]))
          }).pipe(
            CapabilitySet.attenuate(patterns(card.envelope.capabilities)),
            Effect.provide(options.budget(card.envelope)),
            Effect.provide(options.quotaPolicy)
          )
        }
        const seatId = yield* approvedSeat(payload.runId, card, descriptor)
        const seat = yield* seats.resolve(seatId)
        const steering = yield* Notifications.make({ runId: payload.runId, lineageId: payload.runId })
        // The three services a durable flow body already holds, captured
        // together: `StandardFlows.clock` hands them back to a `DurableClock`
        // sleep, whose deferred key is hashed, so `Crypto` travels with the
        // runtime rather than being substituted at the binding.
        const engineServices = yield* Effect.context<
          Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
        >()
        const tags: Array<string> = []
        // The trail is buffered in memory and written by a fiber of its own,
        // never by the stream's consumer.
        //
        // The consumer runs inside the frame: the harness cannot emit its next
        // event until this callback returns, and the frame it is inside holds
        // the engine's write transaction. A journal write here therefore waits
        // on a writer that is waiting on this callback, and the run stalls
        // silently at 0% CPU a few frames in — which is exactly what happened
        // when this was a plain `emitDurable`, and still happened on the lossy
        // channel because its queue drains through the same writer. Pushing
        // onto an array cannot block, so the frame always proceeds; the pump
        // below writes whatever has accumulated once the writer is free again.
        const pending: Array<
          { readonly sourceSeq: JournalEvent.SourceSeq; readonly eventType: string; readonly payload: unknown }
        > = []
        const flush = Effect.suspend(() =>
          Effect.forEach(
            pending.splice(0, pending.length),
            // Contained per entry rather than per batch: one refused event must
            // not take the rest of the batch down with it.
            (entry) => Effect.ignore(trail(payload.runId, entry.sourceSeq, entry.eventType, entry.payload)),
            { discard: true }
          )
        )
        // Journaling is best-effort on purpose: a full or rejecting journal
        // must not fail an agent run that is otherwise making progress.
        // Occurrence time is stamped into the payload because the pump
        // flushes in batches: `emitted_at_ms` is admission time, so every
        // event in one flush shares a millisecond and per-call timing is
        // unrecoverable from the row alone.
        //
        // Where the run is, as the stream reports it, which is what
        // `traceIdentity` derives an event's identity from. A resumed attempt
        // republishes its whole prefix from frame zero, so counting frames and
        // the events inside them reproduces the same coordinates for the same
        // events, and only for them. Non-journaled events (the model deltas)
        // are not counted: they carry no row, and leaving them out keeps the
        // ordinal a position in the trail rather than in the stream.
        let frame = -1
        let ordinal = 0
        let cell = ""
        const record = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => {
              tags.push(event._tag)
              if (event._tag === "turn-opened") {
                frame += 1
                ordinal = 0
                cell = ""
              }
              if (event._tag === "cell-produced") cell = event.cell.digest
              const projected = trace(event)
              if (projected !== undefined) {
                // Normalized once, here, so the identity is derived from the
                // same bytes the journal stores. A projection carries optional
                // fields as `undefined`, which JSON drops and canonical JSON
                // refuses outright, so deriving straight from the projection
                // threw on the first `cell-call-settled` that answered without
                // a message.
                const material = JSON.parse(JSON.stringify(projected.payload)) as Record<string, unknown>
                const sourceSeq = traceIdentity(frame, ordinal, cell, projected.eventType, material)
                ordinal += 1
                pending.push({
                  sourceSeq,
                  eventType: projected.eventType,
                  payload: { ...material, at, journalVersion: Transcript.journalVersion }
                })
              }
            }))
        const pump = yield* Effect.forkChild(
          Effect.forever(Effect.andThen(Effect.sleep(Duration.millis(250)), flush))
        )
        const outcome = yield* agent.run({
          contextWindowTokensFor: contextWindowResolver(seats),
          session: payload.runId,
          seat,
          modelParams: ModelRequest.GenerationParams.make({
            reasoningEffort: effortFor(descriptor, options.reasoningEffort)
          }),
          prompt: prompt(flowBody.text, plan.decodedInput),
          system: options.system,
          registry,
          promptRunner: options.promptRunner,
          flows: [
            ...(options.flows ?? []),
            StandardFlows.clock(engineServices),
            StandardFlows.approval(asker(payload.runId))
          ],
          authorize: authorize(payload.runId, instance),
          capabilityEnvelope: patterns(card.envelope.capabilities),
          limits: options.limits,
          maxFrames: options.maxFrames,
          // A task run's frames are supposed to change something, so hold it
          // to a rhythm of acting rather than only reading.
          readOnlyCap: options.readOnlyCap ?? CellTurn.defaultReadOnlyFrames,
          // Passed straight through rather than defaulted here: unlike the
          // read-only cap, the controller's own default is the one this
          // executor wants, and a second copy of the number would be a second
          // thing to keep true. The repeat cap is passed the same way.
          modelCallMs: options.modelCallMs,
          repeatCap: options.repeatCap,
          narrowingCap: options.narrowingCap,
          unmovedCap: options.unmovedCap,
          unresolvedCap: options.unresolvedCap,
          approvalChannel: options.approvalChannel ?? false
        }).pipe(
          (stream) => agentOutcome(stream, record),
          Effect.provide(options.budget(card.envelope)),
          Effect.provide(options.quotaPolicy),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provideService(Steering.Source, steering),
          // The pump is interrupted before the final flush so the two never
          // race for the same buffered entries, and the flush runs on the way
          // out of every exit — settled, failed, or parked — because a parked
          // run's trail is the one an operator most needs to read.
          Effect.onExit(() => Effect.andThen(Fiber.interrupt(pump), flush))
        )
        if (outcome._tag === "FramesExhausted") {
          return yield* new HarnessError.HarnessError({
            code: "model_failed",
            message:
              `The agent session "${payload.runId}" ended without a completed answer after ${outcome.frames} frames`,
            cause: outcome
          })
        }
        return tags
      })

    const activeBodies = new Map<string, Fiber.Fiber<unknown, unknown>>()

    /** One launched run's drive, for as long as this composition owns its fiber. */
    interface Drive {
      /**
       * Whether the flow body has exited, leaving only the engine's own
       * terminal write.
       *
       * The control status and the engine's terminal transition are two
       * writes, in that order: `settle` runs on the body's exit, INSIDE the
       * registered handler, and the engine records the round's result only
       * after that handler returns.
       */
      settled: boolean
    }

    /**
     * The drive of every run this composition launched and still owns. An
     * entry is created by `launch` and removed when its fiber ends, so nothing
     * a sweep or a resume drives ever enters it.
     */
    const launchedDrives = new Map<string, Drive>()

    /**
     * How long a closing scope waits for a drive fiber whose body has already
     * settled.
     *
     * The wait is for one engine transaction, which is milliseconds. The bound
     * exists so a wedged store costs a bounded exit rather than a hung one.
     */
    const settlementGrace = Duration.seconds(5)

    /**
     * Releases one drive fiber when this composition's scope closes.
     *
     * A drive fiber that is still executing is interrupted at once. That is
     * process shutdown, and `RunDriver.settleInterrupted` releases the row for
     * reclaim, which is the contract. A drive fiber whose body has already
     * settled is a different thing: nothing is left to interrupt but the
     * engine's own terminal write, so that write is awaited first.
     *
     * Without the wait, an attached launch tore that write in half. The CLI
     * returns on `control.run.completed` (`packages/smithers/src/Command.ts`
     * `awaitRun`), its scope closes, and this finalizer interrupted the driver
     * 10 to 14 ms before `engine.execute` had recorded the `Complete` result.
     * The release validation measured it on both a foreground `smithers run` and a
     * `smithers up -d`: `control.run.completed` at 1788163027537,
     * `flows.engine.run-decision interrupt-released` at 1788163027551. The row
     * was left `suspended`/`released` with no result, so every later process
     * that composed an executor claimed it and replayed the agent turn: 16 run
     * decisions across 11 pids for one run, tokens reported six times over,
     * and `gc` never collecting it from `engine.db`.
     */
    const releaseDrive = (drive: Drive, fiber: Fiber.Fiber<unknown, unknown>): Effect.Effect<void> =>
      Effect.suspend(() =>
        drive.settled
          ? Effect.andThen(
            Effect.ignore(Effect.timeout(Fiber.await(fiber), settlementGrace)),
            Fiber.interrupt(fiber)
          )
          : Fiber.interrupt(fiber)
      )

    const driveFibers = new Map<Drive, Fiber.Fiber<unknown, unknown>>()
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(driveFibers),
          ([drive, fiber]) => releaseDrive(drive, fiber),
          { discard: true, concurrency: "unbounded" }
        )
      )
    )

    const driver = (runId: string, planId: string) =>
      Effect.gen(function*() {
        const admitted = yield* waitForRunning(
          (id) => runtime.getRun(id).pipe(Effect.orDie, Effect.map((run) => run.status)),
          runId,
          400
        )
        if (!admitted) return
        yield* engine.execute(agentFlow, {
          executionId: runId,
          payload: { runId, planId },
          discard: true
        }).pipe(
          // ControlRuntime awaits this driver while it owns the control
          // transaction, so the active flow body is interrupted synchronously
          // here: no tool escapes a cancellation that has already committed.
          //
          // And that is ALL this handler does. It used to call
          // `engine.interrupt` — the DURABLE cancel, which writes
          // `cancel_requested_at_ms` — for every interruption of this fiber,
          // and a park interrupts it as surely as a cancel does. A flow that
          // suspended on a durable clock or an in-run `ask` was therefore
          // recorded as cancelled at the parking process's exit: the guarded
          // suspended transition in `RunDriver.settleRound` read the request
          // and answered `GuardFailed`, `cancelOwned` completed the run's
          // clock rows 150 seconds before they fell due, and the journal
          // gained `flows.engine.interrupted {"outcome":"cancelled"}` for a
          // run nobody had cancelled (release rehearsal).
          //
          // The durable half of a cancellation belongs to the caller that
          // meant one. `Control.cancel` writes it through
          // `ControlExecutor.requestCancel` INSIDE its own mutation
          // transaction, before it interrupts anything, and rolls the whole
          // cancel back if the engine refuses. `RunDriver.settleInterrupted`
          // then reads that record and discriminates on it: an interruption
          // backed by a request closes the run, and every other one releases
          // it for reclaim (engine-store issue #26). Recording the request
          // here as well made this fiber's interruption its own evidence,
          // which is the one thing it can never be.
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              const bodyFiber = activeBodies.get(runId)
              if (bodyFiber !== undefined) {
                yield* Fiber.interrupt(bodyFiber).pipe(
                  Effect.forkDetach({ startImmediately: true })
                )
              }
            })
          )
        )
      }).pipe(
        Effect.catchCause((cause) =>
          settleDriverFailure(cause, runId, (detail) => writeStatus(runId, "failed", detail))
        )
      )

    /**
     * Whether this engine publishes the execution as parked, treating a store
     * that cannot answer as "not parked": a composition with no evidence
     * leaves the run to the host that has some.
     */
    const parkedHere = (runId: string, attempts: number): Effect.Effect<boolean> =>
      awaitParked(runId, attempts).pipe(
        Effect.catchCause((cause) => recoverCause(cause, "The engine park state could not be read", false, { runId }))
      )

    const awaitParked = (runId: string, attempts: number): Effect.Effect<boolean, unknown> =>
      Effect.gen(function*() {
        // A time-travel fork has executable state but no previous Suspended
        // result. Ownership columns prove it is available without waiting
        // for a publication that only an already-executed run can produce.
        const row = yield* engineRuns.get(runId).pipe(
          Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.fail(error))
        )
        if (
          row !== undefined && (row.status === "pending" || row.status === "suspended") &&
          row.owner === null && row.claim === null
        ) {
          const state = JSON.parse(row.stateJson) as { flowName?: unknown; result?: unknown }
          if (state.flowName === agentFlow._tag && state.result === undefined) return true
        }
        return yield* waitForParked(
          () =>
            engine.poll(agentFlow, runId).pipe(
              // The journal carries resume events for runs other executors own —
              // a paused system flow, a shared control database. An execution
              // this engine does not know will not become parked by waiting, so
              // it is published as a settled non-parked state: the wait ends
              // now instead of holding the single-concurrency bridge through
              // the whole retry budget.
              Effect.catchTag(
                "@smthrs/flow/FlowExecutionNotFound",
                () => Effect.succeed(Option.some({ _tag: "NotFound" }))
              )
            ),
          attempts
        )
      })

    /**
     * Re-drives one execution `takeUpResume` has already found parked here and
     * claimed. A refusal is contained: one run that cannot restart must not
     * take the follower or the journal bridge down with it.
     */
    const resumeExecution = (runId: string): Effect.Effect<void> =>
      engine.resume(agentFlow, runId).pipe(
        Effect.catchCause(
          (cause) =>
            Effect.annotateLogs(
              Effect.logWarning("A parked agent run could not be resumed"),
              { runId, cause: Cause.pretty(cause) }
            )
        )
      )

    /**
     * Closes a parked run whose cancellation this process has just recorded.
     *
     * A park has no owner, which is what makes it resumable — so nothing is
     * driving the run and nothing reads the request the CONTROL plane just
     * wrote on the engine row. The engine's own parked-run sweep ticks once
     * per `Ownership.heartbeatInterval`, but a `smithers cancel` process
     * writes the request at the very end of its life and exits before that
     * tick lands: the release validation watched an engine row stay `suspended`
     * with `cancel_requested_at_ms` set through six more commands and 15
     * seconds, so `gc` skipped the run in `engine.db` while collecting it in
     * `control.db`, and only a 20-second `smithers serve` finalized it.
     *
     * Driving the run settles it inside the cancelling call, after the
     * mutation that recorded the request has committed — inside it the
     * engine's writes would wait on the writer that transaction holds, and
     * the cancel deadlocked until its timeout. It cannot
     * re-execute the flow: the request is durable BEFORE this runs, and the
     * engine's re-activation guard closes a run with a recorded cancellation
     * instead of entering its body (engine-store issue #39, pinned by
     * `InterruptReleaseReclaim`). A run this engine does not host is not
     * parked as far as `poll` is concerned, or refuses the claim, and either
     * way this is a no-op — the durable request stays for the host that does.
     */
    const settleCancelledPark = (runId: string): Effect.Effect<void> =>
      Effect.flatMap(
        // No retries: a run this engine is not hosting must cost a cancel
        // nothing, and one it is hosting is already parked by the time the
        // request is durable.
        parkedHere(runId, 0),
        (parked) => parked ? resumeExecution(runId) : Effect.void
      )

    /**
     * Whether this composition is the one hosting a parked run.
     *
     * Engine visibility is not hosting. A parked execution has released its
     * owner and its heartbeat on both rows — that is what makes it resumable —
     * so `engine.poll` answers `Suspended` in EVERY process that opened the
     * same `engine.db`, and the shipped CLI composes an executor in every one
     * of them (`NodeControl.layerControl` builds `layerExecutor` unless
     * `--remote`). A `smithers approve` against a run a gateway parked could
     * therefore claim the control row, drive the run itself, and strand it at
     * process exit. `RunSummary.parkedBy` is what answers instead: the fence
     * the park was written under, which only the parking incarnation still
     * holds (triage B-15).
     *
     * Three answers, in order:
     *
     * - No `parkedBy` at all: nothing claims to host the run — an operator's
     *   own park, or a row parked before this field existed — so the take-up
     *   proceeds as it always did.
     * - `parkedBy` this session wrote: this is the host. It takes its own
     *   delegation up at once, which is the ordinary same-process approval.
     * - Somebody else's `parkedBy`: not this composition's run to drive, so
     *   the delegation is left standing for the host that parked it — until
     *   it has stood unanswered for `options.abandonedParkAfter`, defaulting
     *   to the engine's `heartbeatStaleAfter`. Refusing it forever would leave
     *   a run parked by an exited process unresumable by another host.
     *
     * A control store that cannot answer is not evidence of a foreign host, so
     * it leaves the decision where it was before this guard existed.
     */
    const hostsPark = (
      runId: string,
      uptake: Uptake
    ): Effect.Effect<boolean, never> =>
      Effect.gen(function*() {
        if (uptake._tag === "claimed") return true
        const parkedBy = yield* runtime.getRun(runId).pipe(
          Effect.map((run) => run.parkedBy),
          Effect.catchCause((cause) =>
            recoverCause(cause, "The parked run host could not be read", undefined, { runId })
          )
        )
        if (parkedBy === undefined) return true
        if (parkFences.get(runId) === parkedBy) return true
        if (uptake.requestedAtMs === undefined) return false
        const nowMs = yield* Clock.currentTimeMillis
        return nowMs - uptake.requestedAtMs >= abandonedParkAfterMs
      })

    /**
     * Takes up one resume: this executor's execution, this executor's fence.
     *
     * The park wait comes first. It ends `false` for an execution this engine
     * does not have, and for one that is not parked, and neither is this
     * executor's to claim. {@link hostsPark} comes second and is the ownership
     * question proper: an execution this engine can SEE is not one it hosts.
     *
     * The claim comes third and is what makes the re-driven run WRITABLE.
     * `writeStatus` reaches `claimFence`, which requires `ownedByUs`, which
     * requires a `running` row: a run re-driven without a claim runs to its
     * end and then cannot record that it did.
     *
     * `drive` is how the caller wants the re-drive run. The journal bridge
     * awaits it, so one process's re-drives stay serialized; the port forks it,
     * so a control-plane call returns as soon as the run is moving again.
     *
     * `uptake` says which seam asked. See {@link Uptake}: an operator's own
     * resume is not guarded, an approval delegation is.
     */
    const takeUpResume = (
      runId: string,
      drive: (runId: string) => Effect.Effect<void>,
      uptake: Uptake
    ): Effect.Effect<ControlExecutor.ResumeUptake, never> =>
      Effect.gen(function*() {
        if (options.canExecute !== undefined && !(yield* options.canExecute(runId))) return "unknown" as const
        const parked = yield* parkedHere(runId, 500)
        if (!parked) return "unknown" as const
        const hosted = yield* hostsPark(runId, uptake)
        if (!hosted) return "unknown" as const
        const claimed = yield* runtime.resume(runId).pipe(
          Effect.as(true),
          // A lost claim is a live peer holding the run, and the delegation
          // stays standing for it. Answering "resuming" here would clear a
          // delegation this executor is not going to honour.
          Effect.catchCause((cause) =>
            recoverCause(cause, "The parked run could not be claimed for resume", false, { runId })
          )
        )
        if (!claimed) return "unknown" as const
        yield* drive(runId)
        return "resuming" as const
      })

    /**
     * Follows the journal for the control plane's resume events and re-drives
     * the parked engine execution. `Control.resume` and `Control.run`'s
     * `Resume` branch record different event types; both mean the same thing
     * here.
     */
    const resumeBridge = Effect.gen(function*() {
      const subscription = yield* journal.changes
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((entry) => entry.eventType === "control.run.resume" || entry.eventType === "control.run.resumed"),
        Stream.mapEffect(
          (entry) =>
            takeUpResume(
              entry.runId,
              resumeExecution,
              // `control.run.resume` is the operator's own claim, already taken
              // in this process by the call that journaled it; `resumed` is the
              // approval delegation, which belongs to whoever parked the run.
              entry.eventType === "control.run.resume" ? { _tag: "claimed" } : { _tag: "delegated" }
            ),
          { concurrency: 1 }
        ),
        Stream.runDrain
      )
    }).pipe(
      Effect.catchCause(
        (cause) =>
          Effect.annotateLogs(
            Effect.logError("The executor resume bridge stopped"),
            { cause: Cause.pretty(cause) }
          )
      )
    )

    /**
     * Whether the control plane has already settled this run.
     *
     * A control database that cannot be read answers "no": a composition with
     * no evidence must drive the run rather than abandon it.
     */
    const settledAlready = (runId: string): Effect.Effect<boolean> =>
      runtime.getRun(runId).pipe(
        Effect.map((run) => run.status === "completed" || run.status === "failed" || run.status === "cancelled"),
        Effect.catchCause((cause) =>
          recoverCause(cause, "The control run settlement could not be read", false, { runId })
        )
      )

    yield* engine.register(agentFlow, (input) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        // A fork copies the parent's input, but belongs to its own execution.
        // Never settle or send approvals to the parent named by copied data.
        const payload = { ...input, runId: instance.executionId }
        // A run the control plane has already settled is finished here without
        // being executed again.
        //
        // A launcher killed between the two settlement writes leaves the
        // engine row `suspended`/`released` with no result, and that row is
        // reclaimable by design: `RunDriver.sweepCancelRequested` wakes every
        // released row once per heartbeat, in EVERY process that opened the
        // same `engine.db`. Without this guard each of them re-enters the
        // agent body: the release validation counted ten processes replaying run-1,
        // 162 journal events against 36 for an untouched run, and a token
        // total six times the truth. Returning here records a terminal
        // result instead, which is the one write the row is missing, so the
        // next `gc` can collect it. The control row is the run's outcome of
        // record and is not rewritten.
        if (yield* settledAlready(payload.runId)) return []
        const fiber = yield* Effect.forkChild(
          body(payload, instance).pipe(
            Effect.onExit((exit) =>
              Effect.andThen(
                Effect.sync(() => {
                  const drive = launchedDrives.get(payload.runId)
                  if (drive !== undefined) drive.settled = true
                }),
                settle(payload.runId, instance.suspended, exit, instance.waiting?.reason)
              )
            ),
            Effect.provide(services)
          ),
          { startImmediately: true }
        )
        activeBodies.set(payload.runId, fiber)
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (activeBodies.get(payload.runId) === fiber) activeBodies.delete(payload.runId)
          })),
          // `settle` above already read the true exit, so the operator's line
          // and the control plane's recorded cause are unchanged. This is
          // only the shape the engine has to persist.
          Effect.mapError(settlementFailure)
        )
      })).pipe(Scope.provide(scope))

    /**
     * Takes up every resume delegation this executor hosts, once.
     *
     * The journal's `changes` hub is an in-process `PubSub`: no other journal
     * instance can publish into it, so a decision taken in another process
     * reaches this executor through nothing at all. The delegation is durable
     * in the control database instead, and this is what reads it. Runs this
     * executor does not host are left alone with their delegation standing,
     * for the host that does — and this is the one caller that knows how long
     * one has been standing, so it is the only path by which an abandoned
     * park is ever adopted ({@link hostsPark}).
     */
    const drainPendingResumes = runtime.pendingResumes.pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending, (entry) =>
          takeUpResume(
            entry.runId,
            (runId) => Effect.asVoid(Effect.forkIn(resumeExecution(runId), scope)),
            { _tag: "delegated", requestedAtMs: entry.requestedAtMs }
          ).pipe(
            Effect.flatMap((uptake) =>
              uptake === "resuming" ? runtime.clearResume(entry.runId, entry.sequence) : Effect.void
            )
          ), { discard: true })
      ),
      Effect.catchCause((cause) =>
        Effect.annotateLogs(
          Effect.logWarning("A pending resume delegation could not be taken up"),
          { cause: Cause.pretty(cause) }
        )
      )
    )

    /**
     * The durable follower: one pass, then one every second, forever.
     *
     * A second is the same bound `SqlJournal`'s own cross-process follower
     * uses to recheck the durable tail, and the same heartbeat tick the engine
     * sweeps cancellations on. Nothing here is event-driven, because rc.0 has
     * no cross-process wake (the release policy).
     */
    const pendingResumeBridge = drainPendingResumes.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(1))),
      Effect.forever
    )

    yield* Effect.forkIn(resumeBridge, scope)
    yield* Effect.forkIn(pendingResumeBridge, scope)
    // A signal recorded while this process was down has a wait point still
    // open and nobody to complete it. Replaying at start is what makes
    // `Control.signal`'s record a promise rather than a note.
    yield* Effect.forkIn(
      Effect.provide(drainRecordedSignals, services).pipe(Effect.repeat({ schedule: Schedule.spaced("250 millis") })),
      scope
    )

    const launch = (
      input: ControlExecutor.Launch
    ): Effect.Effect<ControlExecutor.Acceptance, LaunchFailed> =>
      Effect.gen(function*() {
        const flowId = input.plan.card.flowId
        const descriptor = yield* registry.getOption(flowId)
        if (Option.isNone(descriptor)) {
          // Not a flow this composition knows — a system flow, or one whose
          // registry another host holds. Pending is the honest acceptance:
          // nothing here runs it, and something else still might.
          return "pending" as const
        }
        const flowBody = yield* registry.loadBody(flowId, input.plan.card.executionDigest).pipe(
          Effect.mapError(
            (cause) =>
              new LaunchFailed({
                runId: input.run.runId,
                message: `The body of flow ${flowId} could not be loaded`,
                // The typed registry failure travels whole. `LaunchFailed.cause`
                // is `Schema.Defect`, so it carries the `RegistryError` with its
                // `_tag` and `code` intact, and an operator reading the refusal
                // can tell a deleted flow file from an unreadable one.
                // `String(cause)` flattened both to the same sentence.
                cause
              })
          )
        )
        if (flowBody._tag !== "Prompt") {
          if (Option.isNone(executables)) return "pending" as const
          const digest = yield* approvedExecution(input.run.runId, input.plan.card, descriptor.value)
          yield* approvedModule(input.run.runId, input.plan.card, digest)
        } else {
          yield* approvedExecution(input.run.runId, input.plan.card, descriptor.value)
          const seatId = yield* approvedSeat(input.run.runId, input.plan.card, descriptor.value)
          // Resolve the seat now, so a missing key refuses the launch as a
          // typed failure instead of failing the run after it was accepted.
          yield* seats.resolve(seatId).pipe(
            Effect.mapError((error) =>
              new LaunchFailed({
                runId: input.run.runId,
                message: error.message,
                cause: { seat: error.seat }
              })
            )
          )
        }
        const start = yield* Deferred.make<void>()
        const drive: Drive = { settled: false }
        launchedDrives.set(input.run.runId, drive)
        const fiber = Effect.runForkWith(services)(
          Deferred.await(start).pipe(
            Effect.andThen(driver(input.run.runId, input.plan.card.planId)),
            // The drive is over: whatever the engine was going to record, it
            // has. Nothing may wait on this fiber after this point.
            Effect.ensuring(Effect.sync(() => {
              if (launchedDrives.get(input.run.runId) === drive) launchedDrives.delete(input.run.runId)
              driveFibers.delete(drive)
            })),
            Effect.scoped
          )
        )
        driveFibers.set(drive, fiber)
        yield* registerDriver(
          () => runtime.registerFiber(input.run.runId, fiber),
          input.run.runId
        ).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Fiber.interrupt(fiber) : Effect.void)
        )
        yield* Deferred.succeed(start, void 0)
        return "accepted" as const
      })

    return ControlExecutor.make({
      readExecution: (runId) => Effect.provide(readExecution(runId), services),
      launch: Effect.fn("AgentSession.launch")(launch),
      requestCancel: Effect.fn("AgentSession.requestCancel")((input) => Effect.provide(requestCancel(input), services)),
      deliverSignal: Effect.fn("AgentSession.deliverSignal")((input) => Effect.provide(deliverSignal(input), services)),
      resumeRun: Effect.fn("AgentSession.resumeRun")((input) =>
        takeUpResume(input.runId, (runId) => Effect.asVoid(Effect.forkIn(resumeExecution(runId), scope)), {
          _tag: "delegated"
        })
      ),
      settleCancelledPark: Effect.fn("AgentSession.settleCancelledPark")((input) => settleCancelledPark(input.runId))
    })
  })

/**
 * Provides the production {@link ControlExecutor.ControlExecutor}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<ControlExecutor.ControlExecutor, never, Services> =>
  Layer.effect(ControlExecutor.ControlExecutor)(make(options))
