import type { TaskDescriptor } from "@smithers/graph";
import type { TaskState } from "./TaskState.ts";
export declare function isTerminalState(state: TaskState, descriptor?: Pick<TaskDescriptor, "continueOnFail">): boolean;
