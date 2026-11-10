/** Code and object identity reach the engine's captured action context. */
import { describe, expect, it } from "@effect/vitest"
import { FlowRuntime, JournalDecode } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import { CloudflareRuntime, ObjectDatabase } from "../src/index.ts"
import { Answer, registration } from "./fixtures/AnswerFlow.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"

describe("Cloudflare journal decode identity", () => {
  for (const configured of [undefined, "explicit-code"] as const) {
    it.live(`captures object identity and ${configured ?? "inherited code"}`, () =>
      Effect.scoped(Effect.gen(function*() {
        const store = SqliteStorage.make()
        const seen: Array<unknown> = []
        {
          yield* Effect.gen(function*() {
            const runtime = yield* FlowRuntime.FlowRuntime
            yield* runtime.execute(Answer, { executionId: "identity", payload: { question: "identity", pauseMs: 0 } })
          }).pipe(
            Effect.provide(
              CloudflareRuntime.layer(
                { hostId: "actual-object", executionId: "identity", flow: Answer._tag, codeVersion: configured },
                registration(() =>
                  Effect.map(JournalDecode.Identity, (identity) => {
                    seen.push(identity)
                    return "answer"
                  })
                )
              ).pipe(Layer.provide(ObjectDatabase.layer(store.storage)))
            ),
            Effect.provideService(JournalDecode.Identity, { objectId: "outer-object", codeVersion: "inherited-code" })
          )
          expect(seen).toEqual([{ objectId: "actual-object", codeVersion: configured ?? "inherited-code" }, {
            objectId: "actual-object",
            codeVersion: configured ?? "inherited-code"
          }])
        }
      })))
  }
})
