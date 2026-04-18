import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { TaskDescriptor } from "@smithers-orchestrator/graph/TaskDescriptor";
import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
import type { EventBus } from "../events.js";
import type { HijackState } from "../HijackState.ts";
import type { TaskBridgeToolConfig } from "./TaskBridgeToolConfig.ts";

export type LegacyExecuteTaskFn = (
	adapter: SmithersDb,
	db: BunSQLiteDatabase<Record<string, unknown>>,
	runId: string,
	desc: TaskDescriptor,
	descriptorMap: Map<string, TaskDescriptor>,
	inputTable: SQLiteTable,
	eventBus: EventBus,
	toolConfig: TaskBridgeToolConfig,
	workflowName: string,
	cacheEnabled: boolean,
	signal?: AbortSignal,
	disabledAgents?: Set<string>,
	runAbortController?: AbortController,
	hijackState?: HijackState,
) => Promise<void>;
