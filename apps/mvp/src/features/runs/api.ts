import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { renewed, withBearer, withoutCookie } from "../../flows/bearer"
import { CONFIRM_401_HEADER, sessionCheckOf } from "../auth/contract"
import { CLOUD_RUNS_LIMIT, CLOUD_RUNS_ROUTE, remoteRunRoute, steersRoute, stopRoute } from "./contract"
import { flowInputsRoute, repoFlowsRoute, repoRunsRoute } from "../actions/contract"
import { type CloudRun, CloudRunList, type Inspection, type RepoName } from "./schema"

// ChatApi's remote runs route as the browser calls it (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare): a run
// Smithers runs on Cloudflare, as the engine's `RunInspection` reads it there, through Effect's HttpClient with one
// deadline over the whole exchange, decoded with the engine's own wire shape (`BrowserEngine.Inspection`). A
// repository's run is stopped there too (docs/features/actions.md#acts), and its flows run by hand or again through its
// runs routes (docs/features/actions.md#running-a-flow-by-hand).

/**
 * ChatApi didn't answer with the run: no whole answer within the deadline, or no network (`status` absent), any status
 * but 200 (`status`, and the refusal's `code` when its body names one), or a 200 whose body isn't a run.
 */
export class RemoteReadFailed extends Data.TaggedError("RemoteReadFailed")<{
  readonly status?: number
  readonly code?: string
}> {}

const decodeInspection = Schema.decodeUnknownEffect(BrowserEngine.Inspection)
const decodeRefusal = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

/** `GET /api/remote-runs/<runId>?afterSeq=&limit=`. */
export const getRun = (
  origin: string,
  runId: string,
  options: { readonly afterSeq?: number; readonly limit?: number },
  within: Duration.Input,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const query = new URLSearchParams()
    if (options.afterSeq !== undefined) query.set("afterSeq", String(options.afterSeq))
    if (options.limit !== undefined) query.set("limit", String(options.limit))
    const search = query.size === 0 ? "" : `?${query}`
    const response = yield* client
      .execute(HttpClientRequest.get(`${origin}${remoteRunRoute(runId)}${search}`))
      .pipe(Effect.mapError(() => new RemoteReadFailed({})))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status !== 200) {
      const refused = yield* response.json.pipe(Effect.option, Effect.map(Option.flatMap(decodeRefusal)))
      return yield* new RemoteReadFailed({
        status: response.status,
        ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
      })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeInspection),
      Effect.mapError(() => new RemoteReadFailed({ status: response.status })),
    )
  }).pipe(
    // Interrupting the request aborts its fetch, so a stalled body stops too.
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new RemoteReadFailed({})) }),
    Effect.withSpan("run.read.remote"),
  )

const decodeCloudRuns = Schema.decodeUnknownEffect(CloudRunList)

/** `GET /api/cloud-runs?limit=`: the runs on Cloudflare this person may read, newest first. */
export const getCloudRuns = (origin: string, within: Duration.Input) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(HttpClientRequest.get(`${origin}${CLOUD_RUNS_ROUTE}?limit=${CLOUD_RUNS_LIMIT}`))
      .pipe(Effect.mapError(() => new RemoteReadFailed({})))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status !== 200) {
      const refused = yield* response.json.pipe(Effect.option, Effect.map(Option.flatMap(decodeRefusal)))
      return yield* new RemoteReadFailed({
        status: response.status,
        ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
      })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeCloudRuns),
      Effect.map((list) => list.runs),
      Effect.mapError(() => new RemoteReadFailed({ status: response.status })),
    )
  }).pipe(
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new RemoteReadFailed({})) }),
    Effect.withSpan("run.list.cloud"),
  )

/**
 * ChatApi didn't take a steer: no whole answer within the deadline, or no network (`status` absent), or any status but
 * 200 and 202 (`status`, and the refusal's `code` when its body names one). A session steer's `401` the page's transport
 * checked against the session carries what it found (`sessionCheck`).
 */
export class SteerFailed extends Data.TaggedError("SteerFailed")<{
  readonly status?: number
  readonly code?: string
  readonly sessionCheck?: "same_person"
}> {}

/** What the steer route answered: the message's id, and whether it had it already. */
export interface SteerTaken {
  readonly id: string
  readonly existing: boolean
}

