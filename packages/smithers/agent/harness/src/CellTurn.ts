/**
 * The cell-first controller.
 *
 * Smithers is a state machine. This module is its deterministic outer loop: it
 * decides continue, park, or finish from durable evidence — the transition a
 * cell returned and the budgets the run declared — and never from the presence
 * of a provider tool call.
 *
 * One frame is: seal a model step, recover the cell from the settlement, run it
 * in the sandbox, resolve each of its flow calls as its own keyed durable
 * boundary, then apply the transition it returned. The cell owns the state that
 * carries forward and the exact context the next frame sees.
 *
 * Governing design: `../docs/concepts.md#durable-cell-loop`.
 *
 * @since 0.1.0
 */
import { Effects, type KeyMaterial, Placement } from "@smthrs/core"
import * as Digest from "@smthrs/core/Digest"
import { Capability, CapabilitySet, Permission } from "@smthrs/kernel"
import { CanonicalJson, type Model, ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Clock, Effect, Option, Queue, Result, Schema, Stream } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import * as CallLedger from "./CallLedger.ts"
import * as Cell from "./Cell.ts"
import * as CellHistory from "./CellHistory.ts"
import * as CellValidation from "./CellValidation.ts"
import * as Compaction from "./Compaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import * as EngineLike from "./EngineLike.ts"
import { HarnessError } from "./HarnessError.ts"
import * as cellPrompt from "./internal/cellPrompt.ts"
import * as DemandText from "./internal/demandText.ts"
import * as elide from "./internal/elide.ts"
import { printsObservation } from "./internal/printsObservation.ts"
import { untrustedData } from "./internal/untrustedData.ts"
import * as NarrowedCheck from "./NarrowedCheck.ts"
import * as Sandbox from "./Sandbox.ts"
import * as Steering from "./Steering.ts"
import * as Sufficiency from "./Sufficiency.ts"
import { journalVersion } from "./Transcript.ts"
import * as TruncatedOutput from "./TruncatedOutput.ts"
import * as UnmovedTree from "./UnmovedTree.ts"
import * as UnresolvedFailure from "./UnresolvedFailure.ts"
import * as VariablesPanel from "./VariablesPanel.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Default number of frames one admitted task may spend. Zero disarms this limit.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultMaxFrames = 100

/**
 * Default number of consecutive read-only frames a task run may spend.
 *
 * Read-only means the frame left the workspace exactly as it found it —
 * measured, not declared; see {@link State.readOnlyFrames}. The number comes
 * from the first head-to-head benchmark — every instance the loop resolved had
 * edited a file well before frame 15, and the instance it lost outright read
 * for all 100 frames, made 132 calls, attempted zero edits, and then claimed
 * the fix was implemented.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultReadOnlyFrames = 12

/**
 * Default wall-clock milliseconds one model call may spend.
 *
 * The number is read off wave 7 of the SWE-bench harness, which journals
 * `durationMillis` for every sealed step. Its 68 model calls settled at a
 * median of 10.2 s, a p90 of 45.2 s, and a p95 of 110.6 s; the longest call
 * that produced a usable answer took 252.3 s (`django__django-16612`, an
 * instance that resolved), and the next longest 169.6 s. One call stood
 * outside that distribution entirely: 667.1 s on `pytest-dev__pytest-6197` —
 * 55% of the run's 1,200 s budget and 60,703 output tokens — for a cell that
 * raised on its first property access. Nothing capped it, because a model call
 * was the one thing the armed discipline did not bound.
 *
 * 300 s clears the longest answering call by 19% and every other call in the
 * wave by more than 2.6x, so the budget is not a latency target and does not
 * ration ordinary thinking; it is the ceiling that separates a slow answer
 * from a run spending half its wall clock on one. Under it the outlier is
 * interrupted at a quarter of the process budget instead of consuming
 * more than half of it, and the retry that follows costs a jittered second
 * rather than the whole run. 240 s would have cut off django's 252 s call, so
 * it is not the number the evidence supports.
 *
 * Zero disarms the budget, which is what a host that wants a model call
 * bounded by nothing but its own process must ask for explicitly.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultModelCallMs = 300_000

/**
 * Default number of consecutive repeat-observation frames a run may spend.
 *
 * A repeat-observation frame is one that issued at least one call, issued no
 * call this run had not already issued, and changed nothing. Such a frame buys
 * a model step and a flow call and is handed back what the run was already
 * holding.
 *
 * The number is read off wave 7 of the SWE-bench harness. Its one unresolved
 * instance made a real, surviving edit at frame 14 and then spent frames 15
 * through 24 re-reading that edit and re-running the same two check files —
 * ten frames that never revisited the mechanism, and the run died on its
 * process budget still confirming itself. Four is the smallest threshold an
 * ordinary re-check cannot reach: reading a file, editing it and reading it
 * back is one repeat frame, and running a check, reading the failure and
 * running it again is two. Four consecutive frames that learn nothing new is a
 * run that has stopped looking, not one double-checking its work.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultRepeatFrames = 4

/**
 * Default number of completions a run may have bounced for narrowed evidence.
 *
 * The demand is answered by acting, not by a counter, so the number is not a
 * budget to spend: it is how many times the loop will name a missing check
 * before it stops naming it. One is the whole design. The sanctioned shape for
 * this class of control is demand-then-continue — bounce once with an in-frame
 * observation, let the agent act, and take the next answer as it comes — which
 * is what the read-only cap and the repeat demand already do, and it is what
 * remains after the completion audit that re-ran commands from the harness was
 * removed on purpose. A second bounce would be the loop arguing with the run
 * about evidence it is not allowed to gather.
 *
 * The failure it answers is the tenth named failure mode of the SWE-bench cell
 * harness and the only one to decide the same instance in two consecutive waves
 * identically; see `NarrowedCheck` for the journal it was read off.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultNarrowingDemands = 1

/**
 * Default number of completions a run may have bounced for an unmoved tree.
 *
 * One, for the reason {@link defaultNarrowingDemands} is one: the sanctioned
 * shape for a control that judges a completion is demand-then-continue, and a
 * second bounce would be the loop arguing with the run.
 *
 * The failure it answers is the eleventh named failure mode of the SWE-bench
 * cell harness, and the only one where the harness held the deciding fact for
 * the whole run and never consulted it: seven frames of `mutation-observed` on
 * one digest, followed by a completion describing an edit that does not exist.
 * See `UnmovedTree` for the journal it was read off.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultUnmovedDemands = 1

/**
 * Default number of completions a run may have bounced for a failing check it
 * replaced rather than answered.
 *
 * One, for the same reason as the other two completion caps. See
 * `UnresolvedFailure` for the journal it was read off, and for why a failing
 * check on its own is not the trigger.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultUnresolvedDemands = 1

/**
 * Default number of times one frame may answer its own unparseable cell.
 *
 * A cell that does not parse never ran, so nothing about the world has changed
 * and the frame has nothing to record except the mistake. Ending the frame
 * there is what the r90 wave did, and it charged a whole model turn for a
 * missing brace nine times — `sympy__sympy-20154` $0.70 for a 53 KB program
 * that never executed, `django__django-15987` 59 % of the instance's bill,
 * `sympy__sympy-18763` twice on the same instance with the second cell
 * repeating the first's syntax error character for character, because the
 * failure was invisible to the model that wrote it.
 *
 * One re-prompt closes that. Everything before the trailing frame block —
 * teaching, catalog, transcript — is byte-identical to the request just sent,
 * so the provider serves it from its prefix cache and the retry costs the
 * output it writes plus cached input. What it buys is the difference between
 * an error the model reads *now* and one it reads after the frame is gone.
 *
 * Zero disarms it. More than one is not the answer to a model that has lost
 * the shape twice: that is worth a fresh frame with the failure on the record,
 * which is what the second one gets.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultRevalidations = 1

/**
 * Default number of trees one run may pin with `ctx.checkpoint()`.
 *
 * Eight, read off the two REPL waves. A checkpoint is worth minting before a
 * change, so the most a run could honestly want is one per frame that changed
 * the tree, and across the 90 runs of `rerun-r95repl` and `rerun-r96repl` that
 * number is 1 in 66 runs, 2 in 18, 3 in 3, 4 in one and 5 in one. Eight is the
 * worst case those waves produced plus headroom, and it is a bound rather than
 * a budget the model is meant to spend: the dominant use needs none of it at
 * all, because {@link Cell.baseCheckpoint} is already there.
 *
 * It is a bound because a checkpoint costs the host a stored tree and a
 * materialization it must clean up. A run that mints one per frame for a
 * hundred frames is not doing anything a run needs to do, and the ninth mint is
 * answered as an ordinary catchable refusal naming the handles it already
 * holds rather than by ending the run.
 *
 * Zero disarms minting entirely, and leaves `ctx.base` — which nobody mints —
 * working.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultMaxCheckpoints = 8

const MaxFrames = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(defaultMaxFrames)),
  Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxFrames))
)

/**
 * The resolved model's context window, in tokens. Zero disables compaction,
 * which is what a host that has not resolved a capability record should get.
 */
const ContextWindowTokens = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(0)),
  Schema.withDecodingDefaultKey(Effect.succeed(0))
)

/** The one journal-event-type table; see `AgentEvent.eventType`. */
const eventType = AgentEvent.eventType

