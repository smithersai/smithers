import * as Effect from "effect/Effect"
import { coreSuite } from "../../src/Conformance.vibe"
import { make as makeEngineSubject } from "../../src/EngineSubject.vibe"
import * as MemoryEngine from "../../src/MemoryEngine.ts"
import * as RestartableEngine from "../../src/RestartableEngine.vibe"
import { describe, it } from "../../src/Vitest.vibe"

// Executable reference semantics. The question closes only when these pins run
// against the production engine.
describe("MemoryEngine conformance", () => {
  for (const conformanceCase of coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.gen(function*() {
        const store = yield* MemoryEngine.makeStore()
        const engine = yield* MemoryEngine.make(store)
        yield* conformanceCase.run(engine)
      }))
  }
})

describe("RestartableEngine replay, race, and interruption conformance", () => {
  const restartableCases = coreSuite({
    filter: (conformanceCase) =>
      conformanceCase.name.startsWith("replay/") ||
      conformanceCase.name.startsWith("race/") ||
      conformanceCase.name.startsWith("interrupt/")
  })

  for (const conformanceCase of restartableCases) {
    it.scoped(conformanceCase.name, () =>
      Effect.gen(function*() {
        const harness = yield* RestartableEngine.make()
        const restartOnResume = makeEngineSubject({
          ...harness.engine,
          name: "RestartableEngine/restart-on-resume",
          resume: harness.restartAndResume
        })
        yield* conformanceCase.run(restartOnResume)
      }))
  }
})
