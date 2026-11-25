// Electric's `messages` shape through ChatApi's proxy, over plain HTTP from Node (docs/features/chat.md#contract): the
// bench's view of the server, beside the browsers' view of the app. The pages ask and the attached fixture answers.
//
// Times are epoch milliseconds with sub-millisecond precision (`performance.timeOrigin + performance.now()`), the
// same clock the pages report on, since everything runs on one machine.

import type { BrowserContext } from "@playwright/test"
import { Effect, Context, Metric } from "effect"
import { attachAgent } from "../e2e/attach.ts"
import { SESSION_ROUTE } from "../src/features/auth/contract.ts"
import { HOME_BRANCH } from "../src/features/branch/contract.ts"
import { DEFAULT_REPOSITORY } from "../worker/defaultRepository.ts"

export type BenchmarkAgent = Awaited<ReturnType<typeof attachAgent>>

/** Pair a test agent to the same home conversation the browser opens at /app. */
export const attachBenchmarkAgent = async (context: BrowserContext, baseUrl: string): Promise<BenchmarkAgent> => {
  const session = await context.request.get(SESSION_ROUTE)
  try {
    if (!session.ok()) throw new Error(`GET ${SESSION_ROUTE} answered ${session.status()}`)
    const person = await session.json() as { signedIn: boolean; personId?: string; homeConversationId?: string }
    if (!person.signedIn || person.personId === undefined || person.homeConversationId === undefined) {
      throw new Error("The benchmark needs a signed-in browser with a home conversation")
    }
    return await attachAgent(context.request, baseUrl, person.personId, {
      repo: process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY,
      branch: HOME_BRANCH,
      conversation: person.homeConversationId,
    })
  } finally {
    await session.dispose()
  }
}


export class FollowerHttp extends Context.Service<FollowerHttp, {
  readonly request: (url: string, signal: AbortSignal) => Effect.Effect<Response, Error>
}>()("bench/FollowerHttp") {}

const followerRequests = Metric.counter("bench_follower_requests")

const liveHttp = { request: (url: string, signal: AbortSignal) => Effect.tryPromise({
  try: () => fetch(url, { signal }), catch: (cause) => new Error(String(cause)),
}) }

/** Now, comparable with a page's `performance.timeOrigin + performance.now()`. */
export const now = () => performance.timeOrigin + performance.now()

/** A `messages` row as Electric sends it: snake_case columns, every value a JSON value. */
export type Row = {
  id: string
  role?: string
  text?: string
  status?: string
  question_id?: string | null
  failure?: string | null
  [column: string]: unknown
}

/** One message of Electric's shape log: a change to a row, or a control message such as `up-to-date`. */
export type ShapeMessage = {
  key?: string
  value?: Partial<Row>
  headers: { operation?: "insert" | "update" | "delete"; control?: string }
}

/**
 * Applies a shape response to `rows`, keyed by `id`: an insert sets a row, an update merges the columns it carries
 * (Electric sends the primary key and the changed columns), a delete removes it. Returns the ids it changed, and
 * whether the response ended up to date.
 */
export const apply = (rows: Map<string, Row>, messages: ReadonlyArray<ShapeMessage>) => {
  const changed = new Set<string>()
  let upToDate = false
  for (const message of messages) {
    if (message.headers.control === "up-to-date") upToDate = true
    const id = message.value?.id
    if (message.key === undefined || id === undefined) continue
    const operation = message.headers.operation
    if (operation === "delete") rows.delete(id)
    else if (operation === "insert") rows.set(id, { ...message.value, id })
    else if (operation === "update") rows.set(id, { ...rows.get(id), ...message.value, id })
    else continue
    changed.add(id)
  }
  return { changed, upToDate }
}

const shapeUrl = (baseUrl: string, params: Record<string, string | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value)
  return `${baseUrl}/api/shapes/messages?${search}`
}

export type InitialSync = {
  /** From the first request to the response that ended up to date. */
  ms: number
  rows: Map<string, Row>
  /** Row changes replayed: Electric's log holds every insert and update since the shape began, not just one per row. */
  operations: number
  requests: number
  /** JSON bytes received, after any content decoding. */
  bytes: number
}

/**
 * What a new device does first: requests the shape from `offset=-1`, with no handle, and follows Electric's
 * `electric-offset` and `electric-handle` until a response ends with `up-to-date`. Not live: it ends there.
 */
export const initialSync = async (baseUrl: string, timeoutMs = 30_000): Promise<InitialSync> => {
  const rows = new Map<string, Row>()
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  let offset = "-1"
  let handle: string | undefined
  let requests = 0
  let operations = 0
  let bytes = 0
  for (;;) {
    if (now() > deadline) throw new Error(`the shape wasn't up to date after ${timeoutMs} ms and ${requests} requests`)
    const response = await fetch(shapeUrl(baseUrl, { offset, handle }), { signal: AbortSignal.timeout(timeoutMs) })
    requests++
    if (!response.ok) throw new Error(`GET /api/shapes/messages answered ${response.status} at offset ${offset}`)
    const body = await response.text()
    bytes += Buffer.byteLength(body)
    const messages = JSON.parse(body) as Array<ShapeMessage>
    operations += messages.filter((message) => message.key !== undefined).length
    handle = response.headers.get("electric-handle") ?? handle
    offset = response.headers.get("electric-offset") ?? offset
    if (apply(rows, messages).upToDate) return { ms: now() - startedAt, rows, operations, requests, bytes }
  }
}

