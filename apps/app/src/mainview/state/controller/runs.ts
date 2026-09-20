/*
 * Lane runs — the run lifecycle beyond launch and cancel.
 *
 * `flow.run` launches a run and its card tracks it; this controller is
 * everything an operator does with a run after that: the inbox of every run
 * on the workspace (runs.list), opening one as a card (runs.open), the
 * lifecycle acts (resume, rerun, signal, the steer family), the facets a run
 * card grows (transcript with follow, the verbose events tab), stopping them
 * all, the trace's reader gestures (runs.trace.filter / runs.trace.select,
 * factory spec 06 §6), and the workspace approvals inbox (approvals.list /
 * approvals.open).
 *
 * Every read is a projection and every act a control procedure over the one
 * gateway seam (gateway.ts); nothing here invents a wire. What the wire does
 * not carry, the flows refuse honestly: `by=` names a launcher the run
 * summary does not record, so runs.list says that instead of silently
 * dropping the filter.
 */
import { LiveTutorialRunSchema } from "@smthrs/rpc/LiveTutorial"
import { questionOf } from "../../cards/ApprovalQuestion"
import { codingPlanOf } from "../../cards/CodingPlan"
import { runHandoff } from "../../cards/RunHandoff"
import type { TraceFilter } from "../../cards/RunTrace"
import { traceFromJournal } from "../../cards/RunTrace"
import type { CommandResult } from "../../flows/Flows"
import { framePath } from "../../runtime/FrameHistory"
import { actorSharedState } from "../ActorBindings"
import type { ApprovalsInboxRequest, Card } from "../AppState"
import { pendingWorkflowLaunch, workflowInputOf } from "../WorkflowLaunch"
import { sameApproval } from "../ApprovalReference"
import { liveTutorialTranscript } from "../LiveTutorialTranscript"
import { gatewayBindingFor,gatewayRunContextFor } from "../RepoContext"
import { approvalCardIdFor,cardContainsRun,runCardInScope,runScopeFromCard,sameRunScope,type RunScope } from "../RunReference"
import { isPracticeRepo,practiceTranscript } from "../practice/PracticeRepository"
import { reconcileRunApprovals } from "./approval-reconciliation"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"
import type { FormsController } from "./forms"
import type { ApprovalRow, RunSummaryRow } from "./gateway"
import type { WorkflowController } from "./workflows"

/**
 * Which of the run card's three views is showing.
 *
 * The wire is the authority: `RunTrace.ts` folds turns and the timeline and
 * knows nothing about the graph, which is a separate fold over the same
 * journal (FlowGraphStatus.ts).
 */
export type TraceView = NonNullable<Extract<Card, { kind: "run-trace" }>["payload"]["traceView"]>

