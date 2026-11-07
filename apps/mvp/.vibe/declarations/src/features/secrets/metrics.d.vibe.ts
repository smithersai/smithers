import { Effect, Metric } from "effect";
import type { WriteFailure } from "../../../../../src/features/secrets/contract";
/**
 * Secret writes from this tab, by `op` (`put`, `delete`) and `outcome`: `started` (ChatApi took it and its flow
 * started), `refused`, `unknown` (no whole answer), then `landed` once the list shows it, or `late` past the deadline.
 */
export declare const writes: Metric.Counter<number>;
export type Outcome = "started" | "refused" | "unknown" | "landed" | "late";
/** One write's log line and count. */
export declare const record: (op: "put" | "delete", secret: string, outcome: Outcome, fields?: {
    readonly code?: WriteFailure;
    readonly hosts?: number;
}) => Effect.Effect<void, never, never>;
