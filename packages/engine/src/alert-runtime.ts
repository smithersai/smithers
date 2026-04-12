import type { SmithersAlertPolicy } from "@smithers/scheduler/SmithersWorkflowOptions";
export type AlertHumanRequestOptions = {
    runId: string;
    nodeId: string;
    iteration: number;
    kind: "ask" | "confirm" | "select" | "json";
    prompt: string;
    linkedAlertId?: string;
};
export type AlertRuntimeServices = {
    runId: string;
    adapter: unknown;
    eventBus: unknown;
    requestCancel: () => void;
    createHumanRequest: (options: AlertHumanRequestOptions) => Promise<void>;
    pauseScheduler: (reason: string) => void;
};
export declare class AlertRuntime {
    readonly policy: SmithersAlertPolicy;
    readonly services: AlertRuntimeServices;
    constructor(policy: SmithersAlertPolicy, services: AlertRuntimeServices);
    start(): void;
    stop(): void;
}
