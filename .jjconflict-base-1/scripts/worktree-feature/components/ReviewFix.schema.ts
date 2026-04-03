import { z } from "zod";

export const ReviewFixOutput = z.object({
  fixesMade: z.array(z.object({
    issue: z.string(),
    fix: z.string(),
    file: z.string(),
  })).describe("Fixes applied"),
  falsePositiveComments: z.array(z.object({
    file: z.string(),
    line: z.number(),
    issue: z.string().describe("The review issue that was a false positive"),
    rationale: z.string().describe("Why this is a false positive"),
  })).nullable().describe("False positives to suppress in future reviews"),
  commitMessages: z.array(z.string()).describe("Commit messages for fixes"),
  allIssuesResolved: z.boolean().describe("Whether all review issues were resolved"),
  summary: z.string().describe("Summary of fixes"),
});
export type ReviewFixOutput = z.infer<typeof ReviewFixOutput>;
