// @smithers-type-exports-begin
/** @typedef {import("./ContinuationRequest.ts").ContinuationRequest} ContinuationRequest */
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphMeta.ts").RalphMeta} RalphMeta */
/** @typedef {import("./RalphState.ts").RalphState} RalphState */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("@smithers/scheduler").ReadonlyTaskStateMap} ReadonlyTaskStateMap */
/** @typedef {import("@smithers/scheduler").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("@smithers/scheduler").ScheduleSnapshot} ScheduleSnapshot */
/** @typedef {import("@smithers/scheduler").TaskRecord} TaskRecord */
/** @typedef {import("@smithers/scheduler").TaskState} TaskState */
/** @typedef {import("@smithers/scheduler").TaskStateMap} TaskStateMap */
/** @typedef {import("@smithers/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smithers/graph/XmlNode").XmlNode} XmlNode */
// @smithers-type-exports-end

import { buildPlanTree as coreBuildPlanTree, scheduleTasks as coreScheduleTasks, } from "@smithers/scheduler";
export { buildStateKey } from "@smithers/scheduler";
export { Scheduler, SchedulerLive } from "@smithers/scheduler";
export { cloneTaskStateMap, isTerminalState, parseStateKey, } from "@smithers/scheduler";

/**
 * @type {(xml: XmlNode | null, ralphState?: RalphStateMap) => { plan: PlanNode | null; ralphs: RalphMeta[] }}
 */
export const buildPlanTree = coreBuildPlanTree;

/**
 * @type {(plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, TaskDescriptor>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult}
 */
export const scheduleTasks = coreScheduleTasks;
