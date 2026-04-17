import type { z } from "zod";
import type { approvalDecisionSchema } from "./Approval.js";

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
