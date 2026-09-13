import { Schema } from "effect"
import { Plan } from "../../../../../../flows/coding/schema"
import type { ControllerContext } from "./context"
import type { FormsController } from "./forms"
import { flag, line, text } from "../../flows/FlowForms"
import { formRenderedText } from "./forms"
import type { WorkflowController } from "./workflows"
import { resolveTargetRepo } from "../RepoContext"
import { lessonCompletion } from "../../onboarding/completion"
import { decodeChangeReceipt, receiptMatchesPlan, validateTutorialPlan } from "../../cards/tutorial2-agent_change-contract"
import type { Card } from "../AppState"
import {
  isPracticeRepo, PRACTICE_BRANCH, PRACTICE_CARD, PRACTICE_REPO, PRACTICE_RUN_ID,
  practiceChange, practiceCommits, practiceJournal, practicePickOf, practicePicker, practicePlan, practiceStack
} from "../practice/PracticeRepository"

export interface TutorialChangeController {
  readonly suggestTutorialChange: (repo?: string, feature?: string) => Promise<string | { readonly value: string }>
  readonly startTutorialChange: (cardId: string) => Promise<string | { readonly value: string }>
  readonly finishTutorialChange: (cardId: string) => Promise<void>
  /** `change.open <repo> <commit…>`: a Change (a stacked landing request) from the picked commits. */
  readonly openChange: (repo: string, commits: ReadonlyArray<string>) => Promise<string | { readonly value: string }>
  /** `change.pick <row>`: toggle one row of the commit picker; the locked fix stays in. */
  readonly pickCommit: (row: number) => Promise<string | { readonly value: string }>
}

type RunCard = Extract<Card, { kind: "run-trace" }>
/** What an already-started plan answers: the run it became and where that run stands, never a refusal. */
const startedPlanState = (card: RunCard): string => {
  const started = card.payload.input?.started as { runId?: string } | undefined
  return started?.runId === undefined ? "This plan was already started." : `This plan was already started as run ${started.runId}; its card shows the run.`
}
const reducedMotion = (): boolean => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
/** The replay's first journal time: step and event times are offsets from it. */
const journalStart = (practiceJournal.events[0]?.occurredAt as number | undefined) ?? 0

