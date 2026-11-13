import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type RequestListener, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFailed } from "vitest"
import * as Kit from "../../../examples/use-cases/kit.ts"
import {
  delayMillis,
  layer,
  PostRefused,
  PostTweet,
  tweets,
  TweetThread,
  xLayer
} from "../../../examples/use-cases/tweet-thread.ts"

const directory = mkdtempSync(join(tmpdir(), "tweet-thread-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A recording HTTP service; no request can reach X from this suite. */
const server = (respond: (count: number) => Response) => {
  const requests: Array<{ readonly url: string; readonly authorization: string; readonly body: unknown }> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const bytes = (request.body as { readonly body: Uint8Array }).body
      requests.push({
        url: request.url,
        authorization: request.headers.authorization ?? "",
        body: JSON.parse(new TextDecoder().decode(bytes))
      })
      return HttpClientResponse.fromWeb(request, respond(requests.length))
    })
  )
  return { requests, transport: Layer.succeed(HttpClient.HttpClient)(client) }
}

const credentials = {
  X_API_KEY: "consumer-key",
  X_API_SECRET: "consumer-secret",
  X_ACCESS_TOKEN: "access-token",
  X_ACCESS_SECRET: "access-secret"
}

const configured = <A, E, R>(
  implementation: Layer.Layer<A, E, R | HttpClient.HttpClient>,
  transport: Layer.Layer<HttpClient.HttpClient>,
  values: Record<string, string> = credentials
) =>
  implementation.pipe(
    Layer.provide(transport),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))
  )

/** The flow makes no agent calls, so any model request is unexpected. */
const noAgents: Kit.Script = () => undefined

/** Observe the real durable waits, then advance the virtual clock once per deadline. */
const advanceTimers = (executionId: string, record: () => void) => {
  const started = Date.now()
  const progress = {
    executionId,
    polls: 0,
    advances: 0,
    wakeAt: null as number | null,
    clock: 0,
    adjusting: false,
    waiting: "none"
  }
  onTestFailed(() =>
    console.error("Tweet timer progress", JSON.stringify({ ...progress, elapsedMs: Date.now() - started }))
  )
  return Layer.effectDiscard(Effect.forkScoped(Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const runtime = yield* FlowRuntime.FlowRuntime
    const virtual = yield* Clock.Clock
    let lastWakeAt: number | null | undefined
    let advances = 0
    return yield* Effect.gen(function*() {
      while (true) {
        const row = yield* state.waiting(executionId)
        progress.polls++
        progress.waiting = Option.isSome(row) ? row.value.reason : "none"
        progress.wakeAt = Option.isSome(row) ? row.value.wakeAt ?? null : null
        progress.clock = virtual.currentTimeMillisUnsafe()
        if (Option.isSome(row) && row.value.reason === "timer" && row.value.wakeAt !== lastWakeAt) {
          lastWakeAt = row.value.wakeAt
          advances++
          record()
          progress.advances = advances
          const now = yield* Clock.currentTimeMillis
          progress.adjusting = true
          yield* TestClock.adjust((row.value.wakeAt ?? now) - now)
          progress.adjusting = false
        }
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
      }
    }).pipe(Effect.ensuring(Effect.gen(function*() {
      const result = yield* runtime.poll(TweetThread, executionId).pipe(Effect.orElseSucceed(() => Option.none()))
      if (Option.isSome(result)) return
      const waiting = yield* state.waiting(executionId)
      console.info("Unfinished tweet timer", {
        executionId,
        advances,
        lastWakeAt,
        now: yield* Clock.currentTimeMillis,
        waiting: Option.isSome(waiting) ? waiting.value.reason : "none"
      })
    })))
  })))
}

/**
 * A timer that records each wait instead of sleeping, and an X stand-in that
 * records each post with the tweet it replies to and answers id `t<n>`, or is
 * refused at tweet `refuseAt`. Both write to one ordered log.
 */
