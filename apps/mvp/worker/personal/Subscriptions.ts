import { Clock, Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { codingChoice, type CodingAgent } from "../../src/features/personal-model/contract.ts"
import type { Keys } from "../secrets/Keys.ts"
import * as Agents from "./Agents.ts"
import * as Codex from "./Codex.ts"
import { sealContext } from "./Models.ts"
import * as Store from "./Store.ts"

// A person's subscription as a `todo` run uses it (decision 0132, docs/features/personal-model.md#subscriptions): which
// agent their list puts first for coding, its credential opened for one request, and a Codex token kept fresh. Nothing
// here runs a model; the vendor's agent does, in the box.

/** The subscription a person's list puts first, as the box reads it: no credential, a Codex account's public ids. */
export interface Subscription {
  readonly personId: string
  readonly connectionId: string
  readonly agent: Exclude<CodingAgent, "smithers">
  readonly baseUrl: string | null
  /** The hosts its credential may go to. */
  readonly hosts: ReadonlyArray<string>
  readonly account?: { readonly accountId: string; readonly planType: string } | undefined
}

/** The hosts `row`'s credential may go to: the vendor's own, or a Claude subscription's own base URL. */
const hostsOf = (agent: Subscription["agent"], baseUrl: string | null) =>
  agent === "codex" ? Agents.CODEX_HOSTS : baseUrl === null ? Agents.CLAUDE_HOSTS : [new URL(baseUrl).hostname]

/** Which agent writes `personId`'s `todo` runs: `smithers` unless their list puts a subscription first. */
export const agentOf = (personId: string): Effect.Effect<CodingAgent, unknown, SqlClient.SqlClient> =>
  Effect.map(Store.saved(personId), (saved) => codingChoice(saved).agent)

/**
 * The subscription `personId`'s list puts first for coding; none when it puts a model first, or the credential doesn't
 * open under `keys` (the run then fails on its first request, and the row's refusal says why).
 */
export const of = (personId: string, keys: Keys) =>
  Effect.gen(function* () {
    const saved = yield* Store.saved(personId)
    const { agent, connectionId } = codingChoice(saved)
    if (agent === "smithers") return Option.none<Subscription>()
    const row = saved.find((connection) => connection.id === connectionId)!
    const common = { personId, connectionId: row.id, agent, baseUrl: row.baseUrl, hosts: hostsOf(agent, row.baseUrl) }
    if (agent === "claude-code") return Option.some<Subscription>(common)
    const opened = yield* keys.cipher.open(row, sealContext(personId, row.keyVersion)).pipe(Effect.option)
    if (Option.isNone(opened)) return Option.none<Subscription>()
    const credential = yield* Codex.readCredential(opened.value).pipe(Effect.option)
    if (Option.isNone(credential)) return Option.none<Subscription>()
    const { accountId, planType } = credential.value
    return Option.some<Subscription>({ ...common, account: { accountId, planType } })
  })

/** The token `connectionId` sends to its host now, for one request; none when it was removed or doesn't open. */
export const reveal = (personId: string, connectionId: string, keys: Keys) =>
  Effect.gen(function* () {
    const row = (yield* Store.saved(personId)).find((connection) => connection.id === connectionId && connection.active)
    if (row === undefined) return Option.none<Redacted.Redacted<string>>()
    const opened = yield* keys.cipher.open(row, sealContext(personId, row.keyVersion)).pipe(Effect.option)
    if (row.kind !== "codex_subscription" || Option.isNone(opened)) return opened
    const credential = yield* Codex.readCredential(opened.value).pipe(Effect.option)
    return Option.map(credential, ({ accessToken }) => Redacted.make(accessToken))
  })

/**
 * Keeps `personId`'s Codex token good for a run's length (`Codex.FRESH_FOR_MS`): refreshes one near its end and seals what
 * OpenAI answered at once, since its refresh tokens rotate. It holds the row while it does, so two runs starting together
 * refresh once: the second waits and reads the first's token. A refusal marks the row and fails. Nothing to do for a
 * Codex connection the person turned off: no run reads it, so its token can't fail one. `force` refreshes it whatever
 * its age or activity: what Check Access does, selecting only its requested row when `selectedId` is given.
 */
export const fresh = (personId: string, keys: Keys, force = false, selectedId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    let connectionId: string | undefined
    const outcome = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Store.holdCodex(personId, selectedId)
        const row = (yield* Store.saved(personId)).find((connection) =>
          connection.kind === "codex_subscription" && (force || connection.active) &&
          (selectedId === undefined || connection.id === selectedId)
        )
        if (row === undefined) return
        connectionId = row.id
        const opened = yield* keys.cipher.open(row, sealContext(personId, row.keyVersion)).pipe(
          Effect.mapError(() => new Codex.CodexAuthFailed({ reason: "refused", status: null })),
        )
        const credential = yield* Codex.readCredential(opened)
        const now = yield* Clock.currentTimeMillis
        if (!force && credential.expiresAt - now > Codex.FRESH_FOR_MS) return
        const next = yield* Codex.refresh(credential, now)
        const sealed = yield* keys.cipher.seal(Redacted.make(JSON.stringify(next)), sealContext(personId, keys.version))
        yield* Store.refreshed({ personId, id: row.id, from: row.ciphertext, sealed: { ...sealed, keyVersion: keys.version } })
      }).pipe(Effect.result),
    )
    if (outcome._tag === "Success") return
    const failure = outcome.failure
    // Outside the hold: a mark written in it would go with whatever ended it.
    if (
      connectionId !== undefined && failure instanceof Codex.CodexAuthFailed && failure.reason === "refused" &&
      failure.status !== null
    ) {
      yield* Store.markConnection(personId, connectionId, failure.status).pipe(Effect.ignore)
    }
    return yield* Effect.fail(failure)
  })
