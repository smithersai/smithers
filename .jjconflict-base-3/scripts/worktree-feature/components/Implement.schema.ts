import { z } from "zod";

export const ImplementOutput = z.object({
  filesCreated: z.array(z.string()).nullable().describe("Files created"),
  filesModified: z.array(z.string()).nullable().describe("Files modified"),
  commitMessages: z.array(z.string()).describe("Git commit messages made"),
  whatWasDone: z.string().describe("Detailed description of what was implemented"),
  testsWritten: z.array(z.string()).describe("Test files written"),
  docsUpdated: z.array(z.string()).describe("Documentation files updated"),
  allTestsPassing: z.boolean().describe("Whether all tests pass after implementation"),
  testOutput: z.string().describe("Output from running tests"),
});
export type ImplementOutput = z.infer<typeof ImplementOutput>;
