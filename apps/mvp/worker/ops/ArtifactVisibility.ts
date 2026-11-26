import type { Actor, Role } from "../Actor.vibe"
import { rankOf } from "../Actor.vibe"
import { holdsDeploymentAuthority } from "../DeploymentPolicy.vibe"

// Who may read a repository's notes and artifacts, and who may change who may (plan tree M0, private Smithers-Ops).
//
//   visibility       who reads
//   public           anyone, signed in or not, once a person approved it
//   repo_members     a Member or above on the repository, or a run acting for one
//   owner_only       the artifact's owner, in person
//
// A private ops repository (`smithersai/Smithers-Ops`) is owner-only whatever an artifact says: only a deployment
// admin (`DEPLOYMENT_ADMIN_LOGINS`), signed in as a person, reads it or changes anything in it, and nothing in it can
// be widened. Every other artifact starts `repo_members`, so a public repository's artifact is public only by opt-in.
// `public` counts only with a person's approval on record: a delegated agent, flow, frame or sandbox can never make
// one public. An artifact the caller may not read answers exactly what a missing one answers, so a refusal carries
// no title, path, size, or the fact that it exists.
//
// A repository is named by its authoritative ID, GitHub's `owner/name`, compared lowercase. An ID that is not exactly
// `owner/name` (a trailing slash, whitespace, an empty or extra segment) is refused before any rule runs. The built-in
// ops set is always in force: a deployment's `opsRepositories` adds to it and never replaces it, and a malformed entry
// there makes every repository ops-only until it is fixed. A role counts only through a `Membership` resolved for the
// artifact's own repository: the role an `Actor` carries, or one resolved for another repository, never authorizes.

/** An artifact's visibility. */
export type Visibility = "public" | "repo_members" | "owner_only"

export const VISIBILITIES: ReadonlyArray<Visibility> = ["public", "repo_members", "owner_only"]

/** Private ops repositories that every deployment protects, as lowercase `owner/name`. */
export const PRIVATE_OPS_REPOSITORIES: ReadonlySet<string> = new Set(["smithersai/smithers-ops"])

/** GitHub's `owner/name`: an owner of 1 to 39 letters, digits or hyphens, and a name that is not `.` or `..`. */
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

/** A repository ID in its one comparable form, lowercase `owner/name`, or `undefined` when it is malformed. */
export const canonicalRepositoryId = (id: unknown): string | undefined =>
  typeof id === "string" && REPOSITORY_ID.test(id) ? id.toLowerCase() : undefined

export interface Repository {
  /** The authoritative repository ID, GitHub's `owner/name`. */
  readonly fullName: string
  readonly private: boolean
}

/** A role resolved for one repository: what GitHub says the actor holds on `repoId`, read for that repository. */
export interface Membership {
  readonly repoId: string
  readonly role: Role | null
}

/** Who made an artifact public: always a person acting in person. */
export interface PublicApproval {
  readonly kind: "person"
  readonly id: string
  readonly login: string
}

export interface Artifact {
  readonly repository: Repository
  readonly path: string
  readonly title: string
  readonly size: number
  /** The owner's person id. */
  readonly owner: string
  /** What was stored. Missing, unknown, or `public` without an approval falls back to the default. */
  readonly visibility?: string
  readonly approvedBy?: PublicApproval
}

/** The deployment's configuration this policy reads. */
export interface Policy {
  /** `DEPLOYMENT_ADMIN_LOGINS`: the only people who may read or change a private ops repository. */
  readonly admins: ReadonlySet<string>
  /** More ops repositories, as `owner/name` in any case. They add to {@link PRIVATE_OPS_REPOSITORIES}. */
  readonly opsRepositories?: Iterable<string>
}

/** Every ops repository a policy protects, lowercase, or `undefined` when a configured entry is malformed. */
export const opsRepositoriesOf = (policy: Policy): ReadonlySet<string> | undefined => {
  const all = new Set(PRIVATE_OPS_REPOSITORIES)
  for (const entry of policy.opsRepositories ?? []) {
    const id = canonicalRepositoryId(entry)
    if (id === undefined) return undefined
    all.add(id)
  }
  return all
}

/** Whether a repository is ops-only. A malformed repository ID or ops configuration counts as ops, failing closed. */
export const isOpsRepository = (repository: Repository, policy: Policy): boolean => {
  const id = canonicalRepositoryId(repository.fullName)
  const ops = opsRepositoriesOf(policy)
  return id === undefined || ops === undefined || ops.has(id)
}

