import { tool, zodSchema } from "ai";
import { z } from "zod";
import { useLinear } from "./useLinear";

export const linearListIssues = tool({
  description:
    "List Linear issues with optional filters for team, assignee, state type, and labels",
  inputSchema: zodSchema(
    z.object({
      teamId: z.string().optional().describe("Filter by team ID"),
      assigneeId: z.string().optional().describe("Filter by assignee ID"),
      stateType: z
        .string()
        .optional()
        .describe("Filter by state type (e.g. started, unstarted, completed)"),
      limit: z.number().optional().describe("Max results (default 50)"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Filter by label names"),
    }),
  ),
  execute: async (params) => {
    const linear = useLinear();
    return linear.listIssues(params);
  },
});

export const linearGetIssue = tool({
  description: "Get a single Linear issue by ID or identifier (e.g. JJH-42)",
  inputSchema: zodSchema(
    z.object({
      id: z.string().describe("Issue ID or identifier (e.g. JJH-42)"),
    }),
  ),
  execute: async ({ id }) => {
    const linear = useLinear();
    return linear.getIssue(id);
  },
});

export const linearUpdateIssue = tool({
  description: "Update a Linear issue state (e.g. move to In Progress, Done)",
  inputSchema: zodSchema(
    z.object({
      issueId: z.string().describe("Issue ID"),
      stateId: z.string().describe("New state ID"),
    }),
  ),
  execute: async ({ issueId, stateId }) => {
    const linear = useLinear();
    return linear.updateIssueState(issueId, stateId);
  },
});

export const linearAddComment = tool({
  description: "Add a comment to a Linear issue",
  inputSchema: zodSchema(
    z.object({
      issueId: z.string().describe("Issue ID"),
      body: z.string().describe("Comment body (markdown)"),
    }),
  ),
  execute: async ({ issueId, body }) => {
    const linear = useLinear();
    return linear.addComment(issueId, body);
  },
});

export const linearListTeams = tool({
  description: "List all teams in the Linear workspace",
  inputSchema: zodSchema(z.object({})),
  execute: async () => {
    const linear = useLinear();
    return linear.listTeams();
  },
});

/**
 * All Linear tools bundled for easy injection into agents.
 */
export const linearTools = {
  linearListIssues,
  linearGetIssue,
  linearUpdateIssue,
  linearAddComment,
  linearListTeams,
};
