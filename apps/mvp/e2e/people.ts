import { isAbsolute } from "node:path"
import { readFileSync, statSync } from "node:fs"
import { personOf, sessionState, type SessionAnswer, type StorageState } from "./deployment/session"

/** Independently signed-in test accounts. Never a development cookie on a deployment. */
export type OtherPerson = "teammate" | "guest"
export const personSettings = (person: OtherPerson, env: Readonly<Record<string, string | undefined>>) => {
  const prefix = person === "teammate" ? "E2E_TEAMMATE" : "E2E_GUEST"
  const login = env[`${prefix}_LOGIN`]
  const session = env[`${prefix}_SESSION`]
  return login && /^[a-z0-9][a-z0-9-]{0,38}$/i.test(login) && session && isAbsolute(session)
    ? { login, session }
    : undefined
}

/** Only the app cookie is ever carried into a test browser; the input file stays private. */
export const personState = (path: string, origin: string): StorageState => {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("The second person's session file must be private (mode 600)")
  let state: StorageState | undefined
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as StorageState
    state = sessionState(stored.cookies, origin)
  } catch {
    throw new Error("The second person's session file is unreadable or invalid")
  }
  if (state === undefined || state.cookies[0]!.expires * 1000 <= Date.now()) {
    throw new Error("The second person's app session is absent or expired; sign the test account in again")
  }
  return state
}

/** Live answers, not filenames or cached identity records, prove two people. */
export const distinctPerson = (owner: SessionAnswer, other: SessionAnswer, login: string) => {
  const person = personOf(other, login)
  if ("refused" in person) throw new Error(`Second test identity refused: ${person.refused}`)
  if (!owner.signedIn || typeof owner.personId !== "string" || typeof owner.login !== "string") {
    throw new Error("The branch owner must have a verified live session")
  }
  if (person.personId === owner.personId || person.login.toLowerCase() === owner.login.toLowerCase()) {
    throw new Error("Two devices of one account do not prove two people's authorization")
  }
  return person
}
