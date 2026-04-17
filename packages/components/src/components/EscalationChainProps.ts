import type React from "react";
import type { ApprovalRequest } from "./ApprovalRequest.ts";
import type { EscalationLevel } from "./EscalationLevel.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type EscalationChainProps = {
	/** ID prefix for generated nodes. */
	id?: string;
	/** Ordered escalation levels. Each level runs only if the previous escalated. */
	levels: EscalationLevel[];
	/** If `true`, the final escalation produces a human approval node. */
	humanFallback?: boolean;
	/** Approval request config used when `humanFallback` is `true`. */
	humanRequest?: ApprovalRequest;
	/** Output target for escalation tracking at each level. */
	escalationOutput: OutputTarget;
	skipIf?: boolean;
	/** Prompt / input passed to each agent level. */
	children?: React.ReactNode;
};