/**
 * The serializable state carried across cell frames.
 *
 * The run's own memory is the realm, which is not in here and cannot be: it is
 * a live JavaScript context, rebuilt on a resume by re-executing the cells that
 * built it. What this carries is the controller's view of it — the panel of
 * names, the call ledger, the budgets and the counters the discipline reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class State extends Schema.Class<State>("flows/harness/CellTurn/State")({
  session: Schema.String,
  /** Missing versions decode as legacy so resume refuses before any model call. */
  journalVersion: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(journalVersion)),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  frame: NonNegativeSafeInt,
  maxFrames: MaxFrames,
  /**
   * Every name the realm holds, with the frame that last bound it.
   *
   * Freshness is a property of the run: the frame that reads a name is rarely
   * the frame that bound it, and "how old is this" cannot be recovered from the
   * realm itself. See `VariablesPanel`.
   */
  panel: VariablesPanel.Ledger,
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  layers: Schema.Array(Schema.String),
  capabilityEnvelope: Schema.Array(Capability.CapabilityPattern),
  placement: Schema.Option(Descriptor.Placement),
  contextWindow: ContextWindow.ContextWindow,
  contextWindowTokens: ContextWindowTokens,
  /**
   * Consecutive read-only frames this run may spend before the controller
   * intervenes. Zero disarms the cap, which is what a conversational run gets.
   */
  readOnlyCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Wall-clock milliseconds one model call may spend. Zero disarms the budget.
   *
   * Carried in controller state, and handed to the engine on every sealed
   * step, so the value journaled in `discipline-armed` is the value enforced.
   * See {@link defaultModelCallMs} for where the number comes from.
   */
  modelCallMs: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultModelCallMs)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultModelCallMs))
  ),
  /**
   * Frames settled since the last frame that changed the workspace.
   *
   * Changed-ness is measured as well as declared: the controller compares the
   * observation the previous frame closed on ({@link State.workspace}) against
   * the one this frame closes on, and a difference is a mutation whoever
   * performed it. The measurement is what a frame's calls cannot say; it is
   * never what overrules them. A frame is read-only when nothing declared a
   * write *and* no complete measurement saw one, because a measurement is
   * rooted, pruned and bounded, and the paths it does not cover are not
   * evidence that a run stopped working.
   *
   * It used to count frames since the last call that *declared* a write, and
   * the difference is not academic. `bash` declares no write set at all — its
   * registry envelope is the conservative empty one and an unhermetic
   * invocation carries no `writes` key, because a shell command's effects do
   * not travel through any boundary the harness can read. On the SWE-bench
   * pytest instance a frame ran `git show <base>:src/_pytest/python.py >
   * src/_pytest/python.py`, destroyed the fix the run had landed six frames
   * earlier, and was counted as read-only; the whole wave made 41 shell calls
   * and not one of them declared a write, so nothing in the harness saw a
   * single one of them.
   *
   * Declared writes are still what the capability envelope is enforced
   * against, still what decides whether the truncated-write refusal applies to
   * a call, still enough on their own to clear this counter, and still
   * journaled beside the measured answer as `declaredWrites`. This is
   * accounting, not permission. A host that measures nothing, or measures only
   * a prefix of its tree, keeps the old rule, and `MutationObserved.basis`
   * says which.
   */
  readOnlyFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Frames the demand stays silent for, bought by an accepted justification.
   *
   * A justification is an escape hatch with a price: it buys `readOnlyCap`
   * quiet frames and never resets {@link State.readOnlyFrames}, so a run that
   * keeps justifying still reaches the hard stop at twice the cap.
   *
   * Only an *answer* buys it. A justification is accepted when the frame that
   * wrote it was handed the demand — {@link State.pendingReadOnlyDemand} is
   * set — and a justification volunteered by a frame that was asked nothing is
   * recorded on its transition and buys zero frames. Otherwise a run can spend
   * the whole allowance without the demand ever being issued: see the comment
   * beside the intervention in `frame`.
   */
  readOnlyGrace: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Intervention waiting to be resolved by the next frame. */
  pendingReadOnlyDemand: Schema.optional(Schema.Struct({
    streak: NonNegativeSafeInt,
    cap: NonNegativeSafeInt
  })),
  /**
   * Consecutive repeat-observation frames this run may spend before the
   * controller redirects it. Zero disarms the demand.
   *
   * Armed separately from {@link State.readOnlyCap} because the two answer
   * different stalls. The read-only cap watches a run that has written
   * nothing; this watches a run that has written something and keeps
   * confirming it. A run can be in both states at once, and telling one that
   * has already edited to "land an edit" sends it back to the file it is
   * already staring at.
   */
  repeatCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultRepeatFrames)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultRepeatFrames))
  ),
  /**
   * Consecutive frames that observed only what this run had already observed.
   *
   * A frame counts when it issued at least one call, issued no call whose
   * signature this run had not already issued, and changed nothing. A frame
   * that issued no call is neither a repeat nor a break: it made no
   * observation, so the counter is carried across it rather than advanced or
   * cleared — a run that thinks for a frame between two identical commands has
   * not stopped repeating itself, and a run planning its next move has not
   * started.
   */
  repeatFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Signatures of the calls this run has issued, oldest first.
   *
   * State rather than a per-frame detail because repetition is a property of
   * the run: the frame that re-runs a check is usually nowhere near the frame
   * that first ran it. It carries digests and no inputs; see
   * {@link signatureOf}.
   */
  callSignatures: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Completions this run may have bounced for narrowed evidence. Zero disarms
   * the demand.
   *
   * Armed separately from every other cap because it watches a different
   * moment. The read-only cap and the repeat demand watch a run that is still
   * working and has stopped making progress; this watches the one frame a run
   * gets wrong for free — the last one, where a narrowed check is presented as
   * evidence for a change it never covered. See {@link defaultNarrowingDemands}.
   */
  narrowingCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultNarrowingDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultNarrowingDemands))
  ),
  /**
   * Completions this run has already had bounced for narrowed evidence.
   *
   * Counted rather than flagged so the cap reads like the others, and carried
   * in state so a bounce survives the frame that answers it: the run stays
   * responsible for the answer, and the loop stops asking once it has asked.
   */
  narrowingDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for an unmoved tree. Zero disarms
   * the demand. See {@link defaultUnmovedDemands} and `UnmovedTree`.
   */
  unmovedCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultUnmovedDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultUnmovedDemands))
  ),
  /** Completions this run has already had bounced for an unmoved tree. */
  unmovedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for a failing check it replaced
   * rather than answered. Zero disarms the demand. See
   * {@link defaultUnresolvedDemands} and `UnresolvedFailure`.
   */
  unresolvedCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultUnresolvedDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultUnresolvedDemands))
  ),
  /** Completions this run has already had bounced for such a check. */
  unresolvedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Trees this run may pin with `ctx.checkpoint()`. Zero disarms minting.
   *
   * See {@link defaultMaxCheckpoints}. `ctx.base` is not minted and is
   * unaffected by this.
   */
  checkpointCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultMaxCheckpoints)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxCheckpoints))
  ),
  /**
   * Ids of the trees this run has already pinned, oldest first.
   *
   * Run state rather than a per-frame count because a checkpoint outlives the
   * frame that minted it: the whole use is a frame taking a reading against a
   * tree some earlier frame pinned, so the bound has to be the run's. The ids
   * rather than a tally, because the one thing worth saying to a run that has
   * reached the bound is which handles it is already holding.
   */
  checkpointIds: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Content address of the workspace this run opened on.
   *
   * Recorded once, from the first frame whose opening measurement covered the
   * tree, and never restamped: the whole question `UnmovedTree` asks is whether
   * the tree a completion describes is the tree the run was handed, and an
   * origin that moved with the run could not answer it. Empty means no frame
   * has produced a complete opening measurement, which makes the demand inert
   * rather than wrong.
   */
  openingDigest: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  /**
   * Checks this run has run, oldest first, each stamped with the tree it ran
   * over.
   *
   * State rather than a per-frame detail for the same reason
   * {@link State.callSignatures} is: the frame that narrows a check is nowhere
   * near the frame that first ran it. It carries the terms of each input rather
   * than the input, and only for calls that declared no write — a call that
   * changes the workspace is not an observation of it. See `NarrowedCheck`.
   */
  checks: NarrowedCheck.Ledger,
  /**
   * Every call this run has settled, bounded and rendered every frame.
   *
   * State rather than a per-frame detail because the frame that needs to see a
   * result is rarely the frame that fetched it, and a cell is authored before
   * any of its results exist. See `CallLedger`.
   */
  callLedger: CallLedger.Ledger,
  /**
   * Checks this run has watched fail, each stamped with the epoch it failed in.
   *
   * Separate from {@link State.checks} because that ledger holds one entry per
   * signature carrying its *latest* run: the moment a failing check is re-run
   * and passes, the failure it reported is gone from it, and the failure is
   * exactly half of what `Sufficiency` needs. See `Sufficiency`.
   */
  failures: Sufficiency.Ledger,
  /**
   * Frames of this run that changed the workspace.
   *
   * The clock `Sufficiency` orders its two halves by. A count rather than a
   * digest, because the fact being established is that something changed
   * between two readings, and a count says that on a host that measures nothing
   * and knows only what its calls declared.
   */
  mutations: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Whether the sufficiency observation has already been written this run.
   *
   * Once, and only once: it is a statement about the record, the record only
   * grows, and repeating it every frame would turn the one control that is not
   * a demand into nagging. A run that is shown it and keeps working is a run
   * that has decided the evidence is not enough, which is its decision to make.
   */
  sufficiencyStated: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * How many times one frame may answer its own unparseable cell before the
   * frame ends. Zero disarms the answer, which restores the old behaviour: a
   * cell that does not parse settles the frame.
   *
   * One, because that is what the evidence asks for. A cell that does not parse
   * is answered by a re-prompt whose whole prefix — teaching, catalog,
   * transcript — is byte-identical to the one just sent, so the retry is paid
   * for at cached-input price plus the output it writes. Two consecutive
   * unparseable answers is a model that has lost the shape rather than
   * mistyped, and that is worth a fresh frame with the failure on the record.
   */
  revalidations: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultRevalidations)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultRevalidations))
  ),
  /**
   * The output of the completion a completion demand handed back, if any.
   *
   * The demand takes a finished answer away and asks for one more frame. It is
   * allowed to do that only because the run gets to answer again — so the one
   * outcome it must never produce is a run that ends holding nothing. Between
   * the bounce and the next completion the run can spend its last frame on a
   * cell that raises, on a refused park, or on more work, and every one of
   * those ends the run on {@link budgetMessage} rather than on a completion.
   * Keeping the bounced output here is what makes the demand recoverable: the
   * budget still ends the run, and the run's own words are still what it ends
   * with. See `NarrowedCheck` for why the demand is issued at all.
   */
  bouncedCompletion: Schema.optional(Schema.String),
  /**
   * The frame a completion demand was handed to, if one is outstanding.
   *
   * Every demand ends with the same promise: what you return next is the answer
   * that stands. Three of them can fire on one `complete` transition and each
   * carries its own cap, so without this the frame written to answer one demand
   * is judged by the next — and a run that changed nothing and displaced a
   * failing check is told "no" twice about one decision, spending two frames
   * and two model calls on the argument. Recorded as the frame number rather
   * than as a flag because it is then self-clearing: it names one frame, and
   * every frame after that one is a frame the run chose to spend.
   */
  demandedFrame: Schema.optional(NonNegativeSafeInt),
  /**
   * Whether a human can answer this run, which is what makes a park honorable.
   *
   * A park is durable waiting, and waiting only ends when somebody answers. A
   * run with no approval channel has nobody to answer it, so a park there is
   * not patience: it is the run abandoning a budget it still holds. False —
   * the default — refuses the transition and answers it in the frame that
   * returned it.
   */
  approvalChannel: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * The workspace as the last measured frame left it.
   *
   * Carried in state rather than re-measured because one measurement serves
   * two frames: what a frame closes on is what the next frame opens on, and
   * nothing between them touches the tree — the sealed model step in between
   * only produces text. So a run pays one walk per frame, not two, and a
   * resumed run replays the recorded measurement instead of walking a tree
   * that has moved on.
   *
   * Absent means no frame has measured yet; `None` means a frame measured and
   * the host reported it has nothing to measure. The two are kept apart so an
   * unobservable host is asked once and then left alone, instead of paying an
   * opening boundary every frame for an answer that will not change.
   */
  workspace: Schema.optional(Schema.Option(EngineLike.Observation)),
  /**
   * Output this run has been handed as a fragment, by digest.
   *
   * The ledger is state rather than a per-frame detail because a cell may store
   * a truncated capture and write it a frame later. It carries no bytes; see
   * `TruncatedOutput`.
   */
  truncatedOutputs: TruncatedOutput.Ledger
}) {}

/**
 * Rebuilds controller state with only the fields one step changes.
 *
 * Every frame produces a whole new `State`, so a field added to the class had
 * to be threaded through five constructions by hand — and the one that was
 * forgotten silently reset a budget. Changes are stated; everything else is
 * carried.
 */
type StateChanges = Partial<ConstructorParameters<typeof State>[0]>

const advance = (state: State, changes: StateChanges): State => new State({ ...state, ...changes })

/**
 * Runtime declarations used to interpret serializable controller state.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input {
  readonly state: State
  /** Resolves the host's seat vocabulary; kept outside serializable state. */
  readonly contextWindowTokensFor?: ((seat: string) => Effect.Effect<number, HarnessError>) | undefined
  /** The flows this frame may call, already narrowed by seat visibility. */
  readonly flows: ReadonlyArray<Descriptor.FlowDescriptor>
  /** Re-read and journal the callable catalog before each frame, including the first. */
  readonly refreshFlows?: Effect.Effect<ReadonlyArray<Descriptor.FlowDescriptor>, HarnessError> | undefined
  readonly limits?: Sandbox.Limits | undefined
}

/**
 * Constructs an initial controller state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: {
  readonly session: string
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly layers: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly placement: Option.Option<Descriptor.Placement>
  readonly contextWindow: ContextWindow.ContextWindow
  readonly contextWindowTokens?: number | undefined
  readonly frame?: number | undefined
  readonly maxFrames?: number | undefined
  /**
   * Caps consecutive read-only frames: at the cap the controller demands an
   * edit or a typed justification, and at twice the cap the run stops as a
   * typed failure. Omitted or zero disarms it, which is what a run that is
   * only meant to read — a question, a review — should get.
   */
  readonly readOnlyCap?: number | undefined
  /**
   * Caps the wall-clock one model call may spend, in milliseconds. Omitted
   * takes {@link defaultModelCallMs}; zero disarms the budget.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Caps consecutive repeat-observation frames: at the cap the controller
   * names the repetition and redirects the run at evidence it does not hold.
   * Omitted takes {@link defaultRepeatFrames}; zero disarms it.
   */
  readonly repeatCap?: number | undefined
  /**
   * Caps how many completions may be bounced for narrowed evidence: at the
   * first such completion the controller names the broader check the run has
   * not re-run since its latest change and asks for another frame. Omitted
   * takes {@link defaultNarrowingDemands}; zero disarms it.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Caps how many completions may be bounced for an unmoved tree: at the first
   * completion whose closing digest is the digest the run opened on, the
   * controller names both and asks for another frame. Omitted takes
   * {@link defaultUnmovedDemands}; zero disarms it.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Caps how many completions may be bounced for a failing check the run
   * replaced rather than answered. Omitted takes
   * {@link defaultUnresolvedDemands}; zero disarms it.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Whether a human can answer this run. Omitted or false refuses a `park`
   * transition and answers it in-frame; only a host that has wired somewhere
   * for an answer to come from may claim true.
   */
  readonly approvalChannel?: boolean | undefined
  /**
   * Caps how many times one frame may answer its own unparseable cell before
   * the frame ends. Omitted takes {@link defaultRevalidations}; zero disarms it.
   */
  readonly revalidations?: number | undefined
  /**
   * Caps how many trees this run may pin with `ctx.checkpoint()`. Omitted takes
   * {@link defaultMaxCheckpoints}; zero disarms minting and leaves `ctx.base`,
   * which nobody mints, working.
   */
  readonly checkpointCap?: number | undefined
}): State =>
  new State({
    session: options.session,
    frame: options.frame ?? 0,
    maxFrames: options.maxFrames ?? defaultMaxFrames,
    panel: [],
    seat: options.seat,
    modelParams: options.modelParams,
    layers: options.layers,
    capabilityEnvelope: options.capabilityEnvelope,
    placement: options.placement,
    contextWindow: options.contextWindow,
    contextWindowTokens: options.contextWindowTokens ?? 0,
    readOnlyCap: options.readOnlyCap ?? 0,
    modelCallMs: options.modelCallMs ?? defaultModelCallMs,
    readOnlyFrames: 0,
    readOnlyGrace: 0,
    pendingReadOnlyDemand: undefined,
    repeatCap: options.repeatCap ?? defaultRepeatFrames,
    repeatFrames: 0,
    callSignatures: [],
    narrowingCap: options.narrowingCap ?? defaultNarrowingDemands,
    narrowingDemands: 0,
    unmovedCap: options.unmovedCap ?? defaultUnmovedDemands,
    unmovedDemands: 0,
    unresolvedCap: options.unresolvedCap ?? defaultUnresolvedDemands,
    unresolvedDemands: 0,
    openingDigest: "",
    checks: [],
    callLedger: [],
    failures: [],
    mutations: 0,
    sufficiencyStated: false,
    revalidations: options.revalidations ?? defaultRevalidations,
    approvalChannel: options.approvalChannel ?? false,
    workspace: undefined,
    truncatedOutputs: [],
    checkpointCap: options.checkpointCap ?? defaultMaxCheckpoints,
    checkpointIds: []
  })

/**
 * Host-measured container facts accepted by {@link teach}.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = cellPrompt.Environment

/**
 * Prepends the cell contract and the callable-flow catalog to a context window.
 *
 * The model is taught one thing — how to write a cell — and shown exactly the
 * flows this frame may call. Both land in prefix segments, which every
 * transition preserves, so the teaching is stable for the run and a cell's
 * projected context never has to carry it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const teach = (
  contextWindow: ContextWindow.ContextWindow,
  flows: ReadonlyArray<Descriptor.FlowDescriptor>,
  environment?: Environment
): ContextWindow.ContextWindow => {
  const projections: Record<string, Cell.FlowProjection & Pick<Descriptor.FlowDescriptor, "provenance" | "path">> = {}
  for (const descriptor of flows) {
    projections[descriptor.name] = {
      ...Cell.project(descriptor),
      provenance: descriptor.provenance,
      path: descriptor.path
    }
  }
  const taught = cellPrompt.make(projections, environment).map((section) =>
    ContextWindow.makeSegment({
      kind: "system",
      zone: "prefix",
      declaredDigest: section.digest,
      content: [ModelRequest.SystemPart.make({ text: section.text })]
    })
  )
  return ContextWindow.make({
    modelId: contextWindow.modelId,
    segments: [...taught, ...contextWindow.segments],
    activeTools: contextWindow.activeTools,
    replaced: contextWindow.replaced
  })
}

/**
 * The distinct terms of everything the harness itself put in front of the run.
 *
 * The prefix zone is exactly that text — the cell contract, the flow catalog,
 * memory, and the task — and nothing else: transcript, observations, and
 * compaction summaries all land in the tail, so no term a model wrote can
 * reach this set. `NarrowedCheck.findOnly` reads it as the vocabulary the run
 * was taught, which no completion may be bounced for repeating: a run that
 * invokes the runner its task prescribes, with the flag its task prescribes,
 * added no condition of its own. Prefix parts that carry no text — a tool
 * declaration, a structured message — teach no terms.
 */
const taughtTerms = (window: ContextWindow.ContextWindow): ReadonlyArray<string> =>
  NarrowedCheck.terms(
    window.segments
      .filter((segment) => segment.zone === "prefix")
      .flatMap((segment) => segment.content)
      .map((part) => "text" in part && typeof part.text === "string" ? part.text : "")
      .join("\n")
  )

