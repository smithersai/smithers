// The Worker worker/ci/Realm.workerd.test.ts runs in local workerd (Miniflare), bundled the way Alchemy bundles ChatApi:
// a repository flow's source, posted as the request's body, planned in the realm (worker/ci/Realm.ts) over the QuickJS
// build the Worker carries (worker/AgentSandbox.ts `variant`), exactly as `repo/Plan` plans it on Cloudflare.
//
// This file is the program boundary: it runs Effects with `Effect.runPromise`.
import { Effect } from "effect"
import * as AgentSandbox from "../../AgentSandbox.vibe"
import * as Realm from "../../ci/Realm.vibe"

export default {
  fetch: async (request: Request): Promise<Response> => {
    const source = await request.text()
    return Effect.runPromise(
      Realm.plan("ci", source, { run: "ci:workerd", repo: "acme/widgets", sha: "a".repeat(40), ref: "refs/heads/main", event: "push" })
        .pipe(
          Effect.provide(AgentSandbox.variant),
          Effect.map((plan) => Response.json(plan)),
          Effect.catchCause((cause) => Effect.succeed(new Response(String(cause), { status: 500 }))),
        ),
    )
  },
}
