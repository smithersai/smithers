import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";
declare const BodyRefused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "BodyRefused";
} & Readonly<A>;
/** Why a body couldn't be read: larger than the route's limit (`too_large`), malformed UTF-8 (`utf8`), or cut off. */
export declare class BodyRefused extends BodyRefused_base<{
    readonly reason: "too_large" | "utf8" | "body";
}> {
}
/**
 * Reads at most `maxBytes` as UTF-8, refusing a declared or streamed body that is larger before buffering it, malformed
 * UTF-8 wherever it falls across chunks, and a body that breaks off. `onBytes` hears how many bytes were read.
 */
export declare const readBounded: (request: HttpServerRequest.HttpServerRequest, maxBytes: number, onBytes?: (bytes: number) => void) => Effect.Effect<string, BodyRefused>;
export {};
