import React from "react";
/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type WaitForEventProps = {
    id: string;
    /** Event name/type to wait for. */
    event: string;
    /** Correlation key to match the right event instance. */
    correlationId?: string;
    /** Where to store the event payload. */
    output: OutputTarget;
    /** Zod schema for the event payload. */
    outputSchema?: import("zod").ZodObject<any>;
    /** Max wait time in ms before timing out. */
    timeoutMs?: number;
    /** Behavior on timeout: fail (default), skip the node, or continue with null. */
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting for the event. */
    async?: boolean;
    skipIf?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};
export declare function WaitForEvent(props: WaitForEventProps): React.ReactElement<{
    id: string;
    key: string | undefined;
    event: string;
    correlationId: string | undefined;
    output: OutputTarget;
    outputSchema: import("zod").ZodObject<any, import("zod/v4/core").$strip> | undefined;
    timeoutMs: number | undefined;
    onTimeout: "fail" | "continue" | "skip";
    waitAsync: boolean;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: {
        onTimeout?: "fail" | "continue" | "skip" | undefined;
        correlationId?: string | undefined;
        event: string;
    } | undefined;
    __smithersEventName: string;
    __smithersCorrelationId: string | undefined;
    __smithersOnTimeout: "fail" | "continue" | "skip";
}, string | React.JSXElementConstructor<any>> | null;
export {};