/**
 * `POST /api/remote-runs/<runId>/steers { id, body }`. With `credential`, the steer goes as the run that sent it, with a
 * fresh credential of that run and without the session cookie (decision 0017 slice 0).
 */
export const postSteer = (
  origin: string,
  runId: string,
  steer: { readonly id: string; readonly body: string },
  within: Duration.Input,
  credential?: string,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const authority = credential === undefined
      ? undefined
      : yield* renewed(origin, credential).pipe(
        Effect.mapError(({ status }) => new SteerFailed(status === undefined ? {} : { status })),
      )
    const request = HttpClientRequest.post(`${origin}${steersRoute(runId)}`).pipe(HttpClientRequest.bodyJsonUnsafe(steer))
    // A 401 in the session is checked against the session first, so a queued steer can be held (writes.ts); a run's
    // 401 is about the run, and stands.
    const response = yield* (authority === undefined
      ? client.execute(HttpClientRequest.setHeader(request, CONFIRM_401_HEADER, "1"))
      : withoutCookie(client.execute(withBearer(request, authority))))
      .pipe(Effect.mapError(() => new SteerFailed({})))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status === 200 || response.status === 202) {
      return { id: steer.id, existing: response.status === 200 } satisfies SteerTaken
    }
    const refused = yield* response.json.pipe(Effect.option, Effect.map(Option.flatMap(decodeRefusal)))
    return yield* new SteerFailed({
      status: response.status,
      ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
      ...sessionCheckOf(response.headers),
    })
  }).pipe(
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new SteerFailed({})) }),
    Effect.withSpan("run.steer.post"),
  )

/**
 * ChatApi didn't stop the run: no whole answer within the deadline, or no network (`status` absent), or any status but
 * 200 and 202 (`status`, and the refusal's `code` when its body names one).
 */
export class StopFailed extends Data.TaggedError("StopFailed")<{
  readonly status?: number
  readonly code?: string
}> {}

const decodeStopped = Schema.decodeUnknownOption(Schema.Struct({ outcome: Schema.Literals(["requested", "settled"]) }))

/** `POST /api/remote-runs/<runId>/stop`: a repository's run, stopped on its Durable Object. */
export const postStop = (origin: string, runId: string, within: Duration.Input) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.post(`${origin}${stopRoute(runId)}`)).pipe(
      Effect.mapError(() => new StopFailed({})),
    )
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    const body = yield* response.json.pipe(Effect.option)
    if (response.status === 200 || response.status === 202) {
      const stopped = Option.flatMap(body, decodeStopped)
      if (Option.isSome(stopped)) return stopped.value
      return yield* new StopFailed({ status: response.status })
    }
    const refused = Option.flatMap(body, decodeRefusal)
    return yield* new StopFailed({
      status: response.status,
      ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
    })
  }).pipe(
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new StopFailed({})) }),
    Effect.withSpan("run.stop.post"),
  )

/**
 * ChatApi didn't answer a repository's runs route: no whole answer within the deadline, or no network (`status`
 * absent), or a refusal (`status`, and its `code` when the body names one), or an answer that isn't one.
 */
export class RepoRunsFailed extends Data.TaggedError("RepoRunsFailed")<{
  readonly status?: number
  readonly code?: string
}> {}

/** A repository's flows a person runs by hand, and its default branch. */
export const RepoFlows = Schema.Struct({
  flows: Schema.Array(Schema.Struct({ name: Schema.String, title: Schema.optionalKey(Schema.String) })),
  defaultBranch: Schema.String,
})
export type RepoFlows = typeof RepoFlows.Type

/** A flow's inputs at a branch's head, and the commit. */
export const FlowInputs = Schema.Struct({ inputs: Schema.Unknown, sha: Schema.String })
export type FlowInputs = typeof FlowInputs.Type

/** What a start answered: the run it started, or had started for that id. */
const Started = Schema.Struct({ runId: Schema.String })

