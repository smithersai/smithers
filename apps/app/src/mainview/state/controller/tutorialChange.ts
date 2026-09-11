import { Schema } from "effect"
import { Plan } from "../../../../../../flows/coding/schema"
import type { ControllerContext } from "./context"
import type { FormsController } from "./forms"
import { flag, line, text } from "../../flows/FlowForms"
import { formRenderedText } from "./forms"
import type { WorkflowController } from "./workflows"
import { resolveTargetRepo } from "../RepoContext"
import { completeGuide } from "../../onboarding/completion"
import { decodeChangeReceipt, receiptMatchesPlan, validateTutorialPlan } from "../../cards/tutorial2-agent_change-contract"

export interface TutorialChangeController {
  readonly suggestTutorialChange: (repo?: string, feature?: string) => Promise<string | { readonly value: string }>
  readonly startTutorialChange: (cardId: string) => Promise<string | { readonly value: string }>
  readonly finishTutorialChange: (cardId: string) => Promise<void>
}

export const createTutorialChangeController = (ctx: ControllerContext, flows: WorkflowController, nextOrdinal: () => number, renderFlowForm: FormsController["renderFlowForm"]): TutorialChangeController => {
  const post = async (verb: string, input: object) => {
    const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/tutorial/change/${verb}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    })
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, "The change service is unavailable."))
    return response.json()
  }
  const suggestTutorialChange: TutorialChangeController["suggestTutorialChange"] = async (repo, feature) => {
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
      return { value: `Review the suggested feature and planned commit in ${id}.` }
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  const startTutorialChange: TutorialChangeController["startTutorialChange"] = async cardId => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "run-trace" || card.payload.kind !== "change-plan" || card.status !== "active") return "This plan is no longer available to start."
    const guard = flows.workflowIdentityGuard() ?? flows.workflowBalanceGuard()
    if (guard) return guard
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(card.payload.input?.plan))
      const scope = card.payload.input?.tutorialScope as { repoKey?: string; playthrough?: number; accountEpoch?: number; accountLogin?: string | null } | undefined
      const session = ctx.store.session()
      if (!scope || scope.repoKey !== session.activeRepoKey || scope.playthrough !== (session.guide?.playthrough ?? 0) || scope.accountEpoch !== ctx.accountEpoch || scope.accountLogin !== ctx.store.collections.identitySessions.get("identity")?.login) return "The repository or tutorial changed; request a new plan."
      // Consume before awaiting the seam: concurrent activation cannot execute twice.
      await ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: cardId, patch: { status: "acted" } }).isPersisted.promise
      await post("preflight", { repo: card.payload.repo, plan })
      const provisioned = await flows.provisionWorkspace(card.payload.repo)
      if (provisioned !== true) throw new Error(provisioned)
      const launched = await flows.launchWorkflow({ repo: card.payload.repo, workflow: "tutorial-change", title: plan.changes[0]!.title,
        kind: "change", input: { ...card.payload.input, plan } })
      if ("message" in launched) throw new Error(launched.message)
      return { value: `Started change run ${launched.runId}.` }
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  const finishTutorialChange: TutorialChangeController["finishTutorialChange"] = async cardId => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "run-trace" || card.payload.kind !== "change" || card.payload.phase !== "completed") return
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(card.payload.input?.plan))
      const receipt = decodeChangeReceipt(await post("receipt", { repo: card.payload.repo, runId: card.payload.runId, plan }))
      if (!receiptMatchesPlan(receipt, plan, card.payload.repo, card.payload.runId)) throw new Error("The commit does not match the captured HEAD.")
      const current = ctx.store.collections.cards.get(cardId)
      if (current?.kind !== "run-trace" || current.payload.phase !== "completed") return
      await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId,
        patch: { payload: { ...current.payload, input: { ...current.payload.input, tutorialReceipt: receipt } } } }).isPersisted.promise
      const scope = card.payload.input?.tutorialScope as { repoKey?: string; playthrough?: number; accountEpoch?: number; accountLogin?: string | null } | undefined
      const session = ctx.store.session(), guide = session.guide
      if (!scope || !guide || guide.step !== 7 || session.activeRepoKey !== scope.repoKey ||
        (guide.playthrough ?? 0) !== scope.playthrough || ctx.accountEpoch !== scope.accountEpoch || scope.accountLogin !== ctx.store.collections.identitySessions.get("identity")?.login) return
      await ctx.store.dispatch({ type: "guide.changed", actor: "system", guide: completeGuide(guide, "change.committed") }).isPersisted.promise
    } catch (error) {
      const current = ctx.store.collections.cards.get(cardId)
      if (current?.kind === "run-trace") ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId,
        patch: { payload: { ...current.payload, error: error instanceof Error ? error.message : String(error) } } })
    }
  }
  return { suggestTutorialChange, startTutorialChange, finishTutorialChange }
}
