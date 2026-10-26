// Program boundary for the production RepoApi route, bundled with Alchemy's plugins.
// Initialization finishes before visitors arrive; no initialization promise crosses requests.
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { ConfigProvider, Effect, Option } from "effect"
import { FetchHttpClient, HttpEffect, type HttpClient, type HttpServerRequest, type HttpServerResponse } from "effect/http"
import * as Actor from "../../Actor.ts"
import * as RepoApi from "../../RepoApi.ts"

interface Env {
  readonly HYPERDRIVE: { readonly connectionString: string }
  readonly SCHEMA: string
}
let handle: ((request: Request) => Promise<Response>) | undefined

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/initialize") {
      const database = PostgresDatabase.layer({ url: env.HYPERDRIVE.connectionString, driver: Pg, schema: env.SCHEMA })
      const api = await Effect.runPromise(RepoApi.make(database, { codeStorage: Option.none() }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        Effect.provide(FetchHttpClient.layer),
      ))
      // Only the About route is exposed: it needs sessions and HTTP, never the clone/flow/cache services.
      const about = api.fetch as Effect.Effect<HttpServerResponse.HttpServerResponse, never,
        HttpServerRequest.HttpServerRequest | HttpClient.HttpClient | Actor.Sessions>
      handle = HttpEffect.toWebHandler(about.pipe(Effect.provide(Actor.signedOut), Effect.provide(FetchHttpClient.layer)))
      return new Response("ready")
    }
    if (new URL(request.url).pathname !== "/api/repos/octocat/Spoon-Knife/about") return new Response(null, { status: 404 })
    return handle!(request)
  },
}
