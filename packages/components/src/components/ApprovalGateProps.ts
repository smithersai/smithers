import type { ApprovalRequest } from "./ApprovalRequest.ts";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import type { OutputTarget } from "./OutputTarget.ts";

export type ApprovalGateProps = {
	id: string;
	/** Where to persist the approval decision. */
	output: OutputTarget;
	/** Human-facing approval request. */
	request: ApprovalRequest;
	/** When `true`, approval is required. When `false`, auto-approves. */
	when: boolean;
	/** Behavior after denial. */
	onDeny?: "fail" | "continue" | "skip";
	skipIf?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatTimeout?: number;
	retries?: number;
	retryPolicy?: RetryPolicy;
	continueOnFail?: boolean;
};
