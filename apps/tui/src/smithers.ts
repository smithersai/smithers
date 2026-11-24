/** The Smithers surface: the Cloud connection and the apps the homepage declares. Runs live in Summary, flows in `/flows`. */
import * as CloudSession from "@smthrs/cli/CloudSession"
import { Effect } from "effect"
import type * as Home from "./home.ts"
import type * as Panels from "./panels.ts"

const text = (value: string | undefined): Array<Panels.Block> =>
  value === undefined || value === "" ? [] : [{ kind: "text", text: value.slice(0, 200_000) }]

/** The panel id; the surface is `ui:smithers`, owned `plugin:smithers`. */
export const id = "smithers"

/** Where a repository lives on Cloud: `owner/name`. */
export type Repository = string

/**
 * The repository the surface belongs to: `SMITHERS_REPO`, else the owner and
 * name the checkout's git or jj remote names, as `smthrs open` reads it (a
 * Cloud repository mirrors its GitHub owner and name).
 */
export const repository = (cwd: string, env: Readonly<Record<string, string | undefined>>): Repository | undefined => {
  const named = env.SMITHERS_REPO?.trim()
  if (named !== undefined && /^[\w.-]+\/[\w.-]+$/.test(named) && !named.split("/").some((part) => /^\.+$/.test(part))) {
    return named
  }
  return CloudSession.repository(cwd, env)
}

/** A failed credential read is uncertain, never evidence that the person signed out. */
export const readIdentity = Effect.flatMap(CloudSession.Authentication, (auth) => auth.status).pipe(
  Effect.catch(() => Effect.succeed(undefined))
)

/** The connection and person share one row; unverified cached identities never claim a login. */
const identityRow = (status: CloudSession.AuthStatus | undefined): Panels.Row => {
  // Terminal controls and oversized account names cannot alter the surrounding panel.
  const clean = (value: string | null | undefined) => (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 160)
  const username = clean(status?.username)
  const email = clean(status?.email)
  const person = username !== "" ? `@${username}` : email !== "" ? email : "identity unknown"
  return {
    id: "cloud:identity",
    label: status === undefined
      ? "Connection unknown"
      : status.verified === false
      ? "Offline · identity unverified"
      : !status.logged_in
      ? "Signed out"
      : `Connected · ${person}`,
    details: []
  }
}

/** The one row a signed-out person sees: how to sign in. */
const signIn: Panels.Row = { id: "cloud:sign-in", label: "Sign in: smthrs auth login", details: [] }

export const panel = (
  apps: ReadonlyArray<Home.App>,
  /** The flows this directory discovers: an app row runs only one of these. */
  discovered: ReadonlySet<string>,
  /** The CLI auth status; absent while it is unknown, independent of repository access. */
  identity?: CloudSession.AuthStatus
): Panels.Panel => {
  const signedOut = identity?.logged_in === false && identity.verified !== false
  return {
    id,
    title: "Smithers",
    summary: apps.length === 0 ? "Smithers Cloud" : `${apps.length} apps`,
    rows: [
      identityRow(identity),
      ...signedOut ? [signIn] : [],
      // The apps the homepage declares (home.ts): the same list the app home shows as tiles. A row runs its flow when this directory discovers it.
      ...apps.map((app) => ({
        id: `app:${app.flow}`,
        label: app.title,
        details: text(app.flow),
        ...(discovered.has(app.flow)
          ? { action: { label: app.title, action: { kind: "flow" as const, flow: app.flow } } }
          : {})
      }))
    ]
  }
}
