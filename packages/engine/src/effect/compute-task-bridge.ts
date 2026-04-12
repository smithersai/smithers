import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { SmithersDb } from "@smithers/db/adapter";
import { EventBus } from "../events";
type ComputeTaskBridgeToolConfig = {
    rootDir: string;
};
export declare const canExecuteBridgeManagedComputeTask: (desc: TaskDescriptor, cacheEnabled: boolean) => boolean;
export declare const executeComputeTaskBridge: (adapter: SmithersDb, db: any, runId: string, desc: TaskDescriptor, eventBus: EventBus, toolConfig: ComputeTaskBridgeToolConfig, workflowName: string, signal?: AbortSignal) => Promise<void>;
export {};