/** When this follower first saw a row, its first text, and its settling (`status` no longer `streaming`). 0: not yet. */
export type Timeline = { seenAt: number; firstTextAt: number; settledAt: number }

/**
 * A device that only listens: follows the shape live from `offset=now`, so it holds only rows written after it
 * started, and records when each row, and each change to it, reached it.
 */
export class Follower {
  readonly rows = new Map<string, Row>()
  readonly timelines = new Map<string, Timeline>()
  /** Electric answered 409 (`must-refetch`); the follower started again from `offset=now`. */
  refetches = 0
  /** Terminal observation failures; an incomplete observation cannot produce a valid benchmark. */
  errors = 0
  readonly #baseUrl: string
  readonly #abort = new AbortController()
  readonly #waiters = new Set<() => void>()
  #loop: Promise<void> | undefined
  #failure: Error | undefined

  readonly options: { timeoutMs?: number; http?: FollowerHttp["Service"] }
  constructor(baseUrl: string, options: { timeoutMs?: number; http?: FollowerHttp["Service"] } = {}) {
    this.#baseUrl = baseUrl
    this.options = options
  }

  async #request(params: Record<string, string | undefined>) {
    const baseUrl = this.#baseUrl
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? (params.live === "true" ? 90_000 : 30_000))])
    return Effect.runPromise(Effect.gen(function* () {
      const http = yield* Effect.service(FollowerHttp)
      const response = yield* http.request(shapeUrl(baseUrl, params), signal)
      const messages = yield* Effect.tryPromise(async () => response.status === 204 ? [] : response.ok ? ((await response.json()) as Array<ShapeMessage>) : (await response.body?.cancel(), []))
      return {
        status: response.status,
        at: now(),
        messages,
        handle: response.headers.get("electric-handle") ?? undefined,
        offset: response.headers.get("electric-offset") ?? undefined,
        cursor: response.headers.get("electric-cursor") ?? undefined,
      }
    }).pipe(
      Effect.tap(() => Metric.update(followerRequests, 1)),
      Effect.tapError(() => Effect.logError("bench.follower.request_failed")),
      Effect.withSpan("bench.follower.request"),
      Effect.provideService(FollowerHttp, this.options.http ?? liveHttp),
    ), { signal })
  }

  /** Joins the shape at `offset=now`; fails when ChatApi's proxy or Electric doesn't answer. */
  async start() {
    const first = await this.#request({ offset: "now" })
    this.#validate(first)
    this.#receive(first.messages, first.at)
    this.#loop = this.#follow(first).catch((error: unknown) => {
      if (this.#abort.signal.aborted) return
      this.errors++
      this.#failure = error instanceof Error ? error : new Error(String(error))
      for (const waiter of this.#waiters) waiter()
    })
  }

  #validate(response: { status: number; handle?: string; offset?: string }) {
    if (response.status !== 200) throw new Error(`GET /api/shapes/messages?offset=now answered ${response.status}`)
    if (!response.handle || !response.offset) throw new Error("Electric returned no valid shape cursor")
  }

  async #follow(start: { handle?: string; offset?: string; cursor?: string }) {
    let { handle, offset, cursor } = start
    while (!this.#abort.signal.aborted) {
      let response = await this.#request({ offset, handle, live: "true", cursor })
      if (response.status === 409) {
        this.refetches++
        response = await this.#request({ offset: "now" })
        this.#validate(response)
        // A refetch replaces the cursor only after a successful, validated response.
        ;({ handle, offset, cursor } = response)
      } else {
        if (response.status !== 200 && response.status !== 204) throw new Error(`HTTP ${response.status}`)
        handle = response.handle ?? handle
        offset = response.offset ?? offset
        cursor = response.cursor ?? cursor
      }
      this.#receive(response.messages, response.at)
    }
  }

  #receive(messages: ReadonlyArray<ShapeMessage>, at: number) {
    for (const id of apply(this.rows, messages).changed) {
      const timeline = this.timelines.get(id) ?? { seenAt: at, firstTextAt: 0, settledAt: 0 }
      const row = this.rows.get(id)
      if (row?.text && timeline.firstTextAt === 0) timeline.firstTextAt = at
      if (row?.status !== undefined && row.status !== "streaming" && timeline.settledAt === 0) timeline.settledAt = at
      this.timelines.set(id, timeline)
    }
    for (const waiter of this.#waiters) waiter()
  }

  /** Resolves with `read()` once it is defined, checked after every response; rejects after `timeoutMs`. */
  until<T>(read: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    const value = read()
    if (value !== undefined) return Promise.resolve(value)
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.#failure !== undefined) {
          done()
          reject(this.#failure)
          return
        }
        const value = read()
        if (value === undefined) return
        done()
        resolve(value)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`no ${what} from Electric after ${timeoutMs} ms`))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        this.#waiters.delete(check)
      }
      this.#waiters.add(check)
    })
  }

  /** The newest question whose text contains `word`. */
  questionWith(word: string): Row | undefined {
    let found: Row | undefined
    for (const row of this.rows.values()) if (row.role === "user" && row.text?.includes(word)) found = row
    return found
  }

  answerTo(questionId: string): Row | undefined {
    for (const row of this.rows.values()) if (row.question_id === questionId) return row
    return undefined
  }

  async stop() {
    this.#abort.abort()
    await this.#loop
  }
}

/** A settled row (`done` or `failed`), or `undefined` while it is missing or still streaming. */
export const settled = (row: Row | undefined) =>
  row?.status !== undefined && row.status !== "streaming" ? row : undefined
