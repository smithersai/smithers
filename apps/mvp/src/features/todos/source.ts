import { mayAsk } from "../auth/contract"
import type { RepoRole, Session } from "../auth/schema"
import type { Access } from "./schema"

/** A stack requires Member authority on the named repository, never the session's role on another one. */
export const stackAccess = (session: Session, roles: ReadonlyArray<RepoRole>, id: string): Access["status"] => {
  if (session.status === "signed_out") return "sign_in"
  if (session.status !== "signed_in") return "unknown"
  const role = roles.find((row) => row.id === id)
  if (role === undefined) return "unknown"
  return mayAsk(role.own ? session.role : role.role) ? "allowed" : "forbidden"
}
