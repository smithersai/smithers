import { currentRepositoryUpdate } from "../RepositoryContext"
import type { CatalogItem, CommandState } from "../../flows/registry"
import type { RepoStep } from "../../Onboarding"
import { RECOMMENDATION_ID } from "../AppState"
import {
  RECOMMEND_FLOW,
  RECOMMEND_OUTCOME_PATH,
  RECOMMEND_PATH,
  isMaterialTransition,
  parseRecommendation,
  recommendRequest,
  recommendRetryAt,
  recommendServiceOrigin,
  ruleSuggestions
} from "../Recommend"
import type { RecommendInput } from "../Recommend"
import type { ControllerContext } from "./context"
import { assignedBinding } from "./modelSeats"

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
 *  - Ceiling: a 429 names when the daily bucket reopens (Retry-After and
 *    body.retryAt, turnLimitResponse). That window is kept on the row, bound
 *    to the account that asked, and no request leaves before it: the rule
 *    still writes on every material change and after a reload, but the POST
 *    that would only be refused again is not sent. The window leaves with an
 *    agent answer or with the account.
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
  /** The clock the retry window is measured against; tests move it, the app reads Date.now. */
  readonly now?: () => number
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

/** A request in flight: the account owner and epoch it was sent for. */
interface Flight {
  readonly owner: string | null | undefined
  readonly epoch: number
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
  const now = deps.config.now ?? Date.now
  const origin = recommendServiceOrigin(ctx.baseUrl, globalThis.location?.href)
  let sequence = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  /** The recommendation the user has not answered yet, by server id. */
  let pendingOutcome: (Flight & { readonly id: string }) | undefined
  /** The one unresolved request, and whose it is; released only by its own settlement. */
  let inflight: Flight | undefined

  /** Whose bucket a request spends: the persisted owner outlives an outage; a visitor is null; unknown is undefined. */
  const accountOwner = (): string | null | undefined => {
    const identity = store.collections.identitySessions.get("identity")
    return identity?.accountOwnerLogin !== undefined ? identity.accountOwnerLogin :
      identity?.state === "signed-in" ? identity.login : identity?.state === "signed-out" ? null : undefined
  }

  /** The row's retry window still binds this account and has not passed at `at`. */
  const closedFor = (owner: string | null | undefined, at: number): boolean => {
    const retry = store.collections.recommendations.get(RECOMMENDATION_ID)?.retry
    return retry !== undefined && owner !== undefined && origin !== undefined &&
      retry.owner === owner && retry.origin === origin && retry.at > at
  }

