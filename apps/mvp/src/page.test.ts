import { Effect } from "effect"
import { expect, test } from "vitest"
import { Page, reload } from "./page.vibe"
import type { AppReloadReason } from "./reloadReason"

test("reload calls the page boundary only when its Effect runs", () => {
  const reasons: Array<AppReloadReason> = []
  const page = Page.layer(reason => { reasons.push(reason) })
  const pending = reload("bfcache").pipe(Effect.provide(page))

  expect(reasons).toEqual([])
  Effect.runSync(pending)
  Effect.runSync(reload("engine_stopped").pipe(Effect.provide(page)))
  expect(reasons).toEqual(["bfcache", "engine_stopped"])
})
