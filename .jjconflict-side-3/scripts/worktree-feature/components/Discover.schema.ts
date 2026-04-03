import { z } from "zod";

export const Ticket = z.object({
  id: z.string().describe("Unique slug identifier (lowercase kebab-case, e.g. 'vcs-jj-rewrite')"),
  title: z.string().describe("Short imperative title"),
  description: z.string().describe("Detailed description of what needs to be implemented"),
  acceptanceCriteria: z.array(z.string()).describe("List of acceptance criteria"),
  filesToModify: z.array(z.string()).describe("Files to modify"),
  filesToCreate: z.array(z.string()).describe("Files to create"),
  dependencies: z.array(z.string()).nullable().describe("IDs of tickets this depends on"),
});
export type Ticket = z.infer<typeof Ticket>;

export const DiscoverOutput = z.object({
  tickets: z.array(Ticket).describe("All tickets to implement, ordered by dependency"),
  reasoning: z.string().describe("Why these tickets were chosen and in this order"),
});
export type DiscoverOutput = z.infer<typeof DiscoverOutput>;
