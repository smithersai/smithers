import { Schema } from "effect"
import { CHECK_OUTCOMES, ROLES } from "./contract"

// Sign-in's row on the tab and ChatApi's answer, as the Effect Schemas they are checked with. Constants the browser
// shares with ChatApi live in contract.ts.

/** What `GET /api/auth/session` answers (contract.ts `SessionState`), checked as it arrives. */
export const SessionState = Schema.Union([
  Schema.Struct({ signedIn: Schema.Literal(false), available: Schema.Boolean }),
  Schema.Struct({
    signedIn: Schema.Literal(true),
    personId: Schema.optional(Schema.String),
    login: Schema.String,
    role: Schema.NullOr(Schema.Literals(ROLES)),
    hostedModel: Schema.optional(Schema.Boolean),
  }),
])

/**
 * This tab's view of who is signed in, one row:
 * - `status`: `loading` until ChatApi answers, then `signed_in` or `signed_out`; `unreachable` when it couldn't ask;
 * - `login` and `role` when signed in; `available` whether this deployment can sign anyone in; `hostedModel` whether
 *   its own model answers anyone (decision 0099), unknown until ChatApi says;
 * - `signingOut` while a sign-out is on its way;
 * - `restored` once the device's last confirmed session (`Confirmed`) has been read.
 */
export const Session = Schema.Struct({
  id: Schema.Literal("session"),
  status: Schema.Literals(["loading", "signed_in", "signed_out", "unreachable"]),
  login: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.Literals(ROLES)),
  available: Schema.Boolean,
  hostedModel: Schema.optional(Schema.Boolean),
  signingOut: Schema.Boolean,
  restored: Schema.Boolean,
})
export type Session = typeof Session.Type

/**
 * The last session ChatApi confirmed signed in on this device, kept on the device so a reload offline still knows who
 * asks: at most one row, retained through expiry and wiped with the device at explicit sign-out.
 */
export const Confirmed = Schema.Struct({
  id: Schema.Literal("session"),
  login: Schema.String,
  personId: Schema.optional(Schema.String),
  role: Schema.NullOr(Schema.Literals(ROLES)),
})
export type Confirmed = typeof Confirmed.Type

// What `auth/refresh`'s step asks the tab that started its run (src/flows/askingTab.ts), and what it answers.

/** The step's call: check your session. */
export const SessionCall = Schema.Struct({})

/** The tab's answer: how its check ended. */
export const SessionAnswer = Schema.Struct({ outcome: Schema.Literals(CHECK_OUTCOMES) })
export type SessionAnswer = typeof SessionAnswer.Type

/** What `GET /api/repos/<owner>/<name>/role` answers (contract.ts `repoRoleRoute`), checked as it arrives. */
export const RepoRoleAnswer = Schema.Struct({
  role: Schema.NullOr(Schema.Literals(ROLES)),
  own: Schema.Boolean,
  /** Repository shapes may be read; with no role this is an explicit public-read receipt. */
  readable: Schema.optional(Schema.Boolean),
  /** `false`: the deployment doesn't sync the repository's issues and pull requests (decision 0079 slice 1b). */
  synced: Schema.optional(Schema.Boolean),
})
export type RepoRoleAnswer = typeof RepoRoleAnswer.Type

/**
 * The person's role on one repository, as ChatApi last answered this tab, keyed by the repository's id: their role
 * there and whether it is the deployment's own repository. No row until ChatApi answers: nothing role-gated shows.
 */
export const RepoRole = Schema.Struct({
  id: Schema.String,
  /** Content-free refusal of the latest authority read; no shape starts until a successful retry. */
  failure: Schema.optional(Schema.String),
  role: Schema.NullOr(Schema.Literals(ROLES)),
  own: Schema.Boolean,
  /** Repository shapes may be read; with no role this is an explicit public-read receipt. */
  readable: Schema.optional(Schema.Boolean),
  /** `false`: the deployment doesn't sync the repository's issues and pull requests, so its pages show GitHub's. */
  synced: Schema.optional(Schema.Boolean),
})
export type RepoRole = typeof RepoRole.Type
