import type { CatalogItem, CommandState } from "../../flows/registry"
import type { RepoStep } from "../../Onboarding"
import {
  RECOMMEND_FLOW,
  RECOMMEND_OUTCOME_PATH,
  RECOMMEND_PATH,
  isMaterialTransition,
  parseRecommendation,
  recommendRequest,
  ruleSuggestions
} from "../Recommend"
import type { RecommendInput } from "../Recommend"
import type { ControllerContext } from "./context"

/*
 * The recommender's controller half (Recommend.ts has the pure half): a
 * store-driven regeneration of the next-step pills.
 *
 *  - Trigger: a material transition lands in the transitions collection; the
 *    regeneration is debounced by revision and runs through the registered
 *    `recommend` flow, so /verbose sees it like every other act.
 *  - Answer: the rule's pills are written at once for the new revision (the
 *    stale onboarding pill must leave the moment a repo opens), then ONE
 *    request to POST /api/recommend replaces them when the server answers.
 *    A newer revision supersedes an older request, whose answer is dropped.
 *  - Fallback: no seam, a 429, a 503, a network failure, or an answer naming
 *    nothing offerable leaves the rule's pills standing (source "rule").
 *    Never an empty row for a failure, never a fabricated list.
 *  - Outcome: the answer's id is remembered; the user's next dispatch of a
 *    listed flow (slash, button, or pill share one door) is reported once to
 *    POST /api/recommend/outcome, fire-and-forget, and the id is cleared.
 */

export interface RecommenderConfig {
  /**
   * Opt-in per composition root (ControllerBoot turns it on; nothing else
   * does). Off, the rule alone writes the row and no request ever leaves the
   * app, so a test harness's fetch double is never consumed by a background
   * regeneration.
   */
  readonly enabled?: boolean
  /** How long a burst of material transitions coalesces before one regeneration. */
  readonly debounceMs?: number
}

export interface RecommendController {
  /** The `recommend` flow's handler: regenerate for the current revision. */
  readonly recommend: () => Promise<void>
  /** Start watching the transitions collection; released on dispose. */
  readonly subscribe: () => void
  /**
   * The user dispatched a flow through the registry's one door. Reports it
   * as the outcome of the standing recommendation, once, then forgets the
   * recommendation. Hidden id-scoped acts and the recommender's own flow are
   * never an outcome: the server never offered them.
   */
  readonly noteDispatch: (name: string) => void
}

export interface RecommendDependencies {
  readonly catalog: () => ReadonlyArray<CatalogItem>
  readonly state: () => CommandState
  readonly repoStep: () => RepoStep
  /** The active repository as `owner/name`, or null. */
  readonly repo: () => string | null
  readonly config: RecommenderConfig
}

export const createRecommendController = (ctx: ControllerContext, deps: RecommendDependencies): RecommendController => {
  const { store } = ctx
  const enabled = deps.config.enabled ?? false
  const debounceMs = deps.config.debounceMs ?? 150
  let sequence = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  /** The recommendation the user has not answered yet, by server id. */
  let pendingId: string | undefined

  const input = (): RecommendInput => ({
    state: deps.state(),
    catalog: deps.catalog(),
    repoStep: deps.repoStep(),
    repo: deps.repo(),
    messages: [...store.collections.messages.values()].sort((a, b) => a.ordinal - b.ordinal),
    cards: [...store.collections.cards.values()].sort((a, b) => a.ordinal - b.ordinal).slice(-5)
  })

  const recommend: RecommendController["recommend"] = async () => {
    if (disposed) return
    const revision = store.session().revision
    const snapshot = input()
    const rule = ruleSuggestions(snapshot)
    // The honest state now: the rule answers for this revision immediately.
    store.dispatch({ type: "recommendations.updated", actor: "system", suggestions: rule, source: "rule", revision })
    if (!enabled) return
    sequence += 1
    const mine = sequence
    let body: unknown
    try {
      const response = await ctx.boundedFetch(`${ctx.baseUrl}${RECOMMEND_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recommendRequest(snapshot))
      })
      // 429 (ceiling spent), 503 (no key, Cerebras down), 4xx: the rule stands.
      if (!response.ok) return
      body = await response.json()
    } catch {
      return
    }
    // A newer state asked since; this answer describes a state that is gone.
    if (disposed || mine !== sequence) return
    const answer = parseRecommendation(body, snapshot.catalog, snapshot.state.surface)
    if (answer === undefined) return
    // The server logged this id whatever it named; the user's next act answers it.
    pendingId = answer.id
    if (answer.suggestions.length === 0) return
    store.dispatch({
      type: "recommendations.updated",
      actor: "smithers",
      suggestions: answer.suggestions,
      source: "agent",
      revision
    })
  }

  const noteDispatch: RecommendController["noteDispatch"] = (name) => {
    if (pendingId === undefined || disposed) return
    const clean = name.trim().replace(/^\/+/, "")
    if (clean === RECOMMEND_FLOW) return
    const entry = ctx.commands.find(clean)
    if (entry === undefined || entry.metadata.hidden === true) return
    const id = pendingId
    pendingId = undefined
    void ctx.boundedFetch(`${ctx.baseUrl}${RECOMMEND_OUTCOME_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, command: clean })
    }).catch(() => {})
  }

  const schedule = (): void => {
    if (disposed) return
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void ctx.commands.run(RECOMMEND_FLOW)
    }, debounceMs)
    ctx.unref(debounce)
  }

  const subscribe: RecommendController["subscribe"] = () => {
    const subscription = store.collections.transitions.subscribeChanges((changes) => {
      if (changes.some((change) => change.type === "insert" && isMaterialTransition(change.value.type))) schedule()
    })
    ctx.onDispose(() => {
      disposed = true
      if (debounce !== undefined) clearTimeout(debounce)
      subscription.unsubscribe()
    })
  }

  return { recommend, subscribe, noteDispatch }
}
