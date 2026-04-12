import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";
declare const InvalidInput_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "InvalidInput";
} & Readonly<A>;
export declare class InvalidInput extends InvalidInput_base<GenericTaggedErrorArgs> {
}
export {};
