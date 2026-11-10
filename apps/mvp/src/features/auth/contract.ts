// Sign-in's contract between the browser and ChatApi (docs/features/sign-in.md): the one home of every value the
// browser, ChatApi and the tests share. Nothing here imports a library, so every side can.

/**
 * The person whose device data a request comes from (src/device/identity.ts): a stable person id, `@visitor` for data
 * made without a verified session, or {@link NO_DEVICE_DATA} from a page that opened nothing of the device's. ChatApi
 * reads a request whose cookie or credential is another person's as nobody, and refuses a cookie-authenticated write
 * that names no one, as an earlier build's tab sends.
 */
export const DEVICE_PERSON_HEADER = "x-smithers-device-person"

/** The client advertises `credential-stale` here because its transport handles the server's stale-credential answer. */
export const ACCEPTS_HEADER = "x-smithers-accepts"

/**
 * A write that asks the page's transport (src/device/identity.ts `boundFetch`) to check a `401` against the session
 * before its caller decides. The transport removes it from every request, so it never leaves the page. Only a write the
 * outbox holds, sent in the person's session, opts in: co-edit's updates, issue writes without a run credential, TODO
 * changes, chat questions and steers without a run credential. A write sent with a run credential never does: its `401` is the run's.
 */
export const CONFIRM_401_HEADER = "x-smithers-confirm-401"

/**
 * On such a write's `401`, set by the transport (never by ChatApi): `same_person` when a session read after the refusal
 * named the person the write was bound to, so the refusal said only that ChatApi couldn't tell who asked then.
 */
export const SESSION_CHECK_HEADER = "x-smithers-session-check"

/** What a write's client reads from {@link SESSION_CHECK_HEADER}: `same_person`, or nothing. */
export const sessionCheckOf = (headers: Readonly<Record<string, string | undefined>>) =>
  headers[SESSION_CHECK_HEADER] === "same_person" ? { sessionCheck: "same_person" as const } : {}

export const ACCEPTS_CREDENTIAL_STALE = "credential-stale"
/** {@link DEVICE_PERSON_HEADER}'s value for a page or worker that opened none of the device's data. */
export const NO_DEVICE_DATA = "@none"

/** A page whose verified viewer is nobody, so neither cookie nor bearer can act. */
export const ANONYMOUS_DEVICE_PERSON = "@anonymous"

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

/**
 * Hands a session at `APP_DOMAIN` to an alias or a verified custom domain (decision 0130): `GET <route>?request=<signed>`
 * at `APP_DOMAIN` answers with a redirect to the alias's {@link ARRIVE_ROUTE}, the one-time code in its fragment.
 */
export const HANDOFF_ROUTE = "/api/auth/handoff"

/**
 * Where an alias redeems a hand-off's code: `GET` is a page that posts the code from its fragment back, and `POST` with
 * the form field `code` signs the alias in (decision 0130).
 */
export const ARRIVE_ROUTE = "/api/auth/arrive"

/** Ends this browser's session: `POST`, answered `204`. */
export const SIGN_OUT_ROUTE = "/api/auth/sign-out"

/** Who this browser is signed in as: `GET`, answered with a {@link SessionState} as JSON. */
export const SESSION_ROUTE = "/api/auth/session"

/** The search parameter the callback adds to the return path when sign-in failed: `?sign_in=failed`. */
export const SIGN_IN_FAILED_PARAM = "sign_in"

/** The last segment of {@link repoRoleRoute}. */
export const REPO_ROLE_SEGMENT = "role"

/**
 * `GET <route>`: the person's role on repository `owner/name` (decision 0079), and whether it is the deployment's own
 * repository (`GITHUB_REPOSITORY`), where the features still fenced to it (secrets, custom domains, triage, merging)
 * act; answered `{ role, own }` (worker/home/Api.ts). Never cached: the answer depends on the session.
 */
