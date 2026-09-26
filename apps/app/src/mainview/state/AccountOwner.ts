import type { IdentitySession } from "./AppState"

/**
 * The owner of the account data on this page: the login that signed in, kept
 * through an identity outage, and null once a definitive answer says nobody
 * is signed in. Undefined means unknown: a legacy row whose outage lost the
 * name, or no identity row at all.
 */
export const accountOwnerOf = (identity: IdentitySession | undefined): string | null | undefined =>
  identity === undefined ? undefined :
    identity.accountOwnerLogin !== undefined ? identity.accountOwnerLogin :
      identity.state === "signed-in" ? identity.login : identity.state === "unavailable" ? undefined : null

/** A known provider switch is a new account even when both accounts spell their login alike. */
export const accountProviderChanged = (previous: IdentitySession["provider"], next: IdentitySession["provider"]): boolean =>
  previous !== undefined && next !== undefined && previous !== next
