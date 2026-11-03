import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { stackRoute, TODO_STATUS_NOT_FOUND, todoStatusRoute } from "./contract"
import { TodoStatusUnavailable, type TodoStatusResult } from "./flows"
import { Refusal, Taken, TodoStatusRead } from "./schema"

// ChatApi's stack route as the browser calls it (decision 0016 §1, docs/features/todos.md#routes), through Effect's
// HttpClient, with one deadline covering the whole exchange, its body included.

/**
 * ChatApi didn't take the change: no whole answer within the deadline, or no network (`status` absent), or any status
 * but 200 and 202 (`status`, and the refusal's `code` when its body names one), or a 200 or 202 whose body isn't the
 * contract's.
 */
export class ChangeNotTaken extends Data.TaggedError("ChangeNotTaken")<{
  readonly status?: number
  readonly code?: string
}> {}

/** A change as the route takes it. It names no door: who acts is the session's to say. */
export type ChangeRequest =
  | {
    readonly opId: string
    readonly op: "commit"
    readonly title: string
    readonly prompt: string
    readonly acceptance: ReadonlyArray<string>
    /** The issue it was made from. */
    readonly issue?: number
  }
  | { readonly opId: string; readonly op: "drop" | "retry"; readonly number: number }
  /** Decision 0153: a TODO with no issue, or a deleted one, under issue `issue`. */
  | { readonly opId: string; readonly op: "attach"; readonly number: number; readonly issue: number }

const decodeTaken = Schema.decodeUnknownEffect(Taken)
const decodeRefusal = Schema.decodeUnknownOption(Refusal)
const decodeStatus = Schema.decodeUnknownEffect(TodoStatusRead)

/** An authorized, current server read. A generic 404 is unavailable, never proof that a TODO is absent. */
export const readTodoStatus = (origin: string, owner: string, name: string, number: number, within: Duration.Input) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get(`${origin}${todoStatusRoute(owner, name, number)}`)).pipe(
      Effect.mapError(() => new TodoStatusUnavailable({ reason: "unavailable" })),
    )
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status !== 200) {
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined))
      const code = Option.getOrUndefined(decodeRefusal(body))?.code
      if (response.status === 404 && code === TODO_STATUS_NOT_FOUND) {
        return { kind: "not_found", number } as const satisfies TodoStatusResult
      }
      return yield* new TodoStatusUnavailable({ reason:
        response.status === 401 && code === "authentication" ? "authentication" :
        response.status === 403 && code === "forbidden" ? "forbidden" : "unavailable",
      })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeStatus),
      Effect.mapError(() => new TodoStatusUnavailable({ reason: "unavailable" })),
    )
  }).pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new TodoStatusUnavailable({ reason: "unavailable" })) }))

/** `POST /api/repos/<owner>/<name>/stack`: `202` took a new change, `200` had it already. */
export const postChange = (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  change: ChangeRequest,
  within: Duration.Input,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${origin}${stackRoute(repository.owner, repository.name)}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(change),
        ),
      )
      .pipe(Effect.mapError(() => new ChangeNotTaken({})))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status !== 200 && response.status !== 202) {
      const refused = yield* response.json.pipe(Effect.option, Effect.map(Option.flatMap(decodeRefusal)))
      return yield* new ChangeNotTaken({
        status: response.status,
        ...(Option.isSome(refused) ? { code: refused.value.code } : {}),
      })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeTaken),
      Effect.mapError(() => new ChangeNotTaken({ status: response.status })),
    )
  }).pipe(
    // Interrupting the request aborts its fetch, so a stalled body stops too.
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new ChangeNotTaken({})) }),
  )

/**
 * ChatApi's stack route, as a service: the one way the browser changes a stack. Tests of a route that fails provide a
 * faulty one; every other test uses the real one.
 */
export class StackClient extends Context.Service<
  StackClient,
  { readonly change: (owner: string, name: string, change: ChangeRequest) => Effect.Effect<Taken, ChangeNotTaken> }
>()("@smthrs/mvp/todos/StackClient") {
  /** The real client: ChatApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input }) =>
    Layer.effect(
      StackClient,
      Effect.map(HttpClient.HttpClient, (client) =>
        StackClient.of({
          change: (owner, name, change) =>
            postChange(options.origin, { owner, name }, change, options.within).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            ),
        })),
    )
}
