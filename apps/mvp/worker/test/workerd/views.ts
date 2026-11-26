// The Worker worker/ViewRealm.workerd.test.ts runs in local workerd (Miniflare), bundled the way Alchemy bundles ChatApi:
// ChatApi's presentation realm (worker/ViewRealm.ts) checks the renderer's tic-tac-toe module, renders it, makes one
// move, and refuses a module that throws, all on Cloudflare's runtime with the QuickJS build the bundle compiled.
//
// This file is the program boundary: it runs Effects with `Effect.runPromise`.
import { ViewCode } from "@smthrs/views"
import { Effect } from "effect"
import { TIC_TAC_TOE, TIC_TAC_TOE_STATE } from "../../../src/features/views/renderer.ts"
import * as ViewRealm from "../../ViewRealm.vibe"

const play = Effect.gen(function* () {
  const realm = yield* ViewRealm.load
  const module = yield* ViewCode.check(TIC_TAC_TOE, { components: realm.components })
  const html = yield* realm.render({ module, props: {}, state: TIC_TAC_TOE_STATE })
  const moved = yield* realm.interact({ module, props: {}, state: TIC_TAC_TOE_STATE, event: { name: "cell", arg: "4" } })
  const throwing = yield* ViewCode.check(`export default function View() { throw new Error("no") }`, {
    components: realm.components,
  })
  const refused = yield* realm.render({ module: throwing, props: {}, state: null }).pipe(Effect.flip)
  return { html, moved, refused: refused.reason, interactions: module.interactions }
})

export default {
  fetch: (): Promise<Response> =>
    Effect.runPromise(
      play.pipe(
        Effect.map((played) => Response.json(played)),
        Effect.catchCause((cause) => Effect.succeed(new Response(String(cause), { status: 500 }))),
      ),
    ),
}
