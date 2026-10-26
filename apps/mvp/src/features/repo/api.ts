import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { HOME_FILE } from "../home/contract"
import { repoRoleRoute } from "../auth/contract"
import { RepoRoleAnswer } from "../auth/schema"
import { aboutRoute, blobRoute, LAUNCH_ROUTE, refsRoute, REPOS_ROUTE, treeRoute } from "./contract"
import { About, CloneAccepted, CloneLaunched, RefusalBody, Refs, TreeListing } from "./schema"

// RepoApi's routes as the browser calls them (docs/features/repo.md#routes), through Effect's HttpClient. Each request
// has one deadline covering the whole exchange, its body included.

/**
 * RepoApi didn't answer as the contract says: no whole answer within the deadline, or no network (`status` absent), or
 * a refusal (`status`, with RepoApi's `code`, for a file over the limit its `size`, and how long RepoApi asked to wait
 * when it sent `Retry-After`), or a body outside the contract (`status` with no `code`).
 */
export class RepoRefused extends Data.TaggedError("RepoRefused")<{
  readonly status?: number
  readonly code?: string
  readonly size?: number
  readonly retryAfterMillis?: number
}> {}

/** How long the app gives RepoApi for one whole request: the tab's client and the engine worker's reads alike. */
export const REQUEST_WITHIN = "15 seconds"

/** A file's bytes as RepoApi answered them. */
export interface Blob {
  readonly bytes: Uint8Array
}

const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(RefusalBody))

/** `Retry-After` in delta-seconds, as milliseconds; RepoApi sends no other form. */
const retryAfter = (value: string | undefined): { readonly retryAfterMillis?: number } =>
  value !== undefined && /^\d+$/.test(value.trim()) ? { retryAfterMillis: Number(value.trim()) * 1000 } : {}

/** A refusal from a non-2xx answer: its status, its `Retry-After`, and the `code` and `size` of its body. */
const refusedBy = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    const body = decodeRefusal(yield* Effect.orElseSucceed(response.text, () => ""))
    return yield* new RepoRefused({
      status: response.status,
      ...retryAfter(response.headers["retry-after"]),
      ...Option.match(body, {
        onNone: () => ({}),
        onSome: ({ code, size }) => (size === undefined ? { code } : { code, size }),
      }),
    })
  })

/** Sends `request` and answers its response when `ok` says it's the one wanted; any other status is refused. */
const exchange = <A, R>(
  request: HttpClientRequest.HttpClientRequest,
  within: Duration.Input,
  ok: (status: number) => boolean,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, RepoRefused, R>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request).pipe(Effect.mapError(() => new RepoRefused({})))
    if (!ok(response.status)) return yield* refusedBy(response)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    return yield* read(response)
  }).pipe(
    // Interrupting the request aborts its fetch, so a stalled body stops too.
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new RepoRefused({})) }),
  )

/** Reads a JSON body with `schema`; a body outside it is refused with the response's status. */
const json = <A>(schema: Schema.Codec<A, unknown>) => (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => new RepoRefused({ status: response.status })),
  )

/**
 * `POST /api/repos`: asks for a clone of `owner/name`, which RepoApi persists and answers at once. `202` a new attempt;
 * `200` one is running or done. `postLaunch` starts it.
 */
export const postClone = Effect.fn("repo.clone.post")(function* (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.post(`${origin}${REPOS_ROUTE}`).pipe(HttpClientRequest.bodyJsonUnsafe(repository)),
    within,
    (status) => status === 200 || status === 202,
    json(CloneAccepted),
  )
})

/** `POST /api/repos/launch`: starts the clone attempt `cloneId` a request persisted. `202` launched; `200` it settled. */
export const postLaunch = Effect.fn("repo.clone.launch.post")(function* (
  origin: string,
  attempt: { readonly owner: string; readonly name: string; readonly cloneId: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.post(`${origin}${LAUNCH_ROUTE}`).pipe(HttpClientRequest.bodyJsonUnsafe(attempt)),
    within,
    (status) => status === 200 || status === 202,
    json(CloneLaunched),
  )
})

/** `GET /api/repos/<owner>/<name>/tree/<sha>`: every file's path at `sha`. */
export const getTree = Effect.fn("repo.tree.get")(function* (
  origin: string,
  repository: { readonly owner: string; readonly name: string; readonly sha: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.get(`${origin}${treeRoute(repository.owner, repository.name, repository.sha)}`),
    within,
    (status) => status === 200,
    json(TreeListing),
  )
})

