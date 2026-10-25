import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect, type Layer, Metric, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import type { SqlClient } from "effect/sql"
import { PUBLICATION_COLUMNS, PUBLICATIONS_TABLE } from "../../src/features/branch/contract.ts"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import { branchAccess, canView } from "./Access.ts"

// `GET /api/shapes/branch-publications?branch=<id>` (docs/features/branch-publish.md#the-branch-page): a branch's
// publication on GitHub, its pull request and how its last Update branch ended, for anyone who may view the branch, so
// everyone on a shared branch sees it published. Anyone else, and a malformed id, get a shape with no rows.

/** `GET /api/shapes/branch-publications` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_branch_publication_shape_requests", {
  description: "GET /api/shapes/branch-publications requests, by status and live",
  incremental: true,
})

/** What a shape filters on for someone who may not view the branch: no branch's id, so it holds no rows. */
const NO_BRANCH = "00000000-0000-0000-0000-000000000000"

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

/** Reads Electric's connection and returns the shape over `database`; sessions unreadable, 503 (worker/ShapeAccess.ts). */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    return ShapeProxy.make({
      ...connection,
      shape: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const named = new URL(request.url, "http://localhost").searchParams.get("branch")
        const actor = yield* ShapeAccess.actor
        const found = named !== null && isUuid(named)
          ? yield* branchAccess(actor, named.toLowerCase()).pipe(
            Effect.provide(database),
            Effect.mapError(() => ShapeAccess.unavailable),
          )
          : undefined
        const branch = found !== undefined && canView(found.access) ? found.branchId : NO_BRANCH
        return { table: PUBLICATIONS_TABLE, where: "branch_id = $1", params: { "1": branch }, columns: PUBLICATION_COLUMNS }
      }),
      name: "branch.publications.shape",
      metric: shapes,
    })
  })
