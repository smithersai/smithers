/**
 * The deciding action of `notification-policy`: a repository's own answer to
 * "who is told about this?", as one deterministic routing rule.
 *
 * The rule is the repository's to change — this module is the shape an
 * ordinary maintainer copies — and it calls no model and reads no file. A
 * routing rule is a declaration, not a judgment: a policy that asked a model
 * who to notify would make a notification nondeterministic and would need the
 * work's words to ask with.
 *
 * COPYABLE ON PURPOSE: everything this file needs is `@smthrs/flow` and
 * `effect`, both published, so dropping the directory into another repository
 * compiles there. It deliberately does NOT import the app: `Request` and
 * `Decision` below restate `Request` and `Decision` of
 * `apps/mvp/worker/NotificationPolicy.ts`, the contract the notification host
 * sends and decodes. `RecipientPolicy.layerFlow` only accepts a flow whose
 * payload and success are those types, and
 * `apps/mvp/worker/NotificationPolicy.test.ts` compares both JSON Schema
 * documents and runs this flow on requests the notification writer builds, so
 * either side moving fails there.
 *
 * The request carries identity only — repository, notice kind, subject,
 * revision, the launcher the work belongs to, and the people who already can
 * read it — and the answer carries bounded typed recipient ids. The app
 * checks access again after this decides, so naming someone who cannot read
 * the work withholds them rather than granting anything.
 */
import { Action } from "@smthrs/flow"
import { Effect, Schema } from "effect"

/** The deciding action's tag. */
export const NOTIFICATION_POLICY_DECIDE_ACTION = "notification-policy/decide"

/** The version of the rule below; change it when the rule changes, so no replay mixes two rules. */
export const implementationVersion = "notification-policy/v2"

/** The notices the app asks about: a run's states, and a repository's `main` or a release moving. */
export const NOTIFICATION_POLICY_KINDS = [
  "working",
  "waiting",
  "needs_you",
  "done",
  "failed",
  "main",
  "release"
] as const

/** How many recipients one decision may name. */
export const NOTIFICATION_RECIPIENT_LIMIT = 50

/** A person or repository id, the same bound the app puts on every identity. */
const Identity = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/))

/**
 * The request the app sends. `candidates` is everyone who already can read the
 * notice; `defaults` is who the app's built-in audience would tell. `owner` is
 * the run's launcher, absent for repository events.
 */
export const Request = Schema.Struct({
  repoId: Identity,
  kind: Schema.Literals(NOTIFICATION_POLICY_KINDS),
  subject: Schema.String,
  revision: Schema.String,
  owner: Schema.optional(Identity),
  candidates: Schema.Array(Identity),
  defaults: Schema.Array(Identity)
})

/** How a notice is handled beside who gets it; the whole allowed surface. */
export const Handling = Schema.Struct({ quiet: Schema.optional(Schema.Boolean) })

/** The answer: recipient ids, and optionally how to handle them. */
export const Decision = Schema.Struct({
  recipients: Schema.Array(Identity).check(Schema.isMaxLength(NOTIFICATION_RECIPIENT_LIMIT)),
  handling: Schema.optional(Handling)
})

/**
 * This repository's example rule, and a sensible default for any repository
 * that copies it:
 *
 * - A run that needs an answer is its launcher's to answer, so only the
 *   launcher is told; the branch stops being a broadcast channel for someone
 *   else's question.
 * - Every other notice is told to everyone who can read the work.
 */
export const decide = (request: typeof Request.Type): typeof Decision.Type =>
  request.kind === "needs_you" && request.owner !== undefined
    ? { recipients: [request.owner] }
    : { recipients: [...request.candidates] }

/** The decision as one action, so the run carries it as a node with a schema. */
export const Decide = Action.make(NOTIFICATION_POLICY_DECIDE_ACTION, {
  payload: Request,
  success: Decision,
  error: Schema.Never,
  implementationVersion
})

/** The host's implementation: the rule above, and nothing else. */
export const layer = Decide.toLayer((request) => Effect.succeed(decide(request)), { implementationVersion })
