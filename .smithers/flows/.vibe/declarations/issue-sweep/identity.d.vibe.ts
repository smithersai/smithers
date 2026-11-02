import { FlowRuntime } from "@smthrs/flow";
/** A fresh work identity is safe only after the existing child is terminal. */
export declare const terminalIdentityConflict: (error: unknown) => error is FlowRuntime.ExecutionIdentityConflict;
