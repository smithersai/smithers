import { Metric } from "effect";
/** Webhook deliveries, by `event` and `outcome` (`applied`, `duplicate`, `ignored`, `refused`, `too_large`, ...). */
export declare const webhooks: Metric.Counter<number>;
/** Milliseconds from a delivery's arrival to its subject's row being written. */
export declare const deliveryLag: Metric.Histogram<number>;
/** Write requests at the route, by `op` and `outcome` (`started`, `existing`, or the refusal's code). */
export declare const writeRequests: Metric.Counter<number>;
/** Writes settled by their flow, by `op`, `outcome` (`done`, `refused`, `failed`) and `token` (`user`, `app`). */
export declare const writes: Metric.Counter<number>;
/** Milliseconds a write took, from the route to its settling, by `op`. */
export declare const writeMs: Metric.Histogram<number>;
/** Writes whose answer was lost, by `op`: the next attempt looked for its marker. */
export declare const writeUnknown: Metric.Counter<number>;
/** Webhook subjects re-read, by `outcome` (`applied`, `tombstoned`, `not_installed`, `unavailable`). */
export declare const applies: Metric.Counter<number>;
/** Rows a reconcile changed that a webhook should have delivered, by `kind` (`issue`, `comment`). */
export declare const reconcileChanged: Metric.Counter<number>;
/** Reconcile walks, by `outcome` (`complete`, `partial`, `not_installed`, `refused`, `superseded`). */
export declare const reconciles: Metric.Counter<number>;
/** Seconds since a repository's sync last finished, at each read of its issues. */
export declare const syncAge: Metric.Gauge<number>;
/**
 * Tokens asked for, by `kind` and `outcome`: a step's (`user`, `app`; worker/github/Tokens.ts), and the deployment's
 * read token (`read`, outcome `minted` or `anonymous`; worker/github/ReadToken.ts).
 */
export declare const tokenMints: Metric.Counter<number>;
/** Shape requests to the git tables, by `table`, then `status` and `live` (`@smthrs/effect-electric` adds those). */
export declare const shapes: Metric.Counter<number>;
/** Triage runs, by `outcome` (`skipped`, `abstained`, `dropped`, `labeled`, `commented`, `comment_failed`, `unavailable`). */
export declare const triageRuns: Metric.Counter<number>;
/** Triage decisions, by `decision` (`accept`, `reject`, `abstain`) and `via` (`flow`, `person`). */
export declare const triageDecisions: Metric.Counter<number>;
/** Flow decisions that wrote nothing, by `reason` (`pinned`, `relabeled`, `edited`, `paused`, ...). */
export declare const triageDropped: Metric.Counter<number>;
/** A person's overrides, by the state `from` and the decision `to`: overriding the flow is the flow's error rate. */
export declare const triageOverrides: Metric.Counter<number>;
/** Model tokens the triage flow spent. */
export declare const triageTokens: Metric.Counter<number>;
/** Reconcile starts a stale read of the issues awaited, by `outcome`: `started`, `timed_out` or `not_started`. */
export declare const reconcileStarts: Metric.Counter<number>;
/** Live anonymous visibility checks, by a bounded outcome. */
export declare const visibilityReads: Metric.Counter<number>;
/** Projection failures after a confirmed successful GitHub write, by operation. */
export declare const projectionFailures: Metric.Counter<number>;
/** `GET /api/repos/<owner>/<name>/issues` requests, by `outcome`: `listed`, `invalid`, `refused`, `not_found`, `unavailable`. */
export declare const issueLists: Metric.Counter<number>;
/** `POST .../issues/<number>/links` requests, by `outcome` and who posted (`by`: `person`, `runner` or `none`). */
export declare const workLinkPosts: Metric.Counter<number>;
/**
 * First-paint requests (`GET /api/repos/<owner>/<name>/first-paint`), by `form` (`issue`, `list`, `invalid`) and
 * `outcome`: `painted`, `missing` (no such issue), `refused_<status>` (the access rule's status), `deadline`
 * or `error` (Postgres, or anything else). Every outcome but `painted` answered an empty `204`.
 */
export declare const firstPaints: Metric.Counter<number>;
