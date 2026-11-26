// Program boundary for the run artifacts' handler (worker/branch/Artifacts.ts) in workerd, over a real R2 binding and
// workerd's `FixedLengthStream`, as a job box's object runs it (worker/BranchSandboxes.ts). The scope the object would
// read from its own branch comes from the test's `x-scope` header.
import { Effect, Option } from "effect"
import { HttpEffect, HttpServerRequest } from "effect/http"
import { Sessions } from "../../Actor.ts"
import { repositoryOf } from "../../github/Config.vibe"
import * as ArtifactRoutes from "../../ops/ArtifactRoutes.vibe"
import * as Artifacts from "../../branch/Artifacts.vibe"

interface Env {
  readonly ARTIFACTS: Artifacts.Bucket
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (ArtifactRoutes.handles(path)) {
      const repo = repositoryOf("smithersai/smithers-ops")
      const login = request.headers.get("x-test-login")
      const storage = Artifacts.r2(env.ARTIFACTS, (bytes) => new FixedLengthStream(bytes))
      return HttpEffect.toWebHandler(ArtifactRoutes.read(
        { repository: repo, resolve: () => Effect.succeed({ role: "admin", held: Option.none() }) },
        { admins: new Set(["roninjin10"]) },
        (execution) => Effect.succeed(execution === "ci:ops-fixture" ? { execution, repoId: repo.id } : null),
        storage.get,
      ).pipe(Effect.provideService(Sessions, Sessions.of({
        resolve: Effect.succeed(login === null ? Option.none() : Option.some({
          subject: { kind: "person", id: login }, login, role: "admin",
        })),
      }))))(request)
    }
    return HttpEffect.toWebHandler(
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (incoming) =>
        Artifacts.answer(incoming, incoming.headers["x-scope"]).pipe(
          Effect.provide(Artifacts.layerR2(env.ARTIFACTS, (bytes) => new FixedLengthStream(bytes))),
        )),
    )(request)
  },
}
