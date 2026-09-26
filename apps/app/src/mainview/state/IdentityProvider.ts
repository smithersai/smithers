import type { AppServices } from "./AppController"
import type { IdentitySession } from "./AppState"

export type IdentityProvider = "github" | "local"

/** The selected authentication door, not the spelling of an account's login. */
export const identityProviderFor = (services: Pick<AppServices, "bootstrap" | "applicationTarget" | "applicationIdentity" | "localIdentity">): IdentityProvider => {
  const hostedSession = services.bootstrap?.host === "cloud" &&
    (services.applicationTarget === undefined || services.applicationTarget.auth.kind === "session")
  const ownerCredentials = services.bootstrap?.host !== "cloud" && services.localIdentity !== undefined &&
    services.applicationTarget?.ownership === "owner" && services.applicationTarget.auth.kind === "session"
  return ownerCredentials || (!hostedSession && services.applicationIdentity !== undefined) ? "local" : "github"
}

/** Backend credentials and bearer identities never establish a GitHub connection. */
export const hasGitHubIdentity = (identity: IdentitySession | undefined, provider: IdentityProvider): boolean =>
  provider === "github" && identity?.state === "signed-in" && identity.provider !== "local"
