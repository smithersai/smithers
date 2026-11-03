// When a conversation's views load (src/features/views/embeds.ts): only while the routed page may show the
// conversation. A repository's issues and pull requests pages show none, so their cold boot opens no other repository's
// issues and asks no other repository's role (decision 0152).
import { Effect, Fiber, Queue, Stream } from "effect"
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

  test("without a route, every conversation; with one, only while the page may show it, from the page it shows now", async () => {
    expect(await Effect.runPromise(Stream.runCollect(shownWhileRouted(Stream.make("home", "branch"))))).toEqual(["home", "branch"])

    let listener: ((path: string) => void) | undefined
    let stopped = false
    const route: Route = {
      pathname: () => "/acme/app/issues/7",
      pages: (heard) => {
        listener = heard
        return () => void (stopped = true)
      },
    }
    const shown = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const conversations = yield* Queue.unbounded<string>()
      const seen: Array<string> = []
      const fiber = yield* shownWhileRouted(Stream.fromQueue(conversations), route).pipe(
        Stream.runForEach((conversation) => Effect.sync(() => void seen.push(conversation))),
        Effect.forkScoped,
      )
      const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
      yield* Queue.offer(conversations, "home")
      yield* settle
      // On an issue page: nothing yet.
      expect(seen).toEqual([])
      // Another issues page still shows none; the repository's home shows it.
      listener!("/acme/app/pulls")
      yield* settle
      expect(seen).toEqual([])
      listener!("/acme/app")
      yield* settle
      expect(seen).toEqual(["home"])
      yield* Queue.offer(conversations, "branch")
      yield* settle
      // Back on an issue page, a conversation shown meanwhile waits.
      listener!("/acme/app/issues")
      yield* Queue.offer(conversations, "other")
      yield* settle
      yield* Fiber.interrupt(fiber)
      return seen
    })))
    expect(shown).toEqual(["home", "branch"])
    expect(stopped).toBe(true)
  })
})
