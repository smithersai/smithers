import { Effect, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import type { Actor } from "../../worker/Actor.ts"
import type { BranchAccess } from "../../worker/branch/Access.ts"
import * as Messages from "../../worker/chat/MessagesShard.ts"
import { makeShardHandler } from "../../worker/chat/MessagesShardObject.ts"
import * as Routes from "../../worker/chat/MessagesShardRoutes.ts"
import { signedIn, signedOut } from "../../worker/test/harness.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA, SESSION_CHECK_HEADER } from "../features/auth/contract"

// ChatApi's messages shard as a browser reaches it, in one process: the Worker's real route
// (worker/chat/MessagesShardRoutes.ts `dispatch`) in front of each conversation's real object handler over real SQLite,
// behind a `fetch` the browser's HttpClient calls. Faults are injected at that `fetch`, the network's place
// (docs/rules.md, test.faults-by-injection): the server and the client under test stay the real ones.

/**
 * What the network does to a matching request:
 * - `offline`: it never leaves the device;
 * - `lost`: ChatApi handles it, and its answer never arrives;
 * - `stall`: no answer until the client gives up, when the request is aborted;
 * - `garbled`: ChatApi handles it, and the 200's body is cut short;
 * - a status: a gateway answers it, and ChatApi never sees it; `same_person` marks a `401` the page's transport
 *   checked against the session;
 * - a function: the answer a gateway rewrote, from ChatApi's own.
 */
export type NetworkFault =
  | "offline"
  | "lost"
  | "stall"
  | "garbled"
  | { readonly status: number; readonly sameSession?: boolean }
  | ((answer: Response) => Response | Promise<Response>)

export const ada: Actor = { subject: { kind: "person", id: "ada" }, role: "member" }
export const bob: Actor = { subject: { kind: "person", id: "bob" }, role: "member" }

/** What `actor` may do on the conversation's branch: edit, unless a test says otherwise. */
export const branchOf = (conversationId: string, over: Partial<BranchAccess> = {}): BranchAccess => ({
  branchId: "branch-1",
  conversationId,
  repoId: "example/project",
  name: "main",
  mode: "open",
  createdBy: "ada",
  access: "edit",
  role: "member",
  shared: false,
  ...over,
})

/**
 * A host of conversations' shards. Each conversation's object is made on its first request, over `:memory:` or, with
 * `path`, a SQLite file a `restart` reopens. Closed with the scope.
 */
export const shardHost = Effect.fnUntraced(function* (options: { readonly path?: (conversationId: string) => string } = {}) {
  const scope = yield* Effect.scope
  type Live = { db: ReturnType<typeof openStorage>; handler: Effect.Success<ReturnType<typeof makeShardHandler>> }
  const objects = new Map<string, Live>()
  const pathOf = (shard: string) => options.path?.(shard.slice("conv:".length)) ?? ":memory:"
  const wake = (shard: Parameters<typeof makeShardHandler>[1]) =>
    Effect.gen(function* () {
      const known = objects.get(shard)
      if (known !== undefined) return known
      const db = openStorage(pathOf(shard))
      const live: Live = { db, handler: yield* makeShardHandler(db.storage, shard) }
      objects.set(shard, live)
      return live
    }).pipe(Scope.provide(scope))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const { db } of objects.values()) db.hibernate()
    })
  )

  const requests: Array<string> = []
  const faults: Array<{ readonly fault: NetworkFault; readonly matches: (request: string) => boolean; times: number }> = []
  let access: (actor: Actor, conversationId: string) => BranchAccess | undefined = (_, conversationId) => branchOf(conversationId)

  const serve = (actor: Actor | null, request: Request) =>
    Effect.runPromise(
      Routes.dispatch(
        (shard, forwarded) =>
          Effect.flatMap(wake(shard), ({ handler }) =>
            handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, forwarded))),
        (who, conversationId) => Effect.sync(() => access(who, conversationId)),
      ).pipe(
        Effect.provide(actor === null ? signedOut : signedIn(actor)),
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
        Effect.map(HttpServerResponse.toWeb),
      ),
    )

  /** The `fetch` of a page signed in as `actor`, or signed out (`null`). */
  const fetchAs = (actor: Actor | null): typeof globalThis.fetch => async (input, init) => {
    const request = new Request(input, init)
    request.headers.set(DEVICE_PERSON_HEADER, NO_DEVICE_DATA)
    const url = new URL(request.url)
    const line = `${request.method} ${url.pathname}${url.search}`
    requests.push(line)
    const index = faults.findIndex((entry) => entry.matches(line))
    const fault = index === -1 ? undefined : faults[index]!.fault
    if (index !== -1 && --faults[index]!.times === 0) faults.splice(index, 1)
    if (fault === "offline") throw new TypeError("fetch failed")
    if (fault === "stall") {
      return new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason))
      )
    }
    if (typeof fault === "object") {
      return new Response(null, {
        status: fault.status,
        headers: fault.sameSession === true ? { [SESSION_CHECK_HEADER]: "same_person" } : {},
      })
    }
    const answer = await serve(actor, request)
    if (fault === "lost") throw new TypeError("fetch failed")
    if (fault === "garbled") return new Response('{"_tag":', { status: 200, headers: { "content-type": "application/json" } })
    return fault === undefined ? answer : fault(answer)
  }

  const live = (conversationId: string) =>
    Effect.flatMap(wake(Messages.shardOf(conversationId)), ({ db }) =>
      Messages.make(db.storage, Messages.shardOf(conversationId)).pipe(Effect.provide(Reactivity.layer)))

  return {
    fetchAs,
    /** Every request a page sent, in order, as `METHOD path?query`, whether or not it arrived. */
    requests,
    /** The next `times` requests whose line contains `match` meet `fault`. Default: every request, once. */
    fail: (fault: NetworkFault, match = "", times = 1) =>
      void faults.push({ fault, matches: (request) => request.includes(match), times }),
    /** Ends every fault still waiting: the network is back. */
    heal: () => void (faults.length = 0),
    /** Decides what each person may do from now on; `undefined` is a conversation that is not there. */
    grant: (decide: typeof access) => void (access = decide),
    /** The state a fresh wake of the conversation's object rebuilds from its SQLite. */
    state: (conversationId: string) => Effect.flatMap(live(conversationId), (hub) => hub.state),
    head: (conversationId: string) => Effect.flatMap(live(conversationId), (hub) => hub.journal.head),
    /** Folds the conversation's history through its head into the snapshot, then wakes its object over it. */
    compact: (conversationId: string) =>
      Effect.gen(function* () {
        const position = yield* (yield* live(conversationId)).compact
        const shard = Messages.shardOf(conversationId)
        const { db } = objects.get(shard)!
        objects.set(shard, { db, handler: yield* makeShardHandler(db.storage, shard) })
        return position
      }),
    /** Every object hibernates and wakes on its next request: a new handler over the same SQLite file. */
    restart: Effect.sync(() => {
      for (const { db } of objects.values()) db.hibernate()
      objects.clear()
    }),
  }
})

export type ShardHost = Effect.Success<ReturnType<typeof shardHost>>