const modelIdFromSeat = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

const placementFrom = (state: State): Placement.Placement | undefined =>
  Option.match(state.placement, {
    onNone: () => undefined,
    onSome: (value) => {
      switch (value) {
        case "client":
          return Placement.client()
        case "local":
          return Placement.local()
        case "remote":
          return Placement.remote()
        case "sandbox":
          return Placement.sandbox()
      }
    }
  })

const keyMaterialFrom = (
  state: State,
  contextWindow: ContextWindow.ContextWindow,
  request: ModelRequest.ModelRequest
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v2",
  kind: "sealed",
  body: { _tag: "ModelCall", request },
  inputs: [{ _tag: "Literal", value: { contextDigest: contextWindow.digest, journalVersion } }],
  layers: [...new Set(state.layers)].sort(),
  capabilities: [...new Set(state.capabilityEnvelope.map(Capability.format))].sort(),
  effects: Effects.make({
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }),
  placement: placementFrom(state)
})

/**
 * Everything the model is told about the run's own memory this frame.
 *
 * Two sections, and each of them exists because a run paid for the same bytes
 * twice without it: what names the realm holds and how fresh each one is
 * (`VariablesPanel`), and what the run has already asked (`CallLedger`).
 *
 * It is one trailing user message rather than a system part, and that placement
 * is the whole point: the teaching, the task and the flow catalog are
 * byte-identical for the life of a run, so putting the one block that changes
 * every frame *after* the transcript leaves the provider's prefix cache
 * covering every byte before it. With the block in the middle, the cache broke
 * at the system boundary on every frame and the accumulated transcript behind
 * it was re-read at full price; two graded instances ran at 38% and 69% cached
 * input against model time that is 76% to 93% of wall clock.
 */
const stateSection = (state: State): string => {
  // The panel is stamped by the frame that ran, which is the frame before the
  // one this prompt is opening.
  const settled = CallLedger.render(state.callLedger)
  return [
    VariablesPanel.render({ ledger: state.panel, frame: state.frame - 1 }),
    ...(settled === undefined ? [] : [settled])
  ].join("\n\n")
}

const requestFrom = (
  state: State,
  contextWindow: ContextWindow.ContextWindow
): Result.Result<ModelRequest.ModelRequest, HarnessError> => {
  let rendered: ModelRequest.ModelRequest
  try {
    rendered = ContextWindow.render(contextWindow)
  } catch (cause) {
    return Result.fail(
      new HarnessError({
        code: "render_failed",
        message: "Unable to render the context window",
        cause
      })
    )
  }
  return Result.succeed(
    ModelRequest.ModelRequest.make({
      modelId: contextWindow.modelId,
      system: rendered.system,
      messages: [...rendered.messages, ModelRequest.Message.user(stateSection(state))],
      // A cell-first frame never declares provider tools: the cell is the plan
      // and `ctx.call` is the only invocation path.
      tools: [],
      toolChoice: "none",
      params: state.modelParams
    })
  )
}

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .filter((part): part is ModelRequest.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

/** The journal-safe form of a permission request, for `SuspendReason.details`. */
const encodePermissionRequired = Schema.encodeSync(Permission.PermissionRequired)

const permissionRequired = (error: unknown): Permission.PermissionRequired | undefined => {
  if (error instanceof Permission.PermissionRequired) return error
  if (error instanceof HarnessError && error.cause instanceof Permission.PermissionRequired) return error.cause
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Permission.PermissionRequired)(
      error instanceof HarnessError ? error.cause : error
    )
  )
}

/**
 * How much of a cell that RAN is echoed back into the next prompt, in UTF-8
 * bytes.
 *
 * Generous, because the model is being asked to fix source it can no longer
 * see: the cell it wrote is only in the transcript, and a raise is repaired by
 * editing the line that threw. Almost every real cell is far under this.
 */
const liveCellEcho = 8192

/**
 * How much of a cell that never RAN is echoed back into the next prompt, in
 * UTF-8 bytes.
 *
 * Tight, because a dead cell is answered by its error and not by its text. The
 * r90 wave charged `sympy__sympy-20154` $0.10 to read back a 53 KB program that
 * had already failed to compile once — the error names the line, and the line
 * is what the next cell needs. What is dropped is stated, so the model is never
 * shown a truncated program it might mistake for a whole one.
 */
const deadCellEcho = 1024

/**
 * Appends one observation turn to a context window, bounding the echo.
 *
 * The assistant message is the model's own reply, and putting it back verbatim
 * is how a frame's output becomes the next frame's input at full price. It is
 * kept whole while it is small, and stated as an excerpt once it is not.
 */
const appended = (
  contextWindow: ContextWindow.ContextWindow,
  assistant: ModelRequest.AssistantMessage,
  messages: ReadonlyArray<ModelRequest.Message>,
  echo: number
): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: contextWindow.modelId,
    segments: [
      ...contextWindow.segments,
      ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [bounded(assistant, echo), ...messages]
      })
    ],
    activeTools: contextWindow.activeTools,
    replaced: contextWindow.replaced
  })

const observedOn = (
  contextWindow: ContextWindow.ContextWindow,
  assistant: ModelRequest.AssistantMessage,
  observation: string,
  echo: number
): ContextWindow.ContextWindow => appended(contextWindow, assistant, [ModelRequest.Message.user(observation)], echo)

/** Whether one drain carried anything the next frame runs differently for. */
const carries = (drained: Steering.DrainRecord): boolean =>
  drained.inserts.length > 0 || drained.seatChanges.length > 0 || drained.activatedToolNames.length > 0

/**
 * The seat and generation parameters one drain leaves the next frame on.
 *
 * Applied in admission order, so the newest change of each kind wins.
 */
const steered = (
  state: State,
  changes: Steering.DrainRecord["seatChanges"],
  resolve: Input["contextWindowTokensFor"]
): Effect.Effect<{
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly contextWindowTokens: number
}, HarnessError> =>
  Effect.gen(function*() {
    let seat = state.seat
    let modelParams = state.modelParams
    for (const change of changes) {
      if (change._tag === "SeatChange") seat = change.seat
      else {
        modelParams = ModelRequest.GenerationParams.make({
          maxTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          topP: modelParams.topP,
          topK: modelParams.topK,
          stopSequences: modelParams.stopSequences,
          thinkingBudget: modelParams.thinkingBudget,
          reasoningEffort: change.thinking
        })
      }
    }
    return {
      seat,
      modelParams,
      contextWindowTokens: seat === state.seat
        ? state.contextWindowTokens
        : resolve === undefined
        ? ContextWindow.contextWindowTokensFor(modelIdFromSeat(seat))
        : yield* resolve(seat)
    }
  })

/**
 * The window the next frame renders, re-keyed when a steer moved the seat.
 *
 * A window carries the model it was measured against, so a seat change has to
 * rebuild it or the next frame budgets its context against the model it left.
 */
const windowOn = (
  state: State,
  seat: string,
  context: ContextWindow.ContextWindow
): ContextWindow.ContextWindow =>
  seat === state.seat ? context : ContextWindow.make({
    modelId: modelIdFromSeat(seat),
    segments: context.segments,
    activeTools: context.activeTools,
    replaced: context.replaced
  })

/**
 * The assistant's own reply, shortened from the middle when it is too long to
 * re-read at input price, with the elision stated.
 */
/**
 * The property name a thrown TypeError says could not be read, if it says one.
 *
 * Every realm this harness runs cells in words the same failure differently —
 * V8 says "Cannot read properties of undefined (reading 'x')", QuickJS says
 * "cannot read property 'x' of undefined" — so the property name is taken from
 * the quotes rather than from the sentence around them.
 */
const missedProperty = (message: string): string | undefined => {
  const match = /reading '([^']+)'|read property '([^']+)'/i.exec(message)
  /* v8 ignore next -- the regex has exactly two alternatives and each binds one group, so a match always has one of them; the fallback only discharges the optional type on a capture */
  return match === null ? undefined : (match[1] ?? match[2])
}

/**
 * States what the realm holds, when a cell threw reading a property.
 *
 * The names are the run's memory, so naming them is naming what the cell could
 * have read. The cell cannot be stopped from throwing — reading an absent
 * property is legal JavaScript and every guard a cell writes depends on it
 * staying legal — so the answer lands in the observation the throw already
 * produces.
 */
const bindingPathMiss = (
  message: string,
  bindings: ReadonlyArray<VariablesPanel.Binding>
): string | undefined => {
  const property = missedProperty(message)
  if (property === undefined) return undefined
  return bindings.length === 0
    ? `If \`${property}\` was meant to come from a name an earlier cell bound: your realm holds no names yet.`
    : `If \`${property}\` was meant to come from a name an earlier cell bound, these are the names your realm holds: ${
      elide.head(
        bindings.map((binding) => binding.name).join(", "),
        CallLedger.width * 4,
        "the panel in the frame block lists them all"
      )
    }. The panel gives each one's type and size.`
}

/**
 * What the next model turn is told about the frame's print buffer.
 *
 * The whole of the context channel, delivered once and appended
 * rather than rebuilt: a run's window is `[cell₁, prints₁], [cell₂, prints₂], …`
 * plus whatever the harness has to say, so the tail is byte-identical to the
 * previous frame's tail plus one pair. That is exactly what a provider's prefix
 * cache is for, and it is what the per-frame rebuild of the transcript this
 * replaced could never be.
 */
const revalidationNote = (rejection: Cell.Rejected): string =>
  `${rejection.message}\n\nThis reply is not a frame. Nothing ran, nothing changed, and no call was made, so you are being asked again inside the same frame instead of losing it: everything above this line is already in the provider's cache, and only what you write next is paid for. Emit the corrected cell and nothing else.`

/**
 * The assistant's own reply, shortened from the middle when it is too long to
 * re-read at input price, with the elision stated.
 *
 * The echo ceilings are UTF-8 bytes, which is what `elide` counts and what the
 * notice it writes reports, so the decision to shorten is taken in the same
 * unit rather than in UTF-16 code units: a reply of three thousand emoji is
 * six thousand code units and twelve thousand bytes, and measuring it in code
 * units let it past an eight-thousand-byte ceiling unshortened. `elide.middle`
 * returns its input unchanged when the whole already fits, so the comparison
 * is the elision's own and there is no second reading to disagree with it.
 */
const bounded = (
  assistant: ModelRequest.AssistantMessage,
  echo: number
): ModelRequest.AssistantMessage => {
  const text = assistantText(assistant)
  const shortened = elide.middle(
    text,
    echo,
    "the reply is not re-read in full; the observation below names what went wrong"
  )
  if (shortened === text) return assistant
  return ModelRequest.Message.assistant(shortened, { stopReason: assistant.stopReason })
}

const clip = (text: string, width: number): string => elide.head(text, width, "clipped")

/**
 * How much of one call's result the salvage list quotes back after a crash.
 *
 * A summary, not the result: the whole of it is still in the realm under the
 * name the cell bound it to, and the line says so. Before that, a clipped
 * summary was the only copy the next frame would ever see, and the next cell
 * re-issued the call to get the rest.
 */
const salvageSummary = 400

/**
 * What the salvage line says a clipped result can be read from.
 *
 * The realm outlives the frame that raised, so a name a cell bound before it
 * threw is still bound. This used to name the transition's `recall` list, which
 * left with the filing surface: a sentence that offers a move the contract no
 * longer has costs a model turn to discover it does nothing. It is worded like
 * {@link CallLedger.render}'s own trailer because it is the same fact.
 */
const salvageRecall = "the whole result is still under the name your cell bound it to"

/**
 * States, unambiguously, that a call this frame failed about itself.
 *
 * The whole defect this closes is that `exitCode: 1` reads the same whether the
 * bug reproduced or the command named a test that does not exist. The flow that
 * ran the command is the only party that can tell, so it says so in its result;
 * this turns that into a sentence the next frame cannot summarise away.
 */
const invalidProbeNotice = (
  calls: ReadonlyArray<{
    readonly flow: string
    readonly invalidProbe: { readonly reason: string; readonly message: string } | undefined
  }>
): string | undefined => {
  const lines = calls.flatMap((call) =>
    call.invalidProbe === undefined
      ? []
      : [`- ${call.flow} (${call.invalidProbe.reason}): ${call.invalidProbe.message}`]
  )
  if (lines.length === 0) return undefined
  return `Invalid probe — ${lines.length} call${
    lines.length === 1 ? "" : "s"
  } this frame failed about the command, not about the code:\n${
    lines.join("\n")
  }\nThat result is not a reproduction and is not a regression: it reads identically on a broken tree and on a fixed one, so it can neither prove the bug nor prove the repair. Repair the command before editing anything — find the real names first — and do not store it as \`state.verification\` or name it when you complete.`
}

/**
 * How many distinct call signatures one run carries forward.
 *
 * The ledger is durable controller state, so it is bounded. Sixty-four covers a
 * whole run at the rate a graded wave actually calls flows — its longest run
 * issued 43 calls across 24 frames — so a call is recognised as a repeat
 * however early the run first made it. A run that outlives the bound forgets
 * its oldest distinct calls first, which can cost a demand and can never
 * invent one.
 */
const retainedSignatures = 64

/**
 * The identity of one invocation: the flow it named and the input it passed.
 *
 * Digested rather than kept verbatim because an input is the whole of a shell
 * command and this list is journaled state. Two invocations share a signature
 * exactly when the cell asked for the same thing twice, which is the only
 * question the repeat demand asks. `Forensics` derives the same identity from
 * the journal after the fact; this is the loop's own view of it, available
 * while the run can still act on it.
 */
const signatureOf = (flow: string, input: Schema.Json, at?: string | undefined): string =>
  Digest.digest(CanonicalJson.stringify(at === undefined ? [flow, input] : [flow, input, at]))

/**
 * Folds one frame's signatures into the run's ledger, newest last and bounded.
 *
 * A repeated signature moves to the newest position rather than taking a
 * second slot, so a run looping on one command cannot push everything it
 * learned earlier out of the ledger.
 */
const remember = (
  known: ReadonlyArray<string>,
  made: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const newest = new Set(known)
  for (const digest of made) {
    newest.delete(digest)
    newest.add(digest)
  }
  const distinct = [...newest]
  return distinct.slice(Math.max(0, distinct.length - retainedSignatures))
}

/**
 * The answer a park gets when nothing is listening for it.
 *
 * A park is a request for a human, and the run's own arming says whether one
 * exists. Refusing it is not an error the model has to repair — the frame is
 * ordinary, its state is kept, and the note states what is left to spend so the
 * next frame has no reason to read the refusal as "there is nothing more to
 * try". On the SWE-bench sphinx instance a run parked at frame 3 with 97
 * frames unspent, asking about a definition `grep` finds in the workspace it
 * was already holding.
 *
 * The frame it is answered in is an ordinary frame in every other respect,
 * read-only discipline included. Exempting it would hand a stalled run a way
 * out of the only control that ends a stall: a cell that parks every frame
 * would change nothing, be demanded nothing, and spend the whole frame budget
 * and the whole wall clock asking questions nobody is listening to.
 */
const parkRefusal = (
  message: string,
  framesLeft: number | "unlimited",
  frameSeconds: number | undefined
): string =>
  `No human is available: this run has no approval channel, so nobody can answer a park and the transition is not honored. What you asked — "${message}" — is now yours to settle. You have ${framesLeft} frame${
    framesLeft === 1 ? "" : "s"
  } left${
    frameSeconds === undefined ? "" : `, each able to spend up to ${frameSeconds} seconds`
  }, and the flows in ctx.flows to spend them on. Answer the question yourself with a call — search the workspace, read the file, run the command — and continue.`

const readOnlyCapFailure = (cap: number, frames: number): HarnessError =>
  new HarnessError({
    code: "read_only_cap",
    message:
      `The run spent ${frames} consecutive frames without one call that declares a write, twice its read-only budget of ${cap}. It is stopped here rather than allowed to report work it never did.`
  })

/**
 * Whether one resolved call *declares* that it changes something.
 *
 * Classification happens at the call boundary and reads declarations, not
 * flow names: a call declares a write when its resolved descriptor declares
 * writes, or when the invocation itself declares them — which is how a shell
 * flow whose registry-time envelope is the conservative empty set still counts
 * when the cell declares what the command writes. `Forensics` classifies the
 * same events after the fact by name; the loop cannot, because a host catalog
 * is whatever the host bound.
 *
 * This is a claim, not an observation, and the two are used for different
 * things. The claim decides authority — whether the truncated-write refusal
 * applies to this call — and the frame's *measured* change decides discipline.
 * A shell command that rewrites a tracked source file declares nothing and is
 * false here; it is still a mutation, and {@link witness} is what sees it.
 */
const mutating = (descriptor: Descriptor.FlowDescriptor, input: Schema.Json): boolean => {
  if (descriptor.effects.writes.length > 0) return true
  const declared = input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).writes
    : undefined
  return Array.isArray(declared) && declared.length > 0
}