const fakes = (executionId: string, refuseAt?: number) => {
  const log: Array<string> = []
  const index = (text: string) => tweets.indexOf(text)
  const x = PostTweet.toLayer(({ replyToId, text }) =>
    Effect.suspend(() => {
      const n = index(text)
      log.push(`post ${n}${replyToId === undefined ? "" : ` replying to ${replyToId}`}`)
      return n === refuseAt
        ? Effect.fail(new PostRefused({ status: 429, body: "Too Many Requests" }))
        : Effect.succeed({ tweetId: `t${n}`, posted: true })
    })
  )
  const timer = advanceTimers(executionId, () => void log.push(`sleep ${delayMillis}`))
  return { log, actions: Layer.mergeAll(x, timer) }
}

it.effect("posts every tweet in order, each replying to the one before it after a pause", () =>
  Effect.gen(function*() {
    const { actions, log } = fakes("tweet-thread-posted")
    const posts = yield* Kit.run(TweetThread, {}, {
      filename: join(directory, "thread.sqlite"),
      executionId: "tweet-thread-posted",
      script: noAgents,
      actions
    })

    expect(tweets).toHaveLength(25)
    expect(log).toEqual([
      "post 0",
      ...tweets.slice(1).flatMap((_, i) => [`sleep ${delayMillis}`, `post ${i + 1} replying to t${i}`])
    ])
    expect(posts).toHaveLength(25)
    expect(posts.every((post) => post.posted)).toBe(true)
    expect(posts.at(-1)).toEqual({ tweetId: "t24", posted: true })
  }))

it.effect("stops the thread at a refused post and never retries it", () =>
  Effect.gen(function*() {
    const { actions, log } = fakes("tweet-thread-refused", 2)
    const exit = yield* Effect.exit(Kit.run(TweetThread, {}, {
      filename: join(directory, "refused.sqlite"),
      executionId: "tweet-thread-refused",
      script: noAgents,
      actions
    }))

    // An irreversible post is attempted once: a retry could post it twice.
    expect(log).toEqual(["post 0", "sleep 3000", "post 1 replying to t0", "sleep 3000", "post 2 replying to t1"])
    expect(Exit.isFailure(exit)).toBe(true)
  }))

it.effect("records every post as not posted, without calling X, when the credentials are missing", () =>
  Effect.gen(function*() {
    const http = server(() => new Response("Unexpected request", { status: 500 }))
    const log: Array<string> = []
    const timer = advanceTimers("tweet-thread-no-credentials", () => void log.push("sleep"))
    const posts = yield* Kit.run(TweetThread, {}, {
      filename: join(directory, "no-credentials.sqlite"),
      executionId: "tweet-thread-no-credentials",
      script: noAgents,
      actions: Layer.mergeAll(configured(xLayer, http.transport, {}), timer)
    })

    expect(http.requests).toEqual([])
    expect(log).toHaveLength(24)
    expect(posts).toHaveLength(25)
    expect(posts.every((post) =>
      !post.posted && post.tweetId === "" &&
      post.error === "Missing X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, or X_ACCESS_SECRET env vars."
    )).toBe(true)
  }))

it.effect("signs each X request and threads it on the id X returned for the post before", () =>
  Effect.gen(function*() {
    const http = server((count) => new Response(JSON.stringify({ data: { id: `x${count}` } }), { status: 201 }))
    const { requests } = http
    const timer = advanceTimers("tweet-thread-signed", () => {})
    const posts = yield* Kit.run(TweetThread, {}, {
      filename: join(directory, "signed.sqlite"),
      executionId: "tweet-thread-signed",
      script: noAgents,
      actions: Layer.mergeAll(configured(xLayer, http.transport), timer)
    })

    expect(requests).toHaveLength(25)
    expect(requests[0]).toMatchObject({ url: "https://api.x.com/2/tweets", body: { text: tweets[0] } })
    expect(requests[1]?.body).toEqual({ text: tweets[1], reply: { in_reply_to_tweet_id: "x1" } })
    expect(requests[0]?.authorization).toMatch(
      /^OAuth oauth_consumer_key="consumer-key", oauth_nonce="[0-9a-f]{32}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="access-token", oauth_version="1.0", oauth_signature="[^"]+"$/
    )
    expect(posts.map((post) => post.tweetId)).toEqual(requests.map((_, i) => `x${i + 1}`))
  }))

/**
 * Waits, in real time, until the run parks on a timer; records how far off its
 * wake-up is and how many posts went out before it; then moves the test clock
 * past it. It runs beside the run, on the same engine.
 */
const clockMover = (executionId: string, posts: () => number, parks: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const pause = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
      let row = yield* state.waiting(executionId)
      while (Option.isNone(row) || row.value.reason !== "timer") {
        yield* pause
        row = yield* state.waiting(executionId)
      }
      const now = yield* Clock.currentTimeMillis
      parks.push(`parked ${(row.value.wakeAt ?? now) - now} ms after ${posts()} post(s)`)
      yield* TestClock.adjust(delayMillis)
    })
  ))