/** The role `membership` grants on `repository`: only when it was resolved for that same repository. */
const roleOn = (repository: Repository, membership: Membership | undefined): Role | null => {
  const id = canonicalRepositoryId(repository.fullName)
  return membership !== undefined && id !== undefined && canonicalRepositoryId(membership.repoId) === id ? membership.role : null
}

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/** A stored approval counts only when it names a person by id and login. */
const approvedByPerson = (approval: PublicApproval | undefined): boolean =>
  approval !== undefined && approval.kind === "person" && filled(approval.id) && filled(approval.login)

/** The visibility an artifact starts with: owner-only in an ops repository, members-only everywhere else. */
export const defaultVisibility = (repository: Repository, policy: Policy): Visibility =>
  isOpsRepository(repository, policy) ? "owner_only" : "repo_members"

const known = (value: string | undefined): value is Visibility => VISIBILITIES.includes(value as Visibility)

/** The visibility that applies: ops repositories stay owner-only, and `public` needs a person's approval. */
export const effectiveVisibility = (artifact: Artifact, policy: Policy): Visibility => {
  if (isOpsRepository(artifact.repository, policy)) return "owner_only"
  const stored = artifact.visibility
  if (!known(stored)) return defaultVisibility(artifact.repository, policy)
  if (stored === "public" && !approvedByPerson(artifact.approvedBy)) return defaultVisibility(artifact.repository, policy)
  return stored
}

const inPerson = (actor: Actor | undefined): actor is Actor => actor !== undefined && actor.act === undefined

/**
 * Whether `actor` (undefined when signed out) may read `artifact`. `membership` is the actor's role resolved for the
 * artifact's repository. A malformed repository ID reads nothing, and an ops repository only its deployment admins.
 */
export const canRead = (actor: Actor | undefined, artifact: Artifact, policy: Policy, membership?: Membership): boolean => {
  if (canonicalRepositoryId(artifact.repository.fullName) === undefined) return false
  if (isOpsRepository(artifact.repository, policy)) return actor !== undefined && holdsDeploymentAuthority(actor, policy.admins)
  switch (effectiveVisibility(artifact, policy)) {
    case "public":
      return true
    case "repo_members":
      return actor !== undefined && rankOf(roleOn(artifact.repository, membership)) >= rankOf("member")
    case "owner_only":
      return inPerson(actor) && actor.subject.id === artifact.owner
  }
}

/** The one answer for an artifact the caller may not read, and for one that does not exist. */
export const NOT_FOUND = { status: 404, body: { error: "not_found" } } as const

/** The one answer for an artifact the caller may read but not change. */
export const FORBIDDEN = { status: 403, body: { error: "forbidden" } } as const

export type Answer<A> =
  | { readonly status: 200; readonly body: A }
  | typeof NOT_FOUND
  | typeof FORBIDDEN

export interface ArtifactView {
  readonly path: string
  readonly title: string
  readonly size: number
  readonly visibility: Visibility
}

/** A read: the artifact, or {@link NOT_FOUND} whether it is missing or hidden. */
export const readArtifact = (
  actor: Actor | undefined,
  artifact: Artifact | undefined,
  policy: Policy,
  membership?: Membership,
): Answer<ArtifactView> => {
  if (artifact === undefined || !canRead(actor, artifact, policy, membership)) return NOT_FOUND
  return {
    status: 200,
    body: { path: artifact.path, title: artifact.title, size: artifact.size, visibility: effectiveVisibility(artifact, policy) },
  }
}

/**
 * Changes an artifact's visibility. A caller who cannot read it gets {@link NOT_FOUND}. Only a person may change it:
 * its owner, or a Maintainer or above on the artifact's own repository per `membership`. Making it `public` needs a known login and records that person as its approver. In an ops repository
 * only a deployment admin gets past the read, and nothing there may become anything but `owner_only`.
 */
export const setVisibility = (
  actor: Actor | undefined,
  artifact: Artifact | undefined,
  visibility: string,
  policy: Policy,
  membership?: Membership,
): Answer<Artifact> => {
  if (artifact === undefined || !canRead(actor, artifact, policy, membership)) return NOT_FOUND
  if (!inPerson(actor) || !known(visibility)) return FORBIDDEN
  if (isOpsRepository(artifact.repository, policy) && visibility !== "owner_only") return FORBIDDEN
  if (actor.subject.id !== artifact.owner && rankOf(roleOn(artifact.repository, membership)) < rankOf("maintainer")) return FORBIDDEN
  if (visibility === "public" && (!filled(actor.login) || !filled(actor.subject.id))) return FORBIDDEN
  const { approvedBy: _previous, ...rest } = artifact
  const approvedBy: PublicApproval | undefined = visibility === "public"
    ? { kind: "person", id: actor.subject.id, login: actor.login! }
    : undefined
  return { status: 200, body: approvedBy === undefined ? { ...rest, visibility } : { ...rest, visibility, approvedBy } }
}
