declare const RunNotFound_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "RunNotFound";
} & Readonly<A>;
export declare class RunNotFound extends RunNotFound_base<{
    readonly message: string;
    readonly runId: string;
}> {
}
export {};
