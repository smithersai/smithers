/** The Smithers surface: the factory's issues and the apps its homepage declares. Runs live in Summary, flows in `/flows`. */
import * as CloudSession from "@smthrs/cli/CloudSession"
import { Effect } from "effect"
import type * as Home from "./home.ts"
import type * as Panels from "./panels.ts"

const text = (value: string | undefined): Array<Panels.Block> =>
  value === undefined || value === "" ? [] : [{ kind: "text", text: value.slice(0, 200_000) }]

/** The panel id; the surface is `ui:smithers`, owned `plugin:smithers`. */
export const id = "smithers"

/** The factory's issue list, when the repository's stack was read from Cloud. */
export interface Factory {
  readonly metrics: string
  readonly rows: ReadonlyArray<Panels.Row>
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

/** The one row a signed-out person sees in place of the factory's issues. */
const signIn: Panels.Row = {
  id: "factory:sign-in",
  label: "Sign in to see the factory: smthrs auth login",
  details: []
}

/** The factory's first row: the composer command that files a TODO. */
const fileTodo: Panels.Row = { id: "factory:todo", label: "File a TODO", details: text("/todo <title>") }

export const panel = (
  apps: ReadonlyArray<Home.App>,
  /** The flows this directory discovers: an app row runs only one of these. */
  discovered: ReadonlySet<string>,
  /** The issue list, or `signed-out` when the repository is known but no Cloud session is. */
  input?: Factory | "signed-out",
  /** The CLI auth status; absent while it is unknown, independent of repository access. */
  identity?: CloudSession.AuthStatus
): Panels.Panel => {
  const factory = input === "signed-out" ? undefined : input
  const signedOut = identity?.logged_in === false && identity.verified !== false
  return {
    id,
    title: "Smithers",
    // The factory's measured numbers lead, when its stack was read.
    summary: factory !== undefined && factory.metrics !== ""
      ? factory.metrics
      : apps.length === 0
      ? "Factory"
      : `${apps.length} apps`,
    rows: [
      identityRow(identity),
      ...input === "signed-out" ? signedOut ? [signIn] : [] : factory === undefined ? [] : [fileTodo, ...factory.rows],
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