/**
 * The schema one workspace measurement is journaled under.
 *
 * `Option` and not a bare struct because "the host measured nothing" is a
 * recorded answer in its own right: a replayed frame must be told that its
 * original attempt could not observe the tree, rather than inferring it from
 * an absent record and measuring a tree that has since moved.
 */
const RecordedObservation = Schema.Option(EngineLike.Observation)

/**
 * Measures the workspace once, through a journaled boundary.
 *
 * The measurement is a read of the world — the same class of thing as the
 * steering drain — so it goes through {@link EngineLike.EngineLike.record}
 * rather than being called directly. Left unjournaled, a resumed frame would
 * walk a tree that has moved on since the original attempt, compare it against
 * the recorded state of a different one, and invent a mutation nobody made.
 *
 * `phase` distinguishes the two measurements a frame can take. Only the first
 * frame of a run takes an opening one; every later frame opens on what its
 * predecessor closed with.
 */
const witness = (
  engine: EngineLike.EngineLike,
  state: State,
  boundary: string,
  phase: "open" | "close"
): Effect.Effect<Option.Option<EngineLike.Observation>, HarnessError> =>
  engine.record({
    name: `workspace-${phase}`,
    // The purpose is folded into the boundary as well as carried in `name`.
    // `EngineLike.record` keys on `(name, identity)` together, and the
    // production engine does; an engine that read the contract as keying on
    // identity alone would replay this frame's opening measurement as its
    // closing one, and its cell outcome as its steering drain. Folding the
    // purpose in makes the controller correct under either reading. No released
    // run database exists at 1.0.0-rc.0, so the labels are free to change now
    // and will not be again.
    identity: { session: state.session, frame: state.frame, boundary: `workspace-${phase}:${boundary}` },
    success: RecordedObservation,
    execute: engine.observe
  })

/**
 * The schema one pinned tree is journaled under.
 *
 * `Option` for the reason {@link RecordedObservation} is: "this host pins
 * nothing" is a recorded answer, and a replayed frame that inferred it from an
 * absent record would pin a tree that has since moved.
 */
const RecordedSnapshot = Schema.Option(EngineLike.Snapshot)

/**
 * Pins the workspace once, through a journaled boundary.
 *
 * The same treatment {@link witness} gives a measurement, for the same reason:
 * a pin is a read of the world, so a resumed frame must be handed the tree its
 * original attempt pinned rather than pin whatever is there now. The boundary
 * is keyed on the cell digest and the ordinal, which is exactly the pair that
 * re-derives when the cell is re-executed.
 */
const pin = (
  engine: EngineLike.EngineLike,
  state: State,
  cell: string,
  ordinal: number,
  id: string,
  callMs: number
): Effect.Effect<Option.Option<EngineLike.Snapshot>, HarnessError> =>
  engine.record({
    name: "checkpoint",
    identity: { session: state.session, frame: state.frame, boundary: `checkpoint:${cell}:${ordinal}` },
    success: RecordedSnapshot,
    // The per-call ceiling, applied INSIDE the record for the reason
    // {@link settled} applies it inside its own: a store that hung past the
    // budget left the cell told nothing was pinned while the pin itself was
    // still in flight, so the resumed frame could be handed a snapshot the
    // original attempt was told it never got. Cut off here, "nothing was
    // pinned" is what the journal holds and what every later attempt reads.
    execute: engine.capture({
      id,
      identity: { session: state.session, frame: state.frame, boundary: `checkpoint-capture:${cell}` }
    }).pipe(
      Effect.timeoutOrElse({ duration: callMs, orElse: () => Effect.succeed(Option.none()) })
    )
  })

/**
 * Issues one call under the run's per-call ceiling, through a journaled
 * boundary.
 *
 * The ceiling is what makes this a boundary rather than a pass-through.
 * `EngineLike.call` is already a keyed activity, so a call that SETTLES is
 * durable on its own; a call the ceiling cuts off is durable nowhere, because
 * the activity it interrupted never settled. Left there, a re-executed cell
 * issues that call again against a world that has moved on, gets an answer this
 * time, and takes a branch the original attempt never took — and every
 * irreversible effect below the fork is bought twice.
 *
 * The record is written AFTER the call and read INSTEAD of it, which is the
 * only order available and is the one that matters. The call cannot run inside
 * the boundary: `EngineLike.call` is where a cell reaches a durable wait, and a
 * `Flow.suspend` raised inside an enclosing activity suspends that activity's
 * attempt rather than the run, so a cell that slept on the durable clock never
 * woke. So this issues the call, records what the cell is about to be told, and
 * on any later attempt hands back the recorded settlement whatever the re-issued
 * call answered this time. The cell's branch is what has to be stable, and it
 * is; the re-issued call is work the run pays for twice, which is what a call
 * the ceiling cut off already cost before this existed.
 *
 * The drive loop is told the settlement is bounded here
 * (`Sandbox.RealmEvaluation.bounded`): two clocks over one call would settle it
 * from the reading nothing keeps.
 *
 * The boundary is keyed on the cell digest and the call's ordinal, which is the
 * pair a re-executed cell re-derives.
 */
const issued = (
  engine: EngineLike.EngineLike,
  state: State,
  cell: string,
  ordinal: number,
  callMs: number,
  flow: string,
  issue: Effect.Effect<Cell.CallResult, HarnessError>,
  replaying: boolean
): Effect.Effect<Cell.CallResult, HarnessError> =>
  Effect.gen(function*() {
    if (replaying) {
      // A terminal frame proves this prefix settled. Read its settlements
      // directly, including per-call timeouts whose host activity never settled.
      return yield* engine.record({
        name: "cell-call",
        identity: { session: state.session, frame: state.frame, boundary: `cell-call:${cell}:${ordinal}` },
        success: Cell.CallResultVariant,
        execute: Effect.fail(
          new HarnessError({
            code: "incompatible_journal",
            message: `The timed-out frame is missing settlement ${ordinal}`
          })
        )
      }).pipe(Effect.flatMap(Cell.decodeCallResult))
    }
    // An escape — a permission park, an abort, an engine failure — never
    // reaches the record at all, so nothing journals it and the attempt the
    // grant answers asks again. That is the whole reason the call sits outside
    // the boundary rather than inside its `execute`.
    const settlement = yield* issue.pipe(
      Effect.timeoutOrElse({
        duration: callMs,
        orElse: () => Effect.succeed(Sandbox.callTimedOut(flow, callMs))
      }),
      Effect.flatMap(Cell.decodeCallResult)
    )
    return yield* engine.record({
      name: "cell-call",
      identity: { session: state.session, frame: state.frame, boundary: `cell-call:${cell}:${ordinal}` },
      success: Cell.CallResultVariant,
      execute: Effect.succeed(settlement)
    }).pipe(Effect.flatMap(Cell.decodeCallResult))
  })

/**
 * The schema one settled frame is journaled under.
 *
 * The realm's own answer and execution boundary, because these are things the loop
 * branches on: the outcome decides the transition, the prints become the next
 * frame's context, and the bindings become the variables panel. The boundary
 * prevents a timed-out frame from reconstructing beyond its delivered prefix.
 */
const RecordedFrame = Schema.Struct({
  boundary: Schema.optional(Sandbox.FrameBoundary),
  outcome: Cell.Outcome,
  prints: Schema.String,
  bindings: Schema.Array(VariablesPanel.Binding)
})

/**
 * Settles one `ctx.checkpoint()` from inside a running cell.
 *
 * The id is `cp-<frame>-<ordinal>`, which is derived from the two things that
 * re-derive identically when a cell is re-executed, so a resumed run addresses
 * the same trees its original attempt did — and short enough for a model to
 * read back in a print. `minted` is this frame's own tally; the run's is
 * `State.checkpointIds`, folded in when the frame closes.
 */
const minter = (
  state: State,
  cell: Cell.Source,
  engine: EngineLike.EngineLike,
  minted: Array<string>,
  callMs: number,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Sandbox.Minter =>
(mint) =>
  Effect.gen(function*() {
    const held = state.checkpointIds.length + minted.length
    if (held >= state.checkpointCap) {
      return new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "checkpoint_exhausted",
        message: `This run has pinned its ${state.checkpointCap} checkpoints and nothing was pinned here. ${
          held === 0 ? "" : `The ones you hold are ${[...state.checkpointIds, ...minted].join(", ")}, and `
        }ctx.base is always the tree this run opened on.`
      })
    }
    const id = `cp-${state.frame}-${mint.ordinal}`
    const snapshot = yield* pin(engine, state, cell.digest, mint.ordinal, id, callMs)
    if (Option.isNone(snapshot)) {
      return new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "checkpoint_unavailable",
        message: "This host pins no trees, so nothing was checkpointed. Take your readings on the live tree instead."
      })
    }
    minted.push(id)
    yield* emit(
      new AgentEvent.CheckpointMinted({
        eventType: eventType.checkpointMinted,
        id: snapshot.value.id,
        ref: snapshot.value.ref,
        cell: cell.digest,
        ordinal: mint.ordinal
      })
    )
    return new Cell.CallResult({ outcome: "success", value: Cell.checkpoint(snapshot.value.id) })
  })

const emitModelProgress = (
  event: ModelEvent.ModelEvent,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<void> =>
  event.type === "retry"
    ? emit(
      new AgentEvent.ModelRetried({
        eventType: eventType.modelRetried,
        attempt: event.attempt,
        code: event.code,
        delayMillis: event.delayMillis
      })
    )
    : event.type === "settle"
    ? Effect.void
    : emit(new AgentEvent.ModelDelta({ eventType: eventType.modelDelta, delta: event }))

/**
 * The reserved key a flow reports an invalid probe under.
 *
 * This is the one convention the loop reads off an otherwise opaque call
 * result. It is not a shared type — the controller must not depend on the tool
 * library — so it is a documented wire key. `@smthrs/std/Probe` is the
 * producing half and owns the taxonomy; the controller only has to know that a
 * result carrying this key is a result whose failure was about the command.
 */
const invalidProbeKey = "invalidProbe"

/** What a settled call declared about whether it ran a check at all. */
const invalidProbeOf = (
  value: Schema.Json
): { readonly reason: string; readonly message: string } | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const declared = (value as Record<string, unknown>)[invalidProbeKey]
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return undefined
  const { message, reason } = declared as Record<string, unknown>
  return typeof reason === "string" && typeof message === "string" ? { reason, message } : undefined
}

/**
 * What a run says when its frame budget, rather than the run, ended it.
 *
 * A run that never completed has only the budget to report. A run whose
 * completion was handed back for one of the completion demands has something
 * else: an answer it already gave, which the controller took away on the
 * promise of another frame. If that frame goes elsewhere — a cell that raises,
 * a refused park, more work than the budget has room for — the promise is the
 * only thing left, and dropping the answer would make the demand cost the run
 * exactly the thing it was meant to protect. Both facts are reported: the
 * budget ended the run, and this is what the run last said its answer was.
 *
 * Which demand took it is not named here. Three of them can, each writes its
 * own control event when it fires, and a sentence naming one of the three
 * would be wrong for the other two — as this one was, when the narrowing
 * demand was the only demand there was.
 */
const budgetMessage = (state: State): string =>
  state.bouncedCompletion === undefined
    ? `The frame budget of ${state.maxFrames} is exhausted. The run stops here; the last transition was a request to continue.`
    : `The frame budget of ${state.maxFrames} is exhausted. This run completed once and had that completion handed back for another frame, so what it reported then stands here rather than being lost:\n\n${state.bouncedCompletion}`

/**
 * Resolves one cell call into a durable engine boundary.
 *
 * Resolution happens here, at the boundary, and not inside the sandbox: the
 * flow must exist in the catalog this frame was given, and every capability it
 * declares must still be inside the run's narrowed envelope. Both denials are
 * ordinary call failures the cell can catch, which is what lets an agent
 * discover the shape of its authority without crashing the run.
 *
 * The truncation ledger is kept here for the same reason. The boundary is the
 * only party that sees both a result that declared its capture cut short and a
 * later call handing those exact bytes to something that writes, and a write of
 * a known fragment is refused rather than performed. See `TruncatedOutput`.
 *
 * `performed` collects the ordinal of every invocation that actually reached
 * the engine. The three refusals above return before it, and a refused call
 * changed nothing — so it must not read as a write to anything downstream. It
 * did once: the truncated-write refusal is the newest of the three and lands on
 * exactly the calls the read-only cap watches, so a run whose only edit was
 * refused had its read-only streak cleared by a write that never happened, and
 * the cap stayed silent through the stall it exists to break.
 */
