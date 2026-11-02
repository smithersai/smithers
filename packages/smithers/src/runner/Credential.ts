/**
 * A job's read credential for its repository (decision 0148), as the runner
 * asks the host for it: only when a fetch or clone needs one, once per job's
 * claim while it lasts, and one request at a time per claim.
 *
 * The host answers `404` where it has none to give (a public repository, no
 * App, or the route off): the fetch goes on without one. Any other answer is
 * no silent fallback: a host or GitHub that can't answer now is
 * `CredentialUnavailable`, which the job settles `Retryable`; a refusal is
 * `CredentialRefused`, which fails the job's workspace.
 *
 * @since 1.0.0
 */

import { Effect, Option, Schema, Semaphore } from "effect"
import type * as Host from "./Host.ts"
import type { GitCredential } from "./Workspace.ts"

/**
 * The host or GitHub couldn't issue a credential now; `afterSeconds` is the
 * wait the host said, if any.
 *
 * @category errors
 * @since 1.0.0
 */
export class CredentialUnavailable extends Schema.TaggedError<CredentialUnavailable>()(
  "@smthrs/cli/Runner/CredentialUnavailable",
  { afterSeconds: Schema.optional(Schema.Int) }
) {}

/**
 * The host refused a credential for the job: the claim no longer holds it,
 * or the runner may not read the repository.
 *
 * @category errors
 * @since 1.0.0
 */
export class CredentialRefused extends Schema.TaggedError<CredentialRefused>()(
  "@smthrs/cli/Runner/CredentialRefused",
  { status: Schema.optional(Schema.Int) }
) {}

/**
 * How long before its `expiresAt` a credential is asked for again: long
 * enough for the clone or fetch it starts.
 *
 * @category constants
 * @since 1.0.0
 */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000

interface Held {
  readonly credential: GitCredential
  readonly expiresAt: number
}

const held = new Map<string, Held>()
const gates = new Map<string, Semaphore.Semaphore>()

/**
 * The credential for the job `key` its `claim` names, from `host`: the one
 * already held while it has more than `REFRESH_MARGIN_MS` left, else a new
 * one. `none` where the host has none to give. Concurrent asks for one claim
 * wait for each other, so only one reaches the host.
 *
 * @category constructors
 * @since 1.0.0
 */
export const forJob = (
  host: Host.Host["Service"],
  job: { readonly key: string; readonly claim: string },
  now: () => number = Date.now
): Effect.Effect<Option.Option<GitCredential>, CredentialUnavailable | CredentialRefused> =>
  Effect.suspend(() => {
    const id = `${job.key}\n${job.claim}`
    let gate = gates.get(id)
    if (gate === undefined) {
      gate = Semaphore.makeUnsafe(1)
      gates.set(id, gate)
    }
    return gate.withPermits(1)(Effect.gen(function*() {
      for (const [each, value] of held) if (value.expiresAt <= now()) held.delete(each)
      const kept = held.get(id)
      if (kept !== undefined && kept.expiresAt - now() > REFRESH_MARGIN_MS) return Option.some(kept.credential)
      const answer = yield* host.gitCredential({ key: job.key, claim: job.claim }).pipe(Effect.result)
      if (answer._tag === "Failure") {
        const error = answer.failure
        if (error.code === "invalid" && error.status === 404) return Option.none<GitCredential>()
        if (error.code === "unavailable") {
          return yield* new CredentialUnavailable(
            error.retryAfterSeconds === undefined ? {} : { afterSeconds: error.retryAfterSeconds }
          )
        }
        return yield* new CredentialRefused(error.status === undefined ? {} : { status: error.status })
      }
      const credential = {
        remote: answer.success.remote,
        username: answer.success.username,
        password: answer.success.password
      }
      held.set(id, { credential, expiresAt: answer.success.expiresAt })
      return Option.some(credential)
    }))
  })

/**
 * Forgets the credential held for the job `key` its `claim` names: the job
 * ended.
 *
 * @category constructors
 * @since 1.0.0
 */
export const forget = (job: { readonly key: string; readonly claim: string }): void => {
  const id = `${job.key}\n${job.claim}`
  held.delete(id)
  gates.delete(id)
}
