import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";
declare const DbWriteFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "DbWriteFailed";
} & Readonly<A>;
export declare class DbWriteFailed extends DbWriteFailed_base<GenericTaggedErrorArgs> {
}
export {};
