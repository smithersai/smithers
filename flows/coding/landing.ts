/** Opinionated Effect adapter over Plue's landing API; no queue or ledger here. */
import { Cause, Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { ChangeId, Resolved, SourcePublication } from "./native-schema.ts"
import { AppendObservation, AppendPreparation, AppendPreparationInput, AppendRequest, LandingIdentity, QueuedAppend } from "./landing-schema.ts"
import { CodingError } from "./schema.ts"

/** Trusted provisioned workspace binding, never workflow or model input. */
export interface Options {
  readonly apiBaseUrl: string
  readonly repositorySlug: string
  readonly repositoryId: number
  readonly workspaceId: string
  readonly token: Redacted.Redacted<string>
}
export class Landing extends Context.Service<Landing, {
  readonly binding: Pick<Options, "repositoryId" | "workspaceId">
  readonly readMain: Effect.Effect<string, CodingError>
  readonly prepare: (input: AppendPreparationInput) => Effect.Effect<AppendPreparation, CodingError>
  readonly create: (requestId: string, preparation: AppendPreparation, description: string) => Effect.Effect<LandingIdentity, CodingError>
  readonly queue: (identity: LandingIdentity, preparation: AppendPreparation, request: AppendRequest) => Effect.Effect<QueuedAppend, CodingError>
  readonly observe: (queued: QueuedAppend) => Effect.Effect<AppendObservation, CodingError>
}>()("coding/Landing") {}

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const boundedId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const BookmarkPage = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String,
  target_change_id: Schema.String, target_commit_id: Schema.String, is_tracking_remote: Schema.Boolean })).check(Schema.isMaxLength(100)),
  next_cursor: Schema.String.check(Schema.isMaxLength(4096)) })
const LandingResponse = Schema.Struct({ request_id: SourcePublication.fields.requestId, number: boundedId,
  target_bookmark: Schema.Literal("main"), change_ids: Schema.Array(ChangeId).check(Schema.isMaxLength(1024)),
  agent_authored: Schema.Literal(true) })
const QueueResponse = Schema.Struct({ ...LandingResponse.fields, task_id: boundedId })
const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index])
const maximumBodyBytes = 2 * 1024 * 1024

const readJson = (response: HttpClientResponse.HttpClientResponse) => Effect.gen(function*() {
  const declared = response.headers["content-length"]
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBodyBytes)) {
    return yield* invalid("Landing API response exceeds its bounded size")
  }
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const captured = yield* Stream.runFoldEffect(response.stream, () => ({ bytes: 0, text: "" }), (state, chunk) => Effect.try({
    try: () => {
      if (state.bytes + chunk.length > maximumBodyBytes) throw new Error("bound")
      return { bytes: state.bytes + chunk.length, text: state.text + decoder.decode(chunk, { stream: true }) }
    }, catch: () => invalid("Landing API response is invalid or exceeds its bounded size")
  })).pipe(Effect.mapError(error => error instanceof CodingError ? error : unavailable("Landing API response could not be read")))
  return yield* Effect.try({ try: () => JSON.parse(captured.text + decoder.decode()) as unknown,
    catch: () => invalid("Landing API returned no valid JSON receipt") })
})

