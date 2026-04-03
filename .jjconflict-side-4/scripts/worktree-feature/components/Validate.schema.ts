import { z } from "zod";

export const ValidateOutput = z.object({
  allPassed: z.boolean().describe("Whether `bun test` exited with status 0"),
  failingSummary: z.string().nullable().describe("Summary of what failed and why (null if all passed)"),
  fullOutput: z.string().describe("Full output from `bun test`"),
});
export type ValidateOutput = z.infer<typeof ValidateOutput>;
