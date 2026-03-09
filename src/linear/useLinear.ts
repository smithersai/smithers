import { getLinearClient } from "./client";
import type {
  LinearIssue,
  LinearTeam,
  LinearProject,
  LinearComment,
  LinearIssueStatus,
  ListIssuesParams,
} from "./types";

async function resolveIssue(node: any): Promise<LinearIssue> {
  const [state, assignee, labels, project] = await Promise.all([
    node.state,
    node.assignee,
    node.labels(),
    node.project,
  ]);
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: node.priority,
    priorityLabel: node.priorityLabel,
    state: state ? { id: state.id, name: state.name, type: state.type } : null,
    assignee: assignee
      ? { id: assignee.id, name: assignee.name, email: assignee.email }
      : null,
    labels: labels.nodes.map((l: any) => ({ id: l.id, name: l.name })),
    project: project ? { id: project.id, name: project.name } : null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
    url: node.url,
  };
}

export function useLinear() {
  const client = getLinearClient();

  return {
    async listIssues(params: ListIssuesParams = {}): Promise<LinearIssue[]> {
      const filter: any = {};
      if (params.teamId) filter.team = { id: { eq: params.teamId } };
      if (params.assigneeId)
        filter.assignee = { id: { eq: params.assigneeId } };
      if (params.stateType) filter.state = { type: { eq: params.stateType } };
      if (params.labels?.length)
        filter.labels = { name: { in: params.labels } };

      const result = await client.issues({
        filter,
        first: params.limit ?? 50,
      });
      return Promise.all(result.nodes.map(resolveIssue));
    },

    async getIssue(idOrIdentifier: string): Promise<LinearIssue> {
      const node = await client.issue(idOrIdentifier);
      return resolveIssue(node);
    },

    async updateIssueState(
      issueId: string,
      stateId: string,
    ): Promise<boolean> {
      const result = await client.updateIssue(issueId, { stateId });
      return result.success;
    },

    async addComment(issueId: string, body: string): Promise<string> {
      const result = await client.createComment({ issueId, body });
      const comment = await result.comment;
      return comment?.id ?? "";
    },

    async listComments(issueId: string): Promise<LinearComment[]> {
      const issue = await client.issue(issueId);
      const comments = await issue.comments();
      return comments.nodes.map((c: any) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: c._user ? { id: c._user.id, name: c._user.name } : null,
      }));
    },

    async listTeams(): Promise<LinearTeam[]> {
      const result = await client.teams();
      return result.nodes.map((t: any) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        description: t.description ?? null,
      }));
    },

    async listProjects(): Promise<LinearProject[]> {
      const result = await client.projects();
      return result.nodes.map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        state: p.state,
        url: p.url,
      }));
    },

    async listIssueStatuses(teamId: string): Promise<LinearIssueStatus[]> {
      const team = await client.team(teamId);
      const states = await team.states();
      return states.nodes.map((s: any) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        position: s.position,
      }));
    },
  };
}
