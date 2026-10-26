// Program boundary for the production GitHub shape routes (worker/github/Api.ts), bundled with Alchemy's plugins, with
// who is asking from sign-in's real sessions (worker/SignIn.ts) as ChatApi provides them: a request without a session
// cookie is signed out. The GitHub App is configured, so a signed-out reader's visibility check goes out with the App's
// read token (worker/github/ReadToken.ts); a Member's read takes the role path. GitHub is the scripted GitHub on the
// `HttpClient` seam, answering each call after a timer in the calling request, as the network would; Postgres and
// Electric are real. `RoleChecks`, which ChatApi starts on a Durable Object, counts the checks a stale session starts.
// Initialization finishes before visitors arrive; no initialization promise crosses requests.
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { ConfigProvider, Effect, Layer, Option, Redacted, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpEffect } from "effect/http"
import { FlowStarter } from "../../Flows.ts"
import * as GitHubApi from "../../github/Api.ts"
import * as GitHubConfig from "../../github/Config.ts"
import * as RepoRoles from "../../github/RepoRoles.ts"
import { APP_ID, appKey, SCRIPTED_API, type ScriptedGitHub, scriptedGitHub } from "../../github/test/scriptedGitHub.ts"
import * as SignIn from "../../SignIn.ts"
import { REPOSITORY, SESSION_SECRET } from "./shapesFixture.ts"

interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string }
  readonly SCHEMA: string
  readonly ELECTRIC_URL: string
}

/** How long the scripted GitHub takes to answer each call: long enough for every first reader to arrive meanwhile. */
const LATENCY = "50 millis"

let handle: ((request: Request) => Promise<Response>) | undefined
let github: ScriptedGitHub | undefined
let roleChecks = 0

const initialize = async (env: Env) => {
  github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const scripted = github.http
  const latent = HttpClient.mapRequestEffect(scripted, (request) => Effect.as(Effect.sleep(LATENCY), request))
  const config = ConfigProvider.fromUnknown({
    ELECTRIC_URL: env.ELECTRIC_URL,
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY: Redacted.value(await appKey()),
    GITHUB_API_URL: SCRIPTED_API,
    GITHUB_REPOSITORY: `${REPOSITORY.owner}/${REPOSITORY.name}`,
    GITHUB_APP_CLIENT_ID: "Iv1.scripted",
    GITHUB_APP_CLIENT_SECRET: "workerd-shapes-client-sentinel",
    SESSION_SECRET,
  })
  const database = PostgresDatabase.layer({ url: env.HYPERDRIVE.connectionString, driver: Pg, schema: env.SCHEMA })
  // The isolate's scope, as ChatApi's program has: it outlives every request.
  const scope = await Effect.runPromise(Scope.make())
  const { routes, signIn } = await Effect.runPromise(Effect.gen(function* () {
    const repository = yield* GitHubConfig.repository
    const app = yield* GitHubConfig.configured
    const roles = yield* RepoRoles.make(database, { repository, app, allowed: Option.none(), http: latent })
    const signIn = yield* SignIn.make(database).pipe(Effect.provide(FetchHttpClient.layer))
    return { routes: yield* GitHubApi.make(database, { repository, app, roles, http: latent }), signIn }
  }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(ConfigProvider.ConfigProvider, config)))
  // Who is asking, as ChatApi's `signedIn` layer gives it (worker/ChatApiProgram.ts), with role checks counted.
  const checks = Layer.succeed(SignIn.RoleChecks, SignIn.RoleChecks.of({ start: () => Effect.sync(() => void roleChecks++) }))
  const signedIn = Layer.merge(checks, signIn.sessions.pipe(Layer.provide(checks)))
  // Electric, as the routes call it: each table in this test's schema.
  const electric: typeof globalThis.fetch = (input, init) => {
    const upstream = new URL(input instanceof Request ? input.url : String(input))
    const table = upstream.searchParams.get("table")
    if (table !== null) upstream.searchParams.set("table", `${env.SCHEMA}.${table}`)
    return globalThis.fetch(upstream, init)
  }
  handle = HttpEffect.toWebHandler(routes.fetch.pipe(
    Effect.provide(signedIn),
    Effect.provideService(FlowStarter, FlowStarter.of({ start: () => Effect.void })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, electric),
    Effect.provideService(ConfigProvider.ConfigProvider, config),
  ))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/initialize") {
      await initialize(env)
      return new Response("ready")
    }
    // The installation tokens GitHub minted so far, and the role checks stale sessions started.
    if (path === "/counts") {
      return Response.json({
        mints: github!.calls.filter((call) => call.method === "POST" && call.path.endsWith("/access_tokens")).length,
        roleChecks,
      })
    }
    return handle!(request)
  },
}
