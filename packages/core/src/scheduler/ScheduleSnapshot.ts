import type { PlanNode } from "./PlanNode.ts";
import type { ScheduleResult } from "./ScheduleResult.ts";

export type ScheduleSnapshot = {
  readonly plan: PlanNode | null;
  readonly result: ScheduleResult;
  readonly computedAtMs: number;
};
