// Work a ChatApi request leaves to run after its response, through the request's execution context (workerd's
// `ctx.waitUntil`). It reads `@alchemy.run/cloudflare`, which only Alchemy's bundle resolves, so it stays out of
// worker/ExecutionHost.ts's module graph (worker/ExecutionHost.bundle.test.ts).
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import * as FirstPaint from "./github/FirstPaint.ts"

/**
 * `look` registered with the request's execution context to run after the response: what ChatApi runs on each request,
 * so no request waits on it, however slow it is (worker/flows/RedactFeed.ts `launcher`).
 */
export const inBackground = <R>(look: Effect.Effect<void, never, R>) =>
  Effect.flatMap(Cloudflare.WorkerExecutionContext, (context) => context.waitUntil(look))

/** The request's execution context as the first paint's `Behind`: its role read runs after the response. */
export const firstPaintBehind = Effect.gen(function*() {
  const context = yield* Cloudflare.WorkerExecutionContext
  const runtime = yield* Effect.context<never>()
  return FirstPaint.Behind.of({
    run: (work) => context.waitUntil(work).pipe(Effect.provide(runtime)) as Effect.Effect<void>
  })
})
