import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect, Metric, Option } from "effect"
import { HttpServerRequest } from "effect/http"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  AGENT_RUN_COLUMNS,
  AGENT_RUN_MAINTAINER_COLUMNS,
  AGENT_RUNS_SHAPE_ROUTE,
  MACHINE_COLUMNS,
  MACHINES_SHAPE_ROUTE,
} from "../../src/features/fleet/contract.ts"
import { isRepository } from "../../src/features/repo/contract.ts"
import { canAsk } from "#vibelang/emitted/worker/Actor"
import { mayMaintain } from "../feeds/Api.ts"
import { repositoryOf as repositoryNamed } from "#vibelang/emitted/worker/github/Config"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as ShapeAccess from "#vibelang/emitted/worker/ShapeAccess"

// The fleet's shapes (decision 0143, docs/features/fleet.md#the-shapes): one Electric shape per repository for its
// runs, and one for its machines, so fifty runs are fifty rows of one shape, never fifty inspectors.
//
// - `GET /api/shapes/agent-runs?repo=<owner>/<name>`: `agent_runs` of the repository, for a signed-in Member or above
//   (who may read its stack, as the TODOs' shape checks). Its Maintainers and Admins, in person, get the account label
//   too.
// - `GET /api/shapes/machines?repo=<owner>/<name>`: `runners` of the repository, for its Maintainers and Admins in
//   person; never a token's digest.
//
// The role is the person's on that repository (`RepoRoles`, decision 0079), decided once per request.

/** `GET /api/shapes/agent-runs` requests, by `status` and `live`. */
export const runShapes = Metric.counter("smithers_fleet_run_shape_requests", {
  description: "GET /api/shapes/agent-runs requests, by status and live",
  incremental: true,
})

/** `GET /api/shapes/machines` requests, by `status` and `live`. */
export const machineShapes = Metric.counter("smithers_fleet_machine_shape_requests", {
  description: "GET /api/shapes/machines requests, by status and live",
  incremental: true,
})

/** Whether a path is one of the fleet's shapes. */
export const handles = (path: string): boolean => path === AGENT_RUNS_SHAPE_ROUTE || path === MACHINES_SHAPE_ROUTE

/** The repository a shape request names in `?repo=<owner>/<name>`, or `undefined`. */
const repositoryOf = (url: string) => {
  const [owner, name = "", ...rest] = (new URL(url, "http://localhost").searchParams.get("repo") ?? "").split("/")
  return rest.length === 0 && isRepository(owner!, name) ? repositoryNamed(`${owner}/${name}`) : undefined
}

/** A refusal for a role `RepoRoles` couldn't give: GitHub or Postgres not answering is `503`, the rest `403`. */
const refusal = (refused: RepoRoles.RoleRefused) =>
  RepoRoles.REFUSALS[refused.code] === 503 || refused.code === "rate_limited"
    ? new ShapeProxy.Refused({ status: 503, retryAfter: refused.retryAfterSeconds })
    : new ShapeProxy.Refused({ status: 403 })

/** Reads Electric's connection and returns the two shapes, reading roles through `roles`. */
export const make = <R>(roles: RepoRoles.RepoRoles<R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

    /** Who asks, and their role on the named repository: refused unless signed in and the repository is one. */
    const asker = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const actor = yield* ShapeAccess.actor
      if (Option.isNone(actor)) return yield* new ShapeProxy.Refused({ status: 401 })
      const repository = repositoryOf(request.url)
      if (repository === undefined) return yield* new ShapeProxy.Refused({ status: 403 })
      const resolved = yield* roles.resolve(actor.value, repository).pipe(Effect.mapError(refusal))
      return { actor: actor.value, role: resolved.role, repoId: repository.id }
    })

    const runs = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const { actor, role, repoId } = yield* asker
        if (!canAsk({ ...actor, role })) return yield* new ShapeProxy.Refused({ status: 403 })
        const maintains = mayMaintain(actor, role)
        yield* Effect.annotateCurrentSpan({ "fleet.audience": maintains ? "maintainers" : "members" })
        return {
          table: "agent_runs",
          where: "repo_id = $1",
          params: { "1": repoId },
          columns: [...(maintains ? AGENT_RUN_MAINTAINER_COLUMNS : AGENT_RUN_COLUMNS)],
        }
      }),
      name: "fleet.shape.runs",
      metric: runShapes,
    })

    const machines = ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const { actor, role, repoId } = yield* asker
        if (!mayMaintain(actor, role)) return yield* new ShapeProxy.Refused({ status: 403 })
        return { table: "runners", where: "repo_id = $1", params: { "1": repoId }, columns: [...MACHINE_COLUMNS] }
      }),
      name: "fleet.shape.machines",
      metric: machineShapes,
    })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* (request.url.split("?")[0] === AGENT_RUNS_SHAPE_ROUTE ? runs : machines)
    })
    return { fetch }
  })
