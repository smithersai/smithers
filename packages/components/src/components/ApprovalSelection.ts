import type { z } from "zod";
import type { approvalSelectionSchema } from "./Approval.js";

export type ApprovalSelection = z.infer<typeof approvalSelectionSchema>;
