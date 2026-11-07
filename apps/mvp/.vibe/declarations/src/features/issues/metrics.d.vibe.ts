import { Metric } from "effect";
/**
 * Write steps, by `op`, `door` (`button`, `slash`, `agent`, or `unknown` when no tab answered) and `outcome`
 * (`queued`, `not_admitted`, `tab_gone`, `no_credential`).
 */
export declare const writes: Metric.Counter<number>;
/**
 * Sends of queued writes to ChatApi's writes route, by `op` and `outcome`: `started` (202), `existing` (200),
 * `refused` (a 4xx that stays Not sent) or `retry` (sent again).
 */
export declare const sends: Metric.Counter<number>;
/** Edit and Discard on a write that wasn't sent, by `action`. */
export declare const pendingActions: Metric.Counter<number>;
/** Create presses durably admitted, retained for Retry, or refused by device storage; never their text. */
export declare const admissions: Metric.Counter<number>;
/** Comment submissions that never obtained a queue receipt, without recording their text. */
export declare const submissionFailures: Metric.Counter<number>;
/** Repositories whose issues the device evicted once this person lost read access, by `status` (`sign_in`, `forbidden`). */
export declare const evictions: Metric.Counter<number>;
