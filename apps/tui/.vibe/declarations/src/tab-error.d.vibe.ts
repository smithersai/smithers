export type Code = 
/** No worker tab or flow run has that id. */
"unknown_tab"
/** Only a failed, stopped, or parked tab can be retried. */
 | "not_retryable"
/** Only a worker stopped at its run cap takes a new cap. */
 | "not_capped"
/** Only a failed tab can wait for a provider reset. */
 | "not_failed"
/** The session is closing. */
 | "closed"
/** This session has no flow host. */
 | "flows_unavailable";
declare const TabError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "TabError";
} & Readonly<A>;
export declare class TabError extends TabError_base<{
    readonly code: Code;
    readonly message: string;
    readonly subject?: string;
}> {
    constructor(code: Code, message: string, subject?: string);
}
export {};