export const createTutorialChangeController = (ctx: ControllerContext, flows: WorkflowController, nextOrdinal: () => number, renderFlowForm: FormsController["renderFlowForm"]): TutorialChangeController => {
  const post = async (verb: string, input: object) => {
    const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/tutorial/change/${verb}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    })
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "The change service is unavailable."))
    return response.json()
  }
  /** Finish the current lesson when it waits on `signal`, in the playthrough that asked. */
  const finishLesson = async (signal: string, playthrough: number, said?: string, extra: { pick?: Array<number> } = {}) => {
    const guide = ctx.store.session().guide
    if (guide === undefined || (guide.playthrough ?? 0) !== playthrough) return
    const next = lessonCompletion(guide, signal, said)
    if (next === undefined && extra.pick === undefined) return
    await ctx.store.dispatch({ type: "guide.changed", actor: "system", guide: { ...(next ?? guide), ...extra } }).isPersisted.promise
  }

  /* ---- The practice repository: bundled plan, recorded replay, precomputed stacks. No network, no identity. ---- */

  const suggestPractice = async (): Promise<string | { readonly value: string }> => {
    const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(practicePlan))
    const playthrough = ctx.store.session().guide?.playthrough ?? 0
    const existing = ctx.store.collections.cards.get(PRACTICE_CARD.plan)
    await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id: PRACTICE_CARD.plan, kind: "run-trace", title: plan.changes[0]!.title, status: "active",
      createdAt: existing?.createdAt ?? Date.now(), ordinal: nextOrdinal(),
      payload: { repo: PRACTICE_REPO, runId: PRACTICE_CARD.plan, workflow: "tutorial-change", kind: "change-plan", phase: "completed",
        steps: [], result: null, lastSeq: 0,
        input: { plan, practice: true, atomTags: practiceCommits.map(commit => commit.tag),
          tutorialScope: { repoKey: PRACTICE_REPO, playthrough } } }
    } }).isPersisted.promise
    await finishLesson("plan.ready", playthrough)
    return { value: `Planned 3 commits for #3 in ${PRACTICE_CARD.plan}: ${plan.changes[0]!.atoms.map(atom => atom.message).join("; ")}.` }
  }

  /** Beat 6: replay the recorded run over about ten seconds (at once with reduced motion), then the commit list. */
  const startPractice = async (card: RunCard): Promise<string | { readonly value: string }> => {
    const playthrough = ctx.store.session().guide?.playthrough ?? 0
    await ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: card.id,
      patch: { status: "acted", payload: { ...card.payload, input: { ...card.payload.input, started: { runId: PRACTICE_RUN_ID, cardId: PRACTICE_CARD.run } } } } }).isPersisted.promise
    const plan = card.payload.input?.plan
    const events = practiceJournal.events as Array<Record<string, unknown>>
    const offset = (record: Record<string, unknown>) => (record.occurredAt as number) - journalStart
    const frame = (until: number, phase: RunCard["payload"]["phase"]): RunCard["payload"] => {
      const shown = events.filter(record => offset(record) <= until)
      return { repo: PRACTICE_REPO, runId: PRACTICE_RUN_ID, workflow: "tutorial-change", kind: "change", phase,
        steps: practiceJournal.steps.filter(step => step.at <= until).map(step => step.text),
        result: phase === "completed" ? practiceJournal.result : null,
        lastSeq: (shown[shown.length - 1]?.sequence as number | undefined) ?? 0, events: shown,
        input: { plan, practice: true, tutorialScope: { repoKey: PRACTICE_REPO, playthrough } } }
    }
    const end = practiceJournal.steps[practiceJournal.steps.length - 1]!.at
    const existing = ctx.store.collections.cards.get(PRACTICE_CARD.run)
    await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id: PRACTICE_CARD.run, kind: "run-trace", title: `Fix /hello without a name (#3) · ${PRACTICE_BRANCH}`, status: "active",
      createdAt: existing?.createdAt ?? Date.now(), ordinal: nextOrdinal(), payload: frame(reducedMotion() ? end : 0, reducedMotion() ? "completed" : "running")
    } }).isPersisted.promise
    const stillHere = () => (ctx.store.session().guide?.playthrough ?? 0) === playthrough && ctx.store.collections.cards.has(PRACTICE_CARD.run)
    const settle = async () => {
      if (!stillHere()) return
      await ctx.store.dispatch({ type: "card.updated", actor: "system", id: PRACTICE_CARD.run, patch: { payload: frame(end, "completed") } }).isPersisted.promise
      const commitsCard = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
      await ctx.store.dispatch({ type: "card.upsert", actor: "system", card: {
        id: PRACTICE_CARD.commits, kind: "commit-pick", title: `Commits on ${PRACTICE_BRANCH}`, status: "active",
        createdAt: commitsCard?.createdAt ?? Date.now(), ordinal: nextOrdinal(), payload: practicePicker()
      } }).isPersisted.promise
      await finishLesson("commits.made", playthrough)
    }
    if (reducedMotion()) {
      await settle()
    } else {
      // The replay is presentation over a recorded journal: each step lands at its recorded offset.
      for (const step of practiceJournal.steps.slice(1)) {
        setTimeout(() => {
          if (stillHere() && step.at < end) void ctx.store.dispatch({ type: "card.updated", actor: "system", id: PRACTICE_CARD.run, patch: { payload: frame(step.at, "running") } })
        }, step.at)
      }
      setTimeout(() => { void settle() }, end)
    }
    return { value: `Started the practice run ${PRACTICE_RUN_ID}: 3 commits on ${PRACTICE_BRANCH}.` }
  }

  const suggestTutorialChange: TutorialChangeController["suggestTutorialChange"] = async (repo, feature) => {
    if (isPracticeRepo(repo)) {
      try { return await suggestPractice() } catch (error) { return error instanceof Error ? error.message : String(error) }
    }
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) {
      const form = renderFlowForm({ name: "agent.change", args: feature ? `--feature ${feature}` : undefined,
        via: ctx.commandActor === "smithers" ? "agent" : "user",
        input: Schema.Struct({ repo: Schema.String, feature: Schema.optional(Schema.String) }),
        hints: { fields: { repo: { optionsFrom: "cloud-repos" } }, args: payload => line(text(payload, "repo"), flag(payload, "feature")) } })
      return form ? { value: formRenderedText(form.missing) } : target.error
    }
    const scope = ctx.store.session()
    const actor = ctx.commandActor
    const accountEpoch = ctx.accountEpoch
    const accountLogin = ctx.store.collections.identitySessions.get("identity")?.login
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(await post("plan", { repo: target.repo, feature })))
      if (ctx.store.session().activeRepoKey !== scope.activeRepoKey || ctx.store.session().guide?.playthrough !== scope.guide?.playthrough || ctx.accountEpoch !== accountEpoch) return "The repository changed; request a new plan."
      const id = `tutorial-change-plan-${crypto.randomUUID()}`
      await ctx.store.dispatch({ type: "card.upsert", actor, card: {
        id, kind: "run-trace", title: plan.changes[0]!.title, status: "active", createdAt: Date.now(), ordinal: nextOrdinal(),
        payload: { repo: target.repo, runId: id, workflow: "tutorial-change", kind: "change-plan", phase: "completed", steps: [], result: null, lastSeq: 0,
          input: { plan, tutorialScope: { repoKey: scope.activeRepoKey, playthrough: scope.guide?.playthrough ?? 0, accountEpoch, accountLogin } } }
      } }).isPersisted.promise
      await finishLesson("plan.ready", scope.guide?.playthrough ?? 0)
      return { value: `Review the suggested feature and planned commit in ${id}.` }
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  const startTutorialChange: TutorialChangeController["startTutorialChange"] = async cardId => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "run-trace" || card.payload.kind !== "change-plan") return "This plan is no longer available to start."
    if (card.status !== "active") return { value: startedPlanState(card) }
    // The practice repository needs no account: its run is a recorded replay (SCRIPT v4 §4).
    if (card.payload.input?.practice === true && isPracticeRepo(card.payload.repo)) {
      try { return await startPractice(card) } catch (error) { return error instanceof Error ? error.message : String(error) }
    }
    const guard = flows.workflowIdentityGuard() ?? flows.workflowBalanceGuard()
    if (guard) return guard
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(card.payload.input?.plan))
      const scope = card.payload.input?.tutorialScope as { repoKey?: string; playthrough?: number; accountEpoch?: number; accountLogin?: string | null } | undefined
      const session = ctx.store.session()
      if (!scope || scope.repoKey !== session.activeRepoKey || scope.playthrough !== (session.guide?.playthrough ?? 0) || scope.accountEpoch !== ctx.accountEpoch || scope.accountLogin !== ctx.store.collections.identitySessions.get("identity")?.login) return "The repository or tutorial changed; request a new plan."
      // Consume before awaiting the seam: concurrent activation cannot execute twice.
      const { error: _stale, ...payload } = card.payload
      await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, status: "acted", payload } }).isPersisted.promise
      try {
        await post("preflight", { repo: card.payload.repo, plan })
        const provisioned = await flows.provisionWorkspace(card.payload.repo)
        if (provisioned !== true) throw new Error(provisioned)
        const launched = await flows.launchWorkflow({ repo: card.payload.repo, workflow: "tutorial-change", title: plan.changes[0]!.title,
          kind: "change", input: { ...card.payload.input, plan } })
        if ("message" in launched) throw new Error(launched.message)
        const runCard = [...ctx.store.collections.cards.values()].find(candidate =>
          candidate.kind === "run-trace" && candidate.payload.runId === launched.runId && candidate.payload.repo === card.payload.repo)
        const current = ctx.store.collections.cards.get(cardId)
        if (current?.kind === "run-trace") await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId, patch: { payload: {
          ...current.payload, input: { ...current.payload.input, started: { runId: launched.runId, ...(runCard === undefined ? {} : { cardId: runCard.id }) } } } } }).isPersisted.promise
        return { value: `Started change run ${launched.runId}.` }
      } catch (error) {
        // Nothing launched: the plan keeps its door, and the card says why the start stopped.
        const message = error instanceof Error ? error.message : String(error)
        const current = ctx.store.collections.cards.get(cardId)
        if (current?.kind === "run-trace" && current.payload.input?.started === undefined) {
          await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId, patch: { status: "active", payload: { ...current.payload, error: message } } }).isPersisted.promise
        }
        throw error
      }
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  const finishTutorialChange: TutorialChangeController["finishTutorialChange"] = async cardId => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "run-trace" || card.payload.kind !== "change" || card.payload.phase !== "completed") return
    // A practice run settles itself; it has no hosted receipt to verify.
    if (card.payload.input?.practice === true || isPracticeRepo(card.payload.repo)) return
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(card.payload.input?.plan))
      const receipt = decodeChangeReceipt(await post("receipt", { repo: card.payload.repo, runId: card.payload.runId, plan }))
      if (!receiptMatchesPlan(receipt, plan, card.payload.repo, card.payload.runId)) throw new Error("The commit does not match the captured HEAD.")
      const current = ctx.store.collections.cards.get(cardId)
      if (current?.kind !== "run-trace" || current.payload.phase !== "completed") return
      await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId,
        patch: { payload: { ...current.payload, input: { ...current.payload.input, tutorialReceipt: receipt } } } }).isPersisted.promise
      const scope = card.payload.input?.tutorialScope as { repoKey?: string; playthrough?: number; accountEpoch?: number; accountLogin?: string | null } | undefined
      const session = ctx.store.session()
      if (!scope || session.activeRepoKey !== scope.repoKey || (session.guide?.playthrough ?? 0) !== scope.playthrough ||
        ctx.accountEpoch !== scope.accountEpoch || scope.accountLogin !== ctx.store.collections.identitySessions.get("identity")?.login) return
      await finishLesson("commits.made", scope.playthrough ?? 0)
    } catch (error) {
      const current = ctx.store.collections.cards.get(cardId)
      if (current?.kind === "run-trace") ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId,
        patch: { payload: { ...current.payload, error: error instanceof Error ? error.message : String(error) } } })
    }
  }

  const openChange: TutorialChangeController["openChange"] = async (repo, commits) => {
    if (!isPracticeRepo(repo)) {
      return `Opening a Change from picked commits on ${repo} needs the rebase step in the workspace, which is not wired yet. /prs.create opens one from a bookmark.`
    }
    const pick = practicePickOf(commits)
    if (typeof pick === "string") return pick
    const stack = practiceStack(pick)
    if (typeof stack === "string") return stack
    const playthrough = ctx.store.session().guide?.playthrough ?? 0
    // The picker turns into the stack view: the same card id, now the Change.
    const picker = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
    await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id: PRACTICE_CARD.commits, kind: "change", title: `Change #${stack.landingNumber} · Fix /hello without a name (#3)`, status: "active",
      createdAt: picker?.createdAt ?? Date.now(), ordinal: picker?.ordinal ?? nextOrdinal(), payload: practiceChange(stack)
    } }).isPersisted.promise
    await finishLesson("change.opened", playthrough, stack.line, { pick: [...stack.pick] })
    return { value: stack.line }
  }

  const pickCommit: TutorialChangeController["pickCommit"] = async row => {
    const card = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
    if (card?.kind !== "commit-pick") return "No commit picker is open. Back reopens it after a Change is made."
    const target = card.payload.rows.find(candidate => candidate.index === row)
    if (target === undefined) return `The picker has rows 1 to ${card.payload.rows.length}.`
    if (target.locked) return `Commit ${row} is ${target.hint ?? "required"}; it stays in the Change.`
    const picked = card.payload.picked.includes(row) ? card.payload.picked.filter(index => index !== row) : [...card.payload.picked, row].sort((a, b) => a - b)
    await ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: card.id, patch: { payload: { ...card.payload, picked } } }).isPersisted.promise
    return { value: `${picked.includes(row) ? "Checked" : "Unchecked"} ${target.message}. Picked: ${picked.join(", ")}.` }
  }

  return { suggestTutorialChange, startTutorialChange, finishTutorialChange, openChange, pickCommit }
}
