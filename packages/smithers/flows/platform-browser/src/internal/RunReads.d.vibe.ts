/**
 * The tab's decoder of the leader's run reads: `@smthrs/engine-store`'s
 * `RunInspection.Inspection` and `RunList`, as they travel on the engine's
 * channel.
 *
 * The tab never loads `@smthrs/engine-store` (its SQL reads and the journal's
 * redactor have no business in a tab bundle), so the wire shape is declared
 * here again. The two type assertions at the bottom tie it to the engine's
 * declaration: a field added there without one here, or of another type,
 * fails this package's typecheck.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * One run as `Inspect` reads it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Inspection: Schema.Struct<{
    readonly run: Schema.Struct<{
        runId: Schema.String;
        flowName: Schema.String;
        status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        createdAtMs: Schema.Number;
        startedAtMs: Schema.NullOr<Schema.Number>;
        finishedAtMs: Schema.NullOr<Schema.Number>;
        parentRunId: Schema.NullOr<Schema.String>;
        cancelRequestedAtMs: Schema.NullOr<Schema.Number>;
        waiting: Schema.NullOr<Schema.Struct<{
            readonly kind: Schema.Literals<readonly ["timer", "signal", "approval", "quota", "human", "other"]>;
            readonly reason: Schema.String;
            readonly wakeAtMs: Schema.NullOr<Schema.Number>;
        }>>;
        lastSeq: Schema.Number;
        origin: Schema.NullOr<Schema.Struct<{
            readonly door: Schema.String;
            readonly actor: Schema.String;
        }>>;
        input: Schema.Struct<{
            readonly text: Schema.String;
            readonly bytes: Schema.Number;
            readonly clipped: Schema.Boolean;
        }>;
        result: Schema.NullOr<Schema.Struct<{
            readonly text: Schema.String;
            readonly bytes: Schema.Number;
            readonly clipped: Schema.Boolean;
        }>>;
    }>;
    readonly steps: Schema.$Array<Schema.Struct<{
        readonly nodeId: Schema.String;
        readonly action: Schema.NullOr<Schema.String>;
        readonly kind: Schema.String;
        readonly status: Schema.Literals<readonly ["running", "completed", "failed", "waiting", "skipped"]>;
        readonly scheduledAtMs: Schema.Number;
        readonly settledAtMs: Schema.NullOr<Schema.Number>;
        readonly seq: Schema.Number;
        readonly output: Schema.NullOr<Schema.Struct<{
            readonly text: Schema.String;
            readonly bytes: Schema.Number;
            readonly clipped: Schema.Boolean;
        }>>;
        readonly attempts: Schema.$Array<Schema.Struct<{
            readonly attempt: Schema.Number;
            readonly state: Schema.String;
            readonly startedAtMs: Schema.Number;
            readonly finishedAtMs: Schema.NullOr<Schema.Number>;
            readonly outcome: Schema.NullOr<Schema.Struct<{
                readonly text: Schema.String;
                readonly bytes: Schema.Number;
                readonly clipped: Schema.Boolean;
            }>>;
            readonly error: Schema.NullOr<Schema.String>;
        }>>;
    }>>;
    readonly children: Schema.$Array<Schema.Struct<{
        runId: Schema.String;
        flowName: Schema.String;
        status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        createdAtMs: Schema.Number;
        startedAtMs: Schema.NullOr<Schema.Number>;
        finishedAtMs: Schema.NullOr<Schema.Number>;
        parentRunId: Schema.NullOr<Schema.String>;
        cancelRequestedAtMs: Schema.NullOr<Schema.Number>;
        waiting: Schema.NullOr<Schema.Struct<{
            readonly kind: Schema.Literals<readonly ["timer", "signal", "approval", "quota", "human", "other"]>;
            readonly reason: Schema.String;
            readonly wakeAtMs: Schema.NullOr<Schema.Number>;
        }>>;
        lastSeq: Schema.Number;
        origin: Schema.NullOr<Schema.Struct<{
            readonly door: Schema.String;
            readonly actor: Schema.String;
        }>>;
        input: Schema.Struct<{
            readonly text: Schema.String;
            readonly bytes: Schema.Number;
            readonly clipped: Schema.Boolean;
        }>;
        result: Schema.NullOr<Schema.Struct<{
            readonly text: Schema.String;
            readonly bytes: Schema.Number;
            readonly clipped: Schema.Boolean;
        }>>;
    }>>;
    readonly journal: Schema.Struct<{
        readonly events: Schema.$Array<Schema.Struct<{
            readonly seq: Schema.Number;
            readonly eventType: Schema.String;
            readonly emittedAtMs: Schema.Number;
            readonly payload: Schema.Struct<{
                readonly text: Schema.String;
                readonly bytes: Schema.Number;
                readonly clipped: Schema.Boolean;
            }>;
        }>>;
        readonly afterSeq: Schema.Number;
        readonly nextSeq: Schema.Number;
        readonly hasMore: Schema.Boolean;
    }>;
}>;
/**
 * A page of runs as `List` reads it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const RunList: Schema.Struct<{
    readonly runs: Schema.$Array<Schema.Struct<{
        runId: Schema.String;
        flowName: Schema.String;
        status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        createdAtMs: Schema.Number;
        startedAtMs: Schema.NullOr<Schema.Number>;
        finishedAtMs: Schema.NullOr<Schema.Number>;
        parentRunId: Schema.NullOr<Schema.String>;
        cancelRequestedAtMs: Schema.NullOr<Schema.Number>;
        waiting: Schema.NullOr<Schema.Struct<{
            readonly kind: Schema.Literals<readonly ["timer", "signal", "approval", "quota", "human", "other"]>;
            readonly reason: Schema.String;
            readonly wakeAtMs: Schema.NullOr<Schema.Number>;
        }>>;
        lastSeq: Schema.Number;
        origin: Schema.NullOr<Schema.Struct<{
            readonly door: Schema.String;
            readonly actor: Schema.String;
        }>>;
    }>>;
    readonly cursor: Schema.NullOr<Schema.String>;
}>;
/**
 * Decodes an `Inspect` reply's result.
 *
 * @category decoding
 * @since 1.0.0
 */