const callHandler = (
  state: State,
  cell: Cell.Source,
  descriptors: ReadonlyMap<string, Descriptor.FlowDescriptor>,
  engine: EngineLike.EngineLike,
  ledger: Array<TruncatedOutput.Capture>,
  performed: Set<number>,
  callMs: number,
  replaying: boolean,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Sandbox.Handler =>
(invocation) =>
  Effect.gen(function*() {
    const descriptor = descriptors.get(invocation.flow)
    if (descriptor === undefined) {
      return new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "unknown_flow",
        message: `Unknown flow ${invocation.flow}. Only the flows in ctx.flows are callable.`
      })
    }
    const envelope = CapabilitySet.fromPatterns(state.capabilityEnvelope)
    const refused = descriptor.capabilities.filter((declared) =>
      Option.match(Capability.parse(declared), {
        onNone: () => true,
        onSome: (capability) => !CapabilitySet.allows(envelope, capability)
      })
    )
    if (refused.length > 0) {
      return new Cell.CallResult({
        outcome: "failure",
        value: null,
        code: "capability_refused",
        message: `Flow ${invocation.flow} needs ${refused.join(", ")}, which is outside this run's capability envelope.`
      })
    }
    // Only a call that changes something is checked. Passing a fragment to a
    // search, a diff, or a summary is ordinary use of what the flow returned;
    // handing it to something that writes is the one case that destroys a file.
    const changes = mutating(descriptor, invocation.input)
    if (changes) {
      const found = TruncatedOutput.reuse(invocation.input, ledger)
      if (found !== undefined) {
        return new Cell.CallResult({
          outcome: "failure",
          value: null,
          code: "truncated_write",
          message: TruncatedOutput.refusal(invocation.flow, found)
        })
      }
    }
    // Where this call runs. A checkpoint is a tree the run has already been
    // handed back, so it is a *reading* position and nothing else: the whole
    // promise the surface makes is that taking a reading against one leaves the
    // work alone, and a flow that declared a write would break that promise
    // whichever tree the host materialized. Both refusals below are fail-soft,
    // because both are things a cell fixes on its next line.
    let at: string | undefined
    if (invocation.at !== undefined) {
      at = Cell.checkpointOf(invocation.at)
      if (at === undefined) {
        return new Cell.CallResult({
          outcome: "failure",
          value: null,
          code: "invalid_input",
          message:
            `The at option takes a checkpoint, which is what ctx.checkpoint() resolves with and what ctx.base is. It was given ${
              elide.head(CanonicalJson.stringify(invocation.at), 120, "the rest is the same shape")
            }.`
        })
      }
      if (changes) {
        return new Cell.CallResult({
          outcome: "failure",
          value: null,
          code: "checkpoint_readonly",
          message:
            `Flow ${invocation.flow} declares a write, and a checkpoint is a read-only view of a tree that has already been. Nothing was run. Make the change on the live tree, and keep at for the readings you take against ${at}.`
        })
      }
    }
    const call = new Cell.Call({
      flowName: descriptor.name,
      input: invocation.input,
      capabilities: descriptor.capabilities,
      effects: descriptor.effects,
      placement: descriptor.placement,
      identity: new Cell.CallIdentity({
        session: state.session,
        frame: state.frame,
        cell: cell.digest,
        ordinal: invocation.ordinal,
        declaration: Cell.declarationDigest(descriptor),
        layers: [...new Set(state.layers)].sort()
      }),
      ...(at === undefined ? {} : { at })
    })
    performed.add(invocation.ordinal)
    yield* emit(new AgentEvent.CellCallStarted({ eventType: eventType.cellCallStarted, call }))
    const result = yield* issued(
      engine,
      state,
      cell.digest,
      invocation.ordinal,
      callMs,
      invocation.flow,
      Effect.suspend(() => engine.call(call)),
      replaying
    )
    if (result.outcome === "success") ledger.push(...TruncatedOutput.captures(call.flowName, result.value))
    yield* emit(
      new AgentEvent.CellCallSettled({
        eventType: eventType.cellCallSettled,
        flowName: call.flowName,
        identity: call.identity,
        result
      })
    )
    return result
  })

/**
 * Compacts the frame's context before the model is asked anything.
 *
 * Compaction is a transition of the run, not a repair applied to a request on
 * its way out: the summary is produced by its own sealed step, so it is keyed
 * and journaled like every other model call, and the settlement is emitted as
 * `CompactionSettled`. Without that event a replay rebuilds the uncompacted
 * transcript, re-crosses the same threshold, and re-keys every later frame — so
 * emitting it is what makes the compacted window part of the run's durable
 * state rather than an artifact of when the process happened to notice.
 *
 * Nothing here is best-effort. A window that cannot be compacted stays as it
 * is; a compaction the model started and could not finish is a typed failure.
 */
const compacted = (
  state: State,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<State, HarnessError | Model.ModelFailure> =>
  Effect.gen(function*() {
    const over = Compaction.shouldCompact({
      total: state.contextWindow.tokens.total,
      contextWindow: state.contextWindowTokens
    })
    if (!over) return state
    const prefixLength = Compaction.selectPrefix(state.contextWindow)
    // Nothing compactable is not a failure: a window that is all prefix has
    // already given up everything it can, and the frame proceeds as declared.
    if (prefixLength === 0) return state
    // `InvalidStep` is discharged as a defect, not surfaced as a typed failure.
    // All three calls below receive the same immutable window, `selectPrefix`'s
    // own output, and the state's validated generation parameters. An invalid
    // prefix, digest, or parameter value here would contradict those invariants.
    const step = yield* Compaction.declare(state.contextWindow, prefixLength, {
      identity: "flows/harness/CellTurn.compaction",
      modelId: state.contextWindow.modelId,
      params: state.modelParams
    }).pipe(Effect.orDie)
    const summaryRequest = yield* Compaction.summaryRequest(state.contextWindow, step).pipe(Effect.orDie)
    const request = ModelRequest.ModelRequest.make({
      modelId: summaryRequest.modelId,
      system: summaryRequest.system,
      messages: summaryRequest.messages,
      tools: [],
      toolChoice: "none",
      params: summaryRequest.params
    })
    const events = yield* Stream.runCollect(
      engine.sealStep({
        request,
        keyMaterial: keyMaterialFrom(state, state.contextWindow, request),
        modelCallMs: state.modelCallMs
      }).pipe(
        Stream.tap((event) => emitModelProgress(event, emit))
      )
    ).pipe(Effect.map((collected) => Array.from(collected)))
    if (!events.some((event) => event.type === "settle")) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed compaction step ended without a recorded settlement"
      })
    }
    const settled = ModelEvent.ModelEvent.settledMessage(events)
    const text = settled.message.content.filter(
      (part): part is ModelRequest.TextPart => part.type === "text"
    )
    if (text.length === 0) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed compaction step returned no text summary"
      })
    }
    const summary = ModelRequest.Message.user(
      untrustedData(text.map((part) => part.text).join("\n"), "compaction summary of conversation and tool output")
    )
    const contextWindow = yield* Compaction.apply(state.contextWindow, step, summary).pipe(Effect.orDie)
    yield* emit(
      new AgentEvent.CompactionSettled({
        eventType: eventType.compactionSettled,
        replacedPrefixDigest: step.replacedPrefixDigest,
        retainedMessageCount: state.contextWindow.segments
          .filter((segment) => ["transcript", "summary", "steering"].includes(segment.kind))
          .slice(step.prefixLength)
          .flatMap((segment) => segment.content)
          .filter((item) => "role" in item).length,
        summary
      })
    )
    return advance(state, { contextWindow })
  })

/**
 * The step the controller takes after one frame settles.
 */
type Step =
  | { readonly _tag: "Continue"; readonly state: State }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Suspend"; readonly reason: EngineLike.SuspendReason }

