import { digestSync } from "@smthrs/crypto"
import { Effect, Metric, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { Sessions } from "../Actor.ts"
import * as Artifacts from "../branch/Artifacts.ts"
import { repositoryOf } from "../github/Config.ts"
import type { RepoRoles } from "../github/RepoRoles.ts"
import type { Admitted } from "../RepoRuns.ts"
import * as Visibility from "./ArtifactVisibility.ts"

const route = /^\/api\/repos\/([^/]+)\/([^/]+)\/artifacts\/([^/]+)\/([^/]+)$/
export const handles = (path: string): boolean => route.test(path)

const missing = HttpServerResponse.jsonUnsafe(Visibility.NOT_FOUND.body, {
  status: Visibility.NOT_FOUND.status,
  headers: { "cache-control": "private, no-store" },
})
const reads = Metric.counter("smithers_repo_artifact_reads", { incremental: true })

/** Read a run's stored bytes after authorizing its repository and verifying the run's recorded association. */
export const read = <R, E2, R2, R3>(
  roles: RepoRoles<R>,
  policy: Visibility.Policy,
  runOf: (id: string) => Effect.Effect<Admitted | null, E2, R2>,
  get: (key: string) => Effect.Effect<Option.Option<Artifacts.Stored>, Artifacts.StoreFailed, R3>,
) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const match = route.exec(new URL(request.url, "https://artifacts.internal").pathname)
  if (request.method !== "GET" || match === null) return missing
  const fullName = Visibility.canonicalRepositoryId(`${match[1]}/${match[2]}`)
  const name = match[4]!
  if (fullName === undefined || !Artifacts.NAME.test(name)) return missing
  const execution = decodeURIComponent(match[3]!)
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_:-]{0,255}$/.test(execution)) return missing
  const repository = { fullName, private: true }
  const actor = Option.getOrUndefined(yield* (yield* Sessions).resolve)
  if (actor === undefined) return missing
  const target = repositoryOf(fullName)
  const ops = Visibility.isOpsRepository(repository, policy)
  const role = ops ? null : (yield* roles.resolve(actor, target)).role
  if (!Visibility.canRead(actor, { repository, path: name, title: name, size: 0, owner: "ci" }, policy,
    { repoId: fullName, role })) return missing
  const run = yield* runOf(execution)
  if (run?.repoId !== target.id || run.execution !== execution) return missing
  const artifact = yield* get(Artifacts.keyOf(digestSync(`run:${execution}`).slice(0, 40), name))
  if (Option.isNone(artifact)) return missing
  return HttpServerResponse.raw(artifact.value.body, {
    contentType: "application/octet-stream",
    contentLength: artifact.value.bytes,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  })
}).pipe(
  Effect.catchCause(() => Effect.succeed(missing)),
  Effect.tap((response) => Metric.update(Metric.withAttributes(reads, { status: String(response.status) }), 1)),
  Effect.withSpan("artifact.read"),
)