export declare const decodeInspection: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<{
    readonly run: {
        readonly runId: string;
        readonly flowName: string;
        readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
        readonly createdAtMs: number;
        readonly startedAtMs: number | null;
        readonly finishedAtMs: number | null;
        readonly parentRunId: string | null;
        readonly cancelRequestedAtMs: number | null;
        readonly waiting: {
            readonly kind: "approval" | "human" | "other" | "quota" | "signal" | "timer";
            readonly reason: string;
            readonly wakeAtMs: number | null;
        } | null;
        readonly lastSeq: number;
        readonly origin: {
            readonly door: string;
            readonly actor: string;
        } | null;
        readonly input: {
            readonly text: string;
            readonly bytes: number;
            readonly clipped: boolean;
        };
        readonly result: {
            readonly text: string;
            readonly bytes: number;
            readonly clipped: boolean;
        } | null;
    };
    readonly steps: readonly {
        readonly nodeId: string;
        readonly action: string | null;
        readonly kind: string;
        readonly status: "completed" | "failed" | "running" | "skipped" | "waiting";
        readonly scheduledAtMs: number;
        readonly settledAtMs: number | null;
        readonly seq: number;
        readonly output: {
            readonly text: string;
            readonly bytes: number;
            readonly clipped: boolean;
        } | null;
        readonly attempts: readonly {
            readonly attempt: number;
            readonly state: string;
            readonly startedAtMs: number;
            readonly finishedAtMs: number | null;
            readonly outcome: {
                readonly text: string;
                readonly bytes: number;
                readonly clipped: boolean;
            } | null;
            readonly error: string | null;
        }[];
    }[];
    readonly children: readonly {
        readonly runId: string;
        readonly flowName: string;
        readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
        readonly createdAtMs: number;
        readonly startedAtMs: number | null;
        readonly finishedAtMs: number | null;
        readonly parentRunId: string | null;
        readonly cancelRequestedAtMs: number | null;
        readonly waiting: {
            readonly kind: "approval" | "human" | "other" | "quota" | "signal" | "timer";
            readonly reason: string;
            readonly wakeAtMs: number | null;
        } | null;
        readonly lastSeq: number;
        readonly origin: {
            readonly door: string;
            readonly actor: string;
        } | null;
        readonly input: {
            readonly text: string;
            readonly bytes: number;
            readonly clipped: boolean;
        };
        readonly result: {
            readonly text: string;
            readonly bytes: number;
            readonly clipped: boolean;
        } | null;
    }[];
    readonly journal: {
        readonly events: readonly {
            readonly seq: number;
            readonly eventType: string;
            readonly emittedAtMs: number;
            readonly payload: {
                readonly text: string;
                readonly bytes: number;
                readonly clipped: boolean;
            };
        }[];
        readonly afterSeq: number;
        readonly nextSeq: number;
        readonly hasMore: boolean;
    };
}, Schema.SchemaError, never>;
/**
 * Decodes a `List` reply's result.
 *
 * @category decoding
 * @since 1.0.0
 */
export declare const decodeRunList: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<{
    readonly runs: readonly {
        readonly runId: string;
        readonly flowName: string;
        readonly status: "cancelled" | "completed" | "failed" | "pending" | "running" | "suspended";
        readonly createdAtMs: number;
        readonly startedAtMs: number | null;
        readonly finishedAtMs: number | null;
        readonly parentRunId: string | null;
        readonly cancelRequestedAtMs: number | null;
        readonly waiting: {
            readonly kind: "approval" | "human" | "other" | "quota" | "signal" | "timer";
            readonly reason: string;
            readonly wakeAtMs: number | null;
        } | null;
        readonly lastSeq: number;
        readonly origin: {
            readonly door: string;
            readonly actor: string;
        } | null;
    }[];
    readonly cursor: string | null;
}, Schema.SchemaError, never>;
