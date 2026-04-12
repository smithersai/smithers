import type { TaggedErrorDetails } from "./TaggedErrorDetails.ts";
declare const TaskAborted_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "TaskAborted";
} & Readonly<A>;
export declare class TaskAborted extends TaskAborted_base<{
    readonly message: string;
    readonly details?: TaggedErrorDetails;
    readonly name?: string;
}> {
}
export {};
