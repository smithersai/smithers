import { mayAsk } from "../auth/contract"
import type { RepoRole, Session } from "../auth/schema"
import type { Access } from "./schema"

/** A stack requires Member authority on the named repository, never the session's role on another one. */
export const stackAccess = (session: Session, roles: ReadonlyArray<RepoRole>, id: string): Access["status"] => {
  if (session.status === "signed_out") return "sign_in"
  const role = roles.find((row) => row.id === id)
  // ChatApi refused: an answer, sign in (401) or no role (403), which a session that can't answer now doesn't undo.
  if (role?.refused !== undefined) return role.refused === "authentication" ? "sign_in" : "forbidden"
  // A reached server that couldn't verify the session: nothing private shows (decision 0110, 2026-11-03). A network that
  // failed says nothing of the person, so the role this tab kept still decides, as it does offline.
  const unverified = session.status === "unreachable" && session.unverifiable === true
  if (unverified) return "unverified"
  if (session.status === "loading") return "unknown"
  if (role === undefined) return "unknown"
  // ChatApi couldn't answer (a 503, a rate limit): no denial, unavailable until Try again gets an answer.
  if (role.failure !== undefined) return "unavailable"
  return mayAsk(role.own ? session.role : role.role) ? "allowed" : "forbidden"
}
