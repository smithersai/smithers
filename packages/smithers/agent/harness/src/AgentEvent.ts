/**
 * Serializable events emitted by harness adapters.
 *
 * @since 0.1.0
 */
import * as Permission from "@smthrs/capability/Permission"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Schema } from "effect"
import * as Cell from "./Cell.ts"
import * as EngineLike from "./EngineLike.ts"
import * as Sandbox from "./Sandbox.ts"

/**
 * The loop discipline a run was armed with, journaled once when it starts.
 *
 * Arming used to be observable only through the events a disciplined run
 * *reaches*: the read-cap failure proves the cap was armed, and a run that
 * times out before it fires proves nothing — so a grader could not tell "armed
 * but never reached" from "never armed", which is exactly what the 2026-08-19
 * SWE-bench wave could not decide about its django instance. This event is the
 * positive record: it says what was armed, before anything has had a chance to
 * fire.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class DisciplineArmed extends Schema.TaggedClass<DisciplineArmed>(
  "flows/harness/AgentEvent/DisciplineArmed"
)("discipline-armed", {
  eventType: Schema.Literal("flows.harness.discipline-armed.v1"),
  /** Consecutive read-only frames allowed; zero means the cap is disarmed. */
  readOnlyCap: Schema.Number,
  /** The frame budget the run stops at. */
  maxFrames: Schema.Number,
  /**
   * Whether a human can answer this run.
   *
   * False says nothing is listening: a `park` transition is refused and
   * answered in the frame that returned it, because a run that waits for an
   * answer nobody will give has stopped working with its budget unspent.
   */
  approvalChannel: Schema.Boolean,
  /**
   * Wall-clock milliseconds one model call may spend; zero means disarmed.
   *
   * Every other budget here caps the cell — the calls it makes, the memory and
   * time its code spends, the run's frames. This one caps the step in between,
   * which was the only unbounded thing the loop did.
   */
  modelCallMs: Schema.Number,
  /**
   * Consecutive repeat-observation frames allowed; zero disarms the demand.
   *
   * Armed here for the same reason the read-only cap is: a run that never
   * reaches a control proves nothing about whether the control was armed, and
   * a grader must be able to tell "armed and never needed" from "never armed".
   */
  repeatCap: Schema.Number,
  /**
   * Completions this run may have bounced for narrowed evidence; zero disarms.
   *
   * Journaled with the rest because the demand it governs fires at most once
   * in a run and often not at all, so its absence from a wave says nothing on
   * its own. One is the armed default: the loop names the missing check once,
   * and the answer that comes back is the answer that stands.
   */
  narrowingCap: Schema.Number,
  /**
   * Completions this run may have bounced for an unmoved tree; zero disarms.
   *
   * Journaled for the same reason as the other two completion caps: the demand
   * fires at most once and usually not at all, so a wave that records none must
   * be able to say whether the control was armed and never needed.
   */
  unmovedCap: Schema.Number,
  /**
   * Times one frame may answer its own unparseable cell before ending; zero
   * disarms the answer.
   *
   * Journaled with the rest because a wave that records no
   * `cell-rejected-in-frame` must be able to say whether the answer was armed
   * and never needed or never armed at all.
   */
  revalidations: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for a failing check it replaced
   * rather than answered; zero disarms.
   */
  unresolvedCap: Schema.Number,
  /** Maximum calls per cell, when this binding can enforce one. */
  calls: Schema.optional(Schema.Number),
  /** Maximum sandbox heap, when this binding can enforce one. */
  memoryBytes: Schema.optional(Schema.Number),
  /** Maximum interpreter steps, when this binding can enforce one. */
  steps: Schema.optional(Schema.Number),
  /** Maximum cell-compute time, when this binding can enforce one. */
  timeMs: Schema.optional(Schema.Number),
  /** Maximum whole-evaluation time, when this binding can enforce one. */
  totalMs: Schema.optional(Schema.Number),
  /** Maximum wall-clock time for one flow call. */
  callMs: Schema.optional(Schema.Number)
}) {}

