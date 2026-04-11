import type { ReadonlyTaskStateMap } from "./ReadonlyTaskStateMap.ts";
import type { TaskStateMap } from "./TaskStateMap.ts";

export function cloneTaskStateMap(states: ReadonlyTaskStateMap): TaskStateMap {
  return new Map(states);
}
