import { Duration, Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ModelRole } from "../src/features/model/contract.ts"

// What served model calls spend (docs/features/model-endpoint.md#budget). Before the model runs, a call reserves its
// worst case against the deployment's budget for the UTC day; when it ends, it settles to what it spent, or keeps the
// reservation when what it spent is unknown. A reservation that never settles stays charged, and is final once it
// expires: no statement settles it after that, and nothing sweeps it. One row of `model_budget_days` holds each day's
// committed tokens, the sum of its calls' charges, and `model_usage` is the ledger, one row per call, keyed by the
// invocation id `ModelProxy.serve` minted for that call. Each step is one statement, so concurrent calls can't all pass
// one read of the budget.

/** A call about to run: its ids, its role and model, and the tokens it may spend at most. */
export interface Reservation {
  readonly invocationId: string
  readonly requestId: string
  readonly role: ModelRole
  readonly modelId: string
  readonly tokens: number
}

/** The day's budget a reservation is checked against, and how long it lasts before it is final. */
export interface Limits {
  readonly budget: number
  readonly expiry: Duration.Duration
}

/**
 * Reserves `call.tokens` for today, in one statement: raises today's committed tokens by them and writes the call's
 * ledger row, charged its reservation until it settles and expiring `limits.expiry` from now, only while committed is
 * below `limits.budget`. True when it reserved; false when today's budget is spent, or when the call alone is larger
 * than the whole budget, which no day can hold. Otherwise a call is refused only once committed reaches the budget, so
 * the budget is passed by at most one call's reservation, itself no larger than the budget, never by how many calls run
 * at once. The caller's `requestId` is kept to correlate the row with the caller's records; a caller may repeat it, so
 * it is never the key.
 */
export const reserve = (call: Reservation, limits: Limits) =>
  Effect.gen(function* () {
    // Checked before the day's row: the first reservation of a day inserts that row, which no budget check guards.
    if (call.tokens > limits.budget) return false
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly invocationId: string }>`
      WITH counted AS (
        INSERT INTO model_budget_days AS d (day, committed)
        VALUES ((now() AT TIME ZONE 'UTC')::date, ${call.tokens})
        ON CONFLICT (day) DO UPDATE SET committed = d.committed + EXCLUDED.committed
        WHERE d.committed < ${limits.budget}
        RETURNING day
      )
      INSERT INTO model_usage (invocation_id, request_id, role, model_id, input_tokens, output_tokens, day,
        reserved_tokens, charged_tokens, expires_at)
      SELECT ${call.invocationId}, ${call.requestId}, ${call.role}, ${call.modelId}, 0, 0, day, ${call.tokens},
        ${call.tokens}, now() + make_interval(secs => ${Duration.toSeconds(limits.expiry)})
      FROM counted
      RETURNING invocation_id AS "invocationId"`
    return rows.length === 1
  })

/**
 * What a call spent, as the model reported it: `undefined` for a count it never reported, which is unknown, never zero.
 * `complete` when what it reported is all it spent: the call ended normally and the model reported both counts, or the
 * provider refused it before any output (`ModelProxy.refusedCleanly`), when a count it never reported is 0.
 */
/**
 * How a served call ended, as its ledger row keeps it (no content, no provider text): `answered`; `aborted`, its
 * client went away; `refused`, its provider refused before any output; or `failed`, any other failure. Its model
 * error's code and the provider's HTTP status when it failed.
 */
export interface Ended {
  readonly outcome: "answered" | "aborted" | "refused" | "failed"
  readonly errorCode?: string | undefined
  readonly httpStatus?: number | undefined
}

export interface Spent {
  readonly invocationId: string
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly complete: boolean
  readonly ended: Ended
}

/**
 * Settles a reserved call, in one statement: writes what the model reported to its ledger row (0 for a count it never
 * reported) and moves its charge, and its day's committed tokens, from the reservation to what it spent. A call whose
 * usage isn't `complete` may have spent tokens nobody reported, so it keeps its reservation, or what it reported when
 * that is more. Only an unsettled row whose reservation hasn't expired changes: true when it settled, false when the
 * call had settled already or its reservation expired, which leaves it charged in full.
 */
export const settle = (spent: Spent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const reported = (spent.inputTokens ?? 0) + (spent.outputTokens ?? 0)
    const charge = spent.complete ? sql`${reported}` : sql`GREATEST(${reported}, reserved_tokens)`
    const rows = yield* sql<{ readonly day: string }>`
      WITH settled AS (
        UPDATE model_usage SET input_tokens = ${spent.inputTokens ?? 0}, output_tokens = ${spent.outputTokens ?? 0},
          charged_tokens = ${charge}, settled_at = now(), outcome = ${spent.ended.outcome},
          error_code = ${spent.ended.errorCode ?? null}, http_status = ${spent.ended.httpStatus ?? null}
        WHERE invocation_id = ${spent.invocationId} AND settled_at IS NULL AND expires_at > now()
        RETURNING day, reserved_tokens, charged_tokens
      )
      UPDATE model_budget_days d
      SET committed = d.committed + settled.charged_tokens - settled.reserved_tokens
      FROM settled WHERE d.day = settled.day
      RETURNING d.day::text AS day`
    return rows.length === 1
  })
