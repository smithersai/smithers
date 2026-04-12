import React from "react";
import { z } from "zod";
export declare const approvalDecisionSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    decidedBy: z.ZodNullable<z.ZodString>;
    decidedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const approvalSelectionSchema: z.ZodObject<{
    selected: z.ZodString;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const approvalRankingSchema: z.ZodObject<{
    ranked: z.ZodArray<z.ZodString>;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalSelection = z.infer<typeof approvalSelectionSchema>;
export type ApprovalRanking = z.infer<typeof approvalRankingSchema>;
export type ApprovalRequest = {
    title: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};
export type ApprovalMode = "approve" | "select" | "rank";
export type ApprovalOption = {
    key: string;
    label: string;
    summary?: string;
    metadata?: Record<string, unknown>;
};
export type ApprovalAutoApprove = {
    after?: number;
    condition?: ((ctx: any) => boolean) | (() => boolean);
    audit?: boolean;
    revertOn?: ((ctx: any) => boolean) | (() => boolean);
};
/** Valid output targets for Approval: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type ApprovalProps<Row = ApprovalDecision, Output extends OutputTarget = OutputTarget> = {
    id: string;
    mode?: ApprovalMode;
    options?: ApprovalOption[];
    /** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
    output: Output;
    outputSchema?: import("zod").ZodObject<any>;
    request: ApprovalRequest;
    onDeny?: "fail" | "continue" | "skip";
    allowedScopes?: string[];
    allowedUsers?: string[];
    autoApprove?: ApprovalAutoApprove;
    /** Do not block unrelated downstream flow while this approval is pending. */
    async?: boolean;
    /** Explicit dependency on other task node IDs. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: import("@smithers/scheduler/RetryPolicy").RetryPolicy;
    continueOnFail?: boolean;
    cache?: import("@smithers/scheduler/CachePolicy").CachePolicy;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React.ReactNode;
    smithersContext?: React.Context<any>;
};
export declare function Approval<Row = ApprovalDecision>(props: ApprovalProps<Row>): React.ReactElement<{
    id: string;
    key: string | undefined;
    output: OutputTarget;
    outputSchema: z.ZodObject<any, z.core.$strip>;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    needsApproval: boolean;
    waitAsync: boolean;
    approvalMode: "decision" | "select" | "rank";
    approvalOnDeny: "fail" | "continue" | "skip" | undefined;
    approvalOptions: {
        metadata?: Record<string, unknown> | undefined;
        summary?: string | undefined;
        key: string;
        label: string;
    }[] | undefined;
    approvalAllowedScopes: string[] | undefined;
    approvalAllowedUsers: string[] | undefined;
    approvalAutoApprove: {
        revertOnMet?: boolean | undefined;
        conditionMet?: boolean | undefined;
        audit: boolean;
        after?: number | undefined;
    } | undefined;
    timeoutMs: number | undefined;
    heartbeatTimeoutMs: number | undefined;
    heartbeatTimeout: number | undefined;
    retries: number | undefined;
    retryPolicy: import("@smithers/scheduler").RetryPolicy | undefined;
    continueOnFail: boolean | undefined;
    cache: import("@smithers/scheduler").CachePolicy<any> | undefined;
    label: string;
    meta: {
        approvalAutoApprove?: {
            revertOnMet?: boolean | undefined;
            conditionMet?: boolean | undefined;
            audit: boolean;
            after?: number | undefined;
        } | undefined;
        approvalAllowedUsers?: string[] | undefined;
        approvalAllowedScopes?: string[] | undefined;
        approvalOptions?: {
            metadata?: Record<string, unknown> | undefined;
            summary?: string | undefined;
            key: string;
            label: string;
        }[] | undefined;
        requestSummary?: string | undefined;
    } | undefined;
    __smithersKind: string;
    __smithersComputeFn: () => Promise<Row>;
}, string | React.JSXElementConstructor<any>> | null;
export {};
