import { Context, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

// A run's artifacts (decision 0145 "Artifacts", docs/features/ci.md#artifacts): a job box writes and reads them at
// `http://artifacts.smithers.internal/<name>`, which its own object answers (worker/BranchSandboxes.ts), as it answers
// the forge proxy. `PUT` stores the body, `GET` streams it back, under `ci/<scope>/<name>`, where the scope is the one
// the object's own `SandboxBranch.artifacts` names: a digest of the run (worker/flows/CiJobMachine.ts `machineOf`), so
// every job of a run shares it and no box can name another run's. No credential enters the box. Each request logs
// `sandbox.artifact` with its method, outcome and size, never a name or content, and counts
// `smithers_sandbox_artifacts{method,outcome}`.

/** The host a job box reaches its run's artifacts at. */
export const ARTIFACTS_HOST = "artifacts.smithers.internal"

/** The largest artifact: 512 MiB. */
export const MAX_BYTES = 512 * 1024 * 1024

/** An artifact's name: a letter or digit, then up to 127 letters, digits, `.`, `_` or `-`. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Where artifact `name` of scope `scope` is kept. */
export const keyOf = (scope: string, name: string) => `ci/${scope}/${name}`

/** The store couldn't write or read: the request answers 502. */
export class StoreFailed extends Schema.TaggedError<StoreFailed>()("@smthrs/mvp/branch/ArtifactStoreFailed", {}) {}

/** One stored artifact: its bytes as a stream, and how many. */
export interface Stored {
  readonly body: ReadableStream<Uint8Array>
  readonly bytes: number
}

/** Where artifacts are kept, by key: on Cloudflare the `CiArtifacts` R2 bucket (`r2`). */
export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    /** Stores exactly `bytes` bytes of `body` at `key`, replacing what was there. */
    readonly put: (key: string, body: ReadableStream<Uint8Array> | null, bytes: number) => Effect.Effect<void, StoreFailed>
    /** The artifact at `key`, none when absent. */
    readonly get: (key: string) => Effect.Effect<Option.Option<Stored>, StoreFailed>
  }
>()("@smthrs/mvp/branch/ArtifactStore") {}

/** What `r2` reads of an R2 bucket binding: workerd's `R2Bucket`, or Miniflare's. */
export interface Bucket {
  readonly put: (key: string, value: ReadableStream<Uint8Array> | null) => Promise<unknown>
  readonly get: (key: string) => Promise<{ readonly body: ReadableStream<Uint8Array>; readonly size: number } | null>
}

/**
 * The store over an R2 bucket. `exactly(bytes)` is the stream a body is piped through on its way in, which fails a
 * body longer or shorter than it said: workerd's `FixedLengthStream`, which also gives R2 the length it requires.
 */
export const r2 = (bucket: Bucket, exactly: (bytes: number) => TransformStream<Uint8Array, Uint8Array>) =>
  ArtifactStore.of({
    put: (key, body, bytes) =>
      Effect.tryPromise({
        try: () => bucket.put(key, body === null ? null : body.pipeThrough(exactly(bytes))),
        catch: () => new StoreFailed(),
      }).pipe(Effect.asVoid),
    get: (key) =>
      Effect.tryPromise({ try: () => bucket.get(key), catch: () => new StoreFailed() }).pipe(
        Effect.map((object) => object === null ? Option.none() : Option.some({ body: object.body, bytes: object.size })),
      ),
  })

/** `r2` as a layer. */
export const layerR2 = (bucket: Bucket, exactly: (bytes: number) => TransformStream<Uint8Array, Uint8Array>) =>
  Layer.succeed(ArtifactStore, r2(bucket, exactly))

/** Artifact requests, by `method` (`GET`, `PUT`, `other`) and `outcome`. */
export const requests = Metric.counter("smithers_sandbox_artifacts", {
  description: "Job boxes' requests to their run's artifacts, by method and outcome",
  incremental: true,
})

/** How a request ended, with its status. */
const OUTCOMES = {
  stored: 201,
  read: 200,
  absent: 404,
  bad_name: 400,
  no_scope: 403,
  method: 405,
  length_required: 411,
  too_large: 413,
  store_failed: 502,
} as const
type Outcome = keyof typeof OUTCOMES

/** The declared length of a request's body, none when absent or not a whole number. */
const lengthOf = (header: string | undefined): number | undefined =>
  header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined

/**
 * A box's request to its run's artifacts, `scope` the one its object names (none for a box with no run): stores or
 * reads `/<name>`. 403 without a scope, 400 for a bad name, 405 for another method; a `PUT` needs Content-Length (411)
 * of at most `MAX_BYTES` (413); a `GET` of nothing is 404; a store that fails is 502.
 */
export const answer = (
  request: HttpServerRequest.HttpServerRequest,
  scope: string | undefined,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, ArtifactStore> =>
  Effect.gen(function* () {
    const method = request.method === "GET" || request.method === "PUT" ? request.method : "other"
    let bytes = 0
    const done = (outcome: Outcome, response?: HttpServerResponse.HttpServerResponse) =>
      Effect.as(
        Effect.andThen(
          Metric.update(Metric.withAttributes(requests, { method, outcome }), 1),
          Effect.logInfo("sandbox.artifact").pipe(Effect.annotateLogs({ method, outcome, bytes })),
        ),
        response ?? HttpServerResponse.empty({ status: OUTCOMES[outcome] }),
      )
    if (method === "other") return yield* done("method")
    if (scope === undefined) return yield* done("no_scope")
    const name = new URL(request.url, `http://${ARTIFACTS_HOST}`).pathname.slice(1)
    if (!NAME.test(name)) return yield* done("bad_name")
    const store = yield* ArtifactStore
    const key = keyOf(scope, name)
    if (method === "PUT") {
      const length = lengthOf(request.headers["content-length"])
      if (length === undefined) return yield* done("length_required")
      bytes = length
      if (length > MAX_BYTES) return yield* done("too_large")
      const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie)
      return yield* store.put(key, web.body, length).pipe(
        Effect.andThen(done("stored")),
        Effect.catchTag("@smthrs/mvp/branch/ArtifactStoreFailed", () => done("store_failed")),
      )
    }
    return yield* store.get(key).pipe(
      Effect.flatMap(Option.match({
        onNone: () => done("absent"),
        onSome: (stored) => {
          bytes = stored.bytes
          return done("read", HttpServerResponse.raw(stored.body, {
            contentType: "application/octet-stream",
            contentLength: stored.bytes,
          }))
        },
      })),
      Effect.catchTag("@smthrs/mvp/branch/ArtifactStoreFailed", () => done("store_failed")),
    )
  }).pipe(Effect.withSpan("sandbox.artifact"))
