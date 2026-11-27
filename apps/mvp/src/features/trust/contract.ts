// Shared contracts for Smithers Cloud execution trust, the shared object store, one-time sandbox/agent auth,
// changeset stacks, and mythical history. Zero runtime library imports so browser, Worker, MCP, and tests share one source.

import { REPOS_ROUTE } from "../repo/contract.ts"

/**
 * Execution trust tier derived strictly by the server from live identity or sandbox attestation, never from a client body.
 * - `trusted_sandbox`: executed inside a Smithers-controlled sandbox (Cloudflare GateMachine / BranchSandbox / attested runner).
 * - `trusted_maintainer`: executed or signed by a live Maintainer or Admin of the repository.
 * - `untrusted_contributor`: executed by a non-maintainer contributor or community runner (encouraged, never poisons cache or skips gates).
 */
export const EXECUTION_TRUST_TIERS = [
  "trusted_sandbox",
  "trusted_maintainer",
  "untrusted_contributor",
] as const
export type ExecutionTrust = (typeof EXECUTION_TRUST_TIERS)[number]

/** Shared Smithers Cloud object store namespaces. */
export const OBJECT_NAMESPACES = [
  "artifact",
  "audit-report",
  "wiki",
  "mythical",
  "cache",
  "changeset",
] as const
export type ObjectNamespace = (typeof OBJECT_NAMESPACES)[number]

/** Valid purposes for minted one-time-use sandbox and agent authentication tokens. */
export const ONE_TIME_AUTH_PURPOSES = ["sandbox", "agent", "ci"] as const
export type OneTimeAuthPurpose = (typeof ONE_TIME_AUTH_PURPOSES)[number]

/** Canonical prefix for single-use sandbox/agent authentication tokens (`smot_<64 lowercase hex>`). */
export const ONE_TIME_TOKEN_PREFIX = "smot_"

/** Minimum, default, and maximum lifetime (in seconds) of an unredeemed one-time auth token. */
export const ONE_TIME_TOKEN_MIN_TTL_SECONDS = 60
export const ONE_TIME_TOKEN_DEFAULT_TTL_SECONDS = 300
export const ONE_TIME_TOKEN_MAX_TTL_SECONDS = 900

/** Lifetime (in seconds) of the attenuated MCP bearer token minted when a one-time token is redeemed (2 hours). */
export const ONE_TIME_REDEEMED_TOKEN_TTL_SECONDS = 2 * 60 * 60

/** Maximum object size accepted over the HTTP/MCP object store API (16 MiB for HTTP PUT; 512 KiB for MCP text/JSON). */
export const MAX_OBJECT_HTTP_BYTES = 16 * 1024 * 1024
export const MAX_OBJECT_MCP_BYTES = 512 * 1024
export const MAX_INLINE_OBJECT_BYTES = 256 * 1024

/** Route for redeeming a single-use sandbox/agent token into an attenuated bearer credential. */
export const ONE_TIME_AUTH_REDEEM_ROUTE = "/api/auth/one-time/redeem"

/** Route for minting a single-use sandbox/agent token scoped to one repository.
 * @throws {never}
 */
export const repoOneTimeAuthRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/auth/one-time`

/** Route for listing a repository's shared cloud object store entries. */
export const repoObjectsRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/objects`

/** Route for reading or writing a specific object in a repository's shared cloud object store. */
export const repoObjectRoute = (
  owner: string,
  name: string,
  namespace: ObjectNamespace,
  key: string,
): string =>
  `${repoObjectsRoute(owner, name)}/${encodeURIComponent(namespace)}/${key.split("/").map(encodeURIComponent).join("/")}`

/** Route for reading a repository's mythical history stack. */
export const repoMythicalRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mythical`

/** Route for reading a repository's stacked changesets. */
export const repoChangesetsRoute = (owner: string, name: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/changesets`

/** Whether an execution trust tier is allowed to write trusted build cache entries and satisfy merge/release gates.
 * @throws {never}
 */
export const isTrustedExecution = (trust: ExecutionTrust): boolean =>
  trust === "trusted_sandbox" || trust === "trusted_maintainer"

/** Human-readable trust badge label (no em dashes or semicolons).
 * @throws {never}
 */
export const trustLabel = (trust: ExecutionTrust): string => {
  switch (trust) {
    case "trusted_sandbox":
      return "Trusted sandbox"
    case "trusted_maintainer":
      return "Trusted maintainer"
    case "untrusted_contributor":
      return "Untrusted community run"
  }
}

/** One-time auth mint response returned to the caller (never logged or cached). */
export interface OneTimeAuthMintResult {
  readonly id: string
  readonly oneTimeToken: string
  readonly expiresAt: string
  readonly purpose: OneTimeAuthPurpose
  readonly executionTrust: ExecutionTrust
  readonly repository: string
  readonly scopes: ReadonlyArray<string>
  readonly redeemUrl: string
  readonly mcpUrl: string
  readonly shellSnippet: string
  readonly mcpSnippet: string
}

/** Response returned when a one-time auth token is atomically redeemed once. */
export interface OneTimeAuthRedeemResult {
  readonly tokenId: string
  readonly accessToken: string
  readonly tokenType: "Bearer"
  readonly expiresAt: string
  readonly repository: string
  readonly purpose: OneTimeAuthPurpose
  readonly executionTrust: ExecutionTrust
  readonly gateEligible: boolean
  readonly cacheWriteAllowed: boolean
  readonly scopes: ReadonlyArray<string>
  readonly mcpUrl: string
}

/** Summary metadata for one entry in the shared Smithers Cloud object store. */
export interface CloudObjectSummary {
  readonly id: string
  readonly repoId: string
  readonly namespace: ObjectNamespace
  readonly key: string
  readonly sha256: string
  readonly contentType: string
  readonly bytes: number
  readonly visibility: "public" | "repo_members" | "owner_only"
  readonly executionTrust: ExecutionTrust
  readonly gateEligible: boolean
  readonly commitSha: string | null
  readonly refName: string | null
  readonly runId: string | null
  readonly createdByLogin: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly updatedAt: string
}

/** Summary of one stacked changeset tracked by Smithers Cloud. */
export interface ChangesetEntry {
  readonly id: string
  readonly repoId: string
  readonly stackKey: string
  readonly position: number
  readonly title: string
  readonly summary: string
  readonly branchName: string
  readonly baseBranch: string
  readonly headSha: string | null
  readonly prNumber: number | null
  readonly status: "draft" | "open" | "verified" | "merged" | "abandoned"
  readonly executionTrust: ExecutionTrust
  readonly gateStatus: "pending" | "passed" | "failed" | "untrusted_only"
  readonly authorLogin: string
  readonly artifactRef: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly updatedAt: string
}

/** One clean narrative commit in a repository's mythical history. */
export interface MythicalCommitNote {
  readonly kind: "decision" | "evidence" | "abandoned" | "folded"
  readonly summary: string
  readonly ref?: string | undefined
}

export interface MythicalCommitEntry {
  readonly id: string
  readonly repoId: string
  readonly position: number
  readonly epic: string
  readonly title: string
  readonly summary: string
  readonly commitSha: string | null
  readonly mainFoldedSha: string | null
  readonly treeEqualToMain: boolean
  readonly prNumber: number | null
  readonly notes: ReadonlyArray<MythicalCommitNote>
  readonly authorLogin: string
  readonly createdAt: string
  readonly updatedAt: string
}
