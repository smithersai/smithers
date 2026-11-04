import { Crypto } from "@smthrs/crypto"
import { NodeHost } from "@smthrs/platform-node"
import { Engine } from "@smthrs/flows"
import { Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { AboutReader, registration, RepoAbout, RepoNotFound, RepoReadsPaused, RepoReadUnavailable } from "./flows"
import type { About } from "./schema"
import { RepoClient } from "./api"
import { readerLayer } from "./reader"

const about: About = {
  name: "octocat/Spoon-Knife", description: "Refreshed", homepage: null, topics: [], stars: 0, forks: 0, watchers: 0,
  license: null, defaultBranch: "main", archived: false, languages: [], release: null, releases: 0, contributors: [],
  contributorCount: 0, commits: null, branches: null, tags: null, head: null, root: null, readme: null, installUrl: null,
}

test("About recovers after a 12-second refresh, honors Retry-After, and bounds retryable refusals only", async () => {
  for (const failure of [undefined, new RepoReadUnavailable({ retryAfterMillis: 4000 }), new RepoNotFound(), new RepoReadsPaused()]) {
    const times: number[] = []
    const firstRead = Deferred.makeUnsafe<void>()
    const runtime = registration.pipe(
      Layer.provideMerge(Engine.FlowEngine.layerMemory),
      Layer.provide(Layer.succeed(AboutReader, AboutReader.of({
        about: () => Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          times.push(now)
          if (failure !== undefined) return yield* Effect.fail(failure)
          // The server's waiter ends at 10 s; the held refresh completes at 12 s.
          if (now < 12_000) {
            yield* Deferred.await(firstRead)
            return yield* Effect.fail(new RepoReadUnavailable({ retryAfterMillis: 2000 }))
          }
          return about
        }),
      }))),
      // The merged registration also needs the real file reader; About never invokes it.
      Layer.provide(readerLayer.pipe(
        Layer.provide(RepoClient.layer({ origin: "https://smithers.test", within: "10 seconds" })),
        Layer.provide(FetchHttpClient.layer),
      )),
    )
    // Effect 4.1 NodeCrypto.layer no longer provides the legacy Crypto service the flow needs.
    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* RepoAbout.execute({ repo: "octocat/Spoon-Knife" }, { executionId: crypto.randomUUID() }).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(10_000)
      yield* Deferred.succeed(firstRead, undefined)
      yield* TestClock.adjust(1999)
      if (failure === undefined) expect(times).toEqual([0])
      yield* TestClock.adjust(60_001)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(runtime), Effect.provide(Crypto.layerFromDigest(NodeHost.NodeCrypto.layerDigest)), Effect.provide(TestClock.layer()), Effect.scoped))
    if (failure === undefined) {
      expect(result).toEqual(Exit.succeed(about))
      expect(times).toEqual([0, 12_000])
    } else {
      expect(Exit.isFailure(result)).toBe(true)
      expect(times).toEqual(failure instanceof RepoReadUnavailable ? [0, 4000, 8000] : [0])
    }
  }
})
