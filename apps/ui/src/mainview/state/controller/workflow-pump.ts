import { approvalCardIdFor, runScopeFromCard, sameRunScope, type RunScope } from "../RunReference"
import type { ProjectionCursor } from "@smthrs/gateway/GatewaySchema"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import type { ApprovalRow, RunStatus, RunSummaryRow } from "./gateway"
import { engineProjectionPending } from "../../cards/EngineTrace"

export interface WorkflowPumpController {
  readonly pumpWorkflowRun: (cardId: string) => Promise<void>
  readonly stopWatchingRun: (cardId: string, reason?: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  readonly resumeWorkflowRuns: () => void
  readonly stopWorkflowPumps: () => void
}

/** How a run card reads each rc.0 run status. */
const PHASE_OF_STATUS: Readonly<Record<RunStatus, Extract<Card, { kind: "run-trace" }>["payload"]["phase"]>> = {
  accepted: "running",
  running: "running",
  parked: "running",
  "waiting-approval": "waiting-approval",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
}

const TERMINAL_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

export const createWorkflowPumpController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number
): WorkflowPumpController => {
  const { store, gateway, unref, workflowPollMs, services } = ctx
  /*
   * Workflows in the conversation ("make me a workflow").
   *
   * Every act routes through the per-user gateway seam on the product Worker:
   * provision-or-resume the workspace gateway for a loaded repo (the loaded
   * set is the universe), then the
   * gateway's own procedures. A run renders as an embedded run card (THE EMBED
   * LAW) whose pump re-reads the `run-summary`, `transcript`, and `approvals`
   * projections. Summary and transcript rows replace their current answer;
   * the journal appends the suffix after the card's retained position.
   */
  const RUN_POLL_MS = workflowPollMs
  const RUN_STEPS_TAIL = 8
  /*
   * The generous bound. A run the workspace never finishes is a real state,
   * and polling it until the tab closes is neither honest nor kind to the
   * workspace. After this long with no progress the card says so and the pump
   * stops; stop/retry are the human's next acts, both registered commands.
   */
  const RUN_QUIET_AFTER_MS = services.workflowQuietMs ?? 10 * 60 * 1000

  const liveRunCards = (): Array<Extract<Card, { kind: "run-trace" }>> =>
    [...store.collections.cards.values()].filter(
      (card) =>
        card.kind === "run-trace" &&
        (card.payload.phase === "launching" ||
          card.payload.phase === "running" ||
          card.payload.phase === "waiting-approval" ||
          card.payload.phase === "reconnecting" ||
          (TERMINAL_PHASES.has(card.payload.phase) && engineProjectionPending(card.payload.events)))
    ) as Array<Extract<Card, { kind: "run-trace" }>>

  const pokeableWait = (cardId: string, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        ctx.pumpPokes.delete(cardId)
        resolve()
      }, ms)
      unref(timer)
      ctx.pumpPokes.set(cardId, () => {
        clearTimeout(timer)
        ctx.pumpPokes.delete(cardId)
        resolve()
      })
    })

  const patchRunCard = (
    cardId: string,
    patch: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>,
    status?: Card["status"]
  ): void => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "run-trace") return
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id: cardId,
      patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) }
    })
  }

  /**
   * What the run has done since the card last looked, in words.
   *
   * The summary counts every fact a human asked about — turns, calls, edits —
   * so the line is computed from the counters rather than from a vocabulary of
   * event names this app would have to keep in step with the engine's.
   */
  const progressWords = (row: RunSummaryRow, previous: RunSummaryRow | undefined): string | undefined => {
    if (previous !== undefined && row.turns === previous.turns && row.calls === previous.calls) return undefined
    if (row.calls === 0 && row.turns === 0) return undefined
    return `${row.turns} ${row.turns === 1 ? "turn" : "turns"} · ${row.calls} ${
      row.calls === 1 ? "call" : "calls"
    }${row.callsFailed > 0 ? ` (${row.callsFailed} refused)` : ""}`
  }

  /** The approval cards a run is waiting on, bound to the existing round trip. */
  const upsertRunApprovals = (runId: string, repo: string, workspaceId: string | undefined, rows: ReadonlyArray<ApprovalRow>): number => {
    let found = 0
    for (const approval of rows) {
      if (approval.runId !== runId || approval.status !== "pending") continue
      found += 1
      const id = approvalCardIdFor(store, { repo, runId, workspaceId }, approval.requestId)
      if (store.approvalRequest(id) !== undefined && store.collections.cards.get(id) !== undefined) continue
      const card: Card = {
        id,
        kind: "approval",
        title: approval.title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: approval.title,
          runId,
          requestId: approval.requestId,
          // The submit-ready envelope the gateway published: the decision goes
          // back with it unchanged, so no client reconstructs authority.
          approval: approval.payload as Record<string, unknown>,
          repo, gatewayBindingVersion: 1, ...(workspaceId === undefined ? {} : { workspaceId })
        }
      }
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return found
  }

  /** A gate this run is still parked on, as the transcript itself holds it. */
  const runAwaitsApproval = (scope: RunScope): boolean =>
    [...store.collections.cards.values()].some(
      (entry) => {
        if (entry.kind !== "approval" || entry.payload.runId !== scope.runId || entry.payload.decision !== undefined) return false
        const recorded = runScopeFromCard(store, entry, scope.runId)
        return recorded !== undefined && sameRunScope(recorded, scope)
      }
    )

  /*
   * The run pump: re-read the run's summary until it settles. Consecutive
   * failures flip the card to the honest reconnecting state; the pump never
   * stops silently.
   */
  const pumpWorkflowRun = async (cardId: string, observeOnce = false): Promise<void> => {
    if (ctx.runPumps.has(cardId)) return
    const pump = { stopped: false }
    ctx.runPumps.set(cardId, pump)
    let failures = 0
    /** A gate the run announced whose approval row is not in hand yet. */
    let approvalPending = false
    /** When this run last actually moved — the clock behind the quiet bound. */
    let lastProgressAt = Date.now()
    /** The last summary read, so a repeated answer does not read as movement. */
    let previous: RunSummaryRow | undefined
    let journalCursor: ProjectionCursor | undefined
    let journalRevision: string | undefined
    let transcriptRevision: string | undefined
    let wasFollowing = false
    let retainedJournal: Extract<Card, { kind: "run-trace" }>["payload"]["events"]
    try {
      for (;;) {
        if (pump.stopped) return
        const card = store.collections.cards.get(cardId)
        if (card === undefined || card.kind !== "run-trace") return
        const alreadyTerminal = TERMINAL_PHASES.has(card.payload.phase)
        const projectionPending = engineProjectionPending(card.payload.events)
        if (
          (alreadyTerminal && !observeOnce && !projectionPending) ||
          card.payload.phase === "no-capacity" ||
          card.payload.phase === "quiet" ||
          card.payload.phase === "stopped"
        ) {
          return
        }
        observeOnce = false
        /*
         * Nothing has moved for a very long time. Say so and stop — an
         * endlessly reconnecting or endlessly "running" card that nobody can
         * act on is the silent stall in a different costume.
         */
        const quietFor = Date.now() - lastProgressAt
        if (quietFor >= RUN_QUIET_AFTER_MS) {
          patchRunCard(cardId, alreadyTerminal
            ? { observationError: "The run has settled, but its recorded engine evidence has not finished synchronizing." }
            : { phase: "quiet", quietForMs: quietFor })
          return
        }
        const { repo, runId, workspaceId } = card.payload
        const binding = { workspaceId }
        // A resume or an explicit inspection may supply a new full prefix.
        // Recover its position from the tail, without scanning old history.
        if (card.payload.events !== retainedJournal) {
          const previousLength = retainedJournal?.length ?? 0
          const previousCursor = journalCursor
          retainedJournal = card.payload.events
          const sequence = retainedJournal?.at(-1)?.sequence
          journalCursor = undefined
          if (typeof sequence === "number" && retainedJournal !== undefined) {
            let offset = 0
            for (let i = retainedJournal.length - 2; i >= 0 && retainedJournal[i]?.sequence === sequence; i--) offset++
            journalCursor = {
              selector: { _tag: "run-events", runId }, projection: "run-events", runId,
              value: sequence, offset
            }
          }
          // Store validation can copy an unchanged prefix during another
          // card update. Its position still acknowledges the same revision.
          if (previousLength !== (retainedJournal?.length ?? 0) ||
            previousCursor?.value !== journalCursor?.value || previousCursor?.offset !== journalCursor?.offset) {
            journalRevision = undefined
          }
        }

        const summary = await gateway.run(repo, runId, binding)
        if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
        if (summary.status !== "ok" || summary.value === undefined) {
          failures += 1
          if (failures >= 2 && !pump.stopped) {
            if (alreadyTerminal) {
              patchRunCard(cardId, { observationError: "The run has settled, but its latest engine evidence could not be read." })
              return
            }
            patchRunCard(cardId, { phase: "reconnecting" })
          }
          await pokeableWait(cardId, RUN_POLL_MS)
          continue
        }
        failures = 0
        const row = summary.value
        const revision = summary.cursor?.projection === "run-summary" && summary.cursor.runId === runId
          ? `${summary.cursor.value}:${summary.cursor.offset}`
          : undefined
        const words = progressWords(row, previous)
        const newSteps = words === undefined || card.payload.steps.includes(words) ? [] : [words]

        if (row.status === "waiting-approval" || row.waitingReason === "approval") approvalPending = true
        if (approvalPending) {
          const approvals = await gateway.approvals(repo, runId, binding)
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          // Keep asking until the gate is actually in hand: a parked run can
          // be readable a beat before its approval row is.
          if (approvals.status === "ok" && upsertRunApprovals(runId, repo, card.payload.workspaceId, approvals.value) > 0) {
            approvalPending = false
          }
        }

        /*
         * Lane runs — the card's transcript follows the live run while the
         * human asked it to (`runs.logs --follow`): changed revisions re-read
         * the projection and replace the rows, bound to the pump
         * the card already pays for. Unfollowing stops the merge, and a
         * terminal run keeps its last transcript standing.
         */
        let transcriptRows: Extract<Card, { kind: "run-trace" }>["payload"]["transcriptRows"]
        if (card.payload.follow === true && (!wasFollowing || revision === undefined || revision !== transcriptRevision)) {
          const transcript = await gateway.transcript(repo, runId, binding)
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          if (transcript.status === "ok") {
            transcriptRevision = revision
            transcriptRows = transcript.value.map((line) => ({
              sequence: line.sequence,
              turn: line.turn,
              at: line.at,
              kind: line.kind,
              text: line.text
            }))
          }
        }

        wasFollowing = card.payload.follow === true

        /*
         * Keep the journal prefix on the card and request only its suffix.
         * A failed read does not acknowledge the summary revision, so the
         * next cycle retries even when the run has not moved again.
         */
        let events: Extract<Card, { kind: "run-trace" }>["payload"]["events"]
        let eventReadError: string | undefined
        // A native projection can append after its control verdict settled,
        // without changing the summary cursor. Its own marker closes this read.
        if (revision === undefined || revision !== journalRevision || projectionPending) {
          const journal = await gateway.runEvents(repo, runId, binding, journalCursor)
          if (pump.stopped || ctx.runPumps.get(cardId) !== pump) return
          const current = store.collections.cards.get(cardId)
          // An inspection that won this race already replaced our prefix.
          // Reconcile its cursor next cycle instead of appending twice.
          if (journal.status === "ok" && current?.kind === "run-trace" && current.payload.events === retainedJournal) {
            // Empty journals and a first sequence-zero event share cursor
            // 0:0. Keep reading until at least one row establishes a prefix.
            journalRevision = journalCursor !== undefined || journal.value.length > 0 ? revision : undefined
            if (journal.value.length > 0) {
              // Preserve old event identities and never mutate a dispatched prefix.
              events = [...(retainedJournal ?? []), ...journal.value.map((event) => ({ ...event }))]
              retainedJournal = events
              for (const event of journal.value) {
                journalCursor = {
                  selector: { _tag: "run-events", runId }, projection: "run-events", runId,
                  value: event.sequence,
                  offset: journalCursor?.value === event.sequence ? journalCursor.offset + 1 : 0
                }
              }
            }
          } else if (journal.status !== "ok") eventReadError = journal.message
        }
        // Only a nonempty, prefix-matched suffix assigns events. A higher
        // offset at the same sequence is also actual observation progress.
        if (events !== undefined) lastProgressAt = Date.now()

        /*
         * Why the run is not moving, in the control plane's word. `accepted`
         * reads "executor" — the CLI's own render-time convention for a run
         * nothing is driving yet — and a parked run names its wait. A moving
         * run names nothing.
         */
        const waiting = row.status === "accepted"
          ? "executor"
          : row.status === "parked"
          ? row.waitingReason ?? "parked"
          : undefined
        const steeringPending = (row.steeringPending ?? 0) > 0

        const phase = PHASE_OF_STATUS[row.status]
        if (TERMINAL_PHASES.has(phase)) {
          const steps = [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL)
          const observationError = eventReadError === undefined ? { observationError: undefined } : {
            observationError: `The run has settled, but its recorded engine evidence could not be read: ${eventReadError}`
          }
          if (phase === "completed") {
            // The run summary's own verdict, which is what `whatHappened`
            // used to answer out of the engine database.
            const result = row.verdict
            patchRunCard(cardId, { phase, steps, lastSeq: row.updatedAt, result, waiting: undefined, steeringPending, error: undefined, ...observationError, ...(transcriptRows === undefined ? {} : { transcriptRows }), ...(events === undefined ? {} : { events }) }, "acted")
            if (!alreadyTerminal) store.dispatch({ type: "message.appended", actor: "system", text: result })
          } else {
            // Lead with the run's own diagnosis; the generic line is the
            // fallback, never a cover for it.
            const detail = row.status === "failed" ? row.verdict : undefined
            const message = phase === "failed"
              ? `The run failed on your workspace: ${detail ?? "the card has what the gateway reported."}`
              : "The run was cancelled."
            patchRunCard(
              cardId,
              { phase, steps, lastSeq: row.updatedAt, waiting: undefined, steeringPending, ...(transcriptRows === undefined ? {} : { transcriptRows }), ...(events === undefined ? {} : { events }), ...(detail === undefined ? {} : { error: detail }), ...observationError },
              "error"
            )
            if (!alreadyTerminal) store.dispatch({ type: "message.appended", actor: "system", text: message })
          }
          if (eventReadError === undefined && (events === undefined ? projectionPending : engineProjectionPending(events))) {
            previous = row
            await pokeableWait(cardId, RUN_POLL_MS)
            continue
          }
          return
        }

        /*
         * Real movement resets the quiet clock: new activity, or a run that
         * CHANGED what it says about itself. A summary that keeps answering
         * the same "running" is not progress — that is precisely the state the
         * quiet bound exists for.
         */
        if (newSteps.length > 0 || events !== undefined || previous === undefined || row.status !== previous.status) {
          lastProgressAt = Date.now()
        }
        const summaryChanged = JSON.stringify(previous) !== JSON.stringify(row)
        previous = row

        const nextPhase = card.payload.phase === "launching" && newSteps.length === 0 && row.status === "accepted"
          ? card.payload.phase
          : runAwaitsApproval(card.payload)
          ? "waiting-approval"
          : phase
        if (summaryChanged || events !== undefined ||
          (transcriptRows !== undefined && JSON.stringify(transcriptRows) !== JSON.stringify(card.payload.transcriptRows)) ||
          nextPhase !== card.payload.phase || waiting !== card.payload.waiting || steeringPending !== card.payload.steeringPending) {
          patchRunCard(cardId, {
            phase: nextPhase,
            steps: [...card.payload.steps, ...newSteps].slice(-RUN_STEPS_TAIL),
            lastSeq: row.updatedAt,
            waiting,
            steeringPending,
            ...(transcriptRows === undefined ? {} : { transcriptRows }),
            ...(events === undefined ? {} : { events })
          })
        }
        await pokeableWait(cardId, RUN_POLL_MS)
      }
    } finally {
      /*
       * Only tear down THIS pump's registrations. "Stop watching" then "Check
       * again" can start a successor while this one is still unwinding its
       * last await, and an unconditional delete here would strip the live pump
       * out of the registry.
       */
      if (ctx.runPumps.get(cardId) === pump) {
        ctx.pumpPokes.delete(cardId)
        ctx.runPumps.delete(cardId)
      }
    }
  }

  /*
   * The two acts a quiet run offers, both registered commands so the card's
   * buttons dispatch through the one path everything else does.
   */
  const runCardFor = (cardId: string): Extract<Card, { kind: "run-trace" }> | undefined => {
    const card = store.collections.cards.get(cardId)
    return card?.kind === "run-trace" ? card : undefined
  }

  /**
   * Stop watching, and stop the run.
   *
   * The old seam relayed no cancel, so it could only stop watching and had to
   * say so. This one does: the gateway's `Cancel` is durable and cross-process,
   * so the card can honestly say the run was stopped.
   */
  const stopWatchingRun = (cardId: string, reason?: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    const pump = ctx.runPumps.get(cardId)
    if (pump !== undefined) pump.stopped = true
    ctx.runPumps.delete(cardId)
    ctx.pumpPokes.get(cardId)?.()
    void gateway.cancel(card.payload.repo, card.payload.runId, reason, { workspaceId: card.payload.workspaceId }).then((cancelled) => {
      patchRunCard(cardId, {
        phase: cancelled.status === "ok" ? "cancelled" : "stopped",
        steps: [
          ...card.payload.steps,
          cancelled.status === "ok" ? "Cancelled this run." : "Stopped watching this run."
        ].slice(-RUN_STEPS_TAIL)
      })
    })
    return undefined
  }

  const retryRunWatch = (cardId: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    patchRunCard(cardId, {
      phase: TERMINAL_PHASES.has(card.payload.phase) ? card.payload.phase : "running",
      ...(TERMINAL_PHASES.has(card.payload.phase) ? {} : { error: undefined }),
      observationError: undefined,
      steps: [...card.payload.steps, "Checking the run again…"].slice(-RUN_STEPS_TAIL)
    })
    void pumpWorkflowRun(cardId, true)
    return undefined
  }

  /** Boot reconciliation: a live run card's pump resumes. */
  const resumeWorkflowRuns = (): void => {
    for (const card of liveRunCards()) void pumpWorkflowRun(card.id)
  }
  ctx.resumeWorkflowRuns = resumeWorkflowRuns

  const stopWorkflowPumps = (): void => {
    for (const pump of ctx.runPumps.values()) pump.stopped = true
    ctx.runPumps.clear()
    ctx.pumpPokes.clear()
  }
  ctx.stopWorkflowPumps = stopWorkflowPumps
  return {
    pumpWorkflowRun,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns,
    stopWorkflowPumps
  }
}
