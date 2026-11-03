import { afterAll, afterEach, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { FlowRuntime } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFailed, vi } from "vitest"
import * as Kit from "../../../examples/use-cases/kit.vibe"
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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
    yield* Effect.gen(function*() {
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
    for (const name of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) vi.stubEnv(name, "")
    const fetched = vi.spyOn(globalThis, "fetch")
    const log: Array<string> = []
    const timer = advanceTimers("tweet-thread-no-credentials", () => void log.push("sleep"))
    const posts = yield* Kit.run(TweetThread, {}, {
      filename: join(directory, "no-credentials.sqlite"),
      executionId: "tweet-thread-no-credentials",
      script: noAgents,
      actions: Layer.mergeAll(xLayer, timer)
    })

    expect(fetched).not.toHaveBeenCalled()
    expect(log).toHaveLength(24)
    expect(posts).toHaveLength(25)
    expect(posts.every((post) =>
      !post.posted && post.tweetId === "" &&
      post.error === "Missing X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, or X_ACCESS_SECRET env vars."
    )).toBe(true)
  }))

it.effect("signs each X request and threads it on the id X returned for the post before", () =>
  Effect.gen(function*() {
    vi.stubEnv("X_API_KEY", "consumer-key")
    vi.stubEnv("X_API_SECRET", "consumer-secret")
    vi.stubEnv("X_ACCESS_TOKEN", "access-token")
    vi.stubEnv("X_ACCESS_SECRET", "access-secret")
    const requests: Array<{ readonly url: string; readonly authorization: string; readonly body: unknown }> = []
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const headers = init?.headers as Record<string, string>
      requests.push({ url: String(url), authorization: headers.authorization!, body: JSON.parse(String(init?.body)) })
      return Promise.resolve(new Response(JSON.stringify({ data: { id: `x${requests.length}` } }), { status: 201 }))
    })
    const timer = advanceTimers("tweet-thread-signed", () => {})
    const posts = yield* Kit.run(TweetThread, {}, {
      filename: join(directory, "signed.sqlite"),
      executionId: "tweet-thread-signed",
      script: noAgents,
      actions: Layer.mergeAll(xLayer, timer)
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
    vi.stubEnv("X_API_KEY", "consumer-key")
    vi.stubEnv("X_API_SECRET", "consumer-secret")
    vi.stubEnv("X_ACCESS_TOKEN", "access-token")
    vi.stubEnv("X_ACCESS_SECRET", "access-secret")
    // X accepts the first post and refuses the second, so the run ends after one pause.
    let posts = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        ++posts === 1
          ? new Response(JSON.stringify({ data: { id: "x1" } }), { status: 201 })
          : new Response("Service Unavailable", { status: 503 })
      )
    )
    const parks: Array<string> = []
    const executionId = "tweet-thread-durable-timer"
    const exit = yield* Effect.exit(Kit.run(TweetThread, {}, {
      filename: join(directory, "durable-timer.sqlite"),
      executionId,
      script: noAgents,
      actions: Layer.mergeAll(layer, clockMover(executionId, () => posts, parks))
    }))

    // The run parked three seconds out after the first post, and posted the
    // second only once the clock moved.
    expect(parks).toEqual(["parked 3000 ms after 1 post(s)"])
    expect(posts).toBe(2)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("PostRefused")
  }))
