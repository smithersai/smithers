import { randomBytes } from "node:crypto"
import type {
  PickLocalRepositoryResult,
  RepositoryAccess
} from "@smthrs/rpc/NativeRepository"
import { inspectLocalRepository } from "./LocalRepository"

/** A short-lived, one-shot capability created only after a native folder pick. */
export interface RepositoryGrant {
  readonly path: string
  readonly access: RepositoryAccess
}

export interface RepositoryAuthority {
  readonly authorize: (path: string, access: RepositoryAccess) => Promise<PickLocalRepositoryResult>
  readonly claim: (authorizationId: string) => RepositoryGrant | undefined
  readonly clear: () => void
}

export interface RepositoryAuthorityOptions {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxGrants?: number
}

const DEFAULT_GRANT_TTL_MS = 60_000
const DEFAULT_MAX_GRANTS = 16

/**
 * Owns renderer-to-host repository authority. Paths never cross the HTTP
 * process boundary in native mode: the picker inspects one, this object
 * mints a random capability, and `/api/repo/open` consumes it exactly once.
 */
export const createRepositoryAuthority = (
  options: RepositoryAuthorityOptions = {}
): RepositoryAuthority => {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_GRANT_TTL_MS
  const maxGrants = options.maxGrants ?? DEFAULT_MAX_GRANTS
  const grants = new Map<string, RepositoryGrant & { readonly expiresAt: number }>()

  const purge = (): void => {
    const at = now()
    for (const [id, grant] of grants) {
      if (grant.expiresAt <= at) grants.delete(id)
    }
    while (grants.size >= maxGrants) {
      const oldest = grants.keys().next().value as string | undefined
      if (oldest === undefined) break
      grants.delete(oldest)
    }
  }

  return {
    authorize: async (path, access) => {
      const result = await inspectLocalRepository(path, access)
      if (result.status !== "connected") return result
      purge()
      const authorizationId = randomBytes(32).toString("base64url")
      grants.set(authorizationId, {
        path: result.repository.root,
        access,
        expiresAt: now() + ttlMs
      })
      return {
        status: "connected",
        repository: { ...result.repository, authorizationId }
      }
    },
    claim: (authorizationId) => {
      const grant = grants.get(authorizationId)
      grants.delete(authorizationId)
      if (grant === undefined || grant.expiresAt <= now()) return undefined
      return { path: grant.path, access: grant.access }
    },
    clear: () => grants.clear()
  }
}
