import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlError from "effect/sql/SqlError"
import { ExecutionObject } from "../src/index.ts"
import * as FailureDetail from "../src/internal/FailureDetail.vibe"
import { Answer } from "./fixtures/AnswerFlow.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import * as Objects from "./fixtures/Objects.ts"

describe("alarm failure detail", () => {
  it.effect("a SqlError at the eight-error chain limit does not break diagnostic generation", () =>
    Effect.gen(function*() {
      let error: unknown = new SqlError.SqlError({ reason: new SqlError.ConnectionError({ cause: undefined }) })
      for (let i = 0; i < 7; i++) error = new Error("wrapper", { cause: error })
      expect(() => FailureDetail.detail(Cause.fail(error), undefined)).not.toThrow()
      expect(FailureDetail.detail(Cause.fail(error), undefined)).toEqual({})

      const memory = MemoryStorage.make()
      const intent = yield* ExecutionObject.intent(Answer, {
        executionId: "bounded-failure-detail",
        payload: { question: "probe", pauseMs: 0 }
      })
      yield* ExecutionObject.start(memory.storage, intent, Effect.void)
      const outcome = yield* ExecutionObject.alarm(memory.storage, {
        flows: [Answer],
        runtime: () => Layer.effectContext<ExecutionObject.Services, unknown, never>(Effect.fail(error)),
        router: Objects.unrouted
      })
      expect(outcome).toMatchObject({ _tag: "Retrying", detail: {} })
    }))
})
