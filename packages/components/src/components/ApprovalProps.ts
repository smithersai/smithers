import type React from "react";
import type { z } from "zod";
import type { SmithersCtx } from "@smithers-orchestrator/driver";
import type { ApprovalMode } from "./ApprovalMode.ts";
import type { ApprovalOption } from "./ApprovalOption.ts";
import type { ApprovalRequest } from "./ApprovalRequest.ts";
import type { ApprovalAutoApprove } from "./ApprovalAutoApprove.ts";
import type { ApprovalDecision } from "./ApprovalDecision.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type ApprovalProps<Row = ApprovalDecision, Output extends OutputTarget = OutputTarget> = {
	id: string;
	mode?: ApprovalMode;
	options?: ApprovalOption[];
	/** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
	output: Output;
	outputSchema?: z.ZodObject<z.ZodRawShape>;
	request: ApprovalRequest;
	onDeny?: "fail" | "continue" | "skip";
	allowedScopes?: string[];
	allowedUsers?: string[];
	autoApprove?: ApprovalAutoApprove;
	/** Do not block unrelated downstream flow while this approval is pending. */
	async?: boolean;
	/** Explicit dependency on other task node IDs. */
	dependsOn?: string[];
	/** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
	needs?: Record<string, string>;
	skipIf?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatTimeout?: number;
	retries?: number;
	retryPolicy?: import("@smithers-orchestrator/scheduler/RetryPolicy").RetryPolicy;
	continueOnFail?: boolean;
	cache?: import("@smithers-orchestrator/scheduler/CachePolicy").CachePolicy;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
	children?: React.ReactNode;
	smithersContext?: React.Context<SmithersCtx<unknown> | null>;
};