export const repoRoleRoute = (owner: string, name: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${REPO_ROLE_SEGMENT}`

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
 * answers this person, `hostedModel`), and, while it hasn't said or can't be reached, the last session it confirmed on
 * this device (`confirmed`, once `restored` from the device): a person who reloads offline keeps asking. The sign-in
 * prompt shows only when ChatApi says signed out, or when ChatApi can't be reached and the device never confirmed a
 * session. While the deployment's model doesn't answer them, a person who may ask needs their own (`own`): without
 * one, the way to add it, never a composer whose every answer would fail; nothing until their row has synced.
 * `member` is whether they are a Member or above on the repository of the conversation the composer asks in (ruling
 * AUTH-8), as its branch's access says; absent, their role on the deployment's own repository (`role`) decides, as in
 * its home conversation.
 */
export const composerAccess = (
  session: {
    readonly status: "loading" | "signed_in" | "signed_out" | "unreachable"
    readonly role: Role | null
    readonly restored: boolean
    readonly roleConfirmed?: boolean | undefined
    readonly hostedModel?: boolean | undefined
  },
  confirmed: { readonly role: Role | null } | undefined,
  own: OwnModel = "saved",
  member?: boolean,
): ComposerAccess => {
  if (session.status === "signed_in") {
    if (!(member ?? mayAsk(session.role))) return session.roleConfirmed === false ? "wait" : "members_only"
    if (session.hostedModel === false && own !== "saved") return own === "none" ? "add_model" : "wait"
    return "ask"
  }
  if (session.status === "signed_out") return "sign_in"
  if (confirmed !== undefined) return (member ?? mayAsk(confirmed.role)) ? "ask" : "members_only"
  return session.restored && session.status === "unreachable" ? "sign_in" : "wait"
}

/**
 * What `GET /api/auth/session` answers:
 * - signed out, with whether this deployment can sign anyone in (`available`: the GitHub App is configured), and
 *   whether its own model answers anyone (`hostedModel`), so a visitor's first run shows the steps they will have
 *   (decision 0121);
 * - signed in, with the person's stable id, their GitHub login, their role on the deployment's own repository, `null`
 *   when they have none, whether the deployment's own model answers them (`hostedModel`, decision 0099: on, and they
 *   are a Member or above of its repository, ruling AUTH-8), and where Install goes (`install`: the Smithers GitHub
 *   App's installation on GitHub), when the deployment signs in with the App. The id, `hostedModel` and `install` are
 *   optional only so a build from before they were added still reads.
 */
export type SessionState =
  | { readonly signedIn: false; readonly available: boolean; readonly hostedModel?: boolean }
  | {
    readonly signedIn: true
    readonly personId?: string
    /** False while the last observed role awaits a durable confirmation; identity remains signed in. */
    readonly roleConfirmed?: boolean
    /** The home conversation's id, every signed-in person's own (decision 0110, the data gate); none when there is none. */
    readonly homeConversationId?: string
    readonly login: string
    readonly role: Role | null
    readonly hostedModel?: boolean
    readonly install?: string
    /** When the session ends, epoch milliseconds on the server's clock; none for a session that has no end, as in local development. */
    readonly expiresAt?: number
    /** The absolute server deadline, epoch milliseconds; optional for older clients and local development. */
    readonly deadline?: number
    /** An opaque tag for the presented session row; optional for older servers and local development. */
    readonly session?: string
    /** The server's clock when it answered, epoch milliseconds: a tab's deadline is `sentAt + (expiresAt - serverNow)`. */
    readonly serverNow?: number
  }

/** The identity-free third answer, consumed by device handling in rollout step 3. */
export type CredentialStaleState = { readonly credential: "stale" }
export type SessionResponse = SessionState | CredentialStaleState

/** How a tab's session check ended: ChatApi said signed in or signed out, or couldn't confirm authority (`unconfirmed`) or reach ChatApi (`unreachable`). */
export const CHECK_OUTCOMES = ["signed_in", "signed_out", "unreachable", "unconfirmed"] as const
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number]

/**
 * How `auth/refresh` ended: the tab's check answered (`unreachable` and `unconfirmed` keep retrying), or
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

/** Where the composer would be, for a signed-in Guest or a person with no role on the conversation's repository. */
export const MEMBERS_ASK = "Members can ask Smithers."

/** Where the composer goes while the deployment's model is off and the person has none of their own. */
export const ADD_YOUR_MODEL = "Add your model"

/** The button that opens Settings ▸ Your model. */
export const OPEN_SETTINGS = "Open settings"

/** Beside the button after the callback failed. */
export const SIGN_IN_FAILED = "Couldn't sign in."

/** The title of `APP_DOMAIN`'s page asking whether to sign custom domain `host` in (decision 0130). */
export const handoffTitle = (host: string) => `Sign in to ${host}?`

/** What that page says: who `host` will be signed in as. */
export const handoffExplanation = (host: string, login: string) =>
  `${host} will be signed in as @${login}. Continue only if you opened ${host} yourself.`

/** That page's button. */
export const continueTo = (host: string) => `Continue to ${host}`

/** That page's way back, signing nobody in. */
export const CANCEL_HANDOFF = "Cancel"

/** The button that ends the session. */
export const SIGN_OUT = "Sign out"

/** What the page offers while the outbox holds a write ChatApi refused because it couldn't tell who asked (src/outbox.ts). */
export const SIGN_IN_TO_SEND = "Sign in to send your changes"

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
  fields: ["signedIn", "status", "outcome", "stage", "reason", "via", "executionId", "durationMs", "smithers.auth.outcome", "errorCode", "feature"],
} as const
