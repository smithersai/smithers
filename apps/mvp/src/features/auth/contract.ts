// Sign-in's contract between the browser and ChatApi (docs/features/sign-in.md): the one home of every value the
// browser, ChatApi and the tests share. Nothing here imports a library, so every side can.

/**
 * The person whose device data a request comes from (src/device/identity.ts): a stable person id, `@visitor` for data
 * made without a verified session, or {@link NO_DEVICE_DATA} from a page that opened nothing of the device's. ChatApi
 * reads a request whose cookie or credential is another person's as nobody, and refuses a cookie-authenticated write
 * that names no one, as an earlier build's tab sends.
 */
export const DEVICE_PERSON_HEADER = "x-smithers-device-person"

/** {@link DEVICE_PERSON_HEADER}'s value for a page or worker that opened none of the device's data. */
export const NO_DEVICE_DATA = "@none"

/**
 * The window event the page dispatches once the person signed in adopts, in place, the visitor's data it opened
 * (src/device/identity.ts): what the page syncs and sends goes again now, as theirs.
 */
export const DEVICE_ADOPTED_EVENT = "smithers-device-adopted"

/** Every sign-in route starts with this. */
export const AUTH_ROUTE = "/api/auth"

/** Starts signing in: `GET <route>?return=<path>` answers with a redirect to GitHub. */
export const SIGN_IN_ROUTE = "/api/auth/sign-in"

/** Where GitHub sends the person back: `GET <route>?code&state`. Register `<origin><route>` on the GitHub App. */
export const CALLBACK_ROUTE = "/api/auth/callback"

/** Ends this browser's session: `POST`, answered `204`. */
export const SIGN_OUT_ROUTE = "/api/auth/sign-out"

/** Who this browser is signed in as: `GET`, answered with a {@link SessionState} as JSON. */
export const SESSION_ROUTE = "/api/auth/session"

/** The search parameter the callback adds to the return path when sign-in failed: `?sign_in=failed`. */
export const SIGN_IN_FAILED_PARAM = "sign_in"

/** Where "Sign in with GitHub" goes: sign-in, returning to `returnTo`, a path on this site. */
export const signInHref = (returnTo: string) => `${SIGN_IN_ROUTE}?return=${encodeURIComponent(returnTo)}`

/** A person's role on the repository (decision 0007): Admin, Maintainer, Member or Guest. */
export const ROLES = ["admin", "maintainer", "member", "guest"] as const

/** One of {@link ROLES}. */
export type Role = (typeof ROLES)[number]

/** The roles that may ask Smithers (`repo:ask`, decision 0007 §2): Member or above. */
export const ASKING_ROLES: ReadonlyArray<Role> = ["admin", "maintainer", "member"]

/** Whether a person with `role` may ask Smithers: Member, Maintainer or Admin; a Guest or no role may not. */
export const mayAsk = (role: Role | null): boolean => role !== null && ASKING_ROLES.includes(role)

/** The roles that may add and remove a repository's custom domains (`repo:domain-write`, decision 0039). */
export const DOMAIN_ROLES: ReadonlyArray<Role> = ["admin", "maintainer"]

/** Whether a person with `role` may manage custom domains: Maintainer or Admin. */
export const mayManageDomains = (role: Role | null): boolean => role !== null && DOMAIN_ROLES.includes(role)

/**
 * What stands where the composer goes: the composer (`ask`), the line saying only Members ask (`members_only`), the
 * sign-in prompt (`sign_in`), the way to add a model of one's own while the deployment's is off (`add_model`, decision
 * 0099), or nothing yet (`wait`).
 */
export type ComposerAccess = "ask" | "members_only" | "sign_in" | "add_model" | "wait"

/** Whether the person has saved a model of their own, as this tab knows it: `saved`, `none`, or not synced yet. */
export type OwnModel = "saved" | "none" | "loading"

/**
 * What stands where the composer goes, from what ChatApi said (`status`, `role` and whether the deployment's own model
 * answers, `hostedModel`), and, while it hasn't said or can't be reached, the last session it confirmed on this device
 * (`confirmed`, once `restored` from the device): a person who reloads offline keeps asking. The sign-in prompt shows
 * only when ChatApi says signed out, or when ChatApi can't be reached and the device never confirmed a session. While
 * the deployment's model is off, a person who may ask needs their own (`own`): without one, the way to add it, never a
 * composer whose every answer would fail; nothing until their row has synced.
 */