/** `GET /api/repos/<owner>/<name>/blob/<sha>/<path>`: a file's bytes at `sha`. */
export const getBlob = Effect.fn("repo.blob.get")(function* (
  origin: string,
  file: { readonly owner: string; readonly name: string; readonly sha: string; readonly path: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.get(`${origin}${blobRoute(file.owner, file.name, file.sha, file.path)}${file.path === HOME_FILE ? "?optional=true" : ""}`),
    within,
    (status) => status === 200 || status === 204,
    (response) =>
      // Keep the existing home state contract while absence travels as a successful HTTP response.
      response.status === 204 ? Effect.fail(new RepoRefused({ status: 404, code: "not_found" })) : response.arrayBuffer.pipe(
        Effect.map((buffer): Blob => ({ bytes: new Uint8Array(buffer) })),
        Effect.mapError(() => new RepoRefused({ status: response.status })),
      ),
  )
})

/** `GET /api/repos/<owner>/<name>/refs`: the default branch, its head, and every branch and tag. */
export const getRefs = Effect.fn("repo.refs.get")(function* (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.get(`${origin}${refsRoute(repository.owner, repository.name)}`),
    within,
    (status) => status === 200 || status === 204,
    (response) => response.status === 204
      ? Effect.fail(new RepoRefused({ status: 404, code: "not_found" }))
      : json(Refs)(response),
  )
})

/** `GET /api/repos/<owner>/<name>/about`: what GitHub says of the repository, cloned or not. */
export const getAbout = Effect.fn("repo.about.get")(function* (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.get(`${origin}${aboutRoute(repository.owner, repository.name)}`),
    within,
    (status) => status === 200,
    json(About),
  )
})

/**
 * `GET /api/repos/<owner>/<name>/role`: the person's role on the repository and whether it is the deployment's own
 * (decision 0079, worker/home/Api.ts).
 */
export const getRole = Effect.fn("repo.role.get")(function* (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  within: Duration.Input,
) {
  return yield* exchange(
    HttpClientRequest.get(`${origin}${repoRoleRoute(repository.owner, repository.name)}`),
    within,
    (status) => status === 200,
    json(RepoRoleAnswer),
  )
})

/**
 * RepoApi's client, as a service: the one way the browser asks for a clone and reads a repository. Tests of a RepoApi
 * that fails provide a faulty one; every other test uses the real one.
 */
export class RepoClient extends Context.Service<
  RepoClient,
  {
    readonly clone: (owner: string, name: string) => Effect.Effect<CloneAccepted, RepoRefused>
    readonly launch: (owner: string, name: string, cloneId: string) => Effect.Effect<CloneLaunched, RepoRefused>
    readonly tree: (owner: string, name: string, sha: string) => Effect.Effect<TreeListing, RepoRefused>
    readonly blob: (owner: string, name: string, sha: string, path: string) => Effect.Effect<Blob, RepoRefused>
    readonly refs: (owner: string, name: string) => Effect.Effect<Refs, RepoRefused>
    readonly about: (owner: string, name: string) => Effect.Effect<About, RepoRefused>
    /** Who the person is on the repository: their role there, and whether it is the deployment's own. */
    readonly role: (owner: string, name: string) => Effect.Effect<RepoRoleAnswer, RepoRefused>
  }
>()("@smthrs/mvp/repo/RepoClient") {
  /** The real client: RepoApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input }) =>
    Layer.effect(
      RepoClient,
      Effect.map(HttpClient.HttpClient, (client) => {
        const withClient = Effect.provideService(HttpClient.HttpClient, client)
        return RepoClient.of({
          clone: (owner, name) => withClient(postClone(options.origin, { owner, name }, options.within)),
          launch: (owner, name, cloneId) => withClient(postLaunch(options.origin, { owner, name, cloneId }, options.within)),
          tree: (owner, name, sha) => withClient(getTree(options.origin, { owner, name, sha }, options.within)),
          blob: (owner, name, sha, path) =>
            withClient(getBlob(options.origin, { owner, name, sha, path }, options.within)),
          refs: (owner, name) => withClient(getRefs(options.origin, { owner, name }, options.within)),
          about: (owner, name) => withClient(getAbout(options.origin, { owner, name }, options.within)),
          role: (owner, name) => withClient(getRole(options.origin, { owner, name }, options.within)),
        })
      }),
    )
}
