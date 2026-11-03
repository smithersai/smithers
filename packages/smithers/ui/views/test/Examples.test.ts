import { Effect, Layer } from "effect"
import { expect, test } from "vitest"
import { counter, program } from "../examples/render-a-view.ts"
import { PresentationRealm } from "../src/index.ts"
import { bundle } from "./fixtures/bundle.ts"
import { layerSingleFile } from "./fixtures/quickjs.ts"

test("the render-a-view example checks, renders and plays one click", async () => {
  const result = await program(counter, { name: "add", arg: "10" }).pipe(
    Effect.provide(PresentationRealm.layer({ bundle: await bundle() }).pipe(Layer.provide(layerSingleFile))),
    Effect.runPromise
  )
  expect(result.interactions).toEqual({ add: { kind: "state" } })
  expect(result.first).toContain("<p>Count: 0</p>")
  expect(result.next.state).toBe(10)
  expect(result.next.html).toContain("<p>Count: 10</p>")
  expect(result.next.html).toContain("data-event=\"add:10\"")
})
