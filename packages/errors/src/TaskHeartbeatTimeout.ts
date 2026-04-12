declare const TaskHeartbeatTimeout_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "TaskHeartbeatTimeout";
} & Readonly<A>;
export declare class TaskHeartbeatTimeout extends TaskHeartbeatTimeout_base<{
    readonly message: string;
    readonly nodeId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly timeoutMs: number;
    readonly staleForMs: number;
    readonly lastHeartbeatAtMs: number;
}> {
}
export {};
