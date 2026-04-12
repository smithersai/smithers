declare const TaskTimeout_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "TaskTimeout";
} & Readonly<A>;
export declare class TaskTimeout extends TaskTimeout_base<{
    readonly message: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly timeoutMs: number;
}> {
}
export {};
