// External agents on runner machines (decision 0133, docs/features/agent-runners.md): the routes and limits the browser,
// the server and a runner share. Nothing here names an agent vendor.

/** How long a runner's claim holds its job past each heartbeat. A runner heartbeats every 10 seconds. */
export const LEASE_SECONDS = 45

/** The most bytes a runner's request body may hold: a settlement carries the change, at most 1 MiB before base64. */
export const MAX_RUNNER_BODY_BYTES = 2 * 1024 * 1024

/** The most bytes an Admin's runner or agent write may hold. */
export const MAX_ADMIN_BODY_BYTES = 8 * 1024

/** The agent a repository codes with when an Admin set none: Smithers' own. */
export const SMITHERS_AGENT = "smithers"

/** What an Admin's write is about: one of a repository's runners, or one of its agents. */
export type AdminKind = "runners" | "agents"

/** The repository and the runner or agent an Admin's write route names, or undefined for any other path. */
export const parseAdminRoute = (
  path: string,
): { readonly kind: AdminKind; readonly owner: string; readonly name: string; readonly item: string } | undefined => {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/(runners|agents)\/([^/]+)$/.exec(path)
  if (match === null) return undefined
  try {
    return {
      kind: match[3] as AdminKind,
      owner: decodeURIComponent(match[1]!),
      name: decodeURIComponent(match[2]!),
      item: decodeURIComponent(match[4]!),
    }
    // expected: a malformed route names nothing
  } catch {
    return undefined
  }
}

/** The execution id of one Admin write: its kind, its op and a fresh id. */
export const adminExecutionId = (kind: AdminKind, op: "put" | "delete", id: string): string => `${kind}-${op}:${id}`

/** Why a write was refused: one code per answer. */
export const REFUSALS = ["authentication", "forbidden", "not_found", "invalid", "too_large", "unavailable"] as const
export type Refusal = (typeof REFUSALS)[number]

/** The bytes a base64 string decodes to: what a settled file adds against a change's limits. */
export const base64Bytes = (base64: string): number =>
  Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0)
