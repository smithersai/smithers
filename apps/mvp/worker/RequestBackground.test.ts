import * as Cloudflare from "@alchemy.run/cloudflare"
import { Context, Deferred, Effect } from "effect"
import { expect, test } from "vitest"
import { firstPaintBehind } from "./RequestBackground.vibe"

const requestMarker = Context.Reference("test/RequestBackground/marker", { defaultValue: () => "missing" })

test("the first paint schedules work on the captured request context", async () => {
  const pending: Array<Promise<unknown>> = []
  const execution: Pick<ExecutionContext, "waitUntil"> = {
    waitUntil: (work) => { pending.push(work) },
  }
  const context = Cloudflare.fromExecutionContext(execution as ExecutionContext)
  const release = Effect.runSync(Deferred.make<void>())
  const seen: Array<string> = []
  const behind = await Effect.runPromise(firstPaintBehind.pipe(
    Effect.provideService(Cloudflare.WorkerExecutionContext, context),
    Effect.provideService(requestMarker, "captured"),
  ))

  await Effect.runPromise(behind.run(Effect.gen(function* () {
    yield* Deferred.await(release)
    seen.push(yield* requestMarker)
  })))
  expect(pending).toHaveLength(1)
  expect(seen).toEqual([])

  Effect.runSync(Deferred.succeed(release, undefined))
  await Promise.all(pending)
  expect(seen).toEqual(["captured"])
})
