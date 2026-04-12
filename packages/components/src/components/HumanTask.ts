import React from "react";
/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type HumanTaskProps = {
    id: string;
    /** Where to store the human's response. */
    output: OutputTarget;
    /** Zod schema the human must conform to. Used for validation. */
    outputSchema?: import("zod").ZodObject<any>;
    /** Instructions for the human (string or ReactNode). */
    prompt: string | React.ReactNode;
    /** Max validation retries before failure. */
    maxAttempts?: number;
    /** Do not block unrelated downstream flow while waiting for human input. */
    async?: boolean;
    skipIf?: boolean;
    timeoutMs?: number;
    continueOnFail?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};
export declare function HumanTask(props: HumanTaskProps): React.ReactElement<{
    id: string;
    key: string | undefined;
    output: OutputTarget;
    outputSchema: import("zod").ZodObject<any, import("zod/v4/core").$strip> | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    needsApproval: boolean;
    waitAsync: boolean;
    approvalMode: string;
    timeoutMs: number | undefined;
    retries: number;
    retryPolicy: {
        backoff: "fixed";
        initialDelayMs: number;
    };
    continueOnFail: boolean | undefined;
    label: string;
    meta: {
        humanTask: boolean;
        maxAttempts: number;
        prompt: string;
    };
    __smithersKind: string;
    __smithersComputeFn: () => Promise<unknown>;
}, string | React.JSXElementConstructor<any>> | null;
export {};