/**
 * The serializable snapshot fixed when a turn opens.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TurnOpened extends Schema.TaggedClass<TurnOpened>(
  "flows/harness/AgentEvent/TurnOpened"
)("turn-opened", {
  eventType: Schema.Literal("flows.harness.turn-opened.v1"),
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  /**
   * The tool set the turn opened with, which the cell-first controller always
   * opens empty: it declares no provider tools. The field stays on the event
   * so journals written before the provider-tool loop was retired keep
   * decoding, and so a foreign-adapter loop has somewhere to put one.
   */
  activeToolNames: Schema.Array(Schema.String),
  contextDigest: Schema.String
}) {}

/**
 * One provider-neutral model progress event.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class ModelDelta extends Schema.TaggedClass<ModelDelta>(
  "flows/harness/AgentEvent/ModelDelta"
)("model-delta", {
  eventType: Schema.Literal("flows.harness.model-delta.v1"),
  delta: ModelEvent.ModelEvent
}) {}

/**
 * A transport-only model retry taken before the sealed step settled.
 *
 * @category events
 * @since 0.1.0
 */
export class ModelRetried extends Schema.TaggedClass<ModelRetried>(
  "flows/harness/AgentEvent/ModelRetried"
)("model-retried", {
  eventType: Schema.Literal("flows.harness.model-retried.v1"),
  attempt: Schema.Int,
  code: Schema.String,
  /**
   * Milliseconds the boundary waited before this attempt.
   *
   * Every retry of one sealed step is journaled at the moment the step
   * settles, so the event timestamps cannot show the schedule. This carries
   * it. Zero is what an unscheduled retry, or a record written before the
   * field existed, reports.
   */
  delayMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
}) {}

/**
 * The complete recorded model settlement and usage.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class ModelSettled extends Schema.TaggedClass<ModelSettled>(
  "flows/harness/AgentEvent/ModelSettled"
)("model-settled", {
  eventType: Schema.Literal("flows.harness.model-settled.v1"),
  message: ModelRequest.AssistantMessage,
  usage: ModelEvent.Usage,
  /**
   * Wall-clock milliseconds the sealed step took, measured on the injected
   * clock.
   *
   * Usage alone answers what a call cost, never how long it took, so a
   * benchmark could compare tokens per run but not seconds per call — and
   * speed was the larger half of the gap the first head-to-head measured.
   * Zero is what an event carries when nothing timed it.
   */
  durationMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
}) {}

/**
 * The cell source recovered from one model settlement.
 *
 * The source itself is durable evidence: replay re-executes exactly this text,
 * and every call identity inside the frame folds in its digest.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellProduced extends Schema.TaggedClass<CellProduced>(
  "flows/harness/AgentEvent/CellProduced"
)("cell-produced", {
  eventType: Schema.Literal("flows.harness.cell-produced.v1"),
  cell: Cell.Source,
  /**
   * How many fenced cell blocks the reply was written in.
   *
   * Journaled because it is the only record of how the model laid its frame
   * out, and because the count above one is the shape whose whole program the
   * harness used to discard. See `Cell.extract`.
   */
  blocks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withConstructorDefault(Effect.succeed(1)),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  )
}) {}

/**
 * One reply the boundary parse refused, answered inside the frame it arrived
 * in rather than by ending the frame.
 *
 * Journaled because it is spend: a re-prompt is a real model call, cached
 * prefix or not, and a wave counting cost per frame would otherwise see the
 * output of an answer it has no record of asking for. It is also the only
 * measure of whether validating at the boundary is worth what it costs — the
 * ratio of this event to `cell-settled` rejections says how often one re-ask
 * recovers a frame.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellRejectedInFrame extends Schema.TaggedClass<CellRejectedInFrame>(
  "flows/harness/AgentEvent/CellRejectedInFrame"
)("cell-rejected-in-frame", {
  eventType: Schema.Literal("flows.harness.cell-rejected-in-frame.v1"),
  /** Which attempt of this frame was refused, counting from one. */
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Why the parse refused it. */
  code: Cell.RejectionCode,
  /** What the frame told the model, verbatim. */
  message: Schema.String
}) {}

