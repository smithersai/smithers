import { Context } from "effect";
/** @typedef {import("@smithers-orchestrator/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("./RetryWaitMap.ts").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */

/**
 * @typedef {{
 *   readonly schedule: (
 *     plan: PlanNode | null,
 *     states: TaskStateMap,
 *     descriptors: Map<string, TaskDescriptor>,
 *     ralphState: RalphStateMap,
 *     retryWait: RetryWaitMap,
 *     nowMs: number,
 *   ) => import("effect").Effect.Effect<ScheduleResult>
 * }} SchedulerService
 */

const SchedulerBase =
  /** @type {Context.TagClass<Scheduler, "Scheduler", SchedulerService>} */ (
    /** @type {unknown} */ (Context.Tag("Scheduler")())
  );

export class Scheduler extends SchedulerBase {
}
