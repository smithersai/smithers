import type { TaskStateMap } from "@smithers/scheduler";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { XmlNode } from "@smithers/graph/XmlNode";
export { buildStateKey } from "@smithers/scheduler";
export { Scheduler, SchedulerLive } from "@smithers/scheduler";
export { cloneTaskStateMap, isTerminalState, parseStateKey, } from "@smithers/scheduler";
export type { ReadonlyTaskStateMap, TaskRecord, TaskState, TaskStateMap, } from "@smithers/scheduler";
export type { RetryWaitMap, ScheduleSnapshot } from "@smithers/scheduler";
export type PlanNode = {
    kind: "task";
    nodeId: string;
} | {
    kind: "sequence";
    children: PlanNode[];
} | {
    kind: "parallel";
    children: PlanNode[];
} | {
    kind: "ralph";
    id: string;
    children: PlanNode[];
    until: boolean;
    maxIterations: number;
    onMaxReached: "fail" | "return-last";
    continueAsNewEvery?: number;
} | {
    kind: "continue-as-new";
    stateJson?: string;
} | {
    kind: "group";
    children: PlanNode[];
} | {
    kind: "saga";
    id: string;
    actionChildren: PlanNode[];
    compensationChildren: PlanNode[];
    onFailure: "compensate" | "compensate-and-fail" | "fail";
} | {
    kind: "try-catch-finally";
    id: string;
    tryChildren: PlanNode[];
    catchChildren: PlanNode[];
    finallyChildren: PlanNode[];
};
export type ScheduleResult = {
    runnable: TaskDescriptor[];
    pendingExists: boolean;
    waitingApprovalExists: boolean;
    waitingEventExists: boolean;
    waitingTimerExists: boolean;
    readyRalphs: RalphMeta[];
    continuation?: ContinuationRequest;
    nextRetryAtMs?: number;
    fatalError?: string;
};
export type RalphMeta = {
    id: string;
    until: boolean;
    maxIterations: number;
    onMaxReached: "fail" | "return-last";
    continueAsNewEvery?: number;
};
export type ContinuationRequest = {
    stateJson?: string;
};
export type RalphState = {
    iteration: number;
    done: boolean;
};
export type RalphStateMap = Map<string, RalphState>;
type BuildPlanTree = (xml: XmlNode | null, ralphState?: RalphStateMap) => {
    plan: PlanNode | null;
    ralphs: RalphMeta[];
};
type ScheduleTasks = (plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, TaskDescriptor>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult;
export declare const buildPlanTree: BuildPlanTree;
export declare const scheduleTasks: ScheduleTasks;