/**
 * One flow call opened from inside a running cell.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellCallStarted extends Schema.TaggedClass<CellCallStarted>(
  "flows/harness/AgentEvent/CellCallStarted"
)("cell-call-started", {
  eventType: Schema.Literal("flows.harness.cell-call-started.v1"),
  call: Cell.Call
}) {}

/**
 * One settled flow call made from inside a running cell.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellCallSettled extends Schema.TaggedClass<CellCallSettled>(
  "flows/harness/AgentEvent/CellCallSettled"
)("cell-call-settled", {
  eventType: Schema.Literal("flows.harness.cell-call-settled.v1"),
  flowName: Schema.String,
  identity: Cell.CallIdentity,
  result: Cell.CallResult
}) {}

/**
 * What one REPL cell printed, as the next model turn will read it.
 *
 * The print buffer is the whole of the context channel in REPL mode, so it is
 * journaled rather than derived: a transcript projection rebuilds a resumed
 * run's window from the journal without re-running anything, exactly as it does
 * for the context a filing cell projected. Bounded before it is emitted, so the
 * journal carries what the model saw and nothing larger.
 *
 * @category events
 * @since 0.1.0
 */
export class CellPrinted extends Schema.TaggedClass<CellPrinted>(
  "flows/harness/AgentEvent/CellPrinted"
)("cell-printed", {
  eventType: Schema.Literal("flows.harness.cell-printed.v1"),
  /** The digest of the cell whose prints these are. */
  cell: Schema.String,
  /** The frame's whole print buffer, already bounded; empty when it printed nothing. */
  text: Schema.String
}) {}

/**
 * The outcome of executing one cell, whether it settled, threw, or was
 * rejected before it ran.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellSettled extends Schema.TaggedClass<CellSettled>(
  "flows/harness/AgentEvent/CellSettled"
)("cell-settled", {
  eventType: Schema.Literal("flows.harness.cell-settled.v1"),
  cell: Schema.String,
  outcome: Cell.Outcome,
  /** Absent in journals written before execution frontiers were recorded. */
  boundary: Schema.optional(Sandbox.FrameBoundary)
}) {}

/**
 * The durable transition the controller applied after a cell settled.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TransitionApplied extends Schema.TaggedClass<TransitionApplied>(
  "flows/harness/AgentEvent/TransitionApplied"
)("transition-applied", {
  eventType: Schema.Literal("flows.harness.transition-applied.v1"),
  transition: Cell.Transition
}) {}

/**
 * The controller issuing a read-cap intervention to the next frame.
 *
 * Kept separately from {@link ReadOnlyDemanded}: this event records the user
 * message entering the model transcript, while that event records how a later
 * frame answered it. A crash between those boundaries must retain the demand.
 *
 * @category events
 * @since 1.0.0-rc.0
 */
