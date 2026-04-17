import type { z } from "zod";
import type { approvalRankingSchema } from "./Approval.js";

export type ApprovalRanking = z.infer<typeof approvalRankingSchema>;