const frame = (
  input: Input,
  engine: EngineLike.EngineLike,
  sandbox: Sandbox.Sandbox,
  realm: Sandbox.Realm,
  steering: Steering.Source,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<Step, HarnessError | Sandbox.SandboxError | Model.ModelFailure> =>
  Effect.gen(function*() {
    // Compaction happens before the turn opens, so the digest the turn records
    // is the one the sealed step is actually keyed on.
    const state = yield* compacted(input.state, engine, emit)
    const descriptors = new Map(input.flows.map((descriptor) => [descriptor.name, descriptor]))
    const projections: Record<string, Cell.FlowProjection> = {}
    for (const descriptor of input.flows) projections[descriptor.name] = Cell.project(descriptor)
    // Seeded from what earlier frames were handed, appended to as this frame's
    // calls settle, and carried out through every exit that continues the run.
    const ledger: Array<TruncatedOutput.Capture> = [...state.truncatedOutputs]

    yield* emit(
      new AgentEvent.TurnOpened({
        eventType: eventType.turnOpened,
        seat: state.seat,
        modelParams: state.modelParams,
        activeToolNames: [],
        contextDigest: state.contextWindow.digest
      })
    )

    // The sealed model step, and the boundary parse of whatever it answered
    // with. A cell that does not parse never ran: the world is exactly where
    // the frame found it, so there is nothing to record and everything to gain
    // by asking again inside this frame. The prefix of the re-prompt is
    // byte-identical to the one just sent, so the provider serves it from its
    // cache and the answer costs the output it writes.
    let contextWindow = state.contextWindow
    let settled = undefined as ReturnType<typeof ModelEvent.ModelEvent.settledMessage> | undefined
    let produced:
      | { readonly source: Cell.Source; readonly blocks: number; readonly program: string }
      | undefined
    let refused: Cell.Rejected | undefined
    for (let attempt = 0;; attempt++) {
      const request = yield* Effect.fromResult(requestFrom(state, contextWindow))
      // Timed on the injected clock, never on ambient wall time, so a test that
      // supplies a clock sees the duration it declared.
      const startedAt = yield* Clock.currentTimeMillis
      const events = yield* Stream.runCollect(
        engine.sealStep({
          request,
          keyMaterial: keyMaterialFrom(state, contextWindow, request),
          modelCallMs: state.modelCallMs
        }).pipe(
          Stream.tap((event) => emitModelProgress(event, emit))
        )
      ).pipe(Effect.map((collected) => Array.from(collected)))
      const settledAt = yield* Clock.currentTimeMillis
      if (!events.some((event) => event.type === "settle")) {
        return yield* new HarnessError({
          code: "model_failed",
          message: "The sealed model step ended without a recorded settlement"
        })
      }
      settled = ModelEvent.ModelEvent.settledMessage(events)
      yield* emit(
        new AgentEvent.ModelSettled({
          eventType: eventType.modelSettled,
          message: settled.message,
          usage: settled.usage,
          durationMillis: settledAt - startedAt
        })
      )
      const extracted = settled.message.stopReason === "length"
        ? Result.fail(
          new Cell.Rejected({
            code: "output_truncated",
            message:
              "The model reached its output limit (length) before finishing the response. No blocks ran. Emit a shorter, complete cell."
          })
        )
        : Cell.extract(assistantText(settled.message))
      let rejection: Cell.Rejected | undefined
      if (extracted._tag === "Failure") rejection = extracted.failure
      else {
        // The parse the realm used to do, done here instead: a cell that cannot
        // run is refused before the frame commits to it.
        const validation = CellValidation.validate(extracted.success.source)
        rejection = validation.rejected
        if (validation.rejected === undefined) {
          produced = {
            source: extracted.success.source,
            blocks: extracted.success.blocks,
            program: validation.compiled
          }
        }
      }
      if (rejection === undefined) break
      if (attempt >= state.revalidations) {
        refused = rejection
        break
      }
      yield* emit(
        new AgentEvent.CellRejectedInFrame({
          eventType: eventType.cellRejectedInFrame,
          attempt: attempt + 1,
          code: rejection.code,
          message: rejection.message
        })
      )
      contextWindow = observedOn(
        contextWindow,
        settled.message,
        revalidationNote(rejection),
        deadCellEcho
      )
    }
    const answer = settled

    /** What this frame's cell printed, once it has run. */
    let printed = ""

    const hasNextFrame = state.maxFrames === 0 || state.frame + 1 < state.maxFrames

    // Every exit records its delivery decision. With no frame left to read a
    // message, keep it pending at the source instead of acknowledging and
    // discarding it. Replays see the same decision under the same boundary.
    const drain = (wouldIdle: boolean): Effect.Effect<Steering.DrainRecord, HarnessError> =>
      Effect.gen(function*() {
        const boundary = produced?.source.digest ?? contextWindow.digest
        const drained = yield* engine.record({
          name: "steering-drain",
          identity: { session: state.session, frame: state.frame, boundary: `steering-drain:${boundary}` },
          success: Steering.DrainRecord,
          execute: hasNextFrame
            ? steering.drain({ boundary: `${state.frame}:${boundary}`, wouldIdle }).pipe(
              Effect.map(Steering.drainRecord)
            )
            : Effect.succeed({ inserts: [], seatChanges: [], activatedToolNames: [], queued: false })
        })
        yield* emit(new AgentEvent.SteeringDrained({ eventType: eventType.steeringDrained, messages: drained.inserts }))
        return drained
      })

    // Rejected cells have no execution facts. Once a cell runs, every
    // continuation carries the same measured facts through this one boundary.
    let facts: StateChanges = {}
    const continuing = (changes: StateChanges): Extract<Step, { readonly _tag: "Continue" }> => ({
      _tag: "Continue",
      state: advance(state, {
        frame: state.frame + 1,
        truncatedOutputs: TruncatedOutput.retain(ledger),
        ...facts,
        ...changes
      })
    })
    const close = (
      outcome: "continue" | "resolved" | "suspended",
      output: string = budgetMessage(state)
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* emit(
          new AgentEvent.TurnClosed({
            eventType: eventType.turnClosed,
            stopReason: answer.message.stopReason,
            outcome
          })
        )
        if (outcome === "resolved") {
          yield* emit(
            new AgentEvent.Resolved({
              eventType: eventType.resolved,
              message: ModelRequest.Message.assistant(output, { stopReason: "stop" })
            })
          )
        }
      })
    const finish = (step: Step): Effect.Effect<Step> =>
      close(step._tag === "Done" ? "resolved" : step._tag === "Suspend" ? "suspended" : "continue").pipe(
        Effect.as(step)
      )

    const resumed = (
      drained: Steering.DrainRecord,
      changes: StateChanges = {},
      text: string = printed,
      echo: number = liveCellEcho
    ): Effect.Effect<Extract<Step, { readonly _tag: "Continue" }>, HarnessError> =>
      Effect.gen(function*() {
        const settings = yield* steered(state, drained.seatChanges, input.contextWindowTokensFor)
        const context = appended(
          contextWindow,
          answer.message,
          [ModelRequest.Message.user(text), ...drained.inserts],
          echo
        )
        return continuing({
          ...settings,
          contextWindow: windowOn(state, settings.seat, context),
          ...changes
        })
      })

    /** Records an unusable frame and asks for another, budget permitting. */
    const observe = (
      note: string,
      changes: StateChanges = {},
      echo: number = liveCellEcho
    ): Effect.Effect<Step, HarnessError> =>
      Effect.gen(function*() {
        const drained = yield* drain(!hasNextFrame)
        return hasNextFrame
          ? yield* resumed(drained, changes, printed === "" ? note : `${printed}\n\n${note}`, echo)
          : { _tag: "Done" }
      })

    if (produced === undefined) {
      const rejection = refused!
      yield* emit(
        new AgentEvent.CellSettled({
          eventType: eventType.cellSettled,
          cell: "",
          outcome: rejection
        })
      )
      // A rejected cell is the fourth exit that continues the run, and it is
      // judged by the same rule as the other three: no cell ran, so this frame
      // made no call and wrote nothing, and a frame that wrote nothing counts.
      // Leaving it frozen kept one shape of stall outside the only control
      // that ends one — a model that answers with prose instead of a cell
      // advanced no counter at all and spent the whole frame budget doing it.
      // Nothing to measure and nothing to demand: the cell never reached the
      // sandbox, so any pending demand is carried forward unanswered.
      const rejectedFrames = state.readOnlyFrames + 1
      if (state.readOnlyCap > 0 && rejectedFrames >= state.readOnlyCap * 2) {
        return yield* readOnlyCapFailure(state.readOnlyCap, rejectedFrames)
      }
      const step = yield* observe(rejection.message, { readOnlyFrames: rejectedFrames }, deadCellEcho)
      return yield* finish(step)
    }

    const cell = produced.source
    const program = produced.program
    yield* emit(
      new AgentEvent.CellProduced({
        eventType: eventType.cellProduced,
        cell,
        blocks: produced.blocks
      })
    )

    // Every call the frame settles is remembered so a raise can hand the
    // model its partial work. Without this, one uncaught throw discarded the
    // frame's reads and the next cell re-did them — often raising the same
    // way again. Prime Agent's tool errors return stdout-so-far plus the
    // traceback for exactly this reason.
    const observedCalls: Array<{
      readonly flow: string
      readonly ok: boolean
      readonly summary: string
      /** Where this call lands in the run's ledger, so a salvage line can name it. */
      readonly ordinal: number
      /**
       * Whether the call reached the engine declaring a write, which is what
       * breaks a read-only run. A call the boundary refused is not one: it
       * declared a write and performed none.
       */
      readonly mutates: boolean
      /**
       * What this invocation asked for, as {@link signatureOf} names it, with
       * the tree it asked about folded in.
       *
       * The repeat ledger reads this one, because the identical command against
       * a pinned tree and against the live tree are two different questions and
       * a run that asks both has learned twice.
       */
      readonly signature: string
      /**
       * The same, with the tree left out: what the call asked, of whatever
       * tree.
       *
       * The check ledgers read this one, because `Sufficiency` matches a
       * failing reading against the passing reading that answered it, and the
       * whole shape this surface exists for takes those two readings of one
       * command over two different trees. Keyed on the tree they would never
       * meet. For a call on the live tree the two are the same string, so
       * nothing that existed before checkpoints re-keys.
       */
      readonly subject: string
      /** The checkpoint this call ran against, when it named one. */
      readonly at: string | undefined
      /** What this invocation asked for, verbatim, for the narrowing ledger. */
      readonly input: Schema.Json
      /** What the call resolved with, verbatim, for the call ledger's digest. */
      readonly value: Schema.Json
      /** What the flow said about a failure, for the call ledger's digest. */
      readonly message: string | undefined
      /** What the flow said about its own failure, when it said it ran nothing. */
      readonly invalidProbe: { readonly reason: string; readonly message: string } | undefined
      /**
       * Whether the result reported a failing exit status about its subject.
       *
       * A call that declared an invalid probe is never failing here, whatever
       * its exit status: the flow itself said the failure was about the command
       * and not about the code, so the result is not a statement about the tree
       * at all. See `UnresolvedFailure` `failed`.
       */
      readonly failing: boolean
      /**
       * Whether the result reported a passing exit status about its subject.
       *
       * Not the negation of `failing`: a flow that reports no exit status is
       * neither, and `Sufficiency` needs the difference between a check that
       * passed and a call that never checked anything. An invalid probe is
       * neither either, for the same reason it is never failing — the flow
       * itself said the result is not a statement about the tree.
       */
      readonly passing: boolean
    }> = []
    /** Ordinals of the invocations that reached the engine this frame. */
    const performed = new Set<number>()
    // The per-call ceiling this frame enforces, resolved once. It is applied
    // where the settlement is recorded rather than in the drive loop, so the
    // number a run armed and the number its journal holds are the same one.
    const callMs = Sandbox.withDefaults(sandbox.capabilities, input.limits).callMs ?? Sandbox.defaultLimits.callMs
    let replaying = false
    const observing: Sandbox.Handler = (invocation) =>
      callHandler(state, cell, descriptors, engine, ledger, performed, callMs, replaying, emit)(invocation).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const rendered = result.outcome === "success"
              ? JSON.stringify(result.value)
              : result.message ?? "failed"
            // The ordinal this call will carry in the run's ledger, computed
            // here so the salvage line can name it: a summary the next frame
            // cannot expand is a summary it will pay to re-fetch.
            const ordinal = CallLedger.settled(state.callLedger) + observedCalls.length + 1
            const descriptor = descriptors.get(invocation.flow)
            const probe = result.outcome === "success" ? invalidProbeOf(result.value) : undefined
            // The tree this call actually ran against. A call the boundary
            // refused ran against nothing, and one whose `at` did not decode
            // named nothing, so neither keys anything: `performed` is the set
            // the boundary let through.
            const ranAt = performed.has(invocation.ordinal) && invocation.at !== undefined
              ? Cell.checkpointOf(invocation.at)
              : undefined
            observedCalls.push({
              flow: invocation.flow,
              ok: result.outcome === "success",
              summary: elide.head(rendered, salvageSummary, salvageRecall),
              ordinal,
              mutates: performed.has(invocation.ordinal) && descriptor !== undefined &&
                mutating(descriptor, invocation.input),
              // Every invocation the cell issued, refused ones included: a
              // refusal is still a question the run has already asked, and
              // asking it again learns nothing either.
              signature: signatureOf(invocation.flow, invocation.input, ranAt),
              subject: signatureOf(invocation.flow, invocation.input),
              at: ranAt,
              input: invocation.input,
              value: result.value,
              message: result.message,
              invalidProbe: probe,
              failing: result.outcome === "success" && probe === undefined &&
                UnresolvedFailure.failed(result.value),
              passing: result.outcome === "success" && probe === undefined &&
                UnresolvedFailure.passed(result.value)
            })
          })
        )
      )
    // What the tree looked like before this frame's calls. Every frame after
    // the first opens on the measurement its predecessor closed with, so this
    // walks the workspace only when the run has none yet.
    const opened = state.workspace ?? (yield* witness(engine, state, cell.digest, "open"))
    // One realm per run. It is the caller's scoped resource, so the loop hands
    // it the cell and the call handler and nothing else about how a frame runs
    // depends on where the realm came from.
    //
    // Ids this frame pinned are carried out through every exit that continues
    // the run: a checkpoint a frame minted before it raised is still a tree the
    // run holds, and forgetting it would leak a stored tree nothing can name.
    const minted: Array<string> = []
    const mint = minter(state, cell, engine, minted, callMs, emit)
    // The script the model may promote into a saved flow. It is recorded before
    // the realm evaluates the cell, so a cell that raises is still part of what
    // the run ran. A host that offers no way to save a flow binds no history and
    // nothing is kept.
    const history = yield* Effect.serviceOption(CellHistory.CellHistory)
    yield* Option.match(history, {
      onNone: () => Effect.void,
      onSome: (recorder) => recorder.record(cell.text)
    })
    const evaluated = yield* Effect.gen(function*() {
      // A null record marks an attempt that has not produced a frame yet.
      // Skip saved markers until the terminal frame is found, or append a new
      // marker and evaluate outside any activity. This keeps durable waits and
      // permission parks out of the frame record's execution context.
      for (let attempt = 0;; attempt++) {
        const identity = (slot: number): EngineLike.BoundaryIdentity => ({
          session: state.session,
          frame: state.frame,
          boundary: `cell-frame:${cell.digest}${slot === 0 ? "" : `:attempt:${slot}`}`
        })
        let fresh = false
        const recorded = yield* engine.record({
          name: "cell-frame",
          identity: identity(attempt),
          success: Schema.NullOr(RecordedFrame),
          execute: Effect.sync(() => {
            fresh = true
            return null
          })
        })
        if (recorded === null && !fresh) continue
        if (
          recorded !== null && recorded.boundary === undefined &&
          recorded.outcome._tag === "rejected" && recorded.outcome.code === "limit_exceeded"
        ) {
          return yield* Effect.fail(
            new HarnessError({
              code: "incompatible_journal",
              message: "Cannot reconstruct a limited frame without its recorded execution frontier"
            })
          )
        }
        const replay = recorded !== null && recorded.boundary?.terminal === "timeout"
          ? { boundary: recorded.boundary, outcome: yield* Cell.decodeOutcome(recorded.outcome) }
          : undefined
        replaying = replay !== undefined
        const frame = yield* realm.evaluate({
          cell,
          // The boundary parse above is the only one this cell gets: the realm
          // runs what it compiled rather than parsing the same text again.
          program,
          frame: state.frame,
          flows: input.refreshFlows === undefined ? undefined : projections,
          call: observing,
          mint,
          replay,
          // Settlements are bounded inside their recorded boundaries.
          bounded: true
        })
        if (recorded !== null) return recorded
        const outcome = yield* Cell.decodeOutcome(frame.outcome)
        return yield* engine.record({
          name: "cell-frame",
          identity: identity(attempt + 1),
          success: RecordedFrame,
          execute: Effect.succeed({ ...frame, outcome })
        })
      }
    })
    const outcome = yield* Cell.decodeOutcome(evaluated.outcome)
    const bindings = evaluated.bindings
    printed = printsObservation(evaluated.prints)
    yield* emit(
      new AgentEvent.CellPrinted({
        eventType: eventType.cellPrinted,
        cell: cell.digest,
        text: evaluated.prints
      })
    )
    // The panel the next frame opens with, stamped by the frame that ran.
    const panel = VariablesPanel.stamp(state.panel, bindings, state.frame)
    const closed = yield* witness(engine, state, cell.digest, "close")
    yield* emit(
      new AgentEvent.CellSettled({
        eventType: eventType.cellSettled,
        cell: cell.digest,
        outcome,
        ...(evaluated.boundary === undefined ? {} : { boundary: evaluated.boundary })
      })
    )

    // What this frame asked, folded into what the run had already asked. Every
    // exit that continues the run carries it, a raise included: a call that
    // settled before the throw is work the run paid for, and the ledger is the
    // only place the next model turn can read it.
    const callLedger = CallLedger.remember(state.callLedger, observedCalls)

    // The frame's own record of what it did to the world, computed once and
    // carried out through every exit.
    //
    // `declaredWrites` is what the frame's calls said about themselves and the
    // measurement is what the workspace says. A measurement adds a mutation
    // nothing declared — the shell redirect this exists for — and it does not
    // take away a declaration made by a call that *succeeded*, because it does
    // not cover the whole world: it stops at a bound, it prunes directories,
    // and it is rooted at one path, so a real edit outside what it covers
    // would read as an idle frame and twice the cap later the run would fail
    // as `read_only_cap` having edited files the whole time.
    //
    // A declaration made by a call that *failed* is a different claim. It says
    // what the call would have written, and a complete measurement that saw
    // the workspace hold still contradicts it directly rather than merely
    // failing to confirm it: nothing was written, so nothing was written
    // outside the bound either. Wave 7 recorded two such frames on one
    // instance — an anchor miss reporting `Failed to find expected lines`, and
    // an edit reporting `oldString does not occur` — each of which cleared a
    // read-only streak the run had not broken. Where the measurement is
    // partial or absent the old rule stands, because then the digest holding
    // still is not evidence of anything.
    const declaredWrites = observedCalls.filter((call) => call.mutates).length
    const measured = Option.isSome(opened) && Option.isSome(closed)
    const covered = measured && opened.value.complete && closed.value.complete
    const standingWrites = observedCalls.filter((call) => call.mutates && (call.ok || !covered)).length
    const mutated = standingWrites > 0 || (covered && opened.value.digest !== closed.value.digest)
    const closingDigest = Option.match(closed, { onNone: () => "", onSome: (value) => value.digest })
    yield* emit(
      new AgentEvent.MutationObserved({
        eventType: eventType.mutationObserved,
        basis: covered ? "observed" : measured ? "partial" : "declared",
        mutated,
        digest: closingDigest,
        paths: Option.match(closed, { onNone: () => 0, onSome: (value) => value.paths }),
        declaredWrites
      })
    )
    // The frame's own broken probes, stated once and delivered through every
    // exit. A cell chooses the context its successor sees, so a frame that
    // summarised "the test still fails" would otherwise carry the wrong belief
    // forward with nothing to contradict it.
    const probeNotice = invalidProbeNotice(observedCalls)

    // The frame's own repetition, measured the same way and carried the same
    // way: a frame repeats when it issued calls, issued none this run had not
    // already issued, and changed nothing. A signature the ledger has
    // forgotten reads as new, which delays a demand and never fabricates one.
    const signatures = observedCalls.map((call) => call.signature)
    const asked = new Set(state.callSignatures)
    const novel = signatures.some((signature) => !asked.has(signature))
    const callSignatures = remember(state.callSignatures, signatures)
    const checkpointIds = minted.length === 0 ? state.checkpointIds : [...state.checkpointIds, ...minted]
    const repeatFrames = signatures.length === 0
      ? state.repeatFrames
      : novel || mutated
      ? 0
      : state.repeatFrames + 1

    // The frame's own checks, and the tree they were taken over.
    //
    // Only a call that succeeded and declared no write is a check: a failed
    // call observed nothing, and a call that changes the workspace is not an
    // observation of it. The digest is the frame's own closing measurement, and
    // only when that measurement covered the tree — under a partial or absent
    // one a moved digest is as likely to be a bound moving as work, and this
    // ledger's entire purpose is to say that the tree changed since a check
    // ran. An empty digest makes an entry inert rather than wrong.
    const workspaceDigest = covered ? closingDigest : ""
    const readings = (checkpointed: boolean) =>
      observedCalls.flatMap((call) => {
        if (!call.ok || call.mutates || (call.at !== undefined) !== checkpointed) return []
        const recorded = NarrowedCheck.check({
          flow: call.flow,
          signature: call.subject,
          input: call.input,
          // A reading taken against a checkpoint is a reading of a tree that is
          // not this workspace, so it carries no workspace digest: every ledger
          // that reads one asks a question about the tree the run is standing
          // on, and an entry stamped with this frame's digest would answer that
          // question with somebody else's tree. Empty makes it inert there.
          digest: checkpointed ? "" : workspaceDigest,
          failing: call.failing,
          passing: call.passing,
          // A frame that also edited cannot say whether its checks ran before or
          // after the edit, so the tree stamped on them is a guess in one
          // direction. `UnresolvedFailure` refuses to carry a failure on such a
          // stamp; see `NarrowedCheck.Check` `stable`.
          //
          // A checkpointed reading is the one case where the guess is not a
          // guess. The tree it read was pinned before the edit and cannot move,
          // so the ordering is established by the pin rather than inferred from
          // the frame — which is exactly what this surface exists to buy, and
          // what the run used to buy by reverting its own work.
          stable: checkpointed || !mutated
        })
        return recorded === undefined ? [] : [recorded]
      })
    const frameChecks = readings(false)
    // Live readings only. Every consumer of this ledger — the narrowing demand,
    // the unresolved-failure demand, the vacuous-verification notice — asks
    // whether the tree the run is completing on was checked, and a checkpointed
    // reading is not a reading of that tree.
    const checks = NarrowedCheck.remember(state.checks, frameChecks)

    // How many frames of this run have changed the workspace, and which of
    // this frame's checks failed before any of them did. Both carried out
    // through every exit: a failure watched in a frame that then raised is
    // still a failure this run watched.
    const mutations = state.mutations + (mutated ? 1 : 0)
    // Both, because this is the one ledger a checkpointed reading belongs in:
    // its whole question is an ordering — this failed, then something changed,
    // then that passed — and a pinned tree answers the first half honestly from
    // a frame that also did the changing.
    const failures = Sufficiency.remember(state.failures, {
      frame: [...readings(true), ...frameChecks],
      epoch: state.mutations
    })

    // The tree the run was handed, fixed the first time a frame measured one
    // and never restamped. See `State.openingDigest`.
    const openingDigest = state.openingDigest !== ""
      ? state.openingDigest
      : Option.match(opened, {
        onNone: () => "",
        onSome: (value) => value.complete ? value.digest : ""
      })

    facts = {
      workspace: closed,
      repeatFrames,
      callSignatures,
      checkpointIds,
      checks,
      callLedger,
      failures,
      mutations,
      openingDigest,
      panel,
      ...(mutated ? { readOnlyGrace: 0, pendingReadOnlyDemand: undefined } : {})
    }
    const readOnly = !mutated
    const readOnlyFrames = readOnly ? state.readOnlyFrames + 1 : 0

    // Read-only discipline is armed for the whole frame, not for one exit: a
    // raise, a refused park and a settled transition all continue the run, and
    // each of them judges the frame by this cap.
    const cap = state.readOnlyCap

    if (outcome._tag !== "settled") {
      // The frame settled no transition, but it either changed the workspace
      // or it did not, and that is the whole of what the streak counts.
      // Freezing the counter here is how a stall hid from the cap: a run that
      // alternates a raise with a read advances the streak once every two
      // frames, so a cap of twelve took twenty-four frames to reach and a run
      // that raised more often than it read never reached it at all. Wave 7's
      // own report reads the drift the other way round — the journal's
      // mutation streak and this counter disagreed by one per raise — and the
      // instance that spent its whole budget raised twice.
      // A demand is answered by a write or by a justification, and a frame
      // that settled no transition produced neither. So a raise leaves the
      // demand pending — its text is still in the transcript this exit appends
      // to — and the journal names the frame that finally answers it.
      if (state.pendingReadOnlyDemand !== undefined && mutated) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: "write"
          })
        )
      }
      if (cap > 0 && readOnlyFrames >= cap * 2) {
        return yield* readOnlyCapFailure(cap, readOnlyFrames)
      }
      // The flow name is clipped for the same reason `CallLedger` clips it: a
      // call names whatever string the cell passed to `ctx.call`, a name that
      // matches no descriptor still settles as a failure saying so, and an
      // unbounded name here is an unbounded line in the notice.
      const salvage = observedCalls.length === 0
        ? ""
        : `\nCalls this cell already completed (their results are durable, and each one is still under the name your cell bound it to — read the name instead of redoing the work):\n${
          observedCalls.map((call) =>
            `- ${call.ordinal}. ${clip(call.flow, CallLedger.width)} -> ${call.ok ? "ok" : "FAILED"}: ${call.summary}`
          )
            .join("\n")
        }`
      const alert = probeNotice === undefined ? "" : `\n\n${probeNotice}`
      // A property read through an absent path is the one throw the harness can
      // diagnose without guessing, and it is the throw a cell reaching into
      // a realm binding makes. The names are already computed for the variables
      // panel, so naming them costs nothing and closes the loop the model would
      // otherwise spend a frame on. See `VariablesPanel`.
      const missed = outcome._tag === "raised" ? bindingPathMiss(outcome.message, bindings) : undefined
      const note = outcome._tag === "raised"
        ? `The cell threw ${outcome.name}: ${outcome.message}. Emit a corrected cell.${
          missed === undefined ? "" : `\n${missed}`
        }${salvage}${alert}`
        : `${outcome.message}${salvage}${alert}`
      const step = yield* observe(note, {
        readOnlyFrames
      })
      return yield* finish(step)
    }

    const transition = outcome.transition
    yield* emit(
      new AgentEvent.TransitionApplied({
        eventType: eventType.transitionApplied,
        transition
      })
    )

    if (transition._tag === "park") {
      if (state.pendingReadOnlyDemand !== undefined) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: mutated ? "write" : "park"
          })
        )
      }
      // A park with no channel to answer it is refused and answered here. The
      // journal states this without a event of its own: the pair
      // `transition-applied` carrying a `park` and `turn-closed` carrying
      // `continue` occurs for no other reason.
      if (!state.approvalChannel) {
        // A refused park continues the run, so its frame is judged like every
        // other continuing frame. Waiting was the exemption and there is no
        // waiting here: a cell that parks every frame changes nothing, and
        // without this it would be the one shape a stalled run can take that
        // the read-only cap never sees.
        if (cap > 0 && readOnlyFrames >= cap * 2) {
          return yield* readOnlyCapFailure(cap, readOnlyFrames)
        }
        const limits = Sandbox.withDefaults(sandbox.capabilities, input.limits)
        const step = yield* observe(
          parkRefusal(
            transition.message,
            state.maxFrames === 0 ? "unlimited" : Math.max(0, state.maxFrames - state.frame - 1),
            limits.totalMs === undefined ? undefined : Math.floor(limits.totalMs / 1000)
          ),
          {
            pendingReadOnlyDemand: undefined,
            readOnlyFrames
          }
        )
        return yield* finish(step)
      }
      if (!hasNextFrame) {
        yield* drain(true)
        yield* close("resolved")
        return { _tag: "Done" }
      }
      // The drain on the park path, and the only thing that can ever answer an
      // honored park.
      //
      // A parked run resumes by re-executing its own frames, so it reaches this
      // park again with the same cell, the same transition, and the same
      // question. One boundary per park would hand every later attempt the
      // first attempt's empty answer, the run would park again, and the
      // operator's message would sit in the durable queue for the life of the
      // run — woken, replayed, re-parked, forever. That is what makes
      // `waiting-input` unanswerable today.
      //
      // So the park has a LADDER of boundaries and walks it. Every rung the
      // queue has answered before hands back exactly what it handed back then,
      // which is what keeps a replay identical; the walk stops at the first
      // rung this run has never consulted, which is the one read a resumed
      // attempt is entitled to perform for real. One rung is consumed per
      // attempt, so a steer admitted while the run was parked is delivered by
      // the rung the resume reaches, and every attempt after that replays the
      // delivery rather than draining a queue that no longer holds it.
      //
      // The queue is the record here, and deliberately: `EngineLike.record`
      // would freeze the rung's answer, and a frozen `duplicate` tells every
      // later attempt it was the first, which is the loop this is closing.
      const answered = yield* Effect.gen(function*() {
        for (let rung = 0;; rung++) {
          const drained = yield* steering.drain({
            boundary: `${state.frame}:${cell.digest}:park:${rung}`,
            // A park IS the run going idle, which is the condition a queued
            // follow-up was admitted to wait for. The continue path passes
            // false because a continuing run is not idle; this is the boundary
            // that owes those messages their delivery.
            wouldIdle: true
          })
          const record = Steering.drainRecord(drained)
          if (carries(record) || !drained.duplicate) return record
        }
      })
      if (carries(answered)) {
        yield* emit(
          new AgentEvent.SteeringDrained({
            eventType: eventType.steeringDrained,
            messages: answered.inserts
          })
        )
        // The park was answered, so the run carries on rather than waiting for
        // an answer it has already been given. The frame is judged as an
        // honored park still is — waiting is not evasion — so the read-only
        // streak is carried rather than advanced.
        const step = yield* resumed(answered, {
          pendingReadOnlyDemand: undefined
        })
        return yield* finish(step)
      }
      return yield* finish({
        _tag: "Suspend",
        reason: new EngineLike.SuspendReason({
          code: transition.reason,
          message: transition.message
        })
      })
    }

    // Read-only discipline, applied to every frame that settled a decision.
    // An honored park is exempt: waiting is not evasion, and a parked run is
    // not reporting anything as done. A refused park is not exempt — it
    // continues the run — and the branch above applies the same rule to it.
    if (state.pendingReadOnlyDemand !== undefined) {
      yield* emit(
        new AgentEvent.ReadOnlyDemanded({
          eventType: eventType.readOnlyDemanded,
          streak: state.pendingReadOnlyDemand.streak,
          cap: state.pendingReadOnlyDemand.cap,
          nextFrame: state.frame,
          nextAction: mutated
            ? "write"
            : (transition._tag === "continue" && (transition.justification ?? "").trim().length > 0)
            ? "justification"
            : "read-only"
        })
      )
    }
    if (cap > 0 && readOnlyFrames >= cap * 2) {
      return yield* readOnlyCapFailure(cap, readOnlyFrames)
    }

    // `VacuousVerification` was read here, between the read-only cap and the
    // completion branch, and it is not read anywhere now. The module, its
    // tests and `AgentEvent.VacuousVerificationObserved` are kept; the arm is
    // off. the r93 wave report is the reason and the module's
    // own docblock carries it. Re-wiring is one `stored`/`find` pair here plus
    // the two `State` fields it needs, and it is a controlled arm of its own
    // wave when it happens — not a change that rides along with another.

    const drained = yield* drain(transition._tag === "complete" || !hasNextFrame)
    if (transition._tag === "complete" && carries(drained)) {
      printed += `\n\nThe completed answer before this follow-up:\n${transition.output}`
      const step = yield* resumed(drained, {
        bouncedCompletion: transition.output,
        readOnlyFrames
      })
      return yield* finish(step)
    }
    if (transition._tag === "complete") {
      // The completion's own evidence, judged once per demand. A run gets
      // exactly one frame wrong for free — the last one — and four things can
      // be wrong with it, each read off measurements the controller already
      // took, under three caps:
      //
      // 1. `UnmovedTree`: the tree it is completing on is the tree it opened
      //    on, so there is no change for any evidence to be about;
      // 2. `UnresolvedFailure`: a check over this exact tree reported a failing
      //    exit status and the run answered it with a different reading of the
      //    same subject rather than with the check itself;
      // 3. `NarrowedCheck.find`: this frame's check repeats an earlier, broader
      //    one and adds conditions to it, run after a change the broader one
      //    never saw;
      // 4. `NarrowedCheck.findOnly`: the check this frame ended on is the run's
      //    only reading of what it names — nothing broader was ever taken, so
      //    there was no broader check for (3) to find — and it carries a
      //    condition the run itself added, one taught neither by the prefix
      //    this harness wrote nor by the run's own other checks.
      //
      // The last two share one cap. They are two readings of one question —
      // whether the evidence covers what it looks like it covers — and a run
      // that answers either has answered the question; a second bounce would be
      // the loop asking it twice in different words.
      //
      // At most one is named, in that order, because they are in descending
      // order of how fundamental the missing thing is: there is nothing to
      // check, then the check said no, then the check said less than it looks
      // like it said. Naming two at once would ask the run to answer a
      // question it has not been given a frame for.
      //
      // The loop names what is missing and hands the frame back; it does not
      // re-run anything, and it does not judge the answer that comes back.
      //
      // Asking costs the run a frame it can answer in, so a demand is issued
      // only where that frame exists, and three separate things take it away:
      //
      // - the frame budget, which has no frame left to spend, and turning a
      //   completion into an exhausted budget would lose the run's answer to
      //   make a point about it;
      // - the read-only cap, which is the other budget that ends a run and
      //   ends it as a typed failure carrying nothing. A run that changed
      //   nothing is exactly the run `UnmovedTree` fires on, so a completion
      //   one frame short of twice the cap would be bounced, spend that frame
      //   reading, and die as `read_only_cap` with the answer it had already
      //   written discarded — a demand turning a finished run into a failure,
      //   which is the one outcome none of these may produce;
      // - a demand this run has already answered. Each demand ends by promising
      //   that what comes back next is the answer that stands, and three of
      //   them fire on one transition, so the frame written to answer one is
      //   never judged by the next. See {@link State.demandedFrame}.
      const room = (state.maxFrames === 0 || state.frame + 1 < state.maxFrames) &&
        (cap === 0 || readOnlyFrames + 1 < cap * 2) &&
        state.demandedFrame !== state.frame
      const unmoved = room && state.unmovedDemands < state.unmovedCap
        ? UnmovedTree.find({ opened: openingDigest, digest: workspaceDigest })
        : undefined
      const unresolved = unmoved === undefined && room && state.unresolvedDemands < state.unresolvedCap
        ? UnresolvedFailure.find({ ledger: checks, digest: workspaceDigest })
        : undefined
      const narrowable = unmoved === undefined && unresolved === undefined && room &&
        state.narrowingDemands < state.narrowingCap
      const narrowing = narrowable
        ? NarrowedCheck.find({ ledger: state.checks, frame: frameChecks, digest: workspaceDigest })
        : undefined
      const narrowOnly = narrowable && narrowing === undefined
        ? NarrowedCheck.findOnly({
          ledger: checks,
          before: state.checks.map((entry) => entry.signature),
          frame: frameChecks,
          taught: taughtTerms(contextWindow)
        })
        : undefined
      if (unmoved !== undefined) {
        yield* emit(
          new AgentEvent.UnmovedDemanded({
            eventType: eventType.unmovedDemanded,
            openedDigest: unmoved.opened,
            currentDigest: unmoved.closed,
            nextFrame: state.frame + 1
          })
        )
      }
      if (unresolved !== undefined) {
        yield* emit(
          new AgentEvent.UnresolvedDemanded({
            eventType: eventType.unresolvedDemanded,
            flow: unresolved.failed.flow,
            failed: unresolved.failed.label,
            instead: unresolved.instead.label,
            currentDigest: workspaceDigest,
            nextFrame: state.frame + 1
          })
        )
      }
      if (narrowing !== undefined) {
        yield* emit(
          new AgentEvent.NarrowedDemanded({
            eventType: eventType.narrowedDemanded,
            flow: narrowing.earlier.flow,
            broader: narrowing.earlier.label,
            narrower: narrowing.later.label,
            broaderDigest: narrowing.earlier.digest,
            currentDigest: workspaceDigest,
            nextFrame: state.frame + 1
          })
        )
      }
      if (narrowOnly !== undefined) {
        yield* emit(
          new AgentEvent.NarrowOnlyDemanded({
            eventType: eventType.narrowOnlyDemanded,
            flow: narrowOnly.later.flow,
            check: narrowOnly.later.label,
            targets: narrowOnly.targets,
            currentDigest: workspaceDigest,
            nextFrame: state.frame + 1
          })
        )
      }
      const demanded = unmoved !== undefined
        ? { note: UnmovedTree.demand(unmoved), spent: { unmovedDemands: state.unmovedDemands + 1 } }
        : unresolved !== undefined
        ? {
          note: UnresolvedFailure.demand(unresolved),
          spent: { unresolvedDemands: state.unresolvedDemands + 1 }
        }
        : narrowing !== undefined
        ? { note: NarrowedCheck.demand(narrowing), spent: { narrowingDemands: state.narrowingDemands + 1 } }
        : narrowOnly !== undefined
        ? { note: NarrowedCheck.demandOnly(narrowOnly), spent: { narrowingDemands: state.narrowingDemands + 1 } }
        : undefined
      if (demanded !== undefined) {
        yield* close("continue")
        return continuing({
          // The demand is an in-frame observation appended to what the run
          // was already holding, not a projected context: a completion names
          // no context for a next frame, and a run answering this one needs
          // the frame it just wrote.
          contextWindow: observedOn(contextWindow, answer.message, demanded.note, liveCellEcho),
          readOnlyFrames,
          pendingReadOnlyDemand: undefined,
          ...demanded.spent,
          // The answer the demand is taking away, kept so it cannot be lost.
          // A frame was reserved for the run to answer in, but nothing makes
          // that frame end in a completion, and a run that spends it and
          // then runs out of budget would end on the budget notice with its
          // own answer discarded. See {@link budgetMessage}.
          bouncedCompletion: transition.output,
          // The frame this demand was handed to, which is the frame that
          // gets to answer it without being judged again. See
          // {@link State.demandedFrame}.
          demandedFrame: state.frame + 1
        })
      }
      yield* close("resolved", transition.output)
      return { _tag: "Done" }
    }

    if (state.maxFrames > 0 && state.frame + 1 >= state.maxFrames) {
      yield* close("resolved")
      return { _tag: "Done" }
    }
    yield* close("continue")
    const { contextWindowTokens, modelParams, seat } = yield* steered(
      state,
      drained.seatChanges,
      input.contextWindowTokensFor
    )
    // The intervention. At the cap the next frame is told, structurally, that
    // it must write something or say why it cannot; a justification is typed
    // data on the transition, is recorded, and buys a bounded quiet spell
    // without resetting the counter that ends the run at twice the cap.
    //
    // A justification buys that spell only when it *answers* a demand this
    // frame was handed. A justification volunteered by a frame nobody asked is
    // recorded — it is a field on the transition and the journal writes the
    // whole transition — and buys nothing. The two cannot be the same price,
    // because the counter runs regardless of which one is written: a run that
    // volunteers one every few frames used to renew the quiet spell before the
    // streak could ever hand the demand out, so the demand was never issued,
    // never journaled, and never got its one chance to redirect the run, while
    // the hard stop at twice the cap — which no grace touches — killed the run
    // anyway. Two SWE-bench waves lost `pydata__xarray-7393` exactly so: ten
    // volunteered justifications, zero `read-only-demanded` events, and death
    // at 24 frames against a cap of 12 without the control ever speaking.
    const graceLeft = readOnly ? state.readOnlyGrace : 0
    const demanded = cap > 0 && readOnly && readOnlyFrames >= cap && graceLeft === 0
    const justified = readOnly && state.pendingReadOnlyDemand !== undefined &&
      (transition.justification ?? "").trim().length > 0
    const readOnlyGrace = justified ? cap : Math.max(0, graceLeft - 1)
    if (demanded && !justified) {
      yield* emit(
        new AgentEvent.ReadOnlyDemandIssued({
          eventType: eventType.readOnlyDemandIssued,
          streak: readOnlyFrames,
          cap,
          nextFrame: state.frame + 1
        })
      )
    }
    const demand = demanded && !justified
      ? [ModelRequest.Message.user(DemandText.readOnly(cap, readOnlyFrames))]
      : []
    // The convergence intervention. It is journaled when it is *issued* rather
    // than when the next frame answers it, because what answers it is the
    // shape of that frame's calls — which the journal already writes one by
    // one — and not a field on a transition the controller has to wait for.
    // Issuing it restarts the count, so a run that keeps repeating is told
    // once every `repeatCap` frames instead of every frame.
    const repeatDemanded = state.repeatCap > 0 && repeatFrames >= state.repeatCap
    if (repeatDemanded) {
      yield* emit(
        new AgentEvent.RepeatDemanded({
          eventType: eventType.repeatDemanded,
          frames: repeatFrames,
          cap: state.repeatCap,
          nextFrame: state.frame + 1
        })
      )
    }
    const repeated = repeatDemanded
      ? [ModelRequest.Message.user(DemandText.repeat(repeatFrames, state.repeatCap))]
      : []
    const alerts = probeNotice === undefined ? [] : [ModelRequest.Message.user(probeNotice)]
    // The counterweight, and the only notice here that asks for nothing. It is
    // written on the frame that completes the pair rather than at a completion,
    // because its whole purpose is to reach a run that is still deciding
    // whether to keep working — a run at its `complete` transition has already
    // decided. See `Sufficiency`.
    const sufficient = state.sufficiencyStated
      ? undefined
      : Sufficiency.find({ ledger: failures, frame: frameChecks, epoch: mutations })
    if (sufficient !== undefined) {
      yield* emit(
        new AgentEvent.SufficiencyObserved({
          eventType: eventType.sufficiencyObserved,
          flow: sufficient.failed.flow,
          failed: sufficient.failed.label,
          passed: sufficient.passed.label,
          epoch: sufficient.failed.epoch,
          nextFrame: state.frame + 1
        })
      )
    }
    const held = sufficient === undefined ? [] : [ModelRequest.Message.user(Sufficiency.observation(sufficient))]
    const trailing = [
      ...drained.inserts,
      ...alerts,
      ...demand,
      ...repeated,
      ...held
    ]
    // The frame's own pair, appended. The append is what keeps the provider's
    // prefix cache covering everything below the last frame — a transcript the
    // cell replaced broke the prefix on every turn, and one graded wave recorded
    // zero cached input tokens on an instance where an earlier wave had 5,142.
    const context = appended(
      contextWindow,
      answer.message,
      [ModelRequest.Message.user(printed), ...trailing],
      liveCellEcho
    )
    return continuing({
      seat,
      modelParams,
      contextWindowTokens,
      contextWindow: windowOn(state, seat, context),
      readOnlyFrames,
      readOnlyGrace,
      repeatFrames: repeatDemanded ? 0 : repeatFrames,
      ...(sufficient === undefined ? {} : { sufficiencyStated: true }),
      pendingReadOnlyDemand: demanded && !justified ? { streak: readOnlyFrames, cap } : undefined
    })
  })