export class ReadOnlyDemandIssued extends Schema.TaggedClass<ReadOnlyDemandIssued>(
  "flows/harness/AgentEvent/ReadOnlyDemandIssued"
)("read-only-demand-issued", {
  eventType: Schema.Literal("flows.harness.read-only-demand-issued.v1"),
  /** Consecutive read-only frames the run had spent. */
  streak: Schema.Int,
  /** The armed threshold that streak reached. */
  cap: Schema.Int,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The outcome of the frame immediately following a read-cap intervention.
 *
 * @category events
 * @since 0.1.0
 */
export class ReadOnlyDemanded extends Schema.TaggedClass<ReadOnlyDemanded>(
  "flows/harness/AgentEvent/ReadOnlyDemanded"
)("read-only-demanded", {
  eventType: Schema.Literal("flows.harness.read-only-demanded.v1"),
  streak: Schema.Int,
  cap: Schema.Int,
  nextFrame: Schema.Int,
  nextAction: Schema.Literals(["write", "justification", "read-only", "park"])
}) {}

/**
 * The controller telling a run it has stopped learning anything.
 *
 * Written when a run reaches its repeat-observation threshold: consecutive
 * frames that issued calls, issued none the run had not already issued, and
 * changed nothing. Both this and {@link ReadOnlyDemandIssued} are written when
 * their demand is issued; {@link ReadOnlyDemanded} additionally records the
 * read-cap demand's later answer because that answer is a field on a
 * transition. A repeat demand is answered by the shape of the next frame's
 * calls, which the journal already writes one by one.
 *
 * @category events
 * @since 0.1.0
 */
export class RepeatDemanded extends Schema.TaggedClass<RepeatDemanded>(
  "flows/harness/AgentEvent/RepeatDemanded"
)("repeat-demanded", {
  eventType: Schema.Literal("flows.harness.repeat-demanded.v1"),
  /** Consecutive repeat-observation frames the run had spent. */
  frames: Schema.Int,
  /** The armed threshold that streak reached. */
  cap: Schema.Int,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion whose evidence was narrowed.
 *
 * Written when a frame returns `complete` while the check it ran is a strict
 * narrowing of one the run had already run in full, over a tree that has since
 * changed and never re-run since. Written when the demand is *issued*, like the
 * repeat demand and unlike the read-cap one, because what answers it is the
 * shape of the next frame's calls and its output — both of which the journal
 * already writes.
 *
 * The event is the whole audit trail for the bounce. `broader` and `narrower`
 * quote the two inputs as the run wrote them, and the two digests say which
 * trees they were measured over, so a grader can decide after the fact whether
 * the demand was right without replaying anything.
 *
 * @category events
 * @since 0.1.0
 */
export class NarrowedDemanded extends Schema.TaggedClass<NarrowedDemanded>(
  "flows/harness/AgentEvent/NarrowedDemanded"
)("narrowed-demanded", {
  eventType: Schema.Literal("flows.harness.narrowed-demanded.v1"),
  /** The flow both checks named. */
  flow: Schema.String,
  /** The broader check's input as the run wrote it, clipped. */
  broader: Schema.String,
  /** The narrowing check's input as the run wrote it, clipped. */
  narrower: Schema.String,
  /** Workspace digest the broader check was last run over. */
  broaderDigest: Schema.String,
  /** Workspace digest the completing frame closed on. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion with no change behind it.
 *
 * Written when a frame returns `complete` while the tree it closed on is
 * byte-for-byte the tree the run opened on. Written when the demand is
 * *issued*, like the narrowing demand, because what answers it is the next
 * frame's own record — an edit that moves the digest, or a second completion
 * saying no change was needed — and the journal already writes both.
 *
 * The two digests are the whole audit trail: a grader can decide after the fact
 * whether the demand was right by comparing them to the run's
 * `mutation-observed` record, without replaying anything.
 *
 * @category events
 * @since 0.1.0
 */
export class UnmovedDemanded extends Schema.TaggedClass<UnmovedDemanded>(
  "flows/harness/AgentEvent/UnmovedDemanded"
)("unmoved-demanded", {
  eventType: Schema.Literal("flows.harness.unmoved-demanded.v1"),
  /** Workspace digest the run opened on. */
  openedDigest: Schema.String,
  /** Workspace digest the completing frame closed on, equal to the first. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion that stepped around a failing check.
 *
 * Written when a frame returns `complete` while a check recorded over the same
 * tree reported a failing exit status, was never re-run, and a later check went
 * back to the same subject with a different command.
 *
 * `failed` and `instead` quote the two inputs as the run wrote them, and
 * `currentDigest` is the tree both were measured over, so the record says which
 * reading the completion stands on and which one replaced it.
 *
 * @category events
 * @since 0.1.0
 */
export class UnresolvedDemanded extends Schema.TaggedClass<UnresolvedDemanded>(
  "flows/harness/AgentEvent/UnresolvedDemanded"
)("unresolved-demanded", {
  eventType: Schema.Literal("flows.harness.unresolved-demanded.v1"),
  /** The flow both checks named. */
  flow: Schema.String,
  /** The failing check's input as the run wrote it, clipped. */
  failed: Schema.String,
  /** The input of the reading the run took instead, clipped. */
  instead: Schema.String,
  /** Workspace digest both checks were recorded over, and the frame closed on. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller refusing one completion that holds a single reading.
 *
 * Written when a frame returns `complete` while the last check it ran names
 * subjects no other check of the run covers together, and the run never issued
 * that exact call before. The sibling of `narrowed-demanded`, from the other
 * side: that one fires when a broader check exists in the ledger and was not
 * re-run, this one when no broader check was ever taken.
 *
 * `check` quotes the input as the run wrote it and `targets` names the subjects
 * the demand is about, so a grader can decide after the fact whether the demand
 * was right without replaying anything.
 *
 * @category events
 * @since 0.1.0
 */
export class NarrowOnlyDemanded extends Schema.TaggedClass<NarrowOnlyDemanded>(
  "flows/harness/AgentEvent/NarrowOnlyDemanded"
)("narrow-only-demanded", {
  eventType: Schema.Literal("flows.harness.narrow-only-demanded.v1"),
  /** The flow the check named. */
  flow: Schema.String,
  /** The check's input as the run wrote it, clipped. */
  check: Schema.String,
  /** The subjects it names, sorted. */
  targets: Schema.Array(Schema.String),
  /** Workspace digest the completing frame closed on; empty when unmeasured. */
  currentDigest: Schema.String,
  /** The frame the demand was attached to, which is the one that must answer it. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller telling a run that its own evidence is complete.
 *
 * The one control that is not a brake, and the only one written for a frame
 * that has done nothing wrong: the run watched a check fail before it changed
 * anything and watched the same check, or a broader one, pass after. Written
 * when the observation is *issued*, at most once per run, because what answers
 * it is the next frame's transition and the journal already writes that.
 *
 * `failed` and `passed` quote the two inputs as the run wrote them, and `epoch`
 * is the run's count of mutating frames when the failure was recorded, so the
 * ordering the observation asserts is checkable after the fact. Nothing is
 * refused and no cap is spent, so there is no cap field to record.
 *
 * @category events
 * @since 0.1.0
 */
export class SufficiencyObserved extends Schema.TaggedClass<SufficiencyObserved>(
  "flows/harness/AgentEvent/SufficiencyObserved"
)("sufficiency-observed", {
  eventType: Schema.Literal("flows.harness.sufficiency-observed.v1"),
  /** The flow that ran the failing check. */
  flow: Schema.String,
  /** The failing check's input as the run wrote it, clipped. */
  failed: Schema.String,
  /** The input of the passing check that answered it, clipped. */
  passed: Schema.String,
  /** Mutating frames the run had spent when the failure was recorded. */
  epoch: Schema.Int,
  /** The frame the observation was attached to. */
  nextFrame: Schema.Int
}) {}

/**
 * The controller telling a run that its stored proof was already green.
 *
 * **Nothing emits this.** `VacuousVerification` is unwired from `CellTurn`;
 * the event stays declared so the r93 journals that carry it keep decoding and
 * so a controlled re-measure needs no schema change. See `VacuousVerification`
 * for the evidence that turned the arm off.
 *
 * The second control in this package that is not a brake, and the narrower of
 * the two: a cell stored `state.verification` naming a call this run had
 * already watched pass over the tree it was handed, before any frame changed a
 * byte. Written when the observation is issued, at most once per distinct
 * verification input, and delivered on the `invalidProbe` channel because it is
 * the same class of fact — a result that reads identically on a broken tree and
 * on a fixed one.
 *
 * `check` quotes the stored input as the run wrote it, and `signature` is the
 * controller's own identity for that call, so a reader can reconcile the
 * observation against the run's own `cell-call-settled` rows without replaying
 * anything. Nothing is refused and no cap is spent, so there is no cap field.
 *
 * @category events
 * @since 0.1.0
 */
export class VacuousVerificationObserved extends Schema.TaggedClass<VacuousVerificationObserved>(
  "flows/harness/AgentEvent/VacuousVerificationObserved"
)("vacuous-verification-observed", {
  eventType: Schema.Literal("flows.harness.vacuous-verification-observed.v1"),
  /** The flow the stored check named. */
  flow: Schema.String,
  /** The stored check's input as the run wrote it, clipped. */
  check: Schema.String,
  /** The controller's identity for that call. */
  signature: Schema.String,
  /** The frame the observation was attached to. */
  nextFrame: Schema.Int
}) {}

/**
 * What one frame did to the workspace, and how the controller knows.
 *
 * Emitted once per frame that ran a cell. It is the frame's own answer to the
 * question every later audit asks — "did this frame change anything" — written
 * before any control acts on it, so a run that never trips the cap still leaves
 * the evidence behind.
 *
 * `basis` is the field that keeps the record honest. `observed` means the frame
 * had two measurements around it that each covered the whole workspace, so the
 * tree itself could answer. `partial` means a measurement was taken and stopped
 * at a bound before it covered the tree, so it is set aside: a prefix chosen by
 * sort order cannot say the files being edited outside it held still, and its
 * own movement is as likely to be a tool's churn as work. `declared` means the
 * host measured nothing at all.
 * Under the last two, `mutated` is only what the frame's calls claimed about
 * themselves — which is exactly the signal that missed a shell redirect over a
 * tracked source file.
 *
 * `mutated` is the union of the two signals, with one exception. A declaration
 * by a call that *succeeded* stands even where the measurement cannot see the
 * path it touched, because the alternative is failing a run that has been
 * editing all along on the strength of a walk that never looked at its files.
 * A declaration by a call that *failed* is a claim about what it would have
 * written, and where `basis` is `observed` and the digest did not move, the
 * tree has answered that claim: nothing was written, and the frame is not
 * counted as a write. So `declaredWrites: 1` beside `mutated: false` under
 * `observed` is a declaration the measurement vetoed, and both numbers stay in
 * the record.
 *
 * @category events
 * @since 0.1.0
 */
export class MutationObserved extends Schema.TaggedClass<MutationObserved>(
  "flows/harness/AgentEvent/MutationObserved"
)("mutation-observed", {
  eventType: Schema.Literal("flows.harness.mutation-observed.v1"),
  /** What the frame had to decide with: a full measurement, a partial one, or paperwork. */
  basis: Schema.Literals(["observed", "partial", "declared"]),
  /** Whether this frame changed anything: the tree said so, or a call declared it. */
  mutated: Schema.Boolean,
  /** Content address of the workspace as the frame left it; empty when unobserved. */
  digest: Schema.String,
  /** Paths the closing measurement covered; zero when unobserved. */
  paths: Schema.Int,
  /**
   * Calls this frame made that DECLARED a write, whether or not they landed.
   *
   * Journaled beside the observed answer rather than instead of it, because
   * the gap between the two numbers is the accounting defect itself: a frame
   * with `declaredWrites: 0` and `mutated: true` is a shell mutation nothing
   * else in the run can see, and a frame with `declaredWrites: 1` and
   * `mutated: false` under `observed` is a failed call whose declaration the
   * measurement contradicted.
   */
  declaredWrites: Schema.Int
}) {}

/**
 * One tree this run pinned, and the store's own name for it.
 *
 * Journaled at the mint rather than only at its use, because the two are
 * frames apart by design: a run pins the tree it is about to change and reads
 * against it later, and a journal that recorded only the reading could not say
 * which tree it was a reading of. `ref` is the host's vocabulary and the
 * controller never interprets it; a grader reconciles it against the store by
 * hand. See `EngineLike` `Snapshot`.
 *
 * @category events
 * @since 0.1.0
 */
export class CheckpointMinted extends Schema.TaggedClass<CheckpointMinted>(
  "flows/harness/AgentEvent/CheckpointMinted"
)("checkpoint-minted", {
  eventType: Schema.Literal("flows.harness.checkpoint-minted.v1"),
  /** The handle the cell holds, and what a later call names in its `at`. */
  id: Schema.String,
  /** What the host recorded, in the host's own vocabulary. */
  ref: Schema.String,
  /** The cell that minted it, and where in that cell. */
  cell: Schema.String,
  ordinal: Schema.Int
}) {}

/**
 * The durable reason a cell execution parked.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Suspended extends Schema.TaggedClass<Suspended>(
  "flows/harness/AgentEvent/Suspended"
)("suspended", {
  eventType: Schema.Literal("flows.harness.suspended.v1"),
  reason: EngineLike.SuspendReason
}) {}

/**
 * A sealed compaction summary and the prefix it replaces.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CompactionSettled extends Schema.TaggedClass<CompactionSettled>(
  "flows/harness/AgentEvent/CompactionSettled"
)("compaction-settled", {
  eventType: Schema.Literal("flows.harness.compaction-settled.v1"),
  replacedPrefixDigest: Schema.String,
  // Counts messages, not segments: one live transcript segment can contain
  // both an assistant turn and its observations. Absent in older journals.
  retainedMessageCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  summary: ModelRequest.Message
}) {}

/**
 * Steering messages drained at a turn boundary.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class SteeringDrained extends Schema.TaggedClass<SteeringDrained>(
  "flows/harness/AgentEvent/SteeringDrained"
)("steering-drained", {
  eventType: Schema.Literal("flows.harness.steering-drained.v1"),
  messages: Schema.Array(ModelRequest.Message)
}) {}

/**
 * The terminal decision made at a turn boundary.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TurnClosed extends Schema.TaggedClass<TurnClosed>(
  "flows/harness/AgentEvent/TurnClosed"
)("turn-closed", {
  eventType: Schema.Literal("flows.harness.turn-closed.v1"),
  stopReason: ModelRequest.StopReason,
  outcome: Schema.Literals(["continue", "resolved", "aborted", "suspended"])
}) {}

/**
 * A permission request reported for engine-owned suspension and resolution.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class PermissionRequired extends Schema.TaggedClass<PermissionRequired>(
  "flows/harness/AgentEvent/PermissionRequired"
)("permission-required", {
  eventType: Schema.Literal("flows.harness.permission-required.v1"),
  request: Permission.PermissionRequired
}) {}

/**
 * A normalized harness abort.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Aborted extends Schema.TaggedClass<Aborted>(
  "flows/harness/AgentEvent/Aborted"
)("aborted", {
  eventType: Schema.Literal("flows.harness.aborted.v1"),
  reason: Schema.String
}) {}

/**
 * The final assistant message produced by the harness.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Resolved extends Schema.TaggedClass<Resolved>(
  "flows/harness/AgentEvent/Resolved"
)("resolved", {
  eventType: Schema.Literal("flows.harness.resolved.v1"),
  message: ModelRequest.AssistantMessage
}) {}

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export const AgentEvent = Schema.Union([
  DisciplineArmed,
  TurnOpened,
  ModelDelta,
  ModelRetried,
  ModelSettled,
  CellProduced,
  CellRejectedInFrame,
  CellCallStarted,
  CellCallSettled,
  CellPrinted,
  CellSettled,
  TransitionApplied,
  MutationObserved,
  CheckpointMinted,
  ReadOnlyDemandIssued,
  ReadOnlyDemanded,
  RepeatDemanded,
  NarrowedDemanded,
  NarrowOnlyDemanded,
  UnmovedDemanded,
  UnresolvedDemanded,
  SufficiencyObserved,
  VacuousVerificationObserved,
  Suspended,
  CompactionSettled,
  SteeringDrained,
  TurnClosed,
  PermissionRequired,
  Aborted,
  Resolved
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export type AgentEvent = typeof AgentEvent.Type

/**
 * The journal event type of every member of {@link AgentEvent}, by tag.
 *
 * One table, because the literal used to be written three times: on the class,
 * in `CellTurn`'s emitter, and again in `Transcript`'s decoder. A projection
 * that reads a literal the emitter no longer writes silently returns an empty
 * transcript, and nothing failed when the two drifted. `CellTurn` and
 * `Transcript` both read this, and `Contracts.test.ts` pins it against the
 * union, so an event added without a row here fails a test rather than a run.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export const eventType = {
  aborted: "flows.harness.aborted.v1",
  cellCallSettled: "flows.harness.cell-call-settled.v1",
  cellCallStarted: "flows.harness.cell-call-started.v1",
  cellPrinted: "flows.harness.cell-printed.v1",
  cellProduced: "flows.harness.cell-produced.v1",
  cellRejectedInFrame: "flows.harness.cell-rejected-in-frame.v1",
  cellSettled: "flows.harness.cell-settled.v1",
  checkpointMinted: "flows.harness.checkpoint-minted.v1",
  compactionSettled: "flows.harness.compaction-settled.v1",
  disciplineArmed: "flows.harness.discipline-armed.v1",
  modelDelta: "flows.harness.model-delta.v1",
  modelRetried: "flows.harness.model-retried.v1",
  modelSettled: "flows.harness.model-settled.v1",
  mutationObserved: "flows.harness.mutation-observed.v1",
  narrowOnlyDemanded: "flows.harness.narrow-only-demanded.v1",
  narrowedDemanded: "flows.harness.narrowed-demanded.v1",
  permissionRequired: "flows.harness.permission-required.v1",
  readOnlyDemandIssued: "flows.harness.read-only-demand-issued.v1",
  readOnlyDemanded: "flows.harness.read-only-demanded.v1",
  repeatDemanded: "flows.harness.repeat-demanded.v1",
  resolved: "flows.harness.resolved.v1",
  steeringDrained: "flows.harness.steering-drained.v1",
  sufficiencyObserved: "flows.harness.sufficiency-observed.v1",
  suspended: "flows.harness.suspended.v1",
  transitionApplied: "flows.harness.transition-applied.v1",
  turnClosed: "flows.harness.turn-closed.v1",
  turnOpened: "flows.harness.turn-opened.v1",
  unmovedDemanded: "flows.harness.unmoved-demanded.v1",
  unresolvedDemanded: "flows.harness.unresolved-demanded.v1",
  vacuousVerificationObserved: "flows.harness.vacuous-verification-observed.v1"
} as const
