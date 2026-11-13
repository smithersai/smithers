// When a conversation's views load (src/features/views/embeds.ts): only while the routed page may show the
// conversation. A repository's issues and pull requests pages show none, so their cold boot opens no other repository's
// issues and asks no other repository's role (decision 0152).
import { Deferred, Effect, Fiber, Option, PubSub, Queue, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { type Route, showsConversation, shownWhileRouted } from "./embeds"

describe("a conversation's views load while the routed page may show it", () => {
  test.each([
    ["/app", true],
    ["/app/views/v1", true],
    ["/acme/app", true],
    ["/acme/app/tree/main/src", true],
    ["/acme/app/issues", false],
    ["/acme/app/issues/7", false],
    ["/acme/app/issues/new", false],
    ["/acme/app/pulls", false],
    ["/acme/app/pulls/3/files", false],
    ["/acme/app/issuesx", true],
  ])("%s", (path, shows) => {
    expect(showsConversation(path)).toBe(shows)
  })

  test("without a route, every conversation, including the home conversation", async () => {
    expect(await Effect.runPromise(Stream.runCollect(shownWhileRouted(Stream.make(null, "branch")))))
      .toEqual([Option.some(null), Option.some("branch")])
  })

  test("starts hidden, retains the latest conversation, and releases the route listener", async () => {
    let listener: ((path: string) => void) | undefined
    let stopped = false
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>()
      const conversations = yield* Queue.unbounded<string>()
      const selected = yield* Queue.unbounded<Option.Option<string>>()
      const route: Route = {
        pathname: () => "/acme/app/issues/7",
        pages: (heard) => {
          listener = heard
          Effect.runSync(Deferred.succeed(subscribed, undefined))
          return () => void (stopped = true)
        },
      }
      const fiber = yield* shownWhileRouted(Stream.fromQueue(conversations), route).pipe(
        Stream.runForEach((conversation) => Queue.offer(selected, conversation)),
        Effect.forkScoped,
      )
      // zipLatest waits for both initial values before it pulls the route's live listener.
      yield* Queue.offer(conversations, "home")
      yield* Deferred.await(subscribed)
      expect(yield* Queue.take(selected)).toEqual(Option.none())
      listener!("/acme/app/pulls")
      listener!("/acme/app")
      expect(yield* Queue.take(selected)).toEqual(Option.some("home"))
      yield* Queue.offer(conversations, "branch")
      expect(yield* Queue.take(selected)).toEqual(Option.some("branch"))
      listener!("/acme/app/issues")
      expect(yield* Queue.take(selected)).toEqual(Option.none())
      yield* Queue.offer(conversations, "other")
      expect(yield* Queue.take(selected)).toEqual(Option.none())
      listener!("/app")
      expect(yield* Queue.take(selected)).toEqual(Option.some("other"))
      yield* Fiber.interrupt(fiber)
    })))
    expect(stopped).toBe(true)
  })

  test.each(["/acme/app/issues", "/acme/app/pulls/3/files"])(
    "%s cancels the current rows subscription and resumes the latest conversation",
    async (hiddenPath) => {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const subscribed = yield* Deferred.make<void>()
        const conversations = yield* Queue.unbounded<string | null>()
        const selected = yield* Queue.unbounded<Option.Option<string | null>>()
        const closed = yield* Queue.unbounded<string | null>()
        const loaded = yield* Queue.unbounded<string>()
        const home = yield* PubSub.unbounded<string>()
        const branch = yield* PubSub.unbounded<string>()
        let homeRow = "initial home view"
        let branchRow = "initial branch view"
        let listener: ((path: string) => void) | undefined
        const route: Route = {
          pathname: () => "/app",
          pages: (heard) => {
            listener = heard
            Effect.runSync(Deferred.succeed(subscribed, undefined))
            return () => void (listener = undefined)
          },
        }
        const rowsIn = (conversation: string | null) => Stream.unwrap(Effect.gen(function* () {
          const updates = yield* PubSub.subscribe(conversation === null ? home : branch)
          return Stream.concat(
            Stream.sync(() => conversation === null ? homeRow : branchRow),
            Stream.fromSubscription(updates),
          )
        })).pipe(Stream.ensuring(Queue.offer(closed, conversation)))
        const fiber = yield* shownWhileRouted(Stream.fromQueue(conversations), route).pipe(
          Stream.tap((conversation) => Queue.offer(selected, conversation)),
          Stream.switchMap(Option.match({ onNone: () => Stream.empty, onSome: rowsIn })),
          Stream.runForEach((row) => Queue.offer(loaded, row)),
          Effect.forkScoped,
        )
        yield* Queue.offer(conversations, null)
        yield* Deferred.await(subscribed)
        expect(yield* Queue.take(selected)).toEqual(Option.some(null))
        expect(yield* Queue.take(loaded)).toBe("initial home view")

        listener!(hiddenPath)
        expect(yield* Queue.take(selected)).toEqual(Option.none())
        // Acknowledged finalization makes the negative load assertions independent of timers.
        expect(yield* Queue.take(closed)).toBeNull()
        homeRow = "home view synced while hidden"
        yield* PubSub.publish(home, homeRow)
        yield* Queue.offer(conversations, "branch")
        expect(yield* Queue.take(selected)).toEqual(Option.none())
        branchRow = "branch view synced while hidden"
        yield* PubSub.publish(branch, branchRow)

        listener!("/app")
        expect(yield* Queue.take(selected)).toEqual(Option.some("branch"))
        expect(yield* Queue.take(loaded)).toBe(branchRow)
        branchRow = "branch view synced while visible"
        yield* PubSub.publish(branch, branchRow)
        expect(yield* Queue.take(loaded)).toBe(branchRow)

        // Returning with the same selected conversation also restarts its rows.
        listener!(hiddenPath)
        expect(yield* Queue.take(selected)).toEqual(Option.none())
        expect(yield* Queue.take(closed)).toBe("branch")
        branchRow = "latest hidden branch view"
        yield* PubSub.publish(branch, branchRow)
        listener!("/acme/app/tree/main")
        expect(yield* Queue.take(selected)).toEqual(Option.some("branch"))
        expect(yield* Queue.take(loaded)).toBe(branchRow)
        yield* Fiber.interrupt(fiber)
        expect(yield* Queue.take(closed)).toBe("branch")
        expect(yield* Queue.size(loaded)).toBe(0)
        expect(listener).toBeUndefined()
      })))
    },
  )
})
