import { z } from "zod";

export const ReviewOutput = z.object({
  reviewer: z.string().default("unknown").describe("Which agent reviewed (claude, codex)"),
  approved: z.boolean().describe("Whether the reviewer approves (LGTM)"),
  issues: z.array(z.object({
    severity: z.enum(["critical", "major", "minor", "nit"]),
    file: z.string(),
    line: z.number().nullable(),
    description: z.string(),
    suggestion: z.string().nullable(),
  })).describe("Issues found during review"),
  testCoverage: z.enum(["excellent", "good", "insufficient", "missing"]).describe("Test coverage assessment"),
  codeQuality: z.enum(["excellent", "good", "needs-work", "poor"]).describe("Code quality assessment"),
  feedback: z.string().describe("Overall review feedback"),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
