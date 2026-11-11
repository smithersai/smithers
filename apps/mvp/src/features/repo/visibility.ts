import type { RepoRole, Session } from "../auth/schema"

// What of a repository this person may see on this device now (decision 0110, 2026-11-03): the one rule every display of
// a repository's private rows goes through, `useRepoVisibility` in React and this function elsewhere. Wipes clean the
// device; this decides what shows, so a row a wipe missed or a late read wrote is still not shown.

export type Visibility = "show" | "refused" | "sign_in" | "unverified"

/**
 * Repository `row`'s visibility under `session`. A refusal mark is a `forbidden` role row (`RepoStore.refuse`). A role
 * answer that grants nothing (no role and no public read, `readable` or `public`) hides it too, though it wipes nothing: only a 403 does; signed
 * out, its page asks to sign in. A 401
 * role answer asks to sign in only once the session confirms it ended. A reached server that couldn't verify the session
 * shows nothing private, except a repository whose answer said anyone may read it. Everything else shows: a pending
 * check, a failed network, an unanswered role. Each page keeps its finer states.
 */
export const repoVisibility = (session: Session, row: RepoRole | undefined): Visibility => {
  if (row?.refused === "forbidden") return "refused"
  if (session.status === "signed_out" && row?.refused === "authentication") return "sign_in"
  // Signed out, the page offers Sign in rather than saying there is no access: both show nothing.
  if (grantsNothing(row)) return session.status === "signed_out" ? "sign_in" : "refused"
  const publicRead = row !== undefined && row.role === null && publicly(row) && row.refused === undefined
  if (session.status === "unreachable" && session.unverifiable === true && !publicRead) return "unverified"
  return "show"
}

/**
 * Whether `row` is ChatApi's answer that this person may not read the repository: no role there and no public read
 * (Astra on 0c7b9f01). A row with no answer (a failure, a refusal of the role read) says nothing of the kind.
 */
export const grantsNothing = (row: RepoRole | undefined): boolean =>
  row !== undefined && row.failure === undefined && row.refused === undefined && row.role === null && !publicly(row)

/**
 * Whether the answer says anyone may read the repository: its shapes (`readable`), or, where the App is absent, its
 * home (`public`: GitHub says it is public; rulings GH-4 and AUTH-1).
 */
const publicly = (row: RepoRole): boolean => row.readable === true || row.public === true