export interface RunsController {
  readonly prepareRunHandoff: (runId: string, sourceCard?: string) => CommandResult
  readonly listRuns: (args: {
    readonly status?: string
    readonly flow?: string
    readonly lineage?: string
    readonly sourceCard?: string
    readonly by?: string
    readonly repo?: string
  }) => Promise<CommandResult>
  readonly openRun: (runId: string, repo?: string, sourceCard?: string) => Promise<CommandResult>
  readonly resumeRun: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly rerunRun: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly signalRun: (runId: string, name: string, payload?: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRun: (runId: string, body: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRunSeat: (runId: string, seat: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRunThinking: (runId: string, thinking: string, sourceCard?: string) => Promise<CommandResult>
  readonly steerRunTools: (runId: string, toolNames: string, sourceCard?: string) => Promise<CommandResult>
  readonly showRunLogs: (runId: string, follow?: boolean, sourceCard?: string) => Promise<CommandResult>
  readonly showRunSteps: (runId: string, sourceCard?: string) => CommandResult
  readonly showRunEvents: (runId: string, sourceCard?: string) => Promise<CommandResult>
  /*
   * Where the reader parked is durable state, so each of these gestures answers
   * only once its card write is. A gesture that answered first lost the write
   * to a reload issued straight after it: a production keyboard walk pressed
   * Latest, reloaded, and found the card still parked at its cursor.
   */
  /** `runs.trace.filter <runId> <filter>`: the trace's active filter, in the card payload (spec 06 §5, §6). */
  readonly traceFilter: (runId: string, filter: TraceFilter, sourceCard?: string) => Promise<CommandResult>
  /** `runs.trace.select <runId> <nodeId> [seq]`: the trace's selection and scrub cursor; leaves live tail. */
  readonly traceSelect: (runId: string, nodeId: string, seq?: number, sourceCard?: string) => Promise<CommandResult>
  readonly traceView: (runId: string, view: TraceView, sourceCard?: string) => Promise<CommandResult>
  /** `runs.graph.follow <runId> <on|off>`: whether the graph's camera follows the running node. */
  readonly graphFollow: (runId: string, follow: boolean, sourceCard?: string) => CommandResult
  readonly traceLive: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly selectCodingChange: (runId: string, changeId: string, sourceCard?: string) => CommandResult
  readonly stopAllRuns: (repo?: string, sourceCard?: string) => Promise<CommandResult>
  /**
   * `approvals.list [owner/repo]`: persist the read request for the target
   * named NOW, acknowledge, and read the workspace inbox in the background
   * (root AGENTS "Instant chat; slow work runs in the background").
   */
  readonly listApprovals: (repo?: string) => Promise<CommandResult>
  /** Reconnect every persisted inbox read the current account still owns; idempotent. */
  readonly resumeApprovalRequests: () => void
  readonly openApproval: (runId: string, sourceCard?: string) => Promise<CommandResult>
}

/** Why a run is not moving, in one word the card can render. */
const waitingWord = (row: RunSummaryRow): string | undefined =>
  row.status === "accepted"
    // The CLI's own render-time convention: accepted means nothing is driving it yet.
    ? "executor"
    : row.status === "parked"
    ? row.waitingReason ?? "parked"
    : undefined

export const createRunsController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  workflows: WorkflowController,
  renderFlowForm?: FormsController["renderFlowForm"]
): RunsController => {
  const { store, gateway } = ctx

  const runCardFor = (scope: RunScope) => runCardInScope(store, scope)
  const prepareRunHandoff: RunsController["prepareRunHandoff"] = (runId, sourceCard) => {
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = source?.kind === "run-trace" ? source : runCardFor(target)
    if (card === undefined) return "Open this run's card before preparing its handoff."
    const cardId = `handoff-${card.id}`
    const existing = store.collections.cards.get(cardId)
    if (existing?.kind === "flow-form" && existing.status !== "acted") return { value: "The editable handoff is already open; your draft is preserved." }
    const frame = [...store.collections.frames.values()].find(frame => frame.cardId === card.id)
    const origin = ctx.baseUrl || (typeof location === "undefined" ? "" : location.origin)
    const sourceHref = frame === undefined ? undefined : `${origin}${framePath({ workspaceId: frame.workspaceId, branchId: frame.branchId, frameId: frame.id })}`
    const rendered = renderFlowForm?.({
      name: "chat.copy-message", args: runHandoff(card, sourceHref), via: "user", cardId, title: `Handoff — ${card.title}`,
      hints: { fields: { text: { kind: "textarea", label: "Handoff brief" } }, submitLabel: "Copy brief" }
    })
    return rendered === undefined ? "The handoff form could not be rendered." : { value: "Prepared an editable handoff brief. Review the recorded evidence, fill in remaining work, then copy it." }
  }
  const patchRunCard = (scope: RunScope, patch: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>): void => {
    const card = runCardFor(scope)
    if (card === undefined) return
    store.dispatch({ type: "card.updated", actor: "system", id: card.id, patch: { payload: { ...card.payload, ...patch } } })
  }
  const pokeRun = (scope: RunScope): void => {
    const card = runCardFor(scope)
    if (card !== undefined) ctx.pumpPokes.get(card.id)?.()
  }

  /** Capture the address once, before any await. An explicit source must actually contain this run. */
  const resolveRun = (runId: string, sourceCard?: string, preferred?: string, allowChild = false): RunScope | { readonly error: string } => {
    if (sourceCard !== undefined) {
      const source = store.collections.cards.get(sourceCard)
      if (source === undefined || !cardContainsRun(source, runId, allowChild)) {
        return { error: `Card ${sourceCard} does not record run ${runId}.` }
      }
      const scope = runScopeFromCard(store, source, runId)
      if (scope === undefined || (preferred !== undefined && preferred !== scope.repo)) {
        return { error: "The source card belongs to another repository or has no recorded gateway." }
      }
      return scope
    }
    const recorded = gatewayRunContextFor(store, runId)
    if (recorded !== undefined) {
      if ("error" in recorded) return recorded
      if (preferred !== undefined && preferred !== recorded.repo) return { error: "The run belongs to another repository." }
      return { ...recorded, runId }
    }
    const target = workflows.workflowTargetRepo(preferred)
    if ("error" in target) return target
    const binding = gatewayBindingFor(store, target.repo)
    return "error" in binding ? binding : { repo: target.repo, runId, ...binding }
  }

  const listRuns = async (args: {
    readonly status?: string
    readonly flow?: string
    readonly lineage?: string
    readonly sourceCard?: string
    readonly by?: string
    readonly repo?: string
  }): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    /*
     * The wire's run summary carries no launcher principal, and Control.list
     * refuses the filter — so a by= the app silently dropped would list runs
     * the human asked to exclude. Refuse in words instead.
     */
    if (args.by !== undefined) {
      return "Runs don't record who launched them on this wire, so there is no by= to filter with — status, flow, and lineage are the filters that exist."
    }
    const target = workflows.workflowTargetRepo(args.repo)
    if ("error" in target) return target.error
    const repo = target.repo
    const source = args.sourceCard === undefined ? undefined : store.collections.cards.get(args.sourceCard)
    if (args.sourceCard !== undefined && (source?.kind !== "run-list" || source.payload.repo !== repo)) {
      return "The run list is unavailable or belongs to another repository."
    }
    let binding = source?.kind === "run-list"
      ? (source.payload.workspaceId === undefined ? {} : { workspaceId: source.payload.workspaceId })
      : gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    if (source?.kind === "run-list" && source.payload.workspaceId === undefined && source.payload.gatewayBindingVersion === undefined) {
      const scopes = source.payload.runs.map((run) => runScopeFromCard(store, source, run.runId)!)
      if (scopes.some((scope) => scope.workspaceId !== scopes[0]?.workspaceId)) {
        return "The historical run list records several gateways. Open a run from its own recorded card before listing that workspace."
      }
      binding = { workspaceId: scopes[0]?.workspaceId }
    }
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const attention = args.status === "attention"
    const [listed, inbox] = await Promise.all([
      gateway.workspaceRuns(repo, binding),
      attention ? gateway.approvalsInbox(repo, binding) : undefined
    ])
    if (listed.status !== "ok" && !attention) return listed.message
    const observed = listed.status === "ok" ? listed.value : []
    for (const summary of observed) await store.dispatch({ type: "gateway.run.observed", actor: "system",
      observation: { scope: { repo, ...binding, runId: summary.runId }, summary } }).isPersisted.promise
    if (inbox?.status === "ok") for (const runId of new Set(inbox.value.map(row => row.runId))) {
      await reconcileRunApprovals(store, { repo, ...binding, runId }, inbox.value.filter(row => row.runId === runId))
    }
    const pending = inbox?.status === "ok" ? inbox.value.filter(row => row.status === "pending") : []
    const errors = [listed.status === "error" ? listed.message : undefined, inbox?.status === "error" ? inbox.message : undefined]
      .filter((error): error is string => error !== undefined)
    const rows = observed
      .filter((row) =>
        (args.status === undefined || (attention ? ["parked", "failed", "waiting-approval"].includes(row.status) : row.status === args.status)) &&
        (args.flow === undefined || row.flowId === args.flow) &&
        (args.lineage === undefined || row.lineageId === args.lineage)
      )
      .sort((left, right) => right.createdAt - left.createdAt)
    const cardId = source?.kind === "run-list" ? source.id : `run-list-${repo}${binding.workspaceId === undefined ? "" : `-${binding.workspaceId}`}`
    const existing = store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "run-list",
      title: `${attention ? "Needs attention" : "Runs"} — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo, ...binding, gatewayBindingVersion: 1,
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.flow === undefined ? {} : { flow: args.flow }),
        ...(args.lineage === undefined ? {} : { lineage: args.lineage }),
        ...(attention ? { approvals: pending.map(({ runId, requestId, title }) => ({ runId, requestId, title })) } : {}),
        observedAt: Date.now(),
        ...(errors.length === 0 ? {} : { observationError: errors.join(" · ") }),
        // Every status the UNFILTERED workspace carries, so the filter chips (and "All") survive a single-status filter.
        statuses: [...new Set(observed.map((row) => row.status))].sort(),
        runs: rows.map((row) => ({
          runId: row.runId,
          flowId: row.flowId,
          status: row.status,
          ...(row.statusRollup?.subjectId === `run:${row.runId}` && row.statusRollup.state === row.status ? { statusRollup: row.statusRollup } : {}),
          ...(waitingWord(row) === undefined ? {} : { waiting: waitingWord(row) }),
          createdAt: row.createdAt,
          turns: row.turns,
          calls: row.calls
        }))
      }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    return {
      value: attention ? `${pending.length} pending approvals and ${rows.length} parked, failed or approval-waiting runs on ${repo}.${errors.length ? ` Some state could not be read: ${errors.join(" · ")}` : ""}` : rows.length === 0
        ? `No runs on ${repo} match.`
        : `${rows.length} run${rows.length === 1 ? "" : "s"} on ${repo}.`
    }
  }

  const openRun = async (runId: string, repoArg?: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard, repoArg, true)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = { workspaceId: target.workspaceId }
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const summary = await gateway.run(repo, runId, binding)
    if (summary.status !== "ok") return summary.message
    if (summary.value === undefined) return `There's no run ${runId} on ${repo}.`
    const row = summary.value
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: target, summary: row, summaryCursor: summary.cursor
    } }).isPersisted.promise
    workflows.upsertRunCard({
      runId,
      repo,
      ...binding,
      workflow: row.flowId,
      title: `${row.flowId} — ${repo}`,
      firstStep: `Watching ${row.flowId} (run ${runId}).`
      /*
       * No `input`: this run was not launched from here, so its launch input
       * is not recorded on this client — `runs.rerun` says so honestly rather
       * than relaunching with a guessed one.
       */
    })
    return { value: `run-opened run=${runId} repo=${repo}` }
  }

  const resumeRun = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    const resumed = await gateway.resume(
      target.repo,
      runId,
      card?.payload.waiting === "executor" ? "Nothing was driving the run." : undefined,
      { workspaceId: target.workspaceId }
    )
    if (resumed.status !== "ok") return resumed.message
    pokeRun(target)
    return { value: `resume-requested run=${runId}` }
  }

  const rerunRun = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) {
      return `Open the run first (runs.open ${runId}) — rerunning needs the card that knows the flow and its launch input.`
    }
    if (card.payload.input === undefined) {
      return `This run's launch input isn't recorded on this client, so there's nothing faithful to rerun — start the flow fresh with flow.run ${card.payload.workflow}.`
    }
    const repo = card.payload.repo
    const binding = { workspaceId: target.workspaceId }
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const launched = await workflows.launchWorkflow({
      repo,
      binding,
      workflow: card.payload.workflow,
      input: workflowInputOf(card)!,
      title: `${card.payload.workflow} — ${repo}`
    })
    if ("message" in launched) return launched.message
    return { value: `run-started workflow=${card.payload.workflow} run=${launched.runId} repo=${repo}` }
  }

  const signalRun = async (runId: string, name: string, payloadText?: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    if (name.trim() === "") return "runs.signal needs the signal's name."
    let payload: unknown = {}
    if (payloadText !== undefined && payloadText.trim() !== "") {
      try {
        payload = JSON.parse(payloadText)
      } catch {
        return `That signal payload isn't JSON: ${payloadText}`
      }
    }
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const signaled = await gateway.signal(target.repo, runId, name.trim(), payload, { workspaceId: target.workspaceId })
    if (signaled.status !== "ok") return signaled.message
    pokeRun(target)
    return { value: `signal-sent run=${runId} signal=${name.trim()}` }
  }

  const steer = async (
    runId: string,
    item:
      | { readonly kind: "Message"; readonly body: string }
      | { readonly kind: "Seat"; readonly seat: string }
      | { readonly kind: "Thinking"; readonly thinking: string }
      | { readonly kind: "Tools"; readonly toolNames: ReadonlyArray<string> },
    sourceCard?: string
  ): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const steered = await gateway.steer(target.repo, runId, item, { workspaceId: target.workspaceId })
    if (steered.status !== "ok") return steered.message
    patchRunCard(target, { steeringPending: true })
    pokeRun(target)
    return { value: `steered run=${runId}` }
  }

  const steerRun = (runId: string, body: string, sourceCard?: string): Promise<CommandResult> =>
    body.trim() === ""
      ? Promise.resolve("runs.steer needs the message to deliver.")
      : steer(runId, { kind: "Message", body }, sourceCard)

  const steerRunSeat = (runId: string, seat: string, sourceCard?: string): Promise<CommandResult> =>
    seat.trim() === ""
      ? Promise.resolve("runs.seat needs the seat to move the run to.")
      : steer(runId, { kind: "Seat", seat: seat.trim() }, sourceCard)

  const steerRunThinking = (runId: string, thinking: string, sourceCard?: string): Promise<CommandResult> =>
    thinking.trim() === ""
      ? Promise.resolve("runs.thinking needs the thinking level.")
      : steer(runId, { kind: "Thinking", thinking: thinking.trim() }, sourceCard)

  const steerRunTools = (runId: string, toolNames: string, sourceCard?: string): Promise<CommandResult> => {
    const names = toolNames.split(",").map((name) => name.trim()).filter((name) => name !== "")
    return names.length === 0
      ? Promise.resolve("runs.tools needs the tool names, comma-separated.")
      : steer(runId, { kind: "Tools", toolNames: names }, sourceCard)
  }

  /**
   * The transcript facet. `--follow` toggles the live merge (the pump keeps
   * the rows current while the run moves); without it the tab is one snapshot
   * of where the transcript stood when asked.
   */
  const showRunLogs = async (runId: string, follow?: boolean, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}) — the transcript lives on its card.`
    if (card.payload.input?.liveTutorial) {
      const snapshot=LiveTutorialRunSchema.safeParse(card.payload.input.liveTutorialSnapshot)
      if(snapshot.success&&snapshot.data.runId!==runId)return "The saved live tutorial snapshot belongs to another run."
      const following=follow===true?card.payload.follow!==true:false
      patchRunCard(target,{facet:"transcript",follow:following,transcriptRows:snapshot.success?liveTutorialTranscript(snapshot.data):[]})
      return {value:following?`following run=${runId}`:`transcript run=${runId}`}
    }
    // The practice run (onboarding SCRIPT v4 §4) has no gateway: its transcript is the bundled journal, and it never follows.
    if (isPracticeRepo(card.payload.repo) && card.payload.input?.practice === true) {
      patchRunCard(target, { facet: "transcript", follow: false, transcriptRows: practiceTranscript() })
      return { value: `transcript run=${runId}` }
    }
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const following = follow === true ? card.payload.follow !== true : false
    const transcript = await gateway.transcript(target.repo, runId, { workspaceId: target.workspaceId })
    if (transcript.status !== "ok") return transcript.message
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: target, transcript: [...transcript.value], transcriptCursor: transcript.cursor
    } }).isPersisted.promise
    patchRunCard(target, {
      facet: "transcript",
      follow: following,
      transcriptAtRevision: following ? undefined : store.session().revision,
      ...(following ? {} : { transcriptRows: transcript.value.map((row) => ({
        sequence: row.sequence,
        ...(row.turn === undefined ? {} : { turn: row.turn }),
        ...(row.at === undefined ? {} : { at: row.at }),
        kind: row.kind,
        text: row.text
      })) })
    })
    if (following) pokeRun(target)
    return { value: following ? `following run=${runId}` : `transcript run=${runId}` }
  }

  /** Back to the default facet; unfollows the transcript if it was following. */
  const showRunSteps = (runId: string, sourceCard?: string): CommandResult => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}).`
    patchRunCard(target, { facet: "steps", follow: false })
    return { value: `steps run=${runId}` }
  }

  /** The raw journal, a debug surface: it exists only where verbose does. */
  const showRunEvents = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    if (store.session().verbose !== true) {
      return "The events tab is the run's raw journal — a debug view. Turn on /debug.verbose first."
    }
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}) — the events live on its card.`
    const events = await gateway.runEvents(target.repo, runId, { workspaceId: target.workspaceId })
    if (events.status !== "ok") return events.message
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: target, journal: { mode: "full", events: [...events.value] }
    } }).isPersisted.promise
    patchRunCard(target, {
      facet: "events"
    })
    return { value: `events run=${runId}` }
  }

  /*
   * The trace's reader gestures (spec 06 §6). Both change the card payload
   * alone (§5: the trace, selection, cursor, filters and live-tail flag live
   * there), so the tree, the waterfall and the pane re-render from one record
   * and no request leaves the browser. The pump keeps the journal current on
   * its own cycle.
   */
  const traceFilter = async (runId: string, filter: TraceFilter, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, filter } }
    }).isPersisted.promise
    return { value: `trace-filter run=${runId} filter=${filter}` }
  }

  const traceSelect = async (runId: string, nodeId: string, seq?: number, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    // The node must be one the journal in hand folds to; a made-up id selects nothing, so say so.
    const { workflow, phase, kind, events } = card.payload
    const latest = (events ?? []).reduce(
      (max, record) => typeof record.sequence === "number" ? Math.max(max, record.sequence) : max,
      0
    )
    const cursorSeq = seq ?? card.payload.cursorSeq ?? latest
    if (!Number.isSafeInteger(cursorSeq) || cursorSeq < 0 || cursorSeq > latest) {
      return `Run ${runId} has no recorded journal sequence ${cursorSeq}.`
    }
    const records = (events ?? []).filter((record) =>
      typeof record.sequence === "number" && record.sequence <= cursorSeq
    )
    const model = traceFromJournal({
      runId,
      flowId: workflow,
      status: cursorSeq < latest ? "running" : phase,
      ...(kind === undefined ? {} : { kind })
    }, records)
    if (!model.rows.some((span) => span.id === nodeId)) return `Run ${runId} has no trace node ${nodeId}.`
    // Persist the embedded inspection.
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, facet: "steps", selection: nodeId, liveTail: false, cursorSeq } }
    }).isPersisted.promise

    return { value: `trace-select run=${runId} node=${nodeId}${seq === undefined ? "" : ` seq=${seq}`}` }
  }

  const selectCodingChange = (runId: string, changeId: string, sourceCard?: string): CommandResult => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): its plan lives on the card.`
    if (!codingPlanOf(card)?.changes.some((change) => change.id === changeId)) return `Run ${runId} has no recorded planned Change ${changeId}.`
    const { codingChangeId: previous, ...payload } = card.payload
    const selected = previous === changeId ? {} : { codingChangeId: changeId }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload: { ...payload, ...selected } } })
    return { value: `coding-plan-selection run=${runId} change=${previous === changeId ? "none" : changeId}` }
  }

  const traceView = async (runId: string, view: TraceView, sourceCard?: string): Promise<CommandResult> => {
    /*
     * The graph is the flow builder's (D-038). The other two views are the
     * ones the run card always had, so only the new word is refused here.
     */
    if (view === "graph" && ctx.services.features?.flowBuilder !== true) return "This feature is not enabled."
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, traceView: view } }
    }).isPersisted.promise
    return { value: `trace-view run=${runId} view=${view}` }
  }

  const graphFollow = (runId: string, follow: boolean, sourceCard?: string): CommandResult => {
    if (ctx.services.features?.flowBuilder !== true) return "This feature is not enabled."
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the graph lives on its card.`
    const { graph: _graph, ...payload } = card.payload
    // The camera and the open node are different reader gestures on one field,
    // so neither clears the other (controller/graph.ts).
    const { follow: _follow, ...held } = card.payload.graph ?? {}
    const graph = { ...held, follow }
    // Follow defaults on. Persist an explicit false so reload preserves the
    // reader's choice, independently of drawer selection.
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...payload, graph } }
    })
    return { value: `graph-follow run=${runId} follow=${follow ? "on" : "off"}` }
  }

  const traceLive = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    const { selection: _selection, cursorSeq: _cursorSeq, ...payload } = card.payload
    // card.updated merges payload fields. Replace the card to remove the cursor
    // durably: undefined patch values would disappear in the JSON journal.
    await store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...payload, liveTail: true } }
    }).isPersisted.promise
    return { value: `trace-live run=${runId}` }
  }

  /** Stop every live run card's run — one workspace's, when named. Each cancel is durable; the cards settle from the pump. */
  /** The wire statuses the run inbox counts as live (mirrors RunsCards LIVE_STATUSES). */
  const RUN_LIST_LIVE_STATUSES: ReadonlySet<string> = new Set(["accepted", "running", "parked", "waiting-approval"])
  const stopAllRuns = async (repoArg?: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    /*
     * The button reads "Stop all N" off the run inbox's rows, so the act
     * cancels THOSE rows — the wire's live runs under the inbox's active
     * filter — never just the runs this client happens to hold cards for.
     * With no inbox open, the client's live cards are the only known set.
     */
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    if (sourceCard !== undefined && (source?.kind !== "run-list" || (repoArg !== undefined && source.payload.repo !== repoArg))) return "The run list is unavailable or belongs to another repository."
    const inboxes = [...store.collections.cards.values()].filter(
      (card) => card.kind === "run-list" && (sourceCard === undefined || card.id === sourceCard) && (repoArg === undefined || card.payload.repo === repoArg)
    ) as Array<Extract<Card, { kind: "run-list" }>>
    const live: Array<RunScope> = inboxes.length > 0
      ? inboxes.flatMap((card) =>
        card.payload.runs
          .filter((run) => RUN_LIST_LIVE_STATUSES.has(run.status))
          .map((run) => (runScopeFromCard(store, card, run.runId)!))
      )
      : ([...store.collections.cards.values()].filter(
        (card) =>
          card.kind === "run-trace" &&
          !pendingWorkflowLaunch(card) &&
          (card.payload.phase === "launching" ||
            card.payload.phase === "running" ||
            card.payload.phase === "waiting-approval" ||
            card.payload.phase === "reconnecting")
      ) as Array<Extract<Card, { kind: "run-trace" }>>)
        .filter((card) => repoArg === undefined || card.payload.repo === repoArg)
        .map((card) => ({ repo: card.payload.repo, runId: card.payload.runId, workspaceId: card.payload.workspaceId }))
    if (live.length === 0) return repoArg === undefined ? "No runs are live." : `No runs are live on ${repoArg}.`
    let stopped = 0
    let firstRefusal: string | undefined
    for (const card of live.filter((scope, index) => live.findIndex((other) => sameRunScope(other, scope)) === index)) {
      const cancelled = await gateway.cancel(card.repo, card.runId, "the human stopped every run", { workspaceId: card.workspaceId })
      if (cancelled.status === "ok") {
        stopped += 1
      } else if (firstRefusal === undefined) {
        firstRefusal = cancelled.message
      }
    }
    return {
      value: `stop-all stopped=${stopped} of ${live.length}${
        firstRefusal === undefined ? "" : ` — first refusal: ${firstRefusal}`
      }`
    }
  }

  /*
   * The workspace approvals inbox is a slow read: the workspace may need
   * provisioning, and a Projection.Snapshot against a sleeping workspace
   * waits through the gateway's resume loop (gateway.ts, up to three
   * minutes). The ask therefore persists its target and owner first, answers
   * "requested", and the read runs behind the shared toast — through
   * provision AND the read — publishing the card only from received rows.
   *
   * The in-flight map is shared by the user and agent doors (one operation
   * per target), and every entry names the request id and owner it serves,
   * so a superseded or account-crossed operation is never shared again.
   */
  const inboxCardIdFor = (repo: string, workspaceId: string | undefined): string =>
    `approvals-inbox-${repo}${workspaceId === undefined ? "" : `-${workspaceId}`}`
  const approvalReads = actorSharedState(ctx, "approvals-list", () => ({
    inFlight: new Map<string, { readonly id: string; readonly owner: string; readonly epoch: number; readonly work: Promise<unknown> }>(),
    persisting: new Map<string, Promise<unknown>>()
  }))
  /** The stable owner of retained account data (accountOwnerLogin survives an unavailable probe). */
  const accountOwner = (): string | null | undefined => {
    const identity = store.collections.identitySessions.get("identity")
    return identity?.accountOwnerLogin !== undefined ? identity.accountOwnerLogin :
      identity?.state === "signed-in" ? identity.login : identity?.state === "signed-out" ? null : undefined
  }
  const inboxRequestFor = (key: string): ApprovalsInboxRequest | undefined =>
    (store.session().approvalsInboxRequests ?? []).find((row) => inboxCardIdFor(row.repo, row.workspaceId) === key)

  const resultSaveFailure = "Approvals could not be saved. Try again."
  const publishInbox = async (repo: string, binding: { readonly workspaceId?: string }, rows: ReadonlyArray<ApprovalRow>): Promise<number> => {
    const pending = rows.filter((row) => row.status === "pending")
    const cardId = inboxCardIdFor(repo, binding.workspaceId)
    const existing = store.collections.cards.get(cardId)
    const prior = existing?.kind === "approvals-inbox" ? existing.payload.approvals : []
    const card: Card = {
      id: cardId,
      kind: "approvals-inbox",
      title: `Approvals — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo, ...binding, gatewayBindingVersion: 1,
        approvals: pending.map((row) => {
          // A row's recorded decision survives a refresh: the freeze is the
          // server's answer, not something a re-list may thaw.
          const before = prior.find((entry) => sameApproval(entry, row))
          return {
            runId: row.runId,
            requestId: row.requestId,
            title: row.title,
            approval: row.payload as Record<string, unknown>,
            requestedAt: row.requestedAt,
            ...(questionOf(row) === undefined ? {} : { question: questionOf(row)! }),
            ...(before?.decision === undefined ? {} : { decision: before.decision }),
            ...(before?.decidedAt === undefined ? {} : { decidedAt: before.decidedAt }),
            ...(before?.decisionError === undefined ? {} : { decisionError: before.decisionError })
          }
        })
      }
    }
    try {
      await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    } catch { throw new Error(resultSaveFailure) }
    return pending.length
  }

  /** The background read for one persisted request; shared while it runs. Never replays a mutation. */
  const readInbox = (request: ApprovalsInboxRequest): Promise<unknown> => {
    const key = inboxCardIdFor(request.repo, request.workspaceId)
    const epoch = ctx.accountEpoch
    const running = approvalReads.inFlight.get(key)
    if (running !== undefined && running.id === request.id && running.owner === request.owner && running.epoch === epoch) return running.work
    const binding = request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }
    // The fence at every boundary: the controller is open, the account is
    // the one that asked, and this request is still the one on record.
    const ownsAccount = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && accountOwner() === request.owner
    const current = (): boolean => ownsAccount() && inboxRequestFor(key)?.id === request.id
    const settle = async (error?: string): Promise<boolean> => {
      if (!current()) return false
      try {
        await store.dispatch({ type: "approvals.inbox.settled", actor: "system", id: request.id, ...(error === undefined ? {} : { error }) }).isPersisted.promise
      } catch { throw new Error(resultSaveFailure) }
      return ownsAccount() && (error === undefined ? inboxRequestFor(key) === undefined : inboxRequestFor(key)?.id === request.id)
    }
    const toastKey = `approvals.list.${key}`
    const title = `Loading ${request.repo} approvals…`
    const work = ctx.withToast(toastKey, title, "Approvals loaded", async () => {
      try {
        if (!current()) return TOAST_SUPERSEDED
        const provisioned = await workflows.provisionWorkspace(request.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (provisioned !== true) return await settle(provisioned) ? provisioned : TOAST_SUPERSEDED
        const inbox = await gateway.approvalsInbox(request.repo, binding)
        if (!current()) return TOAST_SUPERSEDED
        if (inbox.status !== "ok") return await settle(inbox.message) ? inbox.message : TOAST_SUPERSEDED
        for (const runId of new Set(inbox.value.map((row) => row.runId))) {
          await reconcileRunApprovals(store, { repo: request.repo, runId, ...binding }, inbox.value.filter((row) => row.runId === runId))
          if (!current()) return TOAST_SUPERSEDED
        }
        const pending = await publishInbox(request.repo, binding, inbox.value)
        if (!await settle()) return TOAST_SUPERSEDED
        return { value: pending === 0 ? `No approvals are pending on ${request.repo}.` : `${pending} approval${pending === 1 ? "" : "s"} pending on ${request.repo}.` }
      } catch (error) {
        if (!current()) return TOAST_SUPERSEDED
        const message = error instanceof Error ? error.message : String(error)
        try {
          if (!await settle(message)) return TOAST_SUPERSEDED
        } catch {
          // A rejected write rolls back; the owed request is retained and no
          // success is reported even when its failure cannot be saved either.
          return current() ? resultSaveFailure : TOAST_SUPERSEDED
        }
        return message
      }
    })
    const entry = { id: request.id, owner: request.owner, epoch, work }
    approvalReads.inFlight.set(key, entry)
    void work.then((outcome) => {
      // A refusal quicker than the toast debounce never showed a notice; the
      // failure still has to be visible, so it takes the same failed toast.
      if (typeof outcome !== "string" || !current() || approvalReads.inFlight.get(key) !== entry || store.collections.toasts.get(`toast-${toastKey}`) !== undefined) return
      store.dispatch({ type: "toast.shown", actor: "system", key: toastKey, title })
      ctx.resolveToast(toastKey, { status: "failed", detail: outcome })
    }).finally(() => { if (approvalReads.inFlight.get(key) === entry) approvalReads.inFlight.delete(key) })
    return work
  }

  const listApprovals = async (repoArg?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    // The target is fixed here, before any await: a later selection cannot retarget the read.
    const target = workflows.workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const owner = accountOwner()
    if (typeof owner !== "string") return "Sign in with GitHub first: flows run on your own workspace."
    const epoch = ctx.accountEpoch
    const ownsAccount = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && accountOwner() === owner
    const accountChanged = "The account changed before the approvals could be read. Run the command again."
    const key = inboxCardIdFor(repo, binding.workspaceId)
    const acknowledgment = { value: "Approvals requested." }
    // An ask that arrives while an earlier ask for this target is still
    // committing waits for that commit, then shares whatever it started.
    for (let saving = approvalReads.persisting.get(key); saving !== undefined; saving = approvalReads.persisting.get(key)) {
      try { await saving } catch { /* the ask that saved it reports the failure */ }
      if (!ownsAccount()) return accountChanged
    }
    const recorded = inboxRequestFor(key)
    const running = approvalReads.inFlight.get(key)
    // Duplicate input shares the operation already reading this target for this account.
    if (recorded !== undefined && recorded.error === undefined && recorded.owner === owner && running?.id === recorded.id && running.owner === owner && running.epoch === epoch) {
      return acknowledgment
    }
    const workspace = binding.workspaceId === undefined ? {} : { workspaceId: binding.workspaceId }
    const request = { id: crypto.randomUUID(), repo, ...workspace, owner }
    const saving = store.dispatch({ type: "approvals.inbox.requested", actor: ctx.commandActor, request }).isPersisted.promise
    approvalReads.persisting.set(key, saving)
    try {
      await saving
    } catch {
      return "The approval request could not be saved, so nothing was read."
    } finally {
      if (approvalReads.persisting.get(key) === saving) approvalReads.persisting.delete(key)
    }
    const persisted = inboxRequestFor(key)
    if (!ownsAccount() || persisted?.id !== request.id) {
      return accountChanged
    }
    void readInbox(persisted)
    return acknowledgment
  }

  const resumeApprovalRequests = (): void => {
    if (ctx.disposed) return
    const epoch = ctx.accountEpoch
    const owner = accountOwner()
    if (typeof owner !== "string") return
    const current = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && accountOwner() === owner
    /*
     * The identity answer that wakes this is an optimistic row until its
     * write settles, and provisioning compares that row by identity: a read
     * started inside the change notification would be refused as an account
     * change the moment the row persists. The notification fires before the
     * write is even queued, so wait one task for the commit, then for it to
     * settle, before reading the account that is actually on record.
     */
    const timer = setTimeout(() => {
      if (!current()) return
      let settled: Promise<void>
      try { settled = store.settled?.() ?? Promise.resolve() } catch { return }
      void settled.then(() => {
        if (!current() || workflows.workflowIdentityGuard() !== undefined) return
        for (const request of store.session().approvalsInboxRequests ?? []) {
          // A recorded failure stays visible and manual; another account's request is not this account's to run.
          if (request.error !== undefined || request.owner !== owner) continue
          void readInbox(request)
        }
      }, () => {})
    }, 0)
    ctx.unref(timer)
  }

  /**
   * Bring one run's pending gates into the transcript as approval cards —
   * the same cards the pump would have upserted, so deciding them rides the
   * existing per-card path (`approval.approve` / `approval.deny`) unchanged.
   */
  const openApproval = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = { workspaceId: target.workspaceId }
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const approvals = await gateway.approvals(repo, runId, binding)
    if (approvals.status !== "ok") return approvals.message
    await reconcileRunApprovals(store, target, approvals.value)
    const alreadyOpen = [...store.collections.cards.values()].filter(
      (card) =>
        store.approvalRequest(card.id) !== undefined && card.kind === "approval" && card.payload.runId === runId &&
        sameRunScope(runScopeFromCard(store, card, runId) ?? { repo: "", runId }, target) && card.payload.decision === undefined
    )
    if (alreadyOpen.length > 0) {
      return {
        value: `${alreadyOpen.length} approval card${
          alreadyOpen.length === 1 ? " is" : "s are"
        } already open for run ${runId}.`
      }
    }
    const pending = approvals.value.filter((row) => row.status === "pending")
    if (pending.length === 0) return `Run ${runId} has no approvals pending.`
    for (const approval of pending) {
      const card: Card = {
        id: approvalCardIdFor(store, target, approval.requestId),
        kind: "approval",
        title: approval.title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: approval.title,
          runId,
          requestId: approval.requestId,
          approval: approval.payload as Record<string, unknown>,
          ...(questionOf(approval) === undefined ? {} : { question: questionOf(approval)! }),
          repo, ...binding, gatewayBindingVersion: 1
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return { value: `${pending.length} approval${pending.length === 1 ? "" : "s"} opened for run ${runId}.` }
  }

  return {
    prepareRunHandoff,
    listRuns,
    openRun,
    resumeRun,
    rerunRun,
    signalRun,
    steerRun,
    steerRunSeat,
    steerRunThinking,
    steerRunTools,
    showRunLogs,
    showRunSteps,
    showRunEvents,
    traceFilter,
    traceSelect,
    selectCodingChange,
    traceView,
    graphFollow,
    traceLive,
    stopAllRuns,
    listApprovals,
    resumeApprovalRequests,
    openApproval
  }
}
