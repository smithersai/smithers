import React from "react";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import type { SmithersWorkflow } from "../SmithersWorkflow";
/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type SubflowProps = {
    id: string;
    /** The child workflow definition. */
    workflow: SmithersWorkflow<any>;
    /** Input to pass to the child workflow. */
    input?: unknown;
    /** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
    mode?: "childRun" | "inline";
    /** Where to store the subflow's result. */
    output: OutputTarget;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy;
    continueOnFail?: boolean;
    cache?: CachePolicy;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React.ReactNode;
};
export declare function Subflow(props: SubflowProps): React.ReactElement<{
    id: string;
    key: string | undefined;
    workflow: SmithersWorkflow<any>;
    input: unknown;
    mode: "childRun" | "inline";
    output: OutputTarget;
    timeoutMs: number | undefined;
    heartbeatTimeoutMs: number | undefined;
    heartbeatTimeout: number | undefined;
    retries: number | undefined;
    retryPolicy: RetryPolicy | undefined;
    continueOnFail: boolean | undefined;
    cache: CachePolicy | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: Record<string, unknown> | undefined;
    __smithersSubflowWorkflow: SmithersWorkflow<any>;
    __smithersSubflowInput: unknown;
    __smithersSubflowMode: "childRun" | "inline";
}, string | React.JSXElementConstructor<any>> | null;
export {};