it.effect("parks on the durable timer between posts with the flow's own layer", () =>
  Effect.gen(function*() {
    // X accepts the first post and refuses the second, so the run ends after one pause.
    const http = server((count) =>
      count === 1
        ? new Response(JSON.stringify({ data: { id: "x1" } }), { status: 201 })
        : new Response("Service Unavailable", { status: 503 })
    )
    const parks: Array<string> = []
    const executionId = "tweet-thread-durable-timer"
    const failure = yield* Effect.flip(Kit.run(TweetThread, {}, {
      filename: join(directory, "durable-timer.sqlite"),
      executionId,
      script: noAgents,
      actions: Layer.mergeAll(
        configured(layer, http.transport),
        clockMover(executionId, () => http.requests.length, parks)
      )
    }))

    // The run parked three seconds out after the first post, and posted the
    // second only once the clock moved.
    expect(parks).toEqual(["parked 3000 ms after 1 post(s)"])
    expect(http.requests).toHaveLength(2)
    expect(failure).toMatchObject({
      _tag: "examples/TweetThread/PostRefused",
      status: 503,
      body: "Service Unavailable"
    })
  }))

const SinglePost = Flow.make("examples/TweetThread/SinglePostTest", {
  payload: PostTweet.payloadSchema,
  success: PostTweet.successSchema,
  error: PostRefused,
  body: Node.capture({ action: PostTweet.name }, (payload) => PostTweet.call(payload))
})

for (const name of Object.keys(credentials)) {
  for (const value of [undefined, ""]) {
    it.effect(`does not send a request when ${name} is ${value === undefined ? "missing" : "empty"}`, () =>
      Effect.gen(function*() {
        const values: Record<string, string> = { ...credentials }
        if (value === undefined) delete values[name]
        else values[name] = value
        const http = server(() => new Response("Unexpected request", { status: 500 }))
        const id = `tweet-missing-${name}-${String(value)}`
        const result = yield* Kit.run(SinglePost, { text: "one post" }, {
          filename: join(directory, `${id}.sqlite`),
          executionId: id,
          script: noAgents,
          actions: configured(xLayer, http.transport, values)
        })
        expect(result.posted).toBe(false)
        expect(result.tweetId).toBe("")
        expect(result.error).toContain("Missing X_API_KEY")
        expect(http.requests).toEqual([])
      }))
  }
}

it.effect("returns a typed refusal when the injected HTTP transport fails", () =>
  Effect.gen(function*() {
    let attempted = 0
    const transport = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request) => {
      attempted++
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection refused" })
        })
      )
    }))
    const failure = yield* Effect.flip(Kit.run(SinglePost, { text: "one post" }, {
      filename: join(directory, "transport-failed.sqlite"),
      executionId: "tweet-transport-failed",
      script: noAgents,
      actions: configured(xLayer, transport)
    }))
    expect(failure).toMatchObject({
      _tag: "examples/TweetThread/PostRefused",
      status: 0,
      body: "The X API could not be reached."
    })
    expect(attempted).toBe(1)
  }))

