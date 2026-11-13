// Optional model lookups use real sealed connections and Postgres; agent subscriptions are never model wires.
import { Effect, Layer, Option } from "effect"
import { expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import { testFile } from "../test/harness.ts"
import { PersonalModels } from "./Models.ts"
import { KEY, seedKeys } from "./test/harness.ts"

const runtime = testFile("optional_models")

test("a deployment with personal models disabled opens neither a tier nor an individual connection", async () => {
  const results = await Effect.runPromise(Effect.flatMap(PersonalModels, (models) => Effect.all([
    models.open("person", "fast"), models.openConnection("person", "missing"),
  ])).pipe(Effect.provide(PersonalModels.none)))
  expect(results).toEqual([Option.none(), Option.none()])
})

test("Check Access cannot open an agent subscription or a nonexistent connection as a model", async () => {
  const [id] = await seedKeys(runtime, "person", [{ kind: "claude_subscription", key: "subscription-sentinel" }])
  const db = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
  const results = await Effect.runPromise(Effect.flatMap(PersonalModels, (models) => Effect.all([
    models.openConnection("person", id!), models.openConnection("person", "missing"),
  ])).pipe(Effect.provide(PersonalModels.layer(db).pipe(Layer.provide(SecretKeys.layer(KEY))))))
  expect(results).toEqual([Option.none(), Option.none()])
})

test.each([
  ["fast", "gpt-6-luna", "claude-haiku-4-5"],
  ["implement", "gpt-6.1-sol", "claude-sonnet-5"],
  ["hard", "gpt-6-astra", "claude-opus-5-5"],
] as const)("%s opens the first saved provider's sealed key after reordering", async (tier, openaiModel, anthropicModel) => {
  const db = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
  const models = PersonalModels.layer(db).pipe(Layer.provide(SecretKeys.layer(KEY)))
  const openai = { protocol: "openai-chat", baseUrl: "https://api.openai.com", key: "openai-sentinel-key" } as const
  const anthropic = { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", key: "anthropic-sentinel-key" } as const
  for (const [connections, modelId] of [
    [[openai, anthropic], openaiModel],
    [[anthropic, openai], anthropicModel],
  ] as const) {
    const [id] = await seedKeys(runtime, "person", connections)
    const opened = await Effect.runPromise(
      Effect.flatMap(PersonalModels, (service) => service.open("person", tier)).pipe(Effect.provide(models)),
    )
    expect(Option.isSome(opened)).toBe(true)
    expect(Option.getOrThrow(opened)).toMatchObject({
      connectionId: id,
      protocol: connections[0].protocol,
      host: new URL(connections[0].baseUrl).hostname,
      modelId,
      tier,
    })
  }
})
