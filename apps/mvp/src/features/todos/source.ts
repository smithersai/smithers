import { mayAsk } from "../auth/contract"
import type { RepoRole, Session } from "../auth/schema"
import type { Access } from "./schema"

/** A stack requires Member authority on the named repository, never the session's role on another one. */
export const stackAccess = (session: Session, roles: ReadonlyArray<RepoRole>, id: string): Access["status"] => {
  if (session.status === "signed_out") return "sign_in"
  if (session.status !== "signed_in") return "unknown"
  const role = roles.find((row) => row.id === id)
  if (role === undefined) return "unknown"
  // ChatApi refused the role read itself: an answer, sign in (401) or no role (403).
  if (role.refused !== undefined) return role.refused === "authentication" ? "sign_in" : "forbidden"
  // ChatApi couldn't answer (a 503, a rate limit): no denial, unavailable until Try again gets an answer.
  if (role.failure !== undefined) return "unavailable"
  return mayAsk(role.own ? session.role : role.role) ? "allowed" : "forbidden"
}