export const composerAccess = (
  session: {
    readonly status: "loading" | "signed_in" | "signed_out" | "unreachable"
    readonly role: Role | null
    readonly restored: boolean
    readonly hostedModel?: boolean | undefined
  },
  confirmed: { readonly role: Role | null } | undefined,
  own: OwnModel = "saved",
): ComposerAccess => {
  if (session.status === "signed_in") {
    if (!mayAsk(session.role)) return "members_only"
    if (session.hostedModel === false && own !== "saved") return own === "none" ? "add_model" : "wait"
    return "ask"
  }
  if (session.status === "signed_out") return "sign_in"
  if (confirmed !== undefined) return mayAsk(confirmed.role) ? "ask" : "members_only"
  return session.restored && session.status === "unreachable" ? "sign_in" : "wait"
}

/**
 * What `GET /api/auth/session` answers:
 * - signed out, with whether this deployment can sign anyone in (`available`: the GitHub App is configured);
 * - signed in, with the person's stable id, their GitHub login, their role on the repository, `null` when they have
 *   none, and whether the deployment's own model answers anyone (`hostedModel`, decision 0099). The id and
 *   `hostedModel` are optional only so a build from before they were added still reads.
 */
export type SessionState =
  | { readonly signedIn: false; readonly available: boolean }
  | {
    readonly signedIn: true
    readonly personId?: string
    readonly login: string
    readonly role: Role | null
    readonly hostedModel?: boolean
  }

/** How a tab's session check ended: ChatApi said signed in or signed out, or couldn't say (`unreachable`). */
export const CHECK_OUTCOMES = ["signed_in", "signed_out", "unreachable"] as const
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number]

/**
 * How `auth/refresh` ended: the tab's check answered (every outcome but `unreachable`, which the engine tries again), or
 * no tab answered because the one that asked is gone (`gone`).
 */
export const REFRESH_OUTCOMES = ["signed_in", "signed_out", "gone"] as const

/** The channel `auth/refresh`'s step asks the tabs of engine `name` on (src/flows/askingTab.ts). */
export const sessionChannel = (name: string): string => `${name}/auth-session`

/**
 * How long `auth/refresh`'s step waits for the tab that asked: its check waits for one already running, and each gives
 * ChatApi 15 s, so an open tab answers well within this.
 */
export const ASK_SESSION_WITHIN = "60 seconds"

// The app's sign-in copy. No other sign-in copy exists.

/** The button that starts signing in. */
export const SIGN_IN = "Sign in with GitHub"

/** Where the composer would be, for a signed-out person. */
export const SIGN_IN_TO_ASK = "Sign in to ask Smithers."

/** Where the composer would be, for a signed-in Guest or a person with no role. */
export const MEMBERS_ASK = "Members can ask Smithers."

/** Where the composer goes while the deployment's model is off and the person has none of their own. */
export const ADD_YOUR_MODEL = "Add your model"

/** The button that opens Settings ▸ Your model. */
export const OPEN_SETTINGS = "Open settings"

/** Beside the button after the callback failed. */
export const SIGN_IN_FAILED = "Couldn't sign in."

/** The button that ends the session. */
export const SIGN_OUT = "Sign out"

/**
 * What sign-in records in the browser (docs/observability.md#browser), by name, and the attributes they carry. ChatApi's
 * relay keeps exactly what src/telemetry.ts merges from every feature; none of these fields carries a login or a token.
 */
export const AUTH_TELEMETRY = {
  records: [
    "auth.session_subscription",
    "auth.session_refresh",
    "auth.refresh",
    "auth.refresh.check",
    "smithers_auth_session_refreshes",
    "session loaded",
    "session unreachable",
    "sign in pressed",
    "signed out",
    "sign out failed",
    "device wiped",
    "device wipe failed",
    "auth.session.get",
    "auth.sign_out.post",
    "smithers_web_sign_in_presses",
    "smithers_web_sign_outs",
    "smithers_web_device_wipes",
  ],
  // `stage`, `reason` and `via` also carry the engine worker's owner check (src/device/identity.ts, FLOWS_TELEMETRY).
  fields: ["signedIn", "status", "outcome", "stage", "reason", "via", "executionId", "durationMs", "smithers.auth.outcome"],
} as const
