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
