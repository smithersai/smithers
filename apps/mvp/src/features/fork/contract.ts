// One-click Fork & upstream contributor loop contract shared between browser, ChatApi, and tests (decision 0175).
// Nothing here imports a library so every runtime can import it directly.

/** @throws {never} */
export const forkRoute = (owner: string, repo: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/fork`

/** @throws {never} */
export const syncUpstreamRoute = (owner: string, repo: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/sync-upstream`

export const FORK_STATUSES = ["none", "forking", "ready", "failed"] as const
export type ForkStatus = (typeof FORK_STATUSES)[number]

export interface ForkState {
  readonly status: ForkStatus
  readonly forkOwner?: string
  readonly forkName?: string
  readonly appInstalled?: boolean
  readonly installUrl?: string
  readonly failure?: string
  readonly isFork?: boolean
  readonly upstreamOwner?: string
  readonly upstreamName?: string
}

export interface SyncUpstreamAnswer {
  readonly synced: boolean
  readonly message: string
  readonly mergeType?: string
  readonly baseBranch?: string
}

/** GitHub compare URL to open a cross-fork PR back to upstream. */
/** @throws {never} */
export const upstreamCompareUrl = (
  upstreamOwner: string,
  upstreamName: string,
  baseBranch: string,
  forkOwner: string,
  headBranch: string,
): string =>
  `https://github.com/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamName)}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(forkOwner)}:${encodeURIComponent(headBranch)}?expand=1`

/** Direct GitHub fork fallback URL when a deployment has no GitHub OAuth session token. */
/** @throws {never} */
export const githubForkUrl = (owner: string, name: string): string =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/fork`

export const FORK_LABEL = "Fork"
export const FORKING_LABEL = "Forking…"
export const OPEN_FORK_LABEL = "Open your fork"
export const INSTALL_ON_FORK_LABEL = "Install app on fork"
export const SYNC_UPSTREAM_LABEL = "Sync upstream"
export const OPEN_UPSTREAM_PR_LABEL = "Open upstream PR"

export const FORK_TELEMETRY = {
  records: ["fork.start", "fork.sync_upstream", "smithers_web_repo_forks"],
  fields: ["outcome", "status", "durationMs"],
} as const
