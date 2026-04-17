import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";

type AnySchema = any;
type AnyEffect = any;

type BuilderStepContext = Record<string, unknown> & {
	input: unknown;
	executionId: string;
	stepId: string;
	attempt: number;
	signal: AbortSignal;
	iteration: number;
	heartbeat: (data?: unknown) => void;
	lastHeartbeat: unknown | null;
};

type ApprovalOptions = {
	needs?: Record<string, BuilderStepHandle>;
	request: (ctx: Record<string, unknown>) => {
		title: string;
		summary?: string | null;
	};
	onDeny?: "fail" | "continue" | "skip";
};

export type BuilderStepHandle = {
	kind: "step" | "approval";
	id: string;
	localId: string;
	tableKey: string;
	tableName: string;
	table: any;
	output: AnySchema;
	needs: Record<string, BuilderStepHandle>;
	run?: (ctx: BuilderStepContext) => AnyEffect;
	request?: ApprovalOptions["request"];
	onDeny?: "fail" | "continue" | "skip";
	retries: number;
	retryPolicy?: RetryPolicy;
	timeoutMs: number | null;
	skipIf?: (ctx: BuilderStepContext) => boolean;
	loopId?: string;
	cache?: CachePolicy;
};
