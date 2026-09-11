import { Authorize } from "@smthrs/chain"
import { Effect, Layer } from "effect"

/*
 * The three-tier policy (Now §6 → DESIGN.md §14) as the chain's gate-4 seam.
 * Tiers ride the capability claims the app catalog declares on every entry:
 *
 *  - `approve:*` — structurally denied. The agent never decides approvals
 *    for itself, whatever the human previously granted.
 *  - `outbound:*` — always asks. A grant is ONE-SHOT and keyed to the call
 *    name so exactly the resumed call passes; it is never remembered.
 *  - `session:*` — asks once per session. The grant is claim-scoped, lives
 *    in memory only, and dies with the page — a reload re-asks.
 *  - anything else is free. The catalog is a closed set this module's
 *    declarations cover, which is what makes the free default honest.
 *
 * A human denial is one-shot too: the next attempt surfaces as a denied
 * observation the model routes around; attempting again later re-asks.
 * The check runs outside the journal (the chain's own law), so a parked
 * lineage re-asks on resume and converges under whatever grant now exists.
 */

export interface PendingAsk {
  readonly name: string
  readonly claim: string
}

export interface ChainPolicy {
  readonly layerFor: (runId: string) => Layer.Layer<Authorize.Authorize>
  readonly pendingAsk: (runId: string) => PendingAsk | undefined
  /**
   * Record the human's decision. `fallback` reconstructs the ask when the
   * in-memory record did not survive a reload; the persisted approval card
   * carries it, so a parked lineage stays resumable across sessions.
   */
  readonly resolve: (
    runId: string,
    decision: "approved" | "denied",
    fallback?: PendingAsk
  ) => boolean
  /** Drop every grant and pending denial. The session tier's revocation. */
  readonly revoke: () => void
}

export const createChainPolicy = (): ChainPolicy => {
  const sessionGrants = new Set<string>()
  // One-shot records are scoped to the lineage that parked, so a decision
  // the human made for one call can never be consumed by another lineage's
  // call to the same command.
  const onceGrants = new Set<string>()
  const onceDenials = new Set<string>()
  const asks = new Map<string, PendingAsk>()
  const onceKey = (runId: string, name: string): string => `${runId}:${name}`

  const layerFor = (runId: string): Layer.Layer<Authorize.Authorize> =>
    Layer.succeed(Authorize.Authorize)(
      Authorize.make({
        authorize: (request) =>
          Effect.suspend(() => {
            for (const claim of request.capabilities) {
              if (claim.startsWith("approve:")) {
                return Effect.fail(
                  new Authorize.AuthorizeError({
                    code: "denied",
                    message: `"${request.name}" is never the agent's call — approvals belong to the human`
                  })
                )
              }
            }
            if (onceDenials.delete(onceKey(runId, request.name))) {
              return Effect.fail(
                new Authorize.AuthorizeError({
                  code: "denied",
                  message: `the user declined "${request.name}"`
                })
              )
            }
            if (onceGrants.delete(onceKey(runId, request.name))) return Effect.void
            const ask = request.capabilities.find(
              (claim) =>
                claim.startsWith("outbound:") ||
                (claim.startsWith("session:") && !sessionGrants.has(claim))
            )
            if (ask !== undefined) {
              asks.set(runId, { name: request.name, claim: ask })
              return Effect.fail(
                new Authorize.AuthorizeError({
                  code: "approval_required",
                  message: `"${request.name}" needs your approval (${ask})`
                })
              )
            }
            return Effect.void
          })
      })
    )

  return {
    layerFor,
    pendingAsk: (runId) => asks.get(runId),
    resolve: (runId, decision, fallback) => {
      const ask = asks.get(runId) ?? fallback
      if (ask === undefined) return false
      asks.delete(runId)
      if (decision === "denied") {
        onceDenials.add(onceKey(runId, ask.name))
        return true
      }
      if (ask.claim.startsWith("session:")) {
        sessionGrants.add(ask.claim)
      } else {
        onceGrants.add(onceKey(runId, ask.name))
      }
      return true
    },
    revoke: () => {
      sessionGrants.clear()
      onceGrants.clear()
      onceDenials.clear()
      asks.clear()
    }
  }
}
