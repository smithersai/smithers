import { GitHub } from "@smthrs/integrations"
import { Effect, Function, Metric, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http"
import { COMPARE_SEGMENT, SHA } from "../../src/features/pulls/contract.ts"
import { REPOS_ROUTE } from "../../src/features/repo/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { statusOf, withToken } from "./Calls.ts"
import type { GitHubApp, Repository } from "./Config.ts"
import * as Tokens from "./Tokens.ts"

// `GET /api/repos/<owner>/<name>/compare/<base>...<head>` (decision 0012 §3, docs/features/pulls.md#files): the files two
// commits differ by, with their patches, which a pull request's Files tab shows. Two SHAs never change what they
// compare, so the answer is kept forever by whoever reads it, and nothing of it is a row. The route reads GitHub with
// the App's installation token for this one repository; the device never calls GitHub.

/** `GET /api/repos/<owner>/<name>/compare/<base>...<head>` as its parts, or `undefined` for any other path. */
export const parseComparePath = (path: string) => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 4 || segments[2] !== COMPARE_SEGMENT) return undefined
  const [base = "", head = ""] = segments[3]!.split("...")
  if (!SHA.test(base) || !SHA.test(head)) return undefined
  try {
    return { owner: decodeURIComponent(segments[0]!), name: decodeURIComponent(segments[1]!), base, head }
  } catch {
    return undefined
  }
}

/** Compare reads, by `outcome`. */
export const compares = Metric.counter("smithers_github_compares", {
  description: "GET .../compare/<base>...<head> answers, by outcome",
  incremental: true,
})

const noStore = { "cache-control": "no-store" }

/**
 * The compare route over `app` and `http` (`fetch` unless set): an installation token per read (`pulls` access), then
 * GitHub's comparison. `200 { files,
 * truncated }` kept forever; `404 not_found` when GitHub has no such commits; `503` when the App isn't installed or
 * GitHub didn't answer. Each read is a log line `github.compare` with the outcome and the file count, never a path.
 */
export const make = (app: GitHubApp, http: Option.Option<HttpClient.HttpClient> = Option.none()) =>
  Effect.gen(function* () {
    const appAuth = GitHub.AppAuth.make({ appId: app.appId, privateKey: app.privateKey, apiBaseUrl: app.apiBaseUrl })
    return (repository: Repository, base: string, head: string) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.gen(function* () {
          const tokens = Tokens.make({
            app: yield* appAuth,
            // Installation tokens only: no session's token to refresh.
            keys: Option.none(),
            refresh: Function.constant(Effect.void),
          })
          const token = yield* tokens.forInstallation(repository, "pulls")
          return yield* GitHub.Commits.compare(repository.owner, repository.name, base, head).pipe(
            withToken(token, app.apiBaseUrl),
          )
        }).pipe(
          Option.isSome(http) ? Effect.provideService(HttpClient.HttpClient, http.value) : Effect.provide(FetchHttpClient.layer),
          Effect.result,
        )
        if (outcome._tag === "Success") {
          yield* Metric.update(Metric.withAttributes(compares, { outcome: "read" }), 1)
          yield* Effect.logInfo("github.compare").pipe(
            Effect.annotateLogs({ outcome: "read", files: outcome.success.files.length }),
          )
          return HttpServerResponse.jsonUnsafe(
            { files: outcome.success.files, truncated: outcome.success.truncated },
            { status: 200, headers: { "cache-control": "private, max-age=31536000, immutable" } },
          )
        }
        const status = statusOf(outcome.failure)
        const code = status === 404 || status === 422 ? "not_found" : "unavailable"
        yield* Metric.update(Metric.withAttributes(compares, { outcome: code }), 1)
        yield* Effect.logWarning("github.compare").pipe(
          Effect.annotateLogs({ outcome: code, errorCode: codeOf(outcome.failure) }),
        )
        return HttpServerResponse.jsonUnsafe({ code }, { status: code === "not_found" ? 404 : 503, headers: noStore })
      }).pipe(Effect.withSpan("github.compare", { kind: "server" }))
  })
