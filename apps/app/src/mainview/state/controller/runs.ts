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
import { liveTutorialTranscript } from "../LiveTutorialTranscript"
import type { TraceFilter, TraceView } from "../../cards/RunTrace"
import { traceFromJournal } from "../../cards/RunTrace"
import { codingPlanOf } from "../../cards/CodingPlan"
import type { CommandResult } from "../../flows/Flows"
import type { Card } from "../AppState"
import { sameApproval } from "../ApprovalReference"
import { reconcileRunApprovals } from "./approval-reconciliation"
import type { ControllerContext } from "./context"
import type { RunSummaryRow } from "./gateway"
import type { WorkflowController } from "./workflows"
import { approvalCardIdFor, cardContainsRun, runCardInScope, runScopeFromCard, sameRunScope, type RunScope } from "../RunReference"
import { completeGuide } from "../../onboarding/completion"
import { canCompleteTutorialTrace, tutorialTraceScopeFor, type TutorialTraceScope } from "./tutorial2-turn_trace"
import { activeRepositoryId, gatewayBindingFor, gatewayRunContextFor } from "../RepoContext"
import { isPracticeRepo, practiceTranscript } from "../practice/PracticeRepository"

export interface RunsController {
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
  /** `runs.trace.filter <runId> <filter>`: the trace's active filter, in the card payload (spec 06 §5, §6). */
  readonly traceFilter: (runId: string, filter: TraceFilter, sourceCard?: string) => CommandResult
  /** `runs.trace.select <runId> <nodeId> [seq]`: the trace's selection and scrub cursor; leaves live tail. */
  readonly traceSelect: (runId: string, nodeId: string, seq?: number, sourceCard?: string) => Promise<CommandResult>
  readonly traceView: (runId: string, view: TraceView, sourceCard?: string) => CommandResult
  readonly traceLive: (runId: string, sourceCard?: string) => CommandResult
  readonly selectCodingChange: (runId: string, changeId: string, sourceCard?: string) => CommandResult
  readonly stopAllRuns: (repo?: string, sourceCard?: string) => Promise<CommandResult>
  readonly listApprovals: (repo?: string) => Promise<CommandResult>
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
  tutorialTraceScope: (runId: string) => TutorialTraceScope | undefined = runId => tutorialTraceScopeFor(ctx.store, runId)
): RunsController => {
  const { store, gateway } = ctx

  const runCardFor = (scope: RunScope) => runCardInScope(store, scope)
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
    const listed = await gateway.workspaceRuns(repo, binding)
    if (listed.status !== "ok") return listed.message
    const rows = listed.value
      .filter((row) =>
        (args.status === undefined || row.status === args.status) &&
        (args.flow === undefined || row.flowId === args.flow) &&
        (args.lineage === undefined || row.lineageId === args.lineage)
      )
      .sort((left, right) => right.createdAt - left.createdAt)
    const cardId = source?.kind === "run-list" ? source.id : `run-list-${repo}${binding.workspaceId === undefined ? "" : `-${binding.workspaceId}`}`
    const existing = store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "run-list",
      title: `Runs — ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo, ...binding, gatewayBindingVersion: 1,
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.flow === undefined ? {} : { flow: args.flow }),
        ...(args.lineage === undefined ? {} : { lineage: args.lineage }),
        // Every status the UNFILTERED workspace carries, so the filter chips (and "All") survive a single-status filter.
        statuses: [...new Set(listed.value.map((row) => row.status))].sort(),
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
      value: rows.length === 0
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
      input: card.payload.input,
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
    patchRunCard(target, {
      facet: "transcript",
      follow: following,
      transcriptRows: transcript.value.map((row) => ({
        sequence: row.sequence,
        ...(row.turn === undefined ? {} : { turn: row.turn }),
        ...(row.at === undefined ? {} : { at: row.at }),
        kind: row.kind,
        text: row.text
      }))
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
    patchRunCard(target, {
      facet: "events",
      events: events.value.map((event) => ({ ...(event as unknown as Record<string, unknown>) }))
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
  const traceFilter = (runId: string, filter: TraceFilter, sourceCard?: string): CommandResult => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, filter } }
    })
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
    const playthrough = store.session().guide?.playthrough ?? 0
    const activeRepoKey = store.session().activeRepoKey
    const accountEpoch = ctx.accountEpoch
    // Persist the actual embedded inspection before completing the lesson.
    await store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, facet: "steps", selection: nodeId, liveTail: false, cursorSeq } }
    }).isPersisted.promise
    const guide = store.session().guide
    if (ctx.accountEpoch === accountEpoch && (guide?.playthrough ?? 0) === playthrough && store.session().activeRepoKey === activeRepoKey &&
        canCompleteTutorialTrace(guide, tutorialTraceScope(runId), activeRepositoryId(store), runId, card.payload.repo, model, nodeId)) {
      await store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide: completeGuide(guide!, "trace.opened") }).isPersisted.promise
    }
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

  const traceView = (runId: string, view: TraceView, sourceCard?: string): CommandResult => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, traceView: view } }
    })
    return { value: `trace-view run=${runId} view=${view}` }
  }

  const traceLive = (runId: string, sourceCard?: string): CommandResult => {
    const target = resolveRun(runId, sourceCard)
    if ("error" in target) return target.error
    const card = runCardFor(target)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the trace lives on its card.`
    const { selection: _selection, cursorSeq: _cursorSeq, ...payload } = card.payload
    // card.updated merges payload fields. Replace the card to remove the cursor
    // durably: undefined patch values would disappear in the JSON journal.
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...payload, liveTail: true } }
    })
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

  const listApprovals = async (repoArg?: string): Promise<CommandResult> => {
    const guard = workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflows.workflowTargetRepo(repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const binding = gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const provisioned = await workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const inbox = await gateway.approvalsInbox(repo, binding)
    if (inbox.status !== "ok") return inbox.message
    for (const runId of new Set(inbox.value.map((row) => row.runId))) reconcileRunApprovals(store, { repo, runId, ...binding }, inbox.value)
    const pending = inbox.value.filter((row) => row.status === "pending")
    const cardId = `approvals-inbox-${repo}${binding.workspaceId === undefined ? "" : `-${binding.workspaceId}`}`
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
            ...(before?.decision === undefined ? {} : { decision: before.decision }),
            ...(before?.decidedAt === undefined ? {} : { decidedAt: before.decidedAt }),
            ...(before?.decisionError === undefined ? {} : { decisionError: before.decisionError })
          }
        })
      }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card })
    return {
      value: pending.length === 0
        ? `No approvals are pending on ${repo}.`
        : `${pending.length} approval${pending.length === 1 ? "" : "s"} pending on ${repo}.`
    }
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
    reconcileRunApprovals(store, target, approvals.value)
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
          repo, ...binding, gatewayBindingVersion: 1
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return { value: `${pending.length} approval${pending.length === 1 ? "" : "s"} opened for run ${runId}.` }
  }

  return {
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
    traceLive,
    stopAllRuns,
    listApprovals,
    openApproval
  }
}
