/**
 * The decisions one controller frame takes from what it measured.
 *
 * `CellTurn` seals a model step and runs a cell, and both need a model, a
 * sandbox and an engine. What the frame decides from the result needs none of
 * them: what it did to the run's ledgers, whether a completion is handed back,
 * and which interventions the next frame is handed are functions of the state
 * the frame opened on and the facts it measured. Each phase here returns a
 * value, events included, instead of writing a variable a later exit reads, so
 * each one is read and tested without running a frame.
 *
 * @since 1.0.0-rc.0
 * @private
 */
import { ModelRequest } from "@smthrs/model"
import { Option, type Schema } from "effect"
import * as AgentEvent from "../AgentEvent.ts"
import * as CallLedger from "../CallLedger.ts"
import type { State } from "../CellTurn.ts"
import type * as ContextWindow from "../ContextWindow.ts"
import type * as EngineLike from "../EngineLike.ts"
import * as NarrowedCheck from "../NarrowedCheck.ts"
import * as Sufficiency from "../Sufficiency.ts"
import * as TruncatedOutput from "../TruncatedOutput.ts"
import * as UnmovedTree from "../UnmovedTree.ts"
import * as UnresolvedFailure from "../UnresolvedFailure.ts"
import * as VariablesPanel from "../VariablesPanel.ts"
import * as DemandText from "./demandText.ts"

/** The one journal-event-type table; see `AgentEvent.eventType`. */
const eventType = AgentEvent.eventType

/**
 * The fields of controller state one step changes; everything else is carried.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type StateChanges = Partial<ConstructorParameters<typeof State>[0]>

/**
 * Whether the frame budget leaves a frame after this one.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const hasNextFrame = (state: State): boolean => state.maxFrames === 0 || state.frame + 1 < state.maxFrames

/**
 * One call a cell made this frame, as the frame's accounting reads it.
 *
 * Every call the frame settles is remembered so a raise can hand the model its
 * partial work. Without this, one uncaught throw discarded the frame's reads
 * and the next cell re-did them — often raising the same way again. Prime
 * Agent's tool errors return stdout-so-far plus the traceback for exactly this
 * reason.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface ObservedCall {
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
   * What this invocation asked for, as `CellTurn`'s `signatureOf` names it,
   * with the tree it asked about folded in.
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
}

/**
 * States, unambiguously, that a call this frame failed about itself.
 *
 * The whole defect this closes is that `exitCode: 1` reads the same whether the
 * bug reproduced or the command named a test that does not exist. The flow that
 * ran the command is the only party that can tell, so it says so in its result;
 * this turns that into a sentence the next frame cannot summarise away.
 */
