import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { type Role, ROLES } from "../../src/features/auth/contract.ts"

// The deployment's stored session (docs/infrastructure.md#against-a-deployment): what e2e/deployment/sign-in.setup.ts
// keeps, and when it signs in again. It keeps one cookie, the app's own session on the app's origin, and nothing from
// GitHub: no test context ever holds a GitHub cookie, so none can sign anybody in by accident (2026-10-21).

/** A cookie as Playwright's storage state holds it. */
export type Cookie = {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires: number
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: "Strict" | "Lax" | "None"
}

/** Playwright's storage state, as the setup writes it: cookies only. */
export type StorageState = { readonly cookies: ReadonlyArray<Cookie>; readonly origins: ReadonlyArray<never> }

/** The app's session cookie for `origin`: `__Host-` over https (worker/SignIn.ts `cookieNames`). */
export const sessionCookieName = (origin: string) => (new URL(origin).protocol === "https:" ? "__Host-smithers_session" : "smithers_session")

/**
 * The storage state to keep from a browser's cookies: the app's session cookie on `origin` alone. Anything else, a
 * GitHub cookie above all, is dropped. Undefined when the browser holds no session for `origin`.
 */
export const sessionState = (cookies: ReadonlyArray<Cookie>, origin: string): StorageState | undefined => {
  const host = new URL(origin).hostname
  const name = sessionCookieName(origin)
  const cookie = cookies.find((candidate) => candidate.name === name && candidate.domain === host)
  return cookie === undefined ? undefined : { cookies: [cookie], origins: [] }
}

/** What `GET /api/auth/session` answers (worker/SignIn.ts). */
export type SessionAnswer = { readonly signedIn: boolean; readonly login?: unknown; readonly personId?: unknown; readonly role?: unknown }

/** A signed-in answer's person, or why it isn't one the run may use. */
export const personOf = (answer: SessionAnswer, login: string): { login: string; personId: string; role: Role | null } | { refused: string } => {
  if (!answer.signedIn) return { refused: "signed out" }
  if (typeof answer.login !== "string" || typeof answer.personId !== "string") return { refused: "the session answer has no login" }
  if (answer.login !== login) return { refused: `signed in as ${answer.login}, not the test account ${login}` }
  const role = answer.role ?? null
  if (role !== null && !ROLES.includes(role as Role)) return { refused: `unknown role ${String(role)}` }
  return { login: answer.login, personId: answer.personId, role: role as Role | null }
}

/** How long before its cookie expires a stored session is replaced, so a run never loses it midway. */
export const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * How often a session whose role is below Member signs in again: a role is read at sign-in, and production's role
 * rechecks run as a remote flow, so a role GitHub raised reaches the run only through a new sign-in.
 */
export const LOW_ROLE_RETRY_MS = 6 * 60 * 60 * 1000

const MEMBER_OR_ABOVE: ReadonlySet<Role | null> = new Set<Role | null>(["admin", "maintainer", "member"])

/** Why the stored session must be replaced, or undefined to keep it. */
export const renewal = (input: {
  readonly state: StorageState | undefined
  readonly person: ReturnType<typeof personOf> | undefined
  readonly signedInAt: number | undefined
  readonly now: number
  readonly fresh: boolean
}): string | undefined => {
  if (input.fresh) return "E2E_FRESH_SIGN_IN is set"
  if (input.state === undefined || input.state.cookies.length !== 1) return "no stored session"
  if (input.person === undefined) return "the stored session wasn't checked"
  if ("refused" in input.person) return `the stored session is refused: ${input.person.refused}`
  const expires = input.state.cookies[0]!.expires * 1000
  if (expires > 0 && expires - input.now < RENEW_BEFORE_MS) return "the stored session expires within 3 days"
  if (!MEMBER_OR_ABOVE.has(input.person.role) && (input.signedInAt === undefined || input.now - input.signedInAt > LOW_ROLE_RETRY_MS)) {
    return `the stored session's role is ${input.person.role ?? "none"}, read more than 6 hours ago`
  }
  return undefined
}

/** Writes `text` to `path` readable by this user only, atomically: a reader never sees half a session. */
export const writePrivate = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}`
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/** Reads a JSON file, or undefined when it doesn't exist. */
export const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
