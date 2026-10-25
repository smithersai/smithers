import type { Role } from "./contract"

/** Signed-in status and repository role available to browser actions. */
export interface Viewer {
  readonly signedIn: boolean
  readonly role: Role | null
}

/** ChatApi's current session, falling back to the last confirmed session while reconnecting. */
export const viewerOf = (
  session: { readonly status: "loading" | "signed_in" | "signed_out" | "unreachable"; readonly role: Role | null },
  confirmed: { readonly role: Role | null } | undefined,
): Viewer => {
  if (session.status === "signed_in") return { signedIn: true, role: session.role }
  if (session.status === "signed_out" || confirmed === undefined) return { signedIn: false, role: null }
  return { signedIn: true, role: confirmed.role }
}

/** ChatApi's answer of who the person is on one repository (`RepoRole` in schema.ts): their role there, and whether it is the deployment's own. */
export interface RepoAnswer {
  readonly role: Role | null
  readonly own: boolean
}

/**
 * Who the person is on the routed repository (decision 0079): signed in, as `viewerOf` says; their role there, as
 * ChatApi answered for that repository (`answer`), none until it has, so nothing role-gated shows on a repository it
 * never answered; and whether it is the deployment's own repository, where the features still fenced to it act.
 */
export interface Here {
  readonly signedIn: boolean
  readonly role: Role | null
  readonly own: boolean
}

export const hereOf = (
  session: { readonly status: "loading" | "signed_in" | "signed_out" | "unreachable"; readonly role: Role | null },
  confirmed: { readonly role: Role | null } | undefined,
  answer: RepoAnswer | undefined,
): Here => {
  const viewer = viewerOf(session, confirmed)
  return {
    signedIn: viewer.signedIn,
    role: viewer.signedIn && answer !== undefined ? answer.role : null,
    own: answer?.own ?? false,
  }
}

/**
 * Whether ChatApi answered that the routed repository is the deployment's own (`GITHUB_REPOSITORY`), where the
 * features still fenced to it act (secrets, custom domains, asking from its home, its synced lists). Unknown fails
 * closed: no answer yet is not the deployment's own.
 */
export const ownRepository = (answer: RepoAnswer | undefined): boolean => answer?.own === true
