import * as GitHubConfig from "../github/Config.ts"
import * as RepoConfig from "../RepoConfig.ts"
import { CREATION_ROUTE } from "../../src/features/branch/creation.ts"
import * as Creation from "./Creation.ts"
import { Effect, type Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { BRANCHES_ROUTE, SHARES_SHAPE_ROUTE } from "../../src/features/branch/contract.ts"
import { commandMaxSeconds } from "../../src/features/sandbox/config.ts"
import { TERMINALS_ROUTE, TERMINALS_SHAPE_ROUTE } from "../../src/features/terminal/contract.ts"
import * as Branches from "./Branches.ts"
import * as ConversationApi from "./ConversationApi.ts"
import * as Presence from "./Presence.ts"
import * as SandboxCalls from "./SandboxCalls.ts"
import * as Shares from "./Shares.ts"
import * as Terminals from "./Terminals.ts"
import * as Texts from "./Texts.ts"

// The branch workspace's routes (decision 0013, docs/features/branch-workspace.md): tracking a branch, sharing it, a
// person's own list of conversations and archiving one (docs/features/conversations.md), its room, its terminals, its
// sandbox tools (docs/features/sandbox-tools.md) and the texts people edit together on it (docs/features/coedit.md).
// ChatApi hands them every request `handles` names; the conversation's own routes stay chat's.

/** Whether a path is one of the branch workspace's routes. */
export const handles = (path: string): boolean =>
  path === BRANCHES_ROUTE || path.startsWith(`${BRANCHES_ROUTE}/`) || path === SHARES_SHAPE_ROUTE ||
  path === TERMINALS_ROUTE || path === TERMINALS_SHAPE_ROUTE || path.startsWith(`${TERMINALS_ROUTE}/`) ||
  SandboxCalls.handles(path) || Texts.handles(path) || ConversationApi.handles(path)

/** `/api/branches/<id>/<what>`: the branch's id and what of it, or `undefined` for any other path under the route. */
const branchPath = (path: string) => {
  const match = /^\/api\/branches\/([^/]+)\/(shares|room)$/.exec(path)
  return match === null ? undefined : { branchId: match[1]!, what: match[2] as "shares" | "room" }
}

/**
 * The routes over `database`, which opens a Postgres client for each request's scope. Reads `SANDBOX_COMMAND_MAX_SECONDS`
 * once, for the sandbox calls' commands. Captures the GitHub App and Code Storage client before building handlers.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const app = yield* GitHubConfig.configured
    const client = yield* RepoConfig.codeStorage
    const conversations = yield* ConversationApi.make(database)
    const terminals = yield* Terminals.make(database)
    const shares = yield* Shares.make(database)
    const room = Presence.make(database)
    const sandboxCalls = SandboxCalls.make(database, yield* commandMaxSeconds)
    const texts = yield* Texts.make(database)
    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (ConversationApi.handles(path)) return yield* conversations.fetch
      if (path === CREATION_ROUTE) return yield* Creation.route(client, database)
      if (path === BRANCHES_ROUTE) return yield* Branches.make(database, app)
      if (SandboxCalls.handles(path)) return yield* sandboxCalls.fetch
      if (Texts.handles(path)) return yield* texts.fetch
      if (path === SHARES_SHAPE_ROUTE) return yield* shares.shape
      if (path === TERMINALS_ROUTE) return yield* terminals.open
      if (path === TERMINALS_SHAPE_ROUTE) return yield* terminals.shape
      if (path.startsWith(`${TERMINALS_ROUTE}/`)) return yield* terminals.connect(path.slice(TERMINALS_ROUTE.length + 1))
      const branch = branchPath(path)
      if (branch?.what === "shares") return yield* shares.change(branch.branchId)
      if (branch?.what === "room") return yield* room(branch.branchId)
      return HttpServerResponse.empty({ status: 404 })
    })
    return { fetch }
  })
