import { Home } from "@smthrs/views"
import { Clock, Effect, Metric, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { audienceOf, HOME_SEGMENT } from "../../src/features/home/contract.ts"
import { REPO_ROLE_SEGMENT } from "../../src/features/auth/contract.ts"
import type { RepoRoleAnswer } from "../../src/features/auth/schema.ts"
import type { HomeAnswer } from "../../src/features/home/schema.ts"
import { isRepository, REPOS_ROUTE } from "../../src/features/repo/contract.ts"
import { type Actor, type Role, Sessions } from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as Curated from "./Curated.ts"

// `GET /api/repos/<owner>/<name>/home` (docs/features/home.md#who-sees-what): who the asker is on the repository, and
// Smithers' curated home for it with only the sections that audience may see. The server decides the audience from
// the person's role on that repository (a Maintainer or Admin is a maintainer, anyone else with a role a contributor,
// the rest everyone, or a contributor too when the curated home opens to anyone), so a section above it never reaches
// the browser; a live block's rows are read through their own shapes, which check the role again. Anyone may ask,
// signed out included. Never cached: the answer depends on the session.
//
// The role is `RepoRoles`' (decision 0079): the session's on the deployment's own repository (`GITHUB_REPOSITORY`),
// and on any other the person's GitHub permission there, read with the App, so a role on one repository never counts
// on another. Where the deployment can't act (the App isn't installed or configured there, or
// `GITHUB_ALLOWED_REPOSITORIES` leaves it out) nobody has a role, and everyone sees what a visitor sees. When GitHub
// or Postgres can't say the role, the route answers `503` with `retry-after`: it never guesses one.
//
// Each request is one span and log line `home.curated` and one count, with its outcome, the audience and how many
// sections it sent and held back; never a section, a block or a name.
//
// `GET /api/repos/<owner>/<name>/role` answers the same role itself, `{ role, own }`, and whether the repository is the
// deployment's own, for the header's links and the buttons each page gates by it (docs/features/sign-in.md). Each
// request is one span and log line `repo.role` and one count, with its outcome and the role; never a login.

/** `GET .../home` requests, by `outcome` and `audience`. */
export const requests = Metric.counter("smithers_home_curated_requests", {
  description: "GET /api/repos/<owner>/<name>/home requests, by outcome and audience",
  incremental: true,
})

/** `GET .../role` requests, by `outcome` and `role`. */
export const roleRequests = Metric.counter("smithers_repo_role_requests", {
  description: "GET /api/repos/<owner>/<name>/role requests, by outcome and role",
  incremental: true,
})

/** The repository a route of `segment` names, from `/api/repos/<owner>/<name>/<segment>`; none for any other path. */
const parseRepoPath = (
  path: string,
  segment: string,
): { readonly owner: string; readonly name: string } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 3 || segments[2] !== segment) return undefined
  try {
    const owner = decodeURIComponent(segments[0]!)
    const name = decodeURIComponent(segments[1]!)
    return isRepository(owner, name) ? { owner, name } : undefined
  } catch {
    return undefined
  }
}

/** The repository a home route names, from `/api/repos/<owner>/<name>/home`; none for any other path. */
export const parseHomePath = (path: string) => parseRepoPath(path, HOME_SEGMENT)

/** The repository a role route names, from `/api/repos/<owner>/<name>/role`; none for any other path. */
export const parseRolePath = (path: string) => parseRepoPath(path, REPO_ROLE_SEGMENT)

/** Whether a path is the home route or the role route. */
export const handles = (path: string): boolean => parseHomePath(path) !== undefined || parseRolePath(path) !== undefined

const headers = { "cache-control": "no-store", vary: "cookie" }

/** What the route serves: who has which role on which repository, and the curated homes. */
export interface Options<R> {
  /** The person's role on the routed repository (decision 0079); `R` is what its database's layer needs. */
  readonly roles: RepoRoles.RepoRoles<R>
  /** The curated homes: worker/home/curated/ unless a test gives its own. */
  readonly files?: ReadonlyArray<Curated.CuratedFile>
}

/** The person's role on the routed repository, and where it came from: no one signed in, `RepoRoles`, or a refusal. */
interface Decided {
  readonly role: Role | null
  readonly source: "signed_out" | "role" | "no_role_here"
  readonly refused?: RepoRoles.Refusal
}

