import * as Cloudflare from "alchemy/Cloudflare"
import { Clock, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../db/Database.ts"
import { type Actor, canAsk } from "./Actor.ts"
import { BranchRoles, branchAccess, canEdit, canView } from "./branch/Access.ts"
import * as Conversations from "./branch/Conversations.ts"
import { scopeAccess } from "./branch/Texts.ts"
import * as GitHubConfig from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as SessionStore from "./SessionStore.ts"
import { type Admission, ended, roleFresh, roleFreshMs as roleFreshConfig, type Verdict } from "./SocketAccess.ts"
import { mayRead } from "./stack/Access.ts"

// The rules a socket host renews a lease by (worker/SocketAccess.ts): the same ones its route admitted it with.
// `checker` builds them inside a Durable Object, over the Hyperdrive config ChatApi binds and the deployment's own
// GitHub settings, as ChatApi builds its `RepoRoles`, which read through the renewal's one Postgres client.

/**
 * `admission`'s verdict now, by the rules its route admitted it with: its session, and the alias it came through, live
 * and theirs, its role confirmed by GitHub within `roleFreshMs` (a failed check confirms nothing), then the basis.
 * `roles` is the `RepoRoles` the route asked. Anything that fails is `unverified`.
 */
export const verdict = <R>(roles: RepoRoles.RepoRoles<R>, admission: Admission, roleFreshMs: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    if (ended(admission, now)) return "session" as const
    let role = admission.role
    if (admission.session !== null) {
      const live = yield* SessionStore.authority(admission.session, admission.alias)
      if (Option.isNone(live) || live.value.personId !== admission.principal) return "session" as const
      // A role GitHub hasn't confirmed lately renews nothing; the page's reconnect through the route starts its check.
      if (!roleFresh(live.value.roleVerifiedAt, now, roleFreshMs)) return "unverified" as const
      role = live.value.role
    }
    const actor: Actor = {
      subject: { kind: "person", id: admission.principal },
      role,
      ...(admission.session === null ? {} : { session: admission.session }),
    }
    const basis = admission.basis
    switch (basis.kind) {
      case "run": {
        const resolved = yield* roles.resolve(actor, GitHubConfig.repositoryOf(basis.repoId.replace(/^github\//, ""))).pipe(
          Effect.map((resolved) => Option.some(resolved.role)),
          // As the route: a refusal that says the deployment can't act there is no; GitHub or Postgres down is unknown.
          Effect.catch((error) =>
            RepoRoles.REFUSALS[error.code] === 503 || error.code === "rate_limited"
              ? Effect.succeed(Option.none<null>())
              : Effect.succeed(Option.some(null))
          ),
        )
        if (Option.isNone(resolved)) return "unverified" as const
        return mayRead(Option.some({ ...actor, role: resolved.value })) ? "keep" as const : "revoked" as const
      }
      case "branch":
      case "terminal": {
        const branch = yield* branchAccess(Option.some(actor), basis.branchId)
        if (branch === undefined || !canView(branch.access)) return "revoked" as const
        if (basis.kind === "branch") return branch.access === admission.access ? "keep" as const : "changed" as const
        if (!canAsk(actor)) return "revoked" as const
        return (canEdit(branch.access) ? "write" : "read") === admission.access ? "keep" as const : "changed" as const
      }
      case "text": {
        const scoped = yield* scopeAccess(Option.some(actor), { run: basis.run })
        if (scoped === undefined || !canView(scoped.access)) return "revoked" as const
        return scoped.access === admission.access ? "keep" as const : "changed" as const
      }
    }
  }).pipe(
    Effect.catchCause(() => Effect.succeed<Verdict>("unverified")),
    Effect.withSpan("socket.verdict"),
  )

/** Local development's roles, as ChatApi's `RepoRoles` takes them (worker/ChatApiProgram.ts). */
export interface Options {
  /** Whether local development's people sign in without the App (`ProgramOptions.fallback`). */
  readonly local?: boolean
  readonly localRoles?: RepoRoles.LocalRoles
}

/**
 * Inside a Durable Object: `check`, an admission's verdict now, and `within`, which runs one renewal with one Postgres
 * client, the one `RepoRoles` reads through too.
 */
export const checker = <E, R>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  options: Options = {},
) =>
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(connection)
    const database = Database.layer(hyperdrive.connectionString)
    const repository = yield* GitHubConfig.repository.pipe(Effect.orDie)
    const app = yield* GitHubConfig.configured.pipe(Effect.orDie)
    const allowed = yield* RepoRoles.allowed.pipe(Effect.orDie)
    const home = yield* Conversations.configuredHomeRepositoryNames.pipe(Effect.orDie)
    const roleFreshMs = yield* roleFreshConfig.pipe(Effect.orDie)
    // `RepoRoles` reads through the client `within` opened for the renewal, not one of its own per read.
    const roles = yield* RepoRoles.make(Layer.effect(SqlClient.SqlClient, Effect.service(SqlClient.SqlClient)), {
      repository,
      app,
      allowed,
      local: options.local === true && Option.isNone(app),
      ...(options.localRoles === undefined ? {} : { localRoles: options.localRoles }),
    })
    const branchRoles = BranchRoles.layer(roles)
    return {
      check: (admission: Admission) =>
        verdict(roles, admission, roleFreshMs).pipe(
          Effect.provide(branchRoles),
          Effect.provideService(Conversations.homeRepositoryNames, home),
          Effect.catchCause(() => Effect.succeed<Verdict>("unverified")),
        ),
      within: <A, R2>(renewal: Effect.Effect<A, never, R2>) =>
        renewal.pipe(Effect.provide(database)) as Effect.Effect<A, unknown, Exclude<R2, SqlClient.SqlClient>>,
    }
  })
