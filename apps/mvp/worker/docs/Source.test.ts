import { ImmutableCache } from "@smthrs/artifacts"
import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import { markdown, outsideWeb } from "../test/pages.ts"
import * as Source from "./Source.vibe"

test("docs settings are captured without acquiring a runtime cache", async () => {
  // Alchemy's Node build has no ImmutableCache/Worker cache service. Only runtime service construction needs it.
  const config: Record<string, string> = { DOCS_KEPT: "7 seconds" }
  const captured = await Effect.runPromise(Source.settings.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
  ))
  delete config.DOCS_KEPT
  expect(captured).toEqual({ kept: 7000 })
})

const DOCS = "https://docs.example/llms.txt"

/**
 * The source over Effect's real fetch client, the real in-memory cache and the scripted outside web (worker/test/pages.ts),
 * which counts what it is asked; GitHub can't answer, so the curated home's index serves.
 */
const served = async <A>(kept: number, body: (read: Effect.Effect<Source.IndexRead>, asked: () => number) => Promise<A>) => {
  const asked: Array<string> = []
  const web = outsideWeb({ [DOCS]: markdown("# Example\n\n## Guide\n\n- [Start](/start.md): Install.\n") }, asked)
  const source = await Effect.runPromise(Source.make({ kept }, {
    about: { answer: () => Effect.succeed({ _tag: "Refused", code: "unavailable", cache: "wait" }) },
    homes: [{ repository: "acme/widgets", defaultBranch: "main", home: { docs: DOCS, blocks: [{ type: "text", text: "Hi" }] } }],
  }).pipe(
    Effect.provide(Layer.merge(FetchHttpClient.layer, ImmutableCache.layerMemory())),
    Effect.provideService(FetchHttpClient.Fetch, web),
  ))
  return body(source.index("acme", "widgets"), () => asked.length)
}

test("DOCS_KEPT=0 keeps nothing: every read asks the docs site again", async () => {
  await served(0, async (read, asked) => {
    const answers = [await Effect.runPromise(read), await Effect.runPromise(read)]
    expect(answers.map((answer) => answer._tag === "Index" && [answer.index.pages.length, answer.cached])).toEqual([[1, false], [1, false]])
    expect(asked()).toBe(2)
  })
})

test("a positive window keeps the index: the second read is the cache's", async () => {
  await served(60_000, async (read, asked) => {
    const answers = [await Effect.runPromise(read), await Effect.runPromise(read)]
    expect(answers.map((answer) => answer._tag === "Index" && answer.cached)).toEqual([false, true])
    expect(asked()).toBe(1)
  })
})
