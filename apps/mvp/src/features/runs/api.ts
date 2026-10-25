import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { renewed, withBearer, withoutCookie } from "../../flows/bearer"
import { CLOUD_RUNS_LIMIT, CLOUD_RUNS_ROUTE, remoteRunRoute, steersRoute, stopRoute } from "./contract"
import { type CloudRun, CloudRunList, type Inspection } from "./schema"

// ChatApi's remote runs route as the browser calls it (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare): a run
// Smithers runs on Cloudflare, as the engine's `RunInspection` reads it there, through Effect's HttpClient with one
// deadline over the whole exchange, decoded with the engine's own wire shape (`BrowserEngine.Inspection`). A
// repository's run is stopped there too (docs/features/actions.md#acts).

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
 * 200 and 202 (`status`, and the refusal's `code` when its body names one).
 */
export class SteerFailed extends Data.TaggedError("SteerFailed")<{
  readonly status?: number
  readonly code?: string
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
    const response = yield* (authority === undefined
      ? client.execute(request)
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
        })),
    )
}