/** The routes. They read who is asking from `Sessions`. */
export const make = <R>({ roles, files = Curated.files }: Options<R>) => {
  /**
   * The person's role on `target`: none signed out, or where the deployment can't act; a role GitHub or Postgres can't
   * say now is the refusal, never a guess.
   */
  const decide = (actor: Option.Option<Actor>, target: { readonly owner: string; readonly name: string }) =>
    Option.match(actor, {
      onNone: () => Effect.succeed<Decided>({ role: null, source: "signed_out" }),
      onSome: (signed) =>
        roles.resolve(signed, repositoryOf(`${target.owner}/${target.name}`)).pipe(
          Effect.map((resolved): Decided => ({ role: resolved.role, source: "role" })),
          Effect.catch((refused) =>
            RepoRoles.CANT_ACT.has(refused.code)
              ? Effect.succeed<Decided>({ role: null, source: "no_role_here", refused: refused.code })
              : Effect.fail(refused)
          ),
        ),
    })

  /** A refusal's answer: its status, with GitHub's wait when it said one. */
  const refusedAnswer = (refused: RepoRoles.RoleRefused) =>
    HttpServerResponse.jsonUnsafe({ code: refused.code }, {
      status: RepoRoles.REFUSALS[refused.code],
      headers: { ...headers, "retry-after": String(refused.retryAfterSeconds ?? 5) },
    })

  const home = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const target = parseHomePath(request.url.split("?")[0]!)!
    const record = (
      response: HttpServerResponse.HttpServerResponse,
      fields: {
        readonly outcome: string
        readonly audience?: Home.Audience
        readonly sections?: number
        readonly hidden?: number
        readonly source?: "signed_out" | "role" | "no_role_here"
        readonly refused?: RepoRoles.Refusal
      },
    ) =>
      Effect.gen(function* () {
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt
        const audience = fields.audience ?? "none"
        yield* Metric.update(Metric.withAttributes(requests, { outcome: fields.outcome, audience }), 1)
        yield* Effect.annotateCurrentSpan({ "smithers.home.outcome": fields.outcome, "smithers.home.audience": audience })
        yield* Effect.logWithLevel(fields.outcome === "unavailable" || fields.outcome === "invalid" || fields.outcome === "role_unavailable" ? "Warn" : "Info")(
          "home.curated",
        ).pipe(Effect.annotateLogs({ ...fields, status: response.status, durationMs }))
        return response
      })
    if (request.method !== "GET") {
      return yield* record(HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } }), { outcome: "method" })
    }
    const actor = yield* Effect.result((yield* Sessions).resolve)
    if (actor._tag === "Failure") {
      return yield* record(
        HttpServerResponse.jsonUnsafe({ code: "unavailable" }, { status: 503, headers: { ...headers, "retry-after": "5" } }),
        { outcome: "unavailable" },
      )
    }
    const decided = yield* decide(actor.success, target).pipe(Effect.result)
    if (decided._tag === "Failure") {
      return yield* record(refusedAnswer(decided.failure), { outcome: "role_unavailable", refused: decided.failure.code })
    }
    const { role, ...why } = decided.success
    const ownView = audienceOf(role)
    const found = Curated.find(target.owner, target.name, files)
    if (found === undefined || found === "invalid") {
      const answer: HomeAnswer = { audience: ownView, curated: null }
      return yield* record(HttpServerResponse.jsonUnsafe(answer, { headers }), {
        outcome: found === undefined ? "absent" : "invalid",
        audience: ownView,
        ...why,
      })
    }
    const audience = Home.widen(ownView, found.contributors)
    const sections = Home.visible(found.sections, audience)
    const answer: HomeAnswer = {
      audience,
      curated: {
        defaultBranch: found.defaultBranch,
        sections,
        ...(found.docs === undefined ? {} : { docs: found.docs }),
      },
    }
    return yield* record(HttpServerResponse.jsonUnsafe(answer, { headers }), {
      outcome: "curated",
      audience,
      sections: sections.length,
      hidden: found.sections.length - sections.length,
      ...why,
    })
  }).pipe(Effect.withSpan("home.curated"))

  const role = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const target = parseRolePath(request.url.split("?")[0]!)!
    const record = (
      response: HttpServerResponse.HttpServerResponse,
      fields: {
        readonly outcome: string
        readonly role?: Role | null
        readonly own?: boolean
        readonly source?: Decided["source"]
        readonly refused?: RepoRoles.Refusal
      },
    ) =>
      Effect.gen(function* () {
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt
        const role = fields.role === undefined ? "none" : fields.role ?? "no_role"
        yield* Metric.update(Metric.withAttributes(roleRequests, { outcome: fields.outcome, role }), 1)
        yield* Effect.annotateCurrentSpan({ "smithers.role.outcome": fields.outcome, "smithers.role.role": role })
        yield* Effect.logWithLevel(fields.outcome === "answered" || fields.outcome === "method" ? "Info" : "Warn")(
          "repo.role",
        ).pipe(Effect.annotateLogs({ ...fields, status: response.status, durationMs }))
        return response
      })
    if (request.method !== "GET") {
      return yield* record(HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } }), { outcome: "method" })
    }
    const actor = yield* Effect.result((yield* Sessions).resolve)
    if (actor._tag === "Failure") {
      return yield* record(
        HttpServerResponse.jsonUnsafe({ code: "unavailable" }, { status: 503, headers: { ...headers, "retry-after": "5" } }),
        { outcome: "unavailable" },
      )
    }
    const decided = yield* decide(actor.success, target).pipe(Effect.result)
    if (decided._tag === "Failure") {
      return yield* record(refusedAnswer(decided.failure), { outcome: "role_unavailable", refused: decided.failure.code })
    }
    const own = repositoryOf(`${target.owner}/${target.name}`).id === roles.repository.id
    const answer: RepoRoleAnswer = { role: decided.success.role, own }
    return yield* record(HttpServerResponse.jsonUnsafe(answer, { headers }), { outcome: "answered", own, ...decided.success })
  }).pipe(Effect.withSpan("repo.role"))

  return {
    fetch: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      parseRolePath(request.url.split("?")[0]!) === undefined ? home : role),
  }
}