const invalidProbeNotice = (calls: ReadonlyArray<ObservedCall>): string | undefined => {
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
 * The frame's own record of what it did to the world, computed once and
 * carried out through every exit that continues the run.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Accounting {
  /** Whether the frame changed the workspace, by declaration or by measurement. */
  readonly mutated: boolean
  /** The journal's record of how that answer was reached. */
  readonly observed: AgentEvent.MutationObserved
  /**
   * The digest the frame closed on, when its closing measurement covered the
   * tree; empty otherwise, which makes every demand that reads it inert.
   */
  readonly workspaceDigest: string
  /** This frame's readings of the live tree, in the order they settled. */
  readonly frameChecks: ReadonlyArray<NarrowedCheck.Check>
  /** The frame's own broken probes, stated once for whichever exit it takes. */
  readonly probeNotice: string | undefined
  /**
   * Every state field the frame's measurements settle.
   *
   * A continuing exit states only what it changes on top of these, so a field
   * measured here is carried whichever exit the frame leaves by. The read-only
   * streak is one of them: when each exit passed it by hand, the frame's
   * accounting was only as complete as the exit that remembered to.
   */
  readonly facts:
    & StateChanges
    & Required<Pick<StateChanges, "readOnlyFrames" | "repeatFrames" | "checks" | "failures" | "mutations">>
    & Required<Pick<StateChanges, "openingDigest">>
}

/**
 * What one frame that ran a cell did to the run's ledgers.
 *
 * Read off the calls the cell made and the two workspace measurements either
 * side of them, and nothing else: no model, sandbox or engine is consulted, so
 * a replayed frame accounts exactly as its original attempt did.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const account = (options: {
  /** The state the frame opened on. */
  readonly state: State
  /** Every call the cell made, in the order they settled. */
  readonly calls: ReadonlyArray<ObservedCall>
  /** The workspace before the frame's calls. */
  readonly opened: Option.Option<EngineLike.Observation>
  /** The workspace after them. */
  readonly closed: Option.Option<EngineLike.Observation>
  /** Ids of the trees the frame pinned, oldest first. */
  readonly minted: ReadonlyArray<string>
  /** What the realm holds after the frame, for the variables panel. */
  readonly bindings: ReadonlyArray<VariablesPanel.Binding>
  /** Output the run has been handed as a fragment, this frame's included. */
  readonly captures: ReadonlyArray<TruncatedOutput.Capture>
}): Accounting => {
  const { calls, closed, opened, state } = options

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
  const declaredWrites = calls.filter((call) => call.mutates).length
  const measured = Option.isSome(opened) && Option.isSome(closed)
  const covered = measured && opened.value.complete && closed.value.complete
  const standingWrites = calls.filter((call) => call.mutates && (call.ok || !covered)).length
  const mutated = standingWrites > 0 || (covered && opened.value.digest !== closed.value.digest)
  const closingDigest = Option.match(closed, { onNone: () => "", onSome: (value) => value.digest })

  // The frame's own repetition, measured the same way and carried the same
  // way: a frame repeats when it issued calls, issued none this run had not
  // already issued, and changed nothing. A signature the ledger has
  // forgotten reads as new, which delays a demand and never fabricates one.
  const signatures = calls.map((call) => call.signature)
  const asked = new Set(state.callSignatures)
  const novel = signatures.some((signature) => !asked.has(signature))
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
    calls.flatMap((call) => {
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

  return {
    mutated,
    observed: new AgentEvent.MutationObserved({
      eventType: eventType.mutationObserved,
      basis: covered ? "observed" : measured ? "partial" : "declared",
      mutated,
      digest: closingDigest,
      paths: Option.match(closed, { onNone: () => 0, onSome: (value) => value.paths }),
      declaredWrites
    }),
    workspaceDigest,
    frameChecks,
    probeNotice: invalidProbeNotice(calls),
    facts: {
      // Seeded from what earlier frames were handed and appended to as this
      // frame's calls settled.
      truncatedOutputs: TruncatedOutput.retain(options.captures),
      workspace: closed,
      // A frame is read-only when it changed nothing; see
      // `State.readOnlyFrames` for why that is measured and not declared.
      readOnlyFrames: mutated ? 0 : state.readOnlyFrames + 1,
      repeatFrames,
      callSignatures: remember(state.callSignatures, signatures),
      // Ids this frame pinned: a checkpoint a frame minted before it raised is
      // still a tree the run holds, and forgetting it would leak a stored tree
      // nothing can name.
      checkpointIds: options.minted.length === 0 ? state.checkpointIds : [...state.checkpointIds, ...options.minted],
      // Live readings only. Every consumer of this ledger — the narrowing
      // demand, the unresolved-failure demand, the vacuous-verification notice
      // — asks whether the tree the run is completing on was checked, and a
      // checkpointed reading is not a reading of that tree.
      checks: NarrowedCheck.remember(state.checks, frameChecks),
      // What this frame asked, folded into what the run had already asked. A
      // raise carries it too: a call that settled before the throw is work
      // the run paid for, and the ledger is the only place the next model turn
      // can read it.
      callLedger: CallLedger.remember(state.callLedger, calls),
      // Which of this frame's checks failed before any change did, and how
      // many frames have changed the workspace. Both, because this is the one
      // ledger a checkpointed reading belongs in: its whole question is an
      // ordering — this failed, then something changed, then that passed — and
      // a pinned tree answers the first half honestly from a frame that also
      // did the changing.
      failures: Sufficiency.remember(state.failures, {
        frame: [...readings(true), ...frameChecks],
        epoch: state.mutations
      }),
      mutations: state.mutations + (mutated ? 1 : 0),
      // The tree the run was handed, fixed the first time a frame measured one
      // and never restamped. See `State.openingDigest`.
      openingDigest: state.openingDigest !== ""
        ? state.openingDigest
        : Option.match(opened, {
          onNone: () => "",
          onSome: (value) => value.complete ? value.digest : ""
        }),
      // The panel the next frame opens with, stamped by the frame that ran.
      panel: VariablesPanel.stamp(state.panel, options.bindings, state.frame),
      ...(mutated ? { readOnlyGrace: 0, pendingReadOnlyDemand: undefined } : {})
    }
  }
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

/**
 * One completion handed back, and what handing it back costs.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface CompletionDemand {
  /** The control event that names the demand in the journal. */
  readonly event:
    | AgentEvent.UnmovedDemanded
    | AgentEvent.UnresolvedDemanded
    | AgentEvent.NarrowedDemanded
    | AgentEvent.NarrowOnlyDemanded
  /** The in-frame observation the next frame answers. */
  readonly note: string
  /** The cap the demand spends. */
  readonly spent: StateChanges
}

/**
 * Whether a `complete` transition stands, or which demand hands it back.
 *
 * The completion's own evidence, judged once per demand. A run gets exactly
 * one frame wrong for free — the last one — and four things can be wrong with
 * it, each read off measurements the controller already took, under three
 * caps:
 *
 * 1. `UnmovedTree`: the tree it is completing on is the tree it opened on, so
 *    there is no change for any evidence to be about;
 * 2. `UnresolvedFailure`: a check over this exact tree reported a failing exit
 *    status and the run answered it with a different reading of the same
 *    subject rather than with the check itself;
 * 3. `NarrowedCheck.find`: this frame's check repeats an earlier, broader one
 *    and adds conditions to it, run after a change the broader one never saw;
 * 4. `NarrowedCheck.findOnly`: the check this frame ended on is the run's only
 *    reading of what it names — nothing broader was ever taken, so there was
 *    no broader check for (3) to find — and it carries a condition the run
 *    itself added, one taught neither by the prefix this harness wrote nor by
 *    the run's own other checks.
 *
 * The last two share one cap. They are two readings of one question — whether
 * the evidence covers what it looks like it covers — and a run that answers
 * either has answered the question; a second bounce would be the loop asking it
 * twice in different words.
 *
 * At most one is named, in that order, because they are in descending order of
 * how fundamental the missing thing is: there is nothing to check, then the
 * check said no, then the check said less than it looks like it said. Naming
 * two at once would ask the run to answer a question it has not been given a
 * frame for.
 *
 * The loop names what is missing and hands the frame back; it does not re-run
 * anything, and it does not judge the answer that comes back.
 *
 * Asking costs the run a frame it can answer in, so a demand is issued only
 * where that frame exists, and three separate things take it away:
 *
 * - the frame budget, which has no frame left to spend, and turning a
 *   completion into an exhausted budget would lose the run's answer to make a
 *   point about it;
 * - the read-only cap, which is the other budget that ends a run and ends it as
 *   a typed failure carrying nothing. A run that changed nothing is exactly the
 *   run `UnmovedTree` fires on, so a completion one frame short of twice the
 *   cap would be bounced, spend that frame reading, and die as `read_only_cap`
 *   with the answer it had already written discarded — a demand turning a
 *   finished run into a failure, which is the one outcome none of these may
 *   produce;
 * - a demand this run has already answered. Each demand ends by promising that
 *   what comes back next is the answer that stands, and three of them fire on
 *   one transition, so the frame written to answer one is never judged by the
 *   next. See `State.demandedFrame`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const judgeCompletion = (
  state: State,
  accounting: Accounting,
  contextWindow: ContextWindow.ContextWindow
): CompletionDemand | undefined => {
  const { facts, frameChecks, workspaceDigest } = accounting
  const room = hasNextFrame(state) &&
    (state.readOnlyCap === 0 || facts.readOnlyFrames + 1 < state.readOnlyCap * 2) &&
    state.demandedFrame !== state.frame
  if (!room) return undefined
  const nextFrame = state.frame + 1
  if (state.unmovedDemands < state.unmovedCap) {
    const unmoved = UnmovedTree.find({ opened: facts.openingDigest, digest: workspaceDigest })
    if (unmoved !== undefined) {
      return {
        event: new AgentEvent.UnmovedDemanded({
          eventType: eventType.unmovedDemanded,
          openedDigest: unmoved.opened,
          currentDigest: unmoved.closed,
          nextFrame
        }),
        note: UnmovedTree.demand(unmoved),
        spent: { unmovedDemands: state.unmovedDemands + 1 }
      }
    }
  }
  if (state.unresolvedDemands < state.unresolvedCap) {
    const unresolved = UnresolvedFailure.find({ ledger: facts.checks, digest: workspaceDigest })
    if (unresolved !== undefined) {
      return {
        event: new AgentEvent.UnresolvedDemanded({
          eventType: eventType.unresolvedDemanded,
          flow: unresolved.failed.flow,
          failed: unresolved.failed.label,
          instead: unresolved.instead.label,
          currentDigest: workspaceDigest,
          nextFrame
        }),
        note: UnresolvedFailure.demand(unresolved),
        spent: { unresolvedDemands: state.unresolvedDemands + 1 }
      }
    }
  }
  if (state.narrowingDemands >= state.narrowingCap) return undefined
  const spent = { narrowingDemands: state.narrowingDemands + 1 }
  const narrowing = NarrowedCheck.find({ ledger: state.checks, frame: frameChecks, digest: workspaceDigest })
  if (narrowing !== undefined) {
    return {
      event: new AgentEvent.NarrowedDemanded({
        eventType: eventType.narrowedDemanded,
        flow: narrowing.earlier.flow,
        broader: narrowing.earlier.label,
        narrower: narrowing.later.label,
        broaderDigest: narrowing.earlier.digest,
        currentDigest: workspaceDigest,
        nextFrame
      }),
      note: NarrowedCheck.demand(narrowing),
      spent
    }
  }
  const only = NarrowedCheck.findOnly({
    ledger: facts.checks,
    before: state.checks.map((entry) => entry.signature),
    frame: frameChecks,
    taught: taughtTerms(contextWindow)
  })
  if (only === undefined) return undefined
  return {
    event: new AgentEvent.NarrowOnlyDemanded({
      eventType: eventType.narrowOnlyDemanded,
      flow: only.later.flow,
      check: only.later.label,
      targets: only.targets,
      currentDigest: workspaceDigest,
      nextFrame
    }),
    note: NarrowedCheck.demandOnly(only),
    spent
  }
}

/**
 * The interventions one ordinary continuing frame hands to the next.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Discipline {
  /** The control events that issue them, in journal order. */
  readonly events: ReadonlyArray<AgentEvent.AgentEvent>
  /** The messages the next frame reads after the steering it was sent. */
  readonly messages: ReadonlyArray<ModelRequest.Message>
  /** What issuing them changes on top of the frame's facts. */
  readonly changes: StateChanges
}

/**
 * The read-only, repeat and sufficiency interventions for a frame that settled
 * a `continue` transition and has a frame after it.
 *
 * The read-only intervention. At the cap the next frame is told, structurally,
 * that it must write something or say why it cannot; a justification is typed
 * data on the transition, is recorded, and buys a bounded quiet spell without
 * resetting the counter that ends the run at twice the cap.
 *
 * A justification buys that spell only when it *answers* a demand this frame
 * was handed. A justification volunteered by a frame nobody asked is recorded —
 * it is a field on the transition and the journal writes the whole transition —
 * and buys nothing. The two cannot be the same price, because the counter runs
 * regardless of which one is written: a run that volunteers one every few
 * frames used to renew the quiet spell before the streak could ever hand the
 * demand out, so the demand was never issued, never journaled, and never got
 * its one chance to redirect the run, while the hard stop at twice the cap —
 * which no grace touches — killed the run anyway. Two SWE-bench waves lost
 * `pydata__xarray-7393` exactly so: ten volunteered justifications, zero
 * `read-only-demanded` events, and death at 24 frames against a cap of 12
 * without the control ever speaking.
 *
 * The convergence intervention. It is journaled when it is *issued* rather than
 * when the next frame answers it, because what answers it is the shape of that
 * frame's calls — which the journal already writes one by one — and not a
 * field on a transition the controller has to wait for. Issuing it restarts the
 * count, so a run that keeps repeating is told once every `repeatCap` frames
 * instead of every frame.
 *
 * The counterweight, and the only notice here that asks for nothing. It is
 * written on the frame that completes the pair rather than at a completion,
 * because its whole purpose is to reach a run that is still deciding whether to
 * keep working — a run at its `complete` transition has already decided. See
 * `Sufficiency`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const discipline = (
  state: State,
  accounting: Accounting,
  justification: string | undefined
): Discipline => {
  const { facts } = accounting
  const cap = state.readOnlyCap
  const readOnly = !accounting.mutated
  const graceLeft = readOnly ? state.readOnlyGrace : 0
  const justified = readOnly && state.pendingReadOnlyDemand !== undefined &&
    (justification ?? "").trim().length > 0
  const demanded = cap > 0 && readOnly && facts.readOnlyFrames >= cap && graceLeft === 0 && !justified
  const repeated = state.repeatCap > 0 && facts.repeatFrames >= state.repeatCap
  const sufficient = state.sufficiencyStated
    ? undefined
    : Sufficiency.find({ ledger: facts.failures, frame: accounting.frameChecks, epoch: facts.mutations })
  const nextFrame = state.frame + 1
  return {
    events: [
      ...(demanded
        ? [
          new AgentEvent.ReadOnlyDemandIssued({
            eventType: eventType.readOnlyDemandIssued,
            streak: facts.readOnlyFrames,
            cap,
            nextFrame
          })
        ]
        : []),
      ...(repeated
        ? [
          new AgentEvent.RepeatDemanded({
            eventType: eventType.repeatDemanded,
            frames: facts.repeatFrames,
            cap: state.repeatCap,
            nextFrame
          })
        ]
        : []),
      ...(sufficient === undefined ? [] : [
        new AgentEvent.SufficiencyObserved({
          eventType: eventType.sufficiencyObserved,
          flow: sufficient.failed.flow,
          failed: sufficient.failed.label,
          passed: sufficient.passed.label,
          epoch: sufficient.failed.epoch,
          nextFrame
        })
      ])
    ],
    messages: [
      ...(accounting.probeNotice === undefined ? [] : [ModelRequest.Message.user(accounting.probeNotice)]),
      ...(demanded ? [ModelRequest.Message.user(DemandText.readOnly(cap, facts.readOnlyFrames))] : []),
      ...(repeated ? [ModelRequest.Message.user(DemandText.repeat(facts.repeatFrames, state.repeatCap))] : []),
      ...(sufficient === undefined ? [] : [ModelRequest.Message.user(Sufficiency.observation(sufficient))])
    ],
    changes: {
      readOnlyGrace: justified ? cap : Math.max(0, graceLeft - 1),
      repeatFrames: repeated ? 0 : facts.repeatFrames,
      ...(sufficient === undefined ? {} : { sufficiencyStated: true }),
      pendingReadOnlyDemand: demanded ? { streak: facts.readOnlyFrames, cap } : undefined
    }
  }
}
