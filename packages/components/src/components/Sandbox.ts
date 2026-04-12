import React from "react";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type SandboxRuntime = "bubblewrap" | "docker" | "codeplane";
export type SandboxVolumeMount = {
    host: string;
    container: string;
    readonly?: boolean;
};
export type SandboxWorkspaceSpec = {
    name: string;
    snapshotId?: string;
    idleTimeoutSecs?: number;
    persistence?: "ephemeral" | "sticky";
};
export type SandboxProps = {
    id: string;
    /** Child workflow definition. If omitted, createSmithers-bound Sandbox wrappers may provide one. */
    workflow?: (...args: any[]) => any;
    /** Input passed to the child workflow. */
    input?: unknown;
    output: OutputTarget;
    runtime?: SandboxRuntime;
    allowNetwork?: boolean;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    image?: string;
    env?: Record<string, string>;
    ports?: Array<{
        host: number;
        container: number;
    }>;
    volumes?: SandboxVolumeMount[];
    memoryLimit?: string;
    cpuLimit?: string;
    command?: string;
    workspace?: SandboxWorkspaceSpec;
    skipIf?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    retries?: number;
    retryPolicy?: RetryPolicy;
    continueOnFail?: boolean;
    cache?: CachePolicy;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: React.ReactNode;
};
export declare function Sandbox(props: SandboxProps): React.ReactElement<{
    id: string;
    key: string | undefined;
    output: OutputTarget;
    runtime: SandboxRuntime;
    allowNetwork: boolean | undefined;
    reviewDiffs: boolean | undefined;
    autoAcceptDiffs: boolean | undefined;
    image: string | undefined;
    env: Record<string, string> | undefined;
    ports: {
        host: number;
        container: number;
    }[] | undefined;
    volumes: SandboxVolumeMount[] | undefined;
    memoryLimit: string | undefined;
    cpuLimit: string | undefined;
    command: string | undefined;
    workspace: SandboxWorkspaceSpec | undefined;
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
    __smithersSandboxWorkflow: ((...args: any[]) => any) | undefined;
    __smithersSandboxInput: unknown;
    __smithersSandboxRuntime: SandboxRuntime;
    __smithersSandboxChildren: React.ReactNode;
}, string | React.JSXElementConstructor<any>> | null;
export {};
