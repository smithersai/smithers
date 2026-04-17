import type { AgentLike } from "@smithers/agents/AgentLike";
import type { ApprovalRequest } from "./ApprovalRequest.ts";
import type { RunbookStep } from "./RunbookStep.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type RunbookProps = {
	id?: string;
	/** Ordered steps to execute. */
	steps: RunbookStep[];
	/** Default agent for steps that don't specify one. */
	defaultAgent?: AgentLike;
	/** Default output schema for step results. */
	stepOutput: OutputTarget;
	/** Template for approval requests on risky/critical steps. */
	approvalRequest?: Partial<ApprovalRequest>;
	/** Behavior when a risky/critical step is denied: "fail" (default) or "skip". */
	onDeny?: "fail" | "skip";
	skipIf?: boolean;
};
