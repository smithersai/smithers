import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";

/** GitHub organization that receives one fork per nominated repository. */
export const forkOrganization = "smithers-community";

export type RepoFork =
  | { status: "forked"; forkedAt: string }
  | { status: "failed"; error: string }
  | { status: "skipped" };

/**
 * Fork a newly nominated repository into the community organization and
 * record the outcome under `repo-fork:<owner/repo>`. Never throws: a fork
 * failure is logged and recorded, and the nomination still succeeds.
 */
export async function forkRepo(env: BugWorkerEnv, deps: BugWorkerDeps, name: string): Promise<RepoFork> {
  let fork: RepoFork;
  if (!env.GITHUB_FORK_TOKEN) {
    fork = { status: "skipped" };
  } else {
    try {
      const response = await deps.fetch(`https://api.github.com/repos/${name}/forks`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GITHUB_FORK_TOKEN}`,
          "content-type": "application/json",
          "user-agent": "Smithers-repo-requests",
        },
        body: JSON.stringify({ organization: forkOrganization }),
        signal: AbortSignal.timeout(10_000),
      });
      fork = response.ok
        ? { status: "forked", forkedAt: new Date(deps.now()).toISOString() }
        : { status: "failed", error: `GitHub responded ${response.status}` };
    } catch (error) {
      fork = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (fork.status === "failed") console.error(`repo-fork ${name} failed: ${fork.error}`);
  try {
    await env.BUGS.put(`repo-fork:${name}`, JSON.stringify(fork));
  } catch (error) {
    console.error(`repo-fork ${name} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fork;
}
