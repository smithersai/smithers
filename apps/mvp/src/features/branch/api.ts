import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { writesRoute } from "../issues/contract"
import { BRANCHES_ROUTE, type Refusal } from "./contract"
import { Refused, Tracked } from "./schema"

// ChatApi's `POST /api/branches` as `branch/track`'s step calls it (docs/features/branch-workspace.md#tracking-a-branch),
// and its writes route as Publish's and Update branch's steps call it (docs/features/branch-publish.md), through Effect's
// HttpClient, with one deadline covering each whole exchange.

/** ChatApi didn't track the branch: a refusal (`status`, with its `code`), or no whole answer in time (neither). */
export class TrackRefused extends Data.TaggedError("TrackRefused")<{
  readonly status?: number
  readonly code?: Refusal
}> {}

/** How long a step gives ChatApi to track a branch: a new one is read from GitHub first. */
export const TRACK_WITHIN = "20 seconds"

const decodeRefused = Schema.decodeUnknownOption(Schema.fromJsonString(Refused))
const decodeTracked = Schema.decodeUnknownEffect(Tracked)

/** Tracks branches through ChatApi on `origin`. */
export class BranchClient extends Context.Service<
  BranchClient,
  {
    /**
     * Tracks `ref`; with `create`, makes it on the forge at the default branch's head first (`branch/create`). A new
     * branch that names no repository is the deployment's own (`conversation/new` from the home conversation).
     */
    readonly track: (branch: {
      readonly owner?: string
      readonly name?: string
      readonly ref: string
      readonly create?: true
      readonly provider?: "github"
      /** With `create`, the request asking for a fresh branch (`conversation/new`). */
      readonly request?: string
      /** When the person opened the branch, in milliseconds since the epoch. */
      readonly openedAt?: number
    }) => Effect.Effect<Tracked, TrackRefused>
  }
>()("@smthrs/mvp/branch/BranchClient") {
  /** The client over the host's `HttpClient`: `200` or `201` with the branch; anything else is refused. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      BranchClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        return BranchClient.of({
          track: Effect.fn("branch.track.post")(function* (branch) {
            const response = yield* client.execute(
              HttpClientRequest.post(`${options.origin}${BRANCHES_ROUTE}`).pipe(HttpClientRequest.bodyJsonUnsafe(branch)),
            ).pipe(Effect.mapError(() => new TrackRefused({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
            if (response.status !== 200 && response.status !== 201) {
              const body = decodeRefused(yield* Effect.orElseSucceed(response.text, () => ""))
              return yield* new TrackRefused({
                status: response.status,
                ...Option.match(body, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
              })
            }
            return yield* response.json.pipe(
              Effect.flatMap(decodeTracked),
              Effect.mapError(() => new TrackRefused({ status: response.status })),
            )
          }, (effect) =>
            // Interrupting the request aborts its fetch, so a stalled body stops too.
            Effect.timeoutOrElse(effect, {
              duration: options.within ?? TRACK_WITHIN,
              orElse: () => Effect.fail(new TrackRefused({})),
            })),
        })
      }),
    )
}

/** A Publish or an Update branch as the writes route takes it (docs/features/branch-publish.md#routes). */
export type BranchWrite =
  | { readonly writeId: string; readonly op: "branch/publish"; readonly branchId: string; readonly title: string; readonly body: string }
  | { readonly writeId: string; readonly op: "branch/update"; readonly branchId: string; readonly method: "merge" | "rebase" }
  | { readonly writeId: string; readonly op: "branch/resync"; readonly branchId: string }

/** Sends Publish, Update branch and Resync writes to ChatApi's writes route on `origin`, in the person's session. */
export class BranchWrites extends Context.Service<
  BranchWrites,
  {
    /** `POST .../writes`: `202` took the write, `200` had it already; anything else is refused with its status and code. */
    readonly send: (owner: string, name: string, write: BranchWrite) => Effect.Effect<void, TrackRefused>
  }
>()("@smthrs/mvp/branch/BranchWrites") {
  /** The client over the host's `HttpClient`. */
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      BranchWrites,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        return BranchWrites.of({
          send: Effect.fn("branch.write.post")(function* (owner, name, write) {
            const response = yield* client.execute(
              HttpClientRequest.post(`${options.origin}${writesRoute(owner, name)}`).pipe(HttpClientRequest.bodyJsonUnsafe(write)),
            ).pipe(Effect.mapError(() => new TrackRefused({})))
            yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, op: write.op })
            if (response.status === 200 || response.status === 202) return
            // A body that can't be read, or isn't a refusal, names no code.
            const code = Option.getOrUndefined(Option.flatMap(yield* Effect.option(response.text), decodeWriteRefusal))?.code
            return yield* new TrackRefused({
              status: response.status,
              ...(code === "not_configured" ? { code } : {}),
            })
          }, (effect) =>
            Effect.timeoutOrElse(effect, {
              duration: options.within ?? TRACK_WITHIN,
              orElse: () => Effect.fail(new TrackRefused({})),
            })),
        })
      }),
    )
}

const decodeWriteRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ code: Schema.String })))
