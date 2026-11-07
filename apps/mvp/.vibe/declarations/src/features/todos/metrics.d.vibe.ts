import { Metric } from "effect";
/** Local admission outcomes, independent of engine startup and network delivery. */
export declare const admissions: Metric.Counter<number>;
/** Drafts a `todo/draft` step kept, by `door` and `outcome` (`kept`, `tab_gone`, `not_kept`). */
export declare const drafts: Metric.Counter<number>;
/** Changes a `todo/commit` or `todo/drop` step queued, by `op`, `door` and `outcome` (`queued`, `tab_gone`, `not_admitted`). */
export declare const queued: Metric.Counter<number>;
/** Sends of a queued change, by `op` and `outcome` (`taken`, `existing`, `retry`, `refused`). */
export declare const sends: Metric.Counter<number>;
/** Edit and Discard on a change Not sent, and Discard on a draft, by `action`. */
export declare const pendingActions: Metric.Counter<number>;
/** Agent reads of the shared TODO state, by found, missing or refusal outcome. */
export declare const statusReads: Metric.Counter<number>;