  const input = (): RecommendInput => ({
    repositoryUpdate: currentRepositoryUpdate(store),
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
    // This regeneration is the newest state that asked, whether or not it sends.
    sequence += 1
    const mine = sequence
    const owner = accountOwner()
    const epoch = ctx.accountEpoch
    // The last 429 said when this account's bucket reopens; until then the rule's pills are the answer.
    if (closedFor(owner, now())) return
    // One request per account at a time: a material change while it is
    // unresolved has its rule row now, and the flight's settlement asks once
    // more for the newest state. Another account's request is its own.
    if (inflight !== undefined && inflight.owner === owner && inflight.epoch === epoch) return
    const flight: Flight = { owner, epoch }
    inflight = flight
    /*
     * Still this controller, this account. Checked after EVERY await and
     * before every write: a response, or its body, can arrive after the
     * account that asked has left, and nothing of it may land on the next
     * account's row. The sequence is not an account authority.
     */
    const owns = (): boolean => !disposed && ctx.accountEpoch === epoch && accountOwner() === owner
    const model = assignedBinding(ctx, "recommend")
    try {
      let response: Response
      try {
        response = await ctx.boundedFetch(`${ctx.baseUrl}${RECOMMEND_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The `recommend` seat: the assigned decision model, or nothing at all.
          body: JSON.stringify({ ...recommendRequest(snapshot), ...(model === undefined ? {} : { model }) })
        })
      } catch {
        return
      }
      // 429 (ceiling spent), 503 (no key, Cerebras down), 4xx: the rule stands.
      if (!response.ok) {
        // A 429 also says until when. The window is kept for the account that
        // asked, and a newer rule-only regeneration does not void it: the
        // bucket is spent whichever state asked.
        if (response.status !== 429 || owner === undefined || origin === undefined || !owns()) return
        const hints = { body: await response.json().catch((): undefined => undefined), retryAfter: response.headers.get("retry-after") }
        if (!owns()) return
        const retryAt = recommendRetryAt(hints, now())
        if (retryAt !== undefined) store.dispatch({ type: "recommendations.deferred", actor: "system", retryAt, origin })
        return
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return
      }
      // The account that asked must still be here, and no newer state may have asked since.
      if (!owns() || mine !== sequence) return
      const answer = parseRecommendation(body, snapshot.catalog, snapshot.state.surface)
      if (answer === undefined) return
      // The server logged this id whatever it named; the user's next act answers it.
      pendingOutcome = { ...flight, id: answer.id }
      if (answer.suggestions.length === 0) return
      store.dispatch({
        type: "recommendations.updated",
        actor: "smithers",
        suggestions: answer.suggestions,
        source: "agent",
        revision
      })
    } finally {
      // Only this flight's own token: a newer account's request keeps its place.
      if (inflight === flight) {
        inflight = undefined
        // A newer state of the same account asked while this one flew; it gets ONE request of its own now.
        if (mine !== sequence && owns()) schedule()
      }
    }
  }

  const noteDispatch: RecommendController["noteDispatch"] = (name) => {
    const outcome = pendingOutcome
    if (outcome === undefined || disposed) return
    if (outcome.owner !== accountOwner() || outcome.epoch !== ctx.accountEpoch) {
      pendingOutcome = undefined
      return
    }
    const clean = name.trim().replace(/^\/+/, "")
    if (clean === RECOMMEND_FLOW) return
    const entry = ctx.commands.find(clean)
    if (entry === undefined || entry.metadata.hidden === true) return
    pendingOutcome = undefined
    void ctx.boundedFetch(`${ctx.baseUrl}${RECOMMEND_OUTCOME_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: outcome.id, command: clean })
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
    const warm = (suggestions: ReadonlyArray<{ flow: string; args?: string }>) => {
      for (const suggestion of suggestions) void ctx.commands.preload?.(suggestion.flow, suggestion.args)
    }
    const subscription = store.collections.transitions.subscribeChanges((changes) => {
      if (changes.some(change => {
        if (change.type !== "insert") return false
        const event = change.value
        if (isMaterialTransition(event.type)) return true
        // HTTP journal frames project message completion inside their batch;
        // that nested fact is not a separate transitions-collection insert.
        // Read the verified projection so deltas and tool continuations do not
        // spend recommendation requests, and rejected batches cannot trigger one.
        if (event.type !== "http.turn.batch.received" && event.type !== "http.turn.interrupted") return false
        let payload: unknown
        try { payload = JSON.parse(event.payload) } catch { return false }
        if (typeof payload !== "object" || payload === null || !("attemptId" in payload) || typeof payload.attemptId !== "string") return false
        const turn = store.collections.httpTurns.get(payload.attemptId)
        return turn !== undefined && turn.status !== "active"
      })) schedule()
    })
    const recommendations = store.collections.recommendations.subscribeChanges(changes => {
      for (const change of changes) if (change.type !== "delete") warm(change.value.suggestions)
    })
    for (const row of store.collections.recommendations.values()) warm(row.suggestions)
    ctx.onDispose(() => {
      disposed = true
      if (debounce !== undefined) clearTimeout(debounce)
      subscription.unsubscribe()
      recommendations.unsubscribe()
    })
  }

  return { recommend, subscribe, noteDispatch }
}
