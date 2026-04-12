import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { SmithersDb } from "@smithers/db/adapter";
import { EventBus } from "../events";
type StaticTaskBridgeToolConfig = {
    rootDir: string;
};
export declare const canExecuteBridgeManagedStaticTask: (desc: TaskDescriptor, cacheEnabled: boolean) => boolean;
export declare const executeStaticTaskBridge: (adapter: SmithersDb, runId: string, desc: TaskDescriptor, eventBus: EventBus, toolConfig: StaticTaskBridgeToolConfig, workflowName: string, signal?: AbortSignal) => Promise<void>;
export {};
