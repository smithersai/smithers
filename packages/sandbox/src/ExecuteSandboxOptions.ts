import type { SmithersWorkflow } from "@smithers-orchestrator/components/SmithersWorkflow";
import type { ChildWorkflowDefinition } from "@smithers-orchestrator/engine/child-workflow";
import type { SandboxRuntime } from "./SandboxRuntime.ts";

export type ExecuteSandboxOptions = {
    parentWorkflow?: SmithersWorkflow<unknown>;
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
