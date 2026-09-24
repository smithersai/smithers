import { runGh as defaultRunGh } from "../../src/github/runGh.ts";

const STATUS_MARKER = "<!-- smithers-review-status -->";

/**
 * One sticky status comment per PR: create it on first call, update the same
 * comment (found by its hidden marker) on later calls, so the PR timeline
 * shows a single live status line instead of a trail of bot comments.
 * Best-effort by design: a comment failure must never fail the review job,
 * so every error degrades to a `::warning::` annotation.
 */
export async function upsertStatusComment(args: {
  workspace: string;
  /** "owner/repo", i.e. GITHUB_REPOSITORY. */
  repository: string;
  prNumber: number;
  /** Comment text; the hidden marker is prepended automatically. */
  body: string;
  runGh?: typeof defaultRunGh;
}): Promise<void> {
  const runGh = args.runGh ?? defaultRunGh;
  const body = `${STATUS_MARKER}\n${args.body}`;
  try {
    const raw = await runGh(args.workspace, [
      "api",
      "--paginate",
      `repos/${args.repository}/issues/${args.prNumber}/comments`,
      "--jq",
      `.[] | select(.user.login == "github-actions[bot]" and .user.type == "Bot") | select(.body | startswith("${STATUS_MARKER}")) | .id`,
    ]);
    const existingId = raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^\d+$/.test(line));
    if (existingId) {
      await runGh(
        args.workspace,
        ["api", "--method", "PATCH", `repos/${args.repository}/issues/comments/${existingId}`, "--input", "-"],
        JSON.stringify({ body }),
      );
    } else {
      await runGh(
        args.workspace,
        ["api", "--method", "POST", `repos/${args.repository}/issues/${args.prNumber}/comments`, "--input", "-"],
        JSON.stringify({ body }),
      );
    }
  } catch (error) {
    console.log(`::warning::smithers review status comment failed: ${(error as Error).message.slice(0, 200)}`);
  }
}