/** One exchange with a repository's runs routes: `ok` statuses decode with `schema`; anything else fails. */
const exchange = <A>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Decoder<A>,
  ok: ReadonlyArray<number>,
  within: Duration.Input,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request).pipe(Effect.mapError(() => new RepoRunsFailed({})))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    const body = yield* response.json.pipe(Effect.option)
    if (ok.includes(response.status)) {
      const decoded = Option.flatMap(body, Schema.decodeUnknownOption(schema))
      if (Option.isSome(decoded)) return decoded.value
      return yield* new RepoRunsFailed({ status: response.status })
    }
    const refused = Option.flatMap(body, decodeRefusal)
    return yield* new RepoRunsFailed({
      status: response.status,
      ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
    })
  }).pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new RepoRunsFailed({})) }))

/** A run by hand, `{ id, flow, ref, input }`, or a run again, `{ id, retryOf, failed }`. */
export type RepoRunStart =
  | { readonly id: string; readonly flow: string; readonly ref: string; readonly input?: Readonly<Record<string, string | number | boolean>> }
  | { readonly id: string; readonly retryOf: string; readonly failed: boolean }

/**
 * ChatApi's remote runs routes, as a service: how this tab reads a run Smithers runs on Cloudflare, and steers its
 * agent. Tests of a route that fails provide a faulty one; every other test uses the real one.
 */
export class RemoteRunsClient extends Context.Service<
  RemoteRunsClient,
  {
    readonly inspect: (
      runId: string,
      options?: { readonly afterSeq?: number; readonly limit?: number },
    ) => Effect.Effect<Inspection, RemoteReadFailed>
    /** Sends `steer`: as the run whose `credential` it carries, else in the person's session. */
    readonly steer: (
      runId: string,
      steer: { readonly id: string; readonly body: string },
      credential?: string,
    ) => Effect.Effect<SteerTaken, SteerFailed>
    /** Stops a repository's run on Cloudflare: `requested`, or `settled` when it had ended. */
    readonly stop: (runId: string) => Effect.Effect<{ readonly outcome: "requested" | "settled" }, StopFailed>
    /** The runs on Cloudflare this person may read, newest first. */
    readonly list: Effect.Effect<ReadonlyArray<CloudRun>, RemoteReadFailed>
    /** The repository's flows a person runs by hand (docs/features/actions.md#running-a-flow-by-hand). */
    readonly flows: (repo: RepoName) => Effect.Effect<RepoFlows, RepoRunsFailed>
    /** Flow `flow`'s inputs at branch `ref`'s head. */
    readonly inputs: (repo: RepoName, flow: string, ref: string) => Effect.Effect<FlowInputs, RepoRunsFailed>
    /** Starts a repository's run by hand, or a run again: the run's id. */
    readonly start: (repo: RepoName, start: RepoRunStart) => Effect.Effect<{ readonly runId: string }, RepoRunsFailed>
  }
>()("@smthrs/mvp/runs/RemoteRunsClient") {
  /** The real client: ChatApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input }) =>
    Layer.effect(
      RemoteRunsClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        RemoteRunsClient.of({
          inspect: (runId, read = {}) =>
            getRun(options.origin, runId, read, options.within).pipe(Effect.provideService(HttpClient.HttpClient, client)),
          steer: (runId, steer, credential) =>
            postSteer(options.origin, runId, steer, options.within, credential).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            ),
          stop: (runId) =>
            postStop(options.origin, runId, options.within).pipe(Effect.provideService(HttpClient.HttpClient, client)),
          list: getCloudRuns(options.origin, options.within).pipe(Effect.provideService(HttpClient.HttpClient, client)),
          flows: (repo) =>
            exchange(
              HttpClientRequest.get(`${options.origin}${repoFlowsRoute(repo.owner, repo.name)}`),
              RepoFlows,
              [200],
              options.within,
            ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.withSpan("repo.flows.get")),
          inputs: (repo, flow, ref) =>
            exchange(
              HttpClientRequest.get(
                `${options.origin}${flowInputsRoute(repo.owner, repo.name, flow)}?${new URLSearchParams({ ref })}`,
              ),
              FlowInputs,
              [200],
              options.within,
            ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.withSpan("repo.flow.inputs.get")),
          start: (repo, start) =>
            exchange(
              HttpClientRequest.post(`${options.origin}${repoRunsRoute(repo.owner, repo.name)}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(start),
              ),
              Started,
              [200, 202],
              options.within,
            ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.withSpan("repo.run.post")),
        })),
    )
}
