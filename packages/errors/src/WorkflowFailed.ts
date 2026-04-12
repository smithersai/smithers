import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";
declare const WorkflowFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "WorkflowFailed";
} & Readonly<A>;
export declare class WorkflowFailed extends WorkflowFailed_base<GenericTaggedErrorArgs & {
    readonly status?: number;
}> {
}
export {};
