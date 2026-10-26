import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Stream } from "effect"
import type { Session, RepoRole } from "../auth/schema"
import type { AuthStore } from "../auth/store"
import type { RepoStore } from "../repo/store"
import type { Access } from "./schema"

/** Authority for the deployment repository, before any shape request. Public read receipts name that repository. */
export const repositoryAccess = (session: Session, roles: ReadonlyArray<RepoRole>): Access["status"] => {
  if (roles.some((row) => row.own && row.role === null && row.readable === true)) return "allowed"
  if (session.status === "signed_in") return session.role === null ? "forbidden" : "allowed"
  return session.status === "signed_out" ? "sign_in" : "unknown"
}

/** Every request, including reconnects, waits for current device authority. The server still checks every request. */
export const repositoryShapeSource = (
  source: ShapeSource.Source,
  access: Stream.Stream<Access["status"]>,
): ShapeSource.Source => ({
  cacheNamespace: source.cacheNamespace,
  request: (url, init) => access.pipe(
    Stream.filter((status) => status === "allowed"),
    Stream.take(1),
    Stream.runDrain,
    Effect.andThen(source.request(url, init)),
  ),
})

/** Session and role changes decide access independently of transport success or refusal. */
export const repositoryAccessChanges = (auth: AuthStore["Service"], repos: RepoStore["Service"]) =>
  Stream.zipLatest(auth.sessionState.rows, repos.rolesState.rows).pipe(
    Stream.map(([sessions, roles]) => repositoryAccess(sessions[0]!, roles)),
    Stream.changes,
  )

/** Transport recovery can change availability only after the device granted access. */
export const syncStatusAfter = (current: Access["status"], transport: "allowed" | "unavailable"): Access["status"] =>
  current === "allowed" || current === "unavailable" ? transport : current
