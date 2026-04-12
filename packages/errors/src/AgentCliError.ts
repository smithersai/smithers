import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";
declare const AgentCliError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "AgentCliError";
} & Readonly<A>;
export declare class AgentCliError extends AgentCliError_base<GenericTaggedErrorArgs> {
}
export {};
