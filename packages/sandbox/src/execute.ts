import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import { type ChildWorkflowDefinition } from "@smithers/engine/child-workflow";
import { type SandboxRuntime } from "./transport";
export type ExecuteSandboxOptions = {
    parentWorkflow?: SmithersWorkflow<any>;
    sandboxId: string;
    runtime?: SandboxRuntime;
    workflow: ChildWorkflowDefinition;
    input?: unknown;
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    config?: Record<string, unknown>;
};
export declare function executeSandbox(options: ExecuteSandboxOptions): Promise<unknown>;
