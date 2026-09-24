/**
 * Pure decision: should this workflow run a review for the given GitHub event
 * payload? Two events count:
 *
 *   pull_request   non-draft same-repo PR (forks have no secrets and a
 *                  read-only token; skip them rather than fail), and only for
 *                  actions that change the reviewable diff: opened,
 *                  synchronize, reopened, ready_for_review. Everything else
 *                  (labeled, edited, assigned, …) skips with a reason.
 *   issue_comment  action is "created" (edited/deleted comments never
 *                  re-trigger), comment is on a PR, body starts with the magic
 *                  phrase "@smithers review", and the author's association is
 *                  OWNER / MEMBER / COLLABORATOR.
 *
 * Returns the PR number (and the head SHA for `pull_request` events, when
 * present) so the orchestrator can pass it to the CLI.
 */
const MAGIC_PHRASE = "@smithers review";
const COLLAB_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEWABLE_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export type GateInputEvent = "pull_request" | "issue_comment";

export type GateDecision =
  | {
      run: true;
      eventName: GateInputEvent;
      prNumber: number;
      headSha?: string;
    }
  | {
      run: false;
      reason: string;
    };

export interface GateInput {
  eventName: string;
  payload: unknown;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function gateEvent({ eventName, payload }: GateInput): GateDecision {
  const top = obj(payload) ?? {};

  if (eventName === "pull_request") {
    const action = typeof top.action === "string" ? top.action : "";
    if (!REVIEWABLE_PR_ACTIONS.has(action)) {
      return {
        run: false,
        reason: `pull_request action "${action || "(missing)"}" does not change the diff (reviewed on: opened, synchronize, reopened, ready_for_review)`,
      };
    }
    const pr = obj(top.pull_request);
    if (!pr) return { run: false, reason: "pull_request event missing pull_request payload" };
    if (pr.draft === true) return { run: false, reason: "pull request is a draft" };
    const head = obj(pr.head);
    const base = obj(pr.base);
    const headFull = obj(head?.repo)?.full_name;
    const baseFull = obj(base?.repo)?.full_name ?? obj(top.repository)?.full_name;
    if (typeof headFull !== "string" || !headFull || typeof baseFull !== "string" || !baseFull) {
      return { run: false, reason: "pull request repository unavailable" };
    }
    if (headFull.toLowerCase() !== baseFull.toLowerCase()) {
      return { run: false, reason: "fork pull requests are not reviewed" };
    }
    const number = pr.number;
    if (typeof number !== "number") {
      return { run: false, reason: "pull_request event missing pull request number" };
    }
    const sha = typeof head?.sha === "string" ? head.sha : undefined;
    return { run: true, eventName: "pull_request", prNumber: number, headSha: sha };
  }

  if (eventName === "issue_comment") {
    const action = typeof top.action === "string" ? top.action : "";
    if (action !== "created") {
      // Only a freshly posted comment triggers a review. Editing or deleting a
      // comment that starts with the magic phrase would otherwise re-run (and
      // could be spammed to re-run) a review the diff has not changed for.
      return {
        run: false,
        reason: `issue_comment action "${action || "(missing)"}" is not "created"`,
      };
    }
    const issue = obj(top.issue);
    const comment = obj(top.comment);
    if (!issue || !obj(issue.pull_request)) {
      return { run: false, reason: "comment is not on a pull request" };
    }
    const rawBody = comment?.body;
    const body = typeof rawBody === "string" ? rawBody.trim().toLowerCase() : "";
    if (!body.startsWith(MAGIC_PHRASE)) {
      return { run: false, reason: `comment does not start with "${MAGIC_PHRASE}"` };
    }
    const assoc = comment?.author_association;
    if (typeof assoc !== "string" || !COLLAB_ASSOCIATIONS.has(assoc)) {
      return {
        run: false,
        reason: `comment author association "${String(assoc)}" is not OWNER/MEMBER/COLLABORATOR`,
      };
    }
    const number = issue.number;
    if (typeof number !== "number") {
      return { run: false, reason: "issue_comment payload missing PR number" };
    }
    return { run: true, eventName: "issue_comment", prNumber: number };
  }

  return { run: false, reason: `unsupported event "${eventName}"` };
}