/** Construct over the host's selected Node/Bun HttpClient. Never follows redirects. */
export const make = (options: Options) => Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const url = yield* Effect.try({ try: () => new URL(options.apiBaseUrl), catch: () => unavailable("Landing API binding is invalid") })
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/api") || options.apiBaseUrl !== url.href.replace(/\/$/, "") ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.repositorySlug) || options.repositorySlug.split("/").some(part => part === "." || part === "..") ||
    !Schema.is(SourcePublication.fields.workspaceId)(options.workspaceId) || !Schema.is(boundedId)(options.repositoryId) ||
    !Redacted.value(options.token).trim() || /[\r\n]/.test(Redacted.value(options.token))) {
    return yield* unavailable("Landing requires the exact provisioned repository, API and credential binding")
  }
  const base = `${options.apiBaseUrl}/repos/${options.repositorySlug.split("/").map(encodeURIComponent).join("/")}`
  const send = <A>(request: HttpClientRequest.HttpClientRequest, expectedStatus: ReadonlyArray<number>, schema: Schema.Codec<A>) =>
    Effect.gen(function*() {
      const response = yield* HttpClient.withScope(client).execute(request.pipe(HttpClientRequest.bearerToken(options.token), HttpClientRequest.acceptJson))
        .pipe(Effect.mapError(() => unavailable("Landing API request could not be acknowledged; retry the same durable request")))
      if (!expectedStatus.includes(response.status)) {
        // Do not expose remote response bodies, request headers or credential-bearing errors.
        if (response.status === 409) return yield* new CodingError({ code: "stale_revision", message: "Landing policy or the pinned source/main changed; inspect this exact landing before replanning" })
        return yield* unavailable(`Landing API did not acknowledge the required operation (HTTP ${response.status})`)
      }
      return yield* readJson(response).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(error => error instanceof CodingError ? error : invalid("Landing API receipt does not match the required protocol")))
    }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.scoped, Effect.timeoutOrElse({ duration: "90 seconds",
        orElse: () => Effect.fail(unavailable("Landing API exceeded its request deadline; retry the same durable request")) }),
      Effect.catchCause(cause => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const error = Cause.squash(cause)
        return Effect.fail(error instanceof CodingError ? error : unavailable("Landing API request failed before a receipt could be verified"))
      }))
  const json = (request: HttpClientRequest.HttpClientRequest, value: object) => HttpClientRequest.bodyJsonUnsafe(request, value)
  const validatePreparation = (value: AppendPreparation, input: AppendPreparationInput) => {
    if (value.target_bookmark !== input.target_bookmark || value.expected_commit_id !== input.expected_commit_id ||
      value.source_commit_id !== input.source_commit_id || value.source_base_commit_id !== input.source_base_commit_id ||
      value.changes.at(-1)?.commit_id !== input.source_commit_id || new Set(value.changes.map(change => change.change_id)).size !== value.changes.length ||
      new Set(value.changes.map(change => change.commit_id)).size !== value.changes.length) return Effect.fail(invalid("Native append preparation does not identify the exact ordered source"))
    return Effect.succeed(value)
  }
  const checkIdentity = (value: typeof LandingResponse.Type, requestId: string, preparation: AppendPreparation) =>
    value.request_id === requestId && same(value.change_ids, preparation.changes.map(change => change.change_id))
      ? Effect.succeed({ requestId: value.request_id, number: value.number })
      : Effect.fail(invalid("Landing receipt does not identify this exact request and native stack"))
  const readMain = Effect.gen(function*() {
    const cursors = new Set<string>(), candidates: string[] = []
    let cursor = ""
    // Existing bookmark pagination, bounded to 10,000 entries. Incomplete pages refuse.
    for (let page = 0; page < 100; page++) {
      const response = yield* send(HttpClientRequest.get(`${base}/bookmarks`).pipe(
        HttpClientRequest.setUrlParams({ limit: "100", ...(cursor === "" ? {} : { cursor }) })), [200], BookmarkPage)
      for (const bookmark of response.items) if (bookmark.name === "main" && !bookmark.is_tracking_remote) candidates.push(bookmark.target_commit_id)
      if (response.next_cursor === "") {
        if (candidates.length !== 1 || !Schema.is(Resolved.fields.commitId)(candidates[0])) return yield* invalid("Repository must have one unambiguous immutable local main bookmark")
        return candidates[0]!
      }
      if (cursors.has(response.next_cursor) || response.items.length === 0) return yield* invalid("Bookmark traversal is incomplete or cyclic")
      cursors.add(response.next_cursor); cursor = response.next_cursor
    }
    return yield* invalid("Bookmark traversal exceeded its bounded page count")
  })
  return Landing.of({ binding: { repositoryId: options.repositoryId, workspaceId: options.workspaceId }, readMain,
    prepare: input => Schema.decodeUnknownEffect(AppendPreparationInput)(input).pipe(
      Effect.mapError(() => invalid("Append preparation requires exact immutable commits")),
      Effect.flatMap(request => send(json(HttpClientRequest.post(`${base}/landings/append/prepare`), request), [200], AppendPreparation)),
      Effect.flatMap(result => validatePreparation(result, input))),
    create: (requestId, preparation, description) => Effect.gen(function*() {
      if (!Schema.is(SourcePublication.fields.requestId)(requestId) || !description.trim() || new TextEncoder().encode(description).length > 32_768) {
        return yield* invalid("Landing creation requires a stable request identity and a bounded final description")
      }
      const title = description.split(/\r?\n/, 1)[0]!
      if (title.length > 255) return yield* invalid("The final landing subject exceeds 255 characters")
      const response = yield* send(json(HttpClientRequest.put(`${base}/landings/requests/${requestId}`), {
        title, body: description, target_bookmark: preparation.target_bookmark,
        change_ids: preparation.changes.map(change => change.change_id)
      }), [200, 201], LandingResponse)
      return yield* checkIdentity(response, requestId, preparation)
    }),
    queue: (identity, preparation, request) => Effect.gen(function*() {
      if (request.commit_id !== preparation.source_commit_id || request.source_base_commit_id !== preparation.source_base_commit_id ||
        request.expected_commit_id !== preparation.expected_commit_id || new TextEncoder().encode(request.description).length > 32_768) {
        return yield* invalid("Append request does not match its recorded preparation")
      }
      const response = yield* send(json(HttpClientRequest.put(`${base}/landings/${identity.number}/land/append`), request), [202], QueueResponse)
      yield* checkIdentity(response, identity.requestId, preparation)
      if (response.number !== identity.number) return yield* invalid("Append queue returned another landing")
      return { ...identity, taskId: response.task_id, preparation, request }
    }),
    observe: queued => Effect.gen(function*() {
      const observation = yield* send(HttpClientRequest.get(`${base}/landings/${queued.number}/land/append`), [200], AppendObservation)
      const request = observation.request
      if (observation.task_id !== queued.taskId || !same(request.change_ids, queued.preparation.changes.map(change => change.change_id)) ||
        request.expected_commit_id !== queued.request.expected_commit_id || request.append.source_commit_id !== queued.request.commit_id ||
        request.append.source_base_commit_id !== queued.request.source_base_commit_id || request.append.description !== queued.request.description ||
        observation.status === "landed" && observation.result.landed_count !== queued.preparation.changes.length) {
        return yield* invalid("Native append observation does not match this exact queued request")
      }
      return observation
    })
  })
})
export const layer = (options: Options) => Layer.effect(Landing)(make(options))
