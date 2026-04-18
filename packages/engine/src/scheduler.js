// @smithers-type-exports-begin
/** @typedef {import("./ContinuationRequest.ts").ContinuationRequest} ContinuationRequest */
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphMeta.ts").RalphMeta} RalphMeta */
/** @typedef {import("./RalphState.ts").RalphState} RalphState */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("@smithers-orchestrator/scheduler").ReadonlyTaskStateMap} ReadonlyTaskStateMap */
/** @typedef {import("@smithers-orchestrator/scheduler").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("@smithers-orchestrator/scheduler").ScheduleSnapshot} ScheduleSnapshot */
/** @typedef {import("@smithers-orchestrator/scheduler").TaskRecord} TaskRecord */
/** @typedef {import("@smithers-orchestrator/scheduler").TaskState} TaskState */
/** @typedef {import("@smithers-orchestrator/scheduler").TaskStateMap} TaskStateMap */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/** @typedef {import("@smithers-orchestrator/graph/XmlNode").XmlNode} XmlNode */
// @smithers-type-exports-end

import { buildPlanTree as coreBuildPlanTree, scheduleTasks as coreScheduleTasks, } from "@smithers-orchestrator/scheduler";
export { buildStateKey } from "@smithers-orchestrator/scheduler";
export { Scheduler, SchedulerLive } from "@smithers-orchestrator/scheduler";
export { cloneTaskStateMap, isTerminalState, parseStateKey, } from "@smithers-orchestrator/scheduler";

/**
 * @type {(xml: XmlNode | null, ralphState?: RalphStateMap) => { plan: PlanNode | null; ralphs: RalphMeta[] }}
 */
export const buildPlanTree = coreBuildPlanTree;

/**
 * @type {(plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, _TaskDescriptor>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult}
 */
export const scheduleTasks = coreScheduleTasks;