/**
 * Runs the cell loop until it completes, parks, or exhausts its budget.
 *
 * Cancellation is fiber interruption: interrupting this stream tears down the
 * sandbox through scope closure and reports one abort, without threading an
 * abort signal anywhere.
 *
 * @category streams
 * @since 0.1.0
 * @slop
 */
export const run = (
  input: Input
): Stream.Stream<
  AgentEvent.AgentEvent,
  HarnessError,
  EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source
> =>
  Stream.callback<
    AgentEvent.AgentEvent,
    HarnessError,
    EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source
  >((queue) => {
    const emit = (event: AgentEvent.AgentEvent): Effect.Effect<void> => Effect.asVoid(Queue.offer(queue, event))
    const loop = Effect.gen(function*() {
      const engine = yield* EngineLike.EngineLike
      const sandbox = yield* Sandbox.Sandbox
      const steering = yield* Steering.Source

      let current = input.state
      let flows = input.flows
      if (current.journalVersion !== journalVersion) {
        return yield* new HarnessError({
          code: "incompatible_journal",
          message: `Controller state predates harness journal format ${journalVersion}; start a new run.`
        })
      }
      // Once, and only on a run's own first frame: a resumed run replays its
      // arming from the journal it already wrote, and a second record would
      // make the gate count runs instead of arming decisions.
      if (current.frame === 0) {
        const limits = Sandbox.withDefaults(sandbox.capabilities, input.limits)
        yield* emit(
          new AgentEvent.DisciplineArmed({
            eventType: eventType.disciplineArmed,
            readOnlyCap: current.readOnlyCap,
            maxFrames: current.maxFrames,
            approvalChannel: current.approvalChannel,
            modelCallMs: current.modelCallMs,
            repeatCap: current.repeatCap,
            narrowingCap: current.narrowingCap,
            unmovedCap: current.unmovedCap,
            unresolvedCap: current.unresolvedCap,
            revalidations: current.revalidations,
            ...limits
          })
        )
      }
      // The run's realm: an `acquireRelease` on this loop's scope rather than
      // on one evaluation, so teardown is still scope closure and cancellation
      // is still fiber interruption. A resumed run rebuilds it by re-executing
      // its own cells from the top — every `ctx.call` replays from its recorded
      // boundary, so the realm that comes out is the realm that was lost,
      // without anything having been serialized.
      //
      // Opened after the arming is journaled, so a run whose realm cannot be
      // built still has its armed budgets on the record. A failure that leaves
      // no record of what was asked for is a failure a grader cannot read.
      const realm = yield* Effect.suspend(() => {
        const projections: Record<string, Cell.FlowProjection> = {}
        for (const descriptor of input.flows) projections[descriptor.name] = Cell.project(descriptor)
        return sandbox.openRealm === undefined
          ? Effect.fail(Sandbox.realmUnsupported)
          : sandbox.openRealm({ flows: projections, limits: input.limits })
      }).pipe(
        Effect.mapError((cause) =>
          new HarnessError({
            code: "engine_failed",
            message: "The run's persistent realm could not be opened",
            cause
          })
        )
      )

      for (;;) {
        if (current.maxFrames > 0 && current.frame >= current.maxFrames) {
          yield* emit(
            new AgentEvent.Resolved({
              eventType: eventType.resolved,
              message: ModelRequest.Message.assistant(budgetMessage(current), { stopReason: "stop" })
            })
          )
          return
        }
        if (input.refreshFlows !== undefined) {
          const refreshed = yield* engine.record({
            name: "flow-catalog",
            identity: { session: current.session, frame: current.frame, boundary: "flow-catalog" },
            success: Schema.Array(Descriptor.FlowDescriptor),
            execute: input.refreshFlows
          })
          // Replace only the teaching we supplied, preserving the host's
          // prefix and the accumulated transcript. Rebuild before compaction
          // so token accounting and the sealed request use this snapshot too.
          const previous = teach(ContextWindow.empty(current.contextWindow.modelId), flows)
          const digests = new Set(previous.segments.map((segment) => segment.digest))
          current = advance(current, {
            contextWindow: teach(
              ContextWindow.make({
                ...current.contextWindow,
                segments: current.contextWindow.segments.filter((segment) => !digests.has(segment.digest))
              }),
              refreshed
            )
          })
          flows = refreshed
        }
        const step = yield* frame({ ...input, state: current, flows }, engine, sandbox, realm, steering, emit).pipe(
          Effect.catch((error) => {
            const request = permissionRequired(error)
            if (request === undefined) {
              return Effect.fail(
                error instanceof HarnessError ? error : new HarnessError({
                  code: error instanceof Sandbox.SandboxError ? "engine_failed" : "model_failed",
                  message: "The cell frame failed",
                  cause: error
                })
              )
            }
            return Effect.gen(function*() {
              yield* emit(
                new AgentEvent.PermissionRequired({
                  eventType: eventType.permissionRequired,
                  request
                })
              )
              yield* emit(
                new AgentEvent.TurnClosed({
                  eventType: eventType.turnClosed,
                  stopReason: "error",
                  outcome: "suspended"
                })
              )
              return {
                _tag: "Suspend",
                reason: new EngineLike.SuspendReason({
                  code: "permission-required",
                  message: `Permission ${request.requestId} is required`,
                  // Encoded, not attached: `request` is a class that extends
                  // `Error`, and this reason is journaled inside
                  // `AgentEvent.Suspended`. A live Error there has no JSON form,
                  // so encoding it dies with a schema failure that replaces the
                  // park it was carrying.
                  details: encodePermissionRequired(request)
                })
              } satisfies Step
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              yield* emit(new AgentEvent.Aborted({ eventType: eventType.aborted, reason: "Cell frame interrupted" }))
              yield* emit(
                new AgentEvent.TurnClosed({
                  eventType: eventType.turnClosed,
                  stopReason: "aborted",
                  outcome: "aborted"
                })
              )
            })
          )
        )
        if (step._tag === "Done") return
        if (step._tag === "Suspend") {
          yield* emit(new AgentEvent.Suspended({ eventType: eventType.suspended, reason: step.reason }))
          return yield* engine.suspend(step.reason)
        }
        current = step.state
      }
    })
    // The queue, not the callback's error channel, terminates the stream, so
    // every event already offered stays observable ahead of whatever ended the
    // run. An interruption is forwarded rather than swallowed: a durable park
    // arrives as one, and turning it into a clean end would report a suspended
    // run as a finished one.
    return Effect.onExit(Effect.scoped(loop), (exit) =>
      Effect.asVoid(
        exit._tag === "Success" ? Queue.end(queue) : Queue.failCause(queue, exit.cause)
      ))
  })