it.effect("returns a typed refusal when an HTTP response body cannot be read", () =>
  Effect.gen(function*() {
    const http = server(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("response disconnected"))
          }
        }),
        { status: 201 }
      )
    )
    const failure = yield* Effect.flip(Kit.run(SinglePost, { text: "one post" }, {
      filename: join(directory, "response-failed.sqlite"),
      executionId: "tweet-response-failed",
      script: noAgents,
      actions: configured(xLayer, http.transport)
    }))
    expect(failure).toMatchObject({
      _tag: "examples/TweetThread/PostRefused",
      status: 0,
      body: "The X API response could not be read."
    })
    expect(http.requests).toHaveLength(1)
  }))

it("bounds each irreversible post and links to the actual examples repository", () => {
  expect(PostTweet.attemptTimeoutMs).toBe(30_000)
  expect(tweets.at(-1)).toContain("github.com/smithersai/smithers")
})

/** A real loopback endpoint, reached by injecting the fetch transport service. */
const serve = (handler: RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer(handler)
      server.once("error", (error) => resume(Effect.die(error)))
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
      return Effect.sync(() => {
        server.closeAllConnections()
        server.close()
      })
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections()
        server.close((error) => resume(error ? Effect.die(error) : Effect.void))
      })
  )

const localTransport = (server: Server, record: (signal: AbortSignal | null | undefined) => void = () => {}) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (_url, init) => {
    record(init?.signal)
    const address = server.address()
    if (address === null || typeof address === "string") return Promise.reject(new Error("No TCP address"))
    return fetch(`http://127.0.0.1:${address.port}/2/tweets`, init)
  })))

it.effect("records malformed successful X responses as typed refusals without retrying", () =>
  Effect.scoped(Effect.gen(function*() {
    let body = ""
    let requests = 0
    const server = yield* serve((_request, response) => {
      requests++
      response.writeHead(201, { "content-type": "application/json" })
      response.end(body)
    })
    const actions = configured(xLayer, localTransport(server))
    const invalid = ["not json", "{}", "null", "{\"data\":null}", "{\"data\":{\"id\":17}}", "{\"data\":{\"id\":\"\"}}"]
    for (const [index, value] of invalid.entries()) {
      body = value
      const exit = yield* Effect.exit(Kit.run(SinglePost, { text: "hello" }, {
        filename: join(directory, `malformed-${index}.sqlite`),
        executionId: `tweet-malformed-${index}`,
        script: noAgents,
        actions
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error) ? error.value : null).toMatchObject({
          _tag: "examples/TweetThread/PostRefused",
          status: 201
        })
        expect(Cause.hasDies(exit.cause)).toBe(false)
      }
      expect(requests).toBe(index + 1)
    }
  })))

for (const mode of ["cancel", "timeout"] as const) {
  it.effect(`aborts a hung X request on ${mode} and never posts twice`, () =>
    Effect.scoped(Effect.gen(function*() {
      let signal: AbortSignal | null | undefined
      let requests = 0
      const arrived = yield* Deferred.make<void>()
      const server = yield* serve((_request, _response) => {
        requests++
        Deferred.doneUnsafe(arrived, Exit.void)
      })
      const executionId = `tweet-hung-${mode}`
      const actions = configured(
        xLayer,
        localTransport(server, (current) => {
          signal = current
        })
      )
      const control = Layer.effectDiscard(Effect.forkScoped(Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        yield* Deferred.await(arrived)
        if (mode === "cancel") yield* runtime.interrupt(SinglePost, executionId).pipe(Effect.orDie)
        else yield* TestClock.adjust(30_000)
      })))
      const exit = yield* Effect.exit(Kit.run(SinglePost, { text: "hello" }, {
        filename: join(directory, `hung-${mode}.sqlite`),
        executionId,
        script: noAgents,
        actions: Layer.mergeAll(actions, control)
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (mode === "timeout") expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("AttemptTimedOut")
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal?.aborted).toBe(true)
      expect(requests).toBe(1)
    })))
}
