import { readFile } from "node:fs/promises"
import { ViewCode } from "@smthrs/views"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "../src/features/views/renderer.ts"
import * as ViewRealm from "./ViewRealm.vibe"

// Give Vitest the same compiled module that Alchemy gives workerd. The workerd suite
// exercises Alchemy's actual import and the test below runs the real QuickJS build in Node.
vi.mock("#quickjs.wasm", async () => {
  const url = new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"))
  return { default: await WebAssembly.compile(await readFile(url)) }
})

test("the compiled QuickJS module renders a view and a failed load can be retried", async () => {
  let attempts = 0
  const loaded = ViewRealm.once(Effect.gen(function* () {
    if (++attempts === 1) return yield* Effect.fail("load failed")
    return yield* ViewRealm.load
  }))

  expect(await Effect.runPromise(Effect.flip(loaded))).toBe("load failed")
  const realm = await Effect.runPromise(loaded)
  expect(await Effect.runPromise(loaded)).toBe(realm)
  expect(attempts).toBe(2)

  const module = await Effect.runPromise(ViewCode.check(TIC_TAC_TOE, { components: realm.components }))
  const html = await Effect.runPromise(realm.render({ module, props: {}, state: TIC_TAC_TOE_STATE }))
  expect(html).toContain("X to move")
})
