import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Option, Stream } from "effect"
import type { AuthStore } from "../auth/store"
import type { RepoStore } from "../repo/store"

/** Repository flow runs require a Member, including on a public repository. No authority means no request. */
export const memberRunSource = (
  source: ShapeSource.Source,
  auth: Option.Option<AuthStore["Service"]>,
  repos: Option.Option<RepoStore["Service"]>,
  id: string,
): ShapeSource.Source => ShapeSource.gated(source,
  Option.isNone(auth) || Option.isNone(repos) ? Stream.succeed(false) :
    Stream.zipLatestWith(auth.value.sessionState.rows, repos.value.rolesState.rows, (sessions, roles) => {
      const session = sessions[0]!
      const row = roles.find((role) => role.id === id)
      const role = row?.own ? session.role : row?.role
      return session.status === "signed_in" && row?.synced !== false &&
        (role === "member" || role === "maintainer" || role === "admin")
    }).pipe(Stream.changes),
)

/** Wait for sign-in to resolve before reading the authenticated cloud index. */
export const cloudRunList = <A, E, R>(
  read: Effect.Effect<ReadonlyArray<A>, E, R>,
  auth: Option.Option<AuthStore["Service"]>,
): Effect.Effect<ReadonlyArray<A>, E, R> => Option.isNone(auth) ? read :
  auth.value.sessionState.rows.pipe(
    Stream.filter((rows) => rows[0]!.status === "signed_in" || rows[0]!.status === "signed_out"),
    Stream.runHead,
    Effect.flatMap((rows) => Option.isSome(rows) && rows.value[0]!.status === "signed_in" ? read : Effect.succeed([])),
  )
