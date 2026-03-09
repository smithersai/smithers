/**
 * Serializable Linear types — plain objects safe for cross-task passing.
 * SDK models use lazy-loaded relations which don't serialize cleanly.
 */

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  state: { id: string; name: string; type: string } | null;
  assignee: { id: string; name: string; email: string } | null;
  labels: { id: string; name: string }[];
  project: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type LinearTeam = {
  id: string;
  name: string;
  key: string;
  description: string | null;
};

export type LinearProject = {
  id: string;
  name: string;
  description: string | null;
  state: string;
  url: string;
};

export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string } | null;
};

export type LinearIssueStatus = {
  id: string;
  name: string;
  type: string;
  position: number;
};

export type ListIssuesParams = {
  teamId?: string;
  assigneeId?: string;
  stateType?: string;
  limit?: number;
  labels?: string[];
};
