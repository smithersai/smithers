import type React from "react";
import type { z } from "zod";
import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { SmithersCtx } from "@smithers-orchestrator/driver";
import type { CachePolicy } from "@smithers-orchestrator/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers-orchestrator/scheduler/RetryPolicy";
import type { ScorersMap } from "@smithers-orchestrator/scorers/types";
import type { TaskMemoryConfig } from "@smithers-orchestrator/memory/types";
import type { OutputTarget } from "./OutputTarget.ts";
import type { DepsSpec } from "./DepsSpec.ts";
import type { InferDeps } from "./InferDeps.ts";

export type TaskProps<Row, Output extends OutputTarget = OutputTarget, D extends DepsSpec = {}> = {
	key?: string;
	id: string;
	/** Where to store the task's result. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
	output: Output;
	/**
	 * Optional Zod schema describing the expected agent output shape.
	 * When `output` is already a ZodObject this is inferred automatically.
	 * Used for validation and to inject schema examples into MDX prompts.
	 */
	outputSchema?: z.ZodObject<z.ZodRawShape>;
	/** Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order on retries. */
	agent?: AgentLike | AgentLike[];
	/** Convenience alias for a single retry fallback without exposing array syntax in JSX. */
	fallbackAgent?: AgentLike;
	/** Explicit dependency on other task node IDs. The task will not run until all listed tasks complete. */
	dependsOn?: string[];
	/** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
	needs?: Record<string, string>;
	/** Render-time typed dependencies. Keys resolve from task ids of the same name, or from matching `needs` entries. */
	deps?: D;
	skipIf?: boolean;
	needsApproval?: boolean;
	/** When paired with `needsApproval`, do not block unrelated downstream flow while the approval is pending. */
	async?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatTimeout?: number;
	/** Disable retries entirely. Equivalent to retries={0}. */
	noRetry?: boolean;
	retries?: number;
	retryPolicy?: RetryPolicy;
	continueOnFail?: boolean;
	cache?: CachePolicy;
	/** Optional scorers to evaluate this task's output after completion. */
	scorers?: ScorersMap;
	/** Optional cross-run memory configuration. */
	memory?: TaskMemoryConfig;
	allowTools?: string[];
	label?: string;
	meta?: Record<string, unknown>;
	/** @internal Used by createSmithers() to bind tasks to the correct workflow context. */
	smithersContext?: React.Context<SmithersCtx<unknown> | null>;
	children?: string | Row | (() => Row | Promise<Row>) | React.ReactNode | ((deps: InferDeps<D>) => Row | React.ReactNode);
};
