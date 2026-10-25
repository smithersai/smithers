import type { RepoAnswer } from "../auth/viewer"
import type { SecretForm, SecretRow } from "./schema"

// What the Secrets page shows, as pure rules its view reads (docs/features/secrets.md#the-secrets-page). The server is
// the authority on every write and every row; these only decide which controls show.

/**
 * What a person may do on the page (decision 0007 `repo:secret-write`), by their role on the repository as ChatApi
 * answered for it (decision 0079): `write` for an Admin, `read` for a Maintainer or Member, `none` for a Guest, anyone
 * signed out, or any repository but the deployment's own, the only one secrets serve; `loading` until sign-in and
 * ChatApi know.
 */
export type SecretsAccess = "loading" | "none" | "read" | "write"

export const accessOf = (
  session: { readonly status: string } | undefined,
  answer: RepoAnswer | undefined,
): SecretsAccess => {
  if (session === undefined || session.status === "loading") return "loading"
  if (session.status !== "signed_in") return "none"
  if (answer === undefined) return "loading"
  if (!answer.own) return "none"
  if (answer.role === "admin") return "write"
  return answer.role === "maintainer" || answer.role === "member" ? "read" : "none"
}

/** Whether the header shows the Secrets link: to a Member or above. */
export const showsLink = (access: SecretsAccess): boolean => access === "read" || access === "write"

/** Form `key`'s last write, if it has one. */
export const formOf = (forms: ReadonlyArray<SecretForm>, key: string): SecretForm | undefined =>
  forms.find((form) => form.id === key)

/** The hosts a row shows and its rotate form starts with: one per line. */
export const hostsText = (hosts: ReadonlyArray<string>): string => hosts.join("\n")

/** Whether a form's write is on its way: sent, or taken and not yet in the list. A second one waits. */
export const onItsWay = (form: SecretForm): boolean => form.state === "sending" || form.state === "confirming"

/** Whether the list may still show a form's write landing: taken, late, or of unknown outcome. */
export const awaiting = (form: SecretForm): boolean =>
  form.state === "confirming" || form.state === "late" || form.state === "unknown"

/**
 * Whether the list shows a form's write landed: for Delete, the row is gone; for Add and Rotate, the row is there and
 * its `updatedAt` isn't what it was before the write (or there was no row). The server's clock is never compared with
 * this device's.
 */
export const landed = (form: SecretForm, rows: ReadonlyArray<Pick<SecretRow, "name" | "updatedAt">>): boolean => {
  const row = rows.find((candidate) => candidate.name === form.secret)
  if (form.kind === "delete") return row === undefined
  return row !== undefined && row.updatedAt !== form.before
}
