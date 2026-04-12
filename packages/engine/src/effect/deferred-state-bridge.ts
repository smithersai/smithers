import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { SmithersDb } from "@smithers/db/adapter";
import { EventBus } from "../events";
type DeferredBridgeState = "pending" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "failed" | "skipped";
type DeferredBridgeResolution = {
    handled: false;
} | {
    handled: true;
    state: DeferredBridgeState;
};
type DeferredBridgeStateEmitter = (state: "pending" | "failed" | "skipped") => Promise<void>;
export declare function isBridgeManagedTimerTask(desc: TaskDescriptor): boolean;
export declare function isBridgeManagedWaitForEventTask(desc: TaskDescriptor): boolean;
export declare function resolveDeferredTaskStateBridge(adapter: SmithersDb, db: any, runId: string, desc: TaskDescriptor, eventBus: EventBus, emitStateEvent?: DeferredBridgeStateEmitter): Promise<DeferredBridgeResolution>;
export declare function cancelPendingTimersBridge(adapter: SmithersDb, runId: string, eventBus: EventBus, reason: string): Promise<void>;
export {};
