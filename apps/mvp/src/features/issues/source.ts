import { ShapeSource } from "@smthrs/effect-electric"
import { Stream } from "effect"
import type { Session, RepoRole } from "../auth/schema"
import type { AuthStore } from "../auth/store"
import type { RepoStore } from "../repo/store"
import type { Access } from "./schema"

/**
 * Authority for repository `id`, before any of its shapes' requests (decision 0110): its role row, as ChatApi last
 * answered this tab (decision 0079), and the session's role only where that row says it is the deployment's own. A row
 * with no role and an explicit public-read receipt lets a visitor read; a role kept from a signed-in session never does.
 * No row yet is unknown, and a repository the deployment doesn't sync is `elsewhere`, for anyone: nothing is requested.
 */
export const repositoryAccess = (session: Session, roles: ReadonlyArray<RepoRole>, id: string): Access["status"] => {
  const row = roles.find((role) => role.id === id)
  if (row === undefined) return "unknown"
  if (row.synced === false) return "elsewhere"
  if (row.role === null && row.readable === true) return "allowed"
  if (session.status === "signed_in") return (row.own ? session.role : row.role) === null ? "forbidden" : "allowed"
  return session.status === "signed_out" ? "sign_in" : "unknown"
}

/** Every request, including reconnects, waits for current device authority. The server still checks every request. */
export const repositoryShapeSource = (
  source: ShapeSource.Source,
  access: Stream.Stream<Access["status"]>,
): ShapeSource.Source => ShapeSource.gated(source, Stream.map(access, (status) => status === "allowed"))

/** Session and repository `id`'s role changes decide its access independently of transport success or refusal. */
export const repositoryAccessChanges = (auth: AuthStore["Service"], repos: RepoStore["Service"], id: string) =>
  Stream.zipLatest(auth.sessionState.rows, repos.rolesState.rows).pipe(
    Stream.map(([sessions, roles]) => repositoryAccess(sessions[0]!, roles, id)),
    Stream.changes,
  )

/** What a shape's transport can say: it answered, it failed, or the deployment doesn't act on the repository (`404`). */
export type Transport = "allowed" | "unavailable" | "elsewhere"

/** Transport can change availability only after the device granted access; it never grants or revokes authority. */
export const syncStatusAfter = (current: Access["status"], transport: Transport): Access["status"] =>
  current === "allowed" || current === "unavailable" || current === "elsewhere" ? transport : current
