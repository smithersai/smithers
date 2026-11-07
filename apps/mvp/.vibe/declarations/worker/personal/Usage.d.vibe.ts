import { Effect, type Layer, Metric } from "effect";
import type { SqlClient } from "effect/sql";
import * as Store from "../../../../worker/personal/Store.ts";
/** Calls a person's own model answered, by `role` and `outcome` (`success`, `failed`, `interrupted`). */
export declare const calls: Metric.Counter<number>;
/** Tokens a person's own model reported, by `role` and `type` (`input`, `output`). */
export declare const tokens: Metric.Counter<number>;
/** Ledger writes that failed, by `op` (`begin`, `end`). */
export declare const errors: Metric.Counter<number>;
/** One call a person's own model answers: whose, for what, the provider's model id and its host. */
export interface Call extends Store.Call {
    readonly host: string;
}
/** How a call ended: its outcome, what the model reported, and the failure's code and the provider's status. */
export interface End {
    readonly outcome: "success" | "failed" | "interrupted";
    readonly usage: {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
    };
    readonly errorCode?: string | undefined;
    readonly httpStatus?: number | undefined;
}
/**
 * Whether a call's failure was the provider refusing the person's key (401, 402, 403), or saying it ran out (a 429 whose
 * code says so). A plain rate limit is a wait, which the caller sits out: it marks nothing.
 */
export declare const refusedKey: (end: End) => boolean;
/** Writes the call's ledger row before the model runs. */
export declare const begin: (call: Call) => Effect.Effect<void, unknown, SqlClient.SqlClient>;
/**
 * Settles the call's ledger row and marks the person's row: the provider's status when it refused their key or said
 * it ran out, cleared when the call succeeded, unchanged otherwise. One count, and a `personal_model.call` log line for
 * a failure; a write Postgres refuses is logged and counted, never raised into the answer.
 */
export declare const end: <E, R>(call: Call, ended: End, database: Layer.Layer<SqlClient.SqlClient, E, R>) => Effect.Effect<void, never, R>;
