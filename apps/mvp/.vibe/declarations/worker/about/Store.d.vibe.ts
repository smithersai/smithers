import { Effect, type Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
/** Which token a kept answer was read with. */
export type Via = "app" | "deployment" | "anonymous";
/** A refusal the row keeps. */
export type KeptRefusal = "not_found" | "rate_limited" | "github_unavailable";
/** The last good answer: `About` as JSON text, which token read it, when, and until when it is fresh. */
export interface KeptAnswer {
    readonly text: string;
    readonly via: Via;
    readonly readAtMs: number;
    readonly freshUntilMs: number;
}
/** A repository's row. Times are epoch milliseconds; `null` is none. */
export interface Kept {
    readonly answer: Option.Option<KeptAnswer>;
    /** Nobody asks GitHub before this instant; `null`, a read is due now. */
    readonly nextReadAtMs: number | null;
    readonly refusal: KeptRefusal | null;
    readonly refusalVia?: Via;
    /** The Smithers App wasn't installed on the repository when last asked; nobody asks again before this instant. */
    readonly appAbsentUntilMs: number | null;
}
declare const StoreUnavailable_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "AboutStoreUnavailable";
} & Readonly<A>;
/** The store couldn't answer `op`: Postgres was unreachable or refused. */
export declare class StoreUnavailable extends StoreUnavailable_base<{
    readonly op: "get" | "claim" | "keep" | "refuse" | "app_absent";
}> {
}
/** The about read's store; `R` is what its effects need. */
export interface AboutStore<R = never> {
    /** `repoId`'s row; none before anyone read it. */
    readonly get: (repoId: string) => Effect.Effect<Option.Option<Kept>, StoreUnavailable, R>;
    /**
     * Takes `repoId`'s next read until `untilMs`, only when it is due at `nowMs` (no row, or `next_read_at` passed):
     * the generation when this caller holds it, `false` otherwise.
     */
    readonly claim: (repoId: string, nowMs: number, untilMs: number, recoverAnonymous?: boolean) => Effect.Effect<string | false, StoreUnavailable, R>;
    /** Keeps an answer only for the matching claim generation, consuming it; `false` means superseded. */
    readonly keep: (repoId: string, answer: KeptAnswer, generation: string) => Effect.Effect<boolean, StoreUnavailable, R>;
    /** Keeps GitHub's refusal with no read before `nextReadAtMs`; `not_found` also drops the answer. */
    readonly refuse: (repoId: string, refusal: KeptRefusal, nextReadAtMs: number, via: Via | undefined, generation: string) => Effect.Effect<boolean, StoreUnavailable, R>;
    /** Remembers that the Smithers App isn't installed on `repoId`, until `untilMs`. */
    readonly appAbsent: (repoId: string, untilMs: number) => Effect.Effect<void, StoreUnavailable, R>;
}
/** The store over `database`: each operation opens its own Postgres client, so none is held while GitHub answers. */
export declare const postgres: <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => AboutStore<R>;
export {};
