import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { SmithersDb } from "@smithers/db/adapter";
import type { EventBus } from "../events.js";
import type { HijackState } from "../HijackState.ts";
import type { TaskBridgeToolConfig } from "./TaskBridgeToolConfig.ts";

export type LegacyExecuteTaskFn = (
	adapter: SmithersDb,
	db: any,
	runId: string,
	desc: TaskDescriptor,
	descriptorMap: Map<string, TaskDescriptor>,
	inputTable: any,
	eventBus: EventBus,
	toolConfig: TaskBridgeToolConfig,
	workflowName: string,
	cacheEnabled: boolean,
	signal?: AbortSignal,
	disabledAgents?: Set<any>,
	runAbortController?: AbortController,
	hijackState?: HijackState,
) => Promise<void>;
