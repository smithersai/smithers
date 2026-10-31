// Program boundary for the run artifacts' handler (worker/branch/Artifacts.ts) in workerd, over a real R2 binding and
// workerd's `FixedLengthStream`, as a job box's object runs it (worker/BranchSandboxes.ts). The scope the object would
// read from its own branch comes from the test's `x-scope` header.
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest } from "effect/http"
import * as Artifacts from "../../branch/Artifacts.ts"

interface Env {
  readonly ARTIFACTS: Artifacts.Bucket
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return HttpEffect.toWebHandler(
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (incoming) =>
        Artifacts.answer(incoming, incoming.headers["x-scope"]).pipe(
          Effect.provide(Artifacts.layerR2(env.ARTIFACTS, (bytes) => new FixedLengthStream(bytes))),
        )),
    )(request)
  },
}
