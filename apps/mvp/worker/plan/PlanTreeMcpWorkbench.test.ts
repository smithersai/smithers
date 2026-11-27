import { GuiAdapter, Principal } from "@smthrs/app-core"
import { ShardProtocol } from "@smthrs/sync"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Exit, Layer, Logger, Option, Schema, Scope, Stream } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import { type McpScope, repoMcpRoute } from "../../src/features/mcp/contract.ts"
import { defaultWorkbenchLayout } from "../../src/features/workbench/layout.ts"
import { planShardId } from "../../src/features/workbench/planContract.ts"
import { PLAN_ROW_ID, Workbench, WorkbenchStore } from "../../src/features/workbench/store.vibe"
import { renderWorkbenchShell } from "../../src/features/workbench/workbench-render.tsx"
import { type Actor, type Role } from "../Actor.vibe"
import { repositoryOf } from "../github/Config.vibe"
import type { RepoRoles } from "../github/RepoRoles.vibe"
import * as McpApi from "../mcp/Api.vibe"
import { McpAuthService, type McpPrincipal, McpToolError, McpToolRegistry } from "../mcp/Contract.vibe"
import {
  callPlanTreeTool,
  isPlanTreeTool,
  PLAN_TREE_TOOL_DESCRIPTORS,
  PLAN_TREE_TOOL_NAMES,
  type PlanTreeMcpDeps,
  visibleDescriptors,
} from "../mcp/PlanTreeTools.vibe"
import { makeLiveToolDeps, makeMcpToolRegistry } from "../mcp/Tools.vibe"
import { signedIn, signedOut } from "../test/harness.ts"
import * as PlanTreeRoutes from "./PlanTreeRoutes.vibe"
import * as PlanTreeShard from "./PlanTreeShard.vibe"

// Real end-to-end suite across the entire shared Workbench Plan Tree path:
// authenticated repository MCP (`McpApi` -> `Protocol` -> `McpToolRegistry` -> `PlanTreeTools`)
// -> real `PlanTreeRoutes.makeShardHandler` -> real `PlanTreeShard` + `DoSqliteShard` on disk SQLite
// -> real `PlanTreeRoutes.dispatch` (`GET /plan/snapshot` + `GET /plan/pull`)
// -> real `WorkbenchClient` + `WorkbenchStore` -> real `renderWorkbenchShell` UI.

interface StoredToken {
  readonly bearer: string
  readonly principal: McpPrincipal
}

const makeToken = (
  hexDigit: string,
  opts: {
    readonly tokenId: string
    readonly personId: string
    readonly login: string
    readonly repoScope: string | null
    readonly scopes: ReadonlyArray<McpScope>
  },
): StoredToken => ({
  bearer: `sma_${hexDigit.repeat(64)}`,
  principal: {
    tokenId: opts.tokenId,
    personId: opts.personId,
    login: opts.login,
    clientName: "codex-cutover",
    repoScope: opts.repoScope,
    scopes: opts.scopes,
    actor: {
      subject: { kind: "person", id: opts.personId },
      role: null,
      login: opts.login,
      act: { kind: "agent", id: `mcp:${opts.tokenId}` },
    },
  },
})

const makeTestHarness = (dir: string) => {
  const storageByShard = new Map<string, ReturnType<typeof openStorage>>()
  const handlerByShard = new Map<string, Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>>()
  let shardScope = Scope.makeUnsafe()
  const roleMatrix = new Map<string, Role | null>()
  const tokens = new Map<string, StoredToken>()
  const forwardCalls: Array<ShardProtocol.ShardId> = []
  let faultMode: "none" | "defect" | "http500" | "http401" | "http403" | "http413" | "bad-json" | "rpc-error" | "bad-read-shape" | "bad-update-shape" = "none"
  let customReply: (() => HttpServerResponse.HttpServerResponse) | null = null

  const sqlitePathFor = (shard: string) => join(dir, `${shard.replace(/[^a-z0-9._-]/gi, "_")}.sqlite`)

  const openShard = (shard: ShardProtocol.ShardId) =>
    Effect.gen(function* () {
      const existing = handlerByShard.get(shard)
      if (existing !== undefined) return existing
      const db = openStorage(sqlitePathFor(shard))
      storageByShard.set(shard, db)
      const handler = yield* PlanTreeRoutes.makeShardHandler(db.storage, shard).pipe(Scope.provide(shardScope))
      handlerByShard.set(shard, handler)
      return handler
    })

  const hibernateAll = () => {
    Effect.runSync(Scope.close(shardScope, Exit.void))
    shardScope = Scope.makeUnsafe()
    for (const db of storageByShard.values()) db.hibernate()
    storageByShard.clear()
    handlerByShard.clear()
  }

  const setRole = (personId: string, repoFullName: string, role: Role | null) => {
    roleMatrix.set(`${personId}:${repoFullName.toLowerCase()}`, role)
  }

  const registerToken = (
    hexDigit: string,
    opts: Parameters<typeof makeToken>[1],
  ) => {
    const token = makeToken(hexDigit, opts)
    tokens.set(token.bearer, token)
    return token
  }

  const policy = { admins: new Set(["williamcory"]) }

  const forward: PlanTreeMcpDeps["forward"] = (shard, request) =>
    Effect.gen(function* () {
      forwardCalls.push(shard)
      if (customReply !== null) return customReply()
      if (faultMode === "defect") return yield* Effect.fail(new Error("durable object unreachable"))
      if (faultMode === "http500") return HttpServerResponse.empty({ status: 500 })
      if (faultMode === "http401") return HttpServerResponse.empty({ status: 401 })
      if (faultMode === "http403") return HttpServerResponse.empty({ status: 403 })
      if (faultMode === "http413") return HttpServerResponse.empty({ status: 413 })
      if (faultMode === "bad-json") return HttpServerResponse.text("{not-json", { status: 200 })
      if (faultMode === "rpc-error") {
        return HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } })
      }
      if (faultMode === "bad-read-shape" || faultMode === "bad-update-shape") {
        return HttpServerResponse.jsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { unexpected: true } },
        })
      }
      const handler = yield* openShard(shard)
      return yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    })

  const authService: McpAuthService["Service"] = {
    authenticate: (request, targetRepoId) =>
      Effect.sync(() => {
        const header = request.headers["authorization"]
        if (header === undefined) return { _tag: "Anonymous" as const }
        const match = /^Bearer ([^\s]+)$/i.exec(header.trim())
        const stored = match === null ? undefined : tokens.get(match[1]!)
        if (stored === undefined) return { _tag: "Rejected" as const, status: 401 as const, code: "invalid_token" as const }
        const scope = stored.principal.repoScope
        if (targetRepoId !== undefined && scope !== null && scope.toLowerCase() !== targetRepoId.toLowerCase()) {
          return { _tag: "Rejected" as const, status: 403 as const, code: "repo_scope_mismatch" as const }
        }
        return { _tag: "Authenticated" as const, principal: stored.principal }
      }),
    resolveRepoAccess: (principal, owner, name) =>
      Effect.gen(function* () {
        const canonical = `github/${owner.toLowerCase()}/${name.toLowerCase()}`
        if (Option.isSome(principal)) {
          const pinned = principal.value.repoScope
          if (pinned !== null && pinned.toLowerCase() !== canonical) {
            return yield* Effect.fail(new McpToolError({ code: "forbidden", message: "This MCP token is scoped to a different repository." }))
          }
          const role = roleMatrix.get(`${principal.value.personId}:${owner.toLowerCase()}/${name.toLowerCase()}`) ?? null
          return { owner, name, repoId: canonical, role, isPublic: true }
        }
        return { owner, name, repoId: canonical, role: null, isPublic: true }
      }),
    requireWriteAccess: (principal, owner, name, minimum) =>
      Effect.gen(function* () {
        if (Option.isNone(principal)) {
          return yield* Effect.fail(new McpToolError({ code: "authentication", message: "Authentication is required." }))
        }
        const current = principal.value
        if (!current.scopes.includes("mcp:write")) {
          return yield* Effect.fail(new McpToolError({ code: "forbidden", message: "Missing mcp:write scope." }))
        }
        const access = yield* authService.resolveRepoAccess(principal, owner, name)
        const ranks: Record<string, number> = { guest: 1, member: 2, maintainer: 3, admin: 4 }
        if ((access.role === null ? 0 : ranks[access.role]!) < ranks[minimum]!) {
          return yield* Effect.fail(new McpToolError({ code: "forbidden", message: `Requires ${minimum} role.` }))
        }
        return {
          principal: { ...current, actor: { ...current.actor, role: access.role } },
          access,
        }
      }),
    listTokens: () => Effect.succeed([]),
    revokeToken: () => Effect.succeed(false),
    handleOAuthOrTokenRoute: () => Effect.succeed(Option.none()),
  }

  const authLayer = Layer.succeed(McpAuthService, authService)
  const mcpApi = McpApi.make()
  const registryLayer = Layer.effect(
    McpToolRegistry,
    makeMcpToolRegistry(
      makeLiveToolDeps({
        planTree: { policy, forward },
      }),
    ),
  ).pipe(Layer.provide(authLayer))

  const postMcp = (
    path: string,
    body: unknown,
    bearer?: string,
  ) =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request(`https://smithers.sh${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          },
          body: JSON.stringify(body),
        }),
      )
      const response = yield* mcpApi.fetch.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(registryLayer),
        Effect.provide(authLayer),
      )
      const web = HttpServerResponse.toWeb(response)
      const text = yield* Effect.promise(() => web.text())
      return {
        status: response.status,
        headers: web.headers,
        json: text.length > 0 ? JSON.parse(text) : null,
      }
    })

  const repoRolesFor = (actor: Actor): RepoRoles => ({
    repository: repositoryOf("smithersai/smithers"),
    resolve: (_a, repo) =>
      Effect.succeed({
        role: roleMatrix.get(`${actor.subject.id}:${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`) ?? null,
        held: Option.none(),
      }),
  })

  const browserHttpLayer = (actor: Actor | null) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const webReq = new Request(request.url, {
            method: request.method,
            headers: { [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA },
          })
          const serverReq = HttpServerRequest.fromWeb(webReq)
          const serverRes = yield* PlanTreeRoutes.dispatch(
            (shard, outgoing) => forward(shard, outgoing),
            repoRolesFor(actor ?? { subject: { kind: "person", id: "anon" }, role: null }),
            policy,
          ).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, serverReq),
            Effect.provide(actor === null ? signedOut : signedIn(actor)),
            Effect.orDie,
          )
          return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(serverRes))
        }),
      ),
    )

  return {
    policy,
    forward,
    forwardCalls,
    authService,
    setFaultMode: (next: typeof faultMode) => {
      faultMode = next
    },
    setCustomReply: (next: typeof customReply) => {
      customReply = next
    },
    setRole,
    registerToken,
    openShard,
    sqlitePathFor,
    hibernateAll,
    postMcp,
    browserHttpLayer,
  }
}

describe("Shared Workbench Plan Tree end-to-end (MCP write -> durable PlanTree DO -> Workbench UI)", () => {
  test("authenticated maintainer MCP write persists to SQLite, loads through uncompacted snapshot(state:null)+pull, renders real goals and status, and survives DO restart + UI reload + compaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-e2e-workbench-"))
    const h = makeTestHarness(dir)
    const maintainer = h.registerToken("a", {
      tokenId: "tok-maint",
      personId: "person-will",
      login: "williamcory",
      repoScope: "github/smithersai/smithers",
      scopes: ["mcp:read", "mcp:write"],
    })
    const browserActor: Actor = {
      subject: { kind: "person", id: "person-will" },
      role: "maintainer",
      login: "williamcory",
    }
    h.setRole("person-will", "smithersai/smithers", "maintainer")

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const mcpPath = repoMcpRoute("smithersai", "smithers")

            // 1. Fresh empty repo: snapshot GET returns { position: { shard, epoch: 0, seq: 0 }, state: null }
            //    and Workbench shows honest empty state (NEVER "Plan tree is unavailable" and NO fake/demo rows).
            const emptyLayer = Workbench.live({ origin: "https://smithers.sh" }).pipe(
              Layer.provideMerge(WorkbenchStore.layer),
              Layer.provide(h.browserHttpLayer(browserActor)),
            )
            yield* Effect.gen(function* () {
              const wb = yield* Workbench
              const store = yield* WorkbenchStore
              yield* Effect.promise(() => wb.actions.loadPlan("smithersai", "smithers"))
              const row = store.plan.tanstack.get(PLAN_ROW_ID)
              expect(row).toMatchObject({
                repoSlug: "smithersai/smithers",
                status: "empty",
                nodes: [],
                totalFrames: 1,
                error: null,
              })
              const html = renderWorkbenchShell({
                repoSlug: "smithersai/smithers",
                layout: defaultWorkbenchLayout("maintainer"),
                maxRole: "maintainer",
                onDispatch: () => {},
                totalFrames: row!.totalFrames,
                planNodes: row!.nodes,
                attachHref: "/smithersai/smithers/tree/main#attach-agent",
              })
              expect(html).toContain("No plan nodes yet.")
              expect(html).not.toContain("Plan tree is unavailable")
            }).pipe(Effect.provide(emptyLayer))

            // 2. tools/list on /api/repos/smithersai/smithers/mcp advertises plan_tree_read and plan_tree_update.
            const listed = yield* h.postMcp(mcpPath, { jsonrpc: "2.0", id: 1, method: "tools/list" }, maintainer.bearer)
            expect(listed.status).toBe(200)
            const toolNames = (listed.json.result.tools as Array<{ name: string }>).map((t) => t.name)
            expect(toolNames).toContain("plan_tree_read")
            expect(toolNames).toContain("plan_tree_update")

            // 3. Agent writes a goal tree via plan_tree_update (never compacted yet -> snapshot.state stays null!).
            const upsertRoot = yield* h.postMcp(
              mcpPath,
              {
                jsonrpc: "2.0",
                id: "req-1",
                method: "tools/call",
                params: {
                  name: "plan_tree_update",
                  arguments: {
                    idempotencyKey: "cutover-root",
                    command: {
                      _tag: "UpsertPlanNode",
                      id: "goal-cutover",
                      parent: null,
                      title: "Live Smithers cutover",
                      milestone: "M0",
                      sources: ["apps/mvp/src/features/workbench/store.vibe"],
                      assumptions: ["Snapshot and pull share one schema"],
                      dodFast: "pnpm test",
                      order: 0,
                      expectedRevision: 0,
                    },
                  },
                },
              },
              maintainer.bearer,
            )
            expect(upsertRoot.status).toBe(200)
            expect(upsertRoot.json.result.isError).toBeUndefined()
            const rootReceipt = JSON.parse(upsertRoot.json.result.content[0].text)
            expect(rootReceipt).toMatchObject({
              repository: "smithersai/smithers",
              shard: "repo:smithersai/smithers",
              journalSeq: 1,
              event: { _tag: "PlanNodeCreated", id: "goal-cutover", title: "Live Smithers cutover" },
            })

            // 4. Child goal + status update to in_progress + assumption verification + artifact attachment.
            const upsertChild = yield* h.postMcp(
              mcpPath,
              {
                jsonrpc: "2.0",
                id: "req-2",
                method: "tools/call",
                params: {
                  name: "plan_tree_update",
                  arguments: {
                    idempotencyKey: "cutover-child",
                    command: {
                      _tag: "UpsertPlanNode",
                      id: "goal-mcp",
                      parent: "goal-cutover",
                      title: "Wire repository MCP PlanTree tools",
                      milestone: "M1",
                      sources: ["apps/mvp/worker/mcp/PlanTreeTools.vibe"],
                      assumptions: ["Scoped roles and repo isolation verified"],
                      dodFast: "vitest run worker/plan",
                      order: 1,
                      expectedRevision: 1,
                    },
                  },
                },
              },
              maintainer.bearer,
            )
            expect(upsertChild.status).toBe(200)
            expect(JSON.parse(upsertChild.json.result.content[0].text).journalSeq).toBe(2)

            const setInProgress = yield* h.postMcp(
              mcpPath,
              {
                jsonrpc: "2.0",
                id: "req-3",
                method: "tools/call",
                params: {
                  name: "plan_tree_update",
                  arguments: {
                    idempotencyKey: "cutover-status",
                    command: {
                      _tag: "SetNodeStatus",
                      nodeId: "goal-mcp",
                      status: "in_progress",
                      expectedRevision: 2,
                    },
                  },
                },
              },
              maintainer.bearer,
            )
            expect(setInProgress.status).toBe(200)
            expect(JSON.parse(setInProgress.json.result.content[0].text).journalSeq).toBe(3)

            const toggleAssumption = yield* h.postMcp(
              mcpPath,
              {
                jsonrpc: "2.0",
                id: "req-4",
                method: "tools/call",
                params: {
                  name: "plan_tree_update",
                  arguments: {
                    idempotencyKey: "cutover-assumption",
                    command: {
                      _tag: "ToggleAssumption",
                      nodeId: "goal-cutover",
                      index: 0,
                      expectedRevision: 3,
                    },
                  },
                },
              },
              maintainer.bearer,
            )
            expect(toggleAssumption.status).toBe(200)

            // 5. MCP plan_tree_read reflects all 4 committed writes.
            const readRes = yield* h.postMcp(
              mcpPath,
              { jsonrpc: "2.0", id: "req-5", method: "tools/call", params: { name: "plan_tree_read", arguments: {} } },
              maintainer.bearer,
            )
            expect(readRes.status).toBe(200)
            const readPayload = JSON.parse(readRes.json.result.content[0].text)
            expect(readPayload.revision).toBe(4)
            expect(readPayload.shard).toBe("repo:smithersai/smithers")
            expect(readPayload.nodes.map((n: { id: string; status: string }) => [n.id, n.status])).toEqual([
              ["goal-cutover", "pending"],
              ["goal-mcp", "in_progress"],
            ])

            // 6. Verify real snapshot GET on uncompacted shard STILL returns position + state:null (production shape!)
            const snapCheck = yield* PlanTreeRoutes.dispatch(
              (shard, outgoing) => h.forward(shard, outgoing),
              {
                repository: repositoryOf("smithersai/smithers"),
                resolve: () => Effect.succeed({ role: "maintainer", held: Option.none() }),
              },
              h.policy,
            ).pipe(
              Effect.provide(signedIn(browserActor)),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    "https://smithers.sh/api/repos/smithersai/smithers/plan/snapshot?shard=repo%3Asmithersai%2Fsmithers",
                    { headers: { [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA } },
                  ),
                ),
              ),
            )
            expect(snapCheck.status).toBe(200)
            const rawSnap = yield* Effect.promise(() => HttpServerResponse.toWeb(snapCheck).json())
            expect(rawSnap).toEqual({
              position: { shard: "repo:smithersai/smithers", epoch: 0, seq: 0 },
              state: null,
            })

            // 7. Signed-in Workbench loads via real snapshot(state:null) + pull AND renders actual goals & statuses,
            //    even with mixed-case URL params ("SmithersAI", "Smithers")!
            const assertWorkbenchShowsLiveGoals = (expectedCount: number, expectedTotalFrames: number) =>
              Effect.gen(function* () {
                const wb = yield* Workbench
                const store = yield* WorkbenchStore
                yield* Effect.promise(() => wb.actions.loadPlan("SmithersAI", "Smithers"))
                const row = store.plan.tanstack.get(PLAN_ROW_ID)
                expect(row?.status).toBe("ready")
                expect(row?.error).toBeNull()
                expect(row?.totalFrames).toBe(expectedTotalFrames)
                expect(row?.nodes).toHaveLength(expectedCount)
                expect(row?.nodes[0]).toMatchObject({
                  id: "goal-cutover",
                  title: "Live Smithers cutover",
                  milestone: "M0",
                  status: "pending",
                  depth: 0,
                  assumptions: [{ id: "goal-cutover#0", text: "Snapshot and pull share one schema", verified: true }],
                })
                expect(row?.nodes[1]).toMatchObject({
                  id: "goal-mcp",
                  title: "Wire repository MCP PlanTree tools",
                  milestone: "M1",
                  status: "in_progress",
                  depth: 1,
                })
                const html = renderWorkbenchShell({
                  repoSlug: "smithersai/smithers",
                  layout: defaultWorkbenchLayout("maintainer"),
                  maxRole: "maintainer",
                  onDispatch: () => {},
                  totalFrames: row!.totalFrames,
                  planNodes: row!.nodes,
                  attachHref: "/smithersai/smithers/tree/main#attach-agent",
                })
                expect(html).toContain("Live Smithers cutover")
                expect(html).toContain("Wire repository MCP PlanTree tools")
                expect(html).toContain("M0")
                expect(html).toContain("M1")
                expect(html).not.toContain("Plan tree is unavailable")
                expect(html).not.toContain("No plan nodes yet.")
              }).pipe(
                Effect.provide(
                  Workbench.live({ origin: "https://smithers.sh" }).pipe(
                    Layer.provideMerge(WorkbenchStore.layer),
                    Layer.provide(h.browserHttpLayer(browserActor)),
                  ),
                ),
              )

            yield* assertWorkbenchShowsLiveGoals(2, 5)

            // 8. Simulate BOTH Durable Object hibernation/restart AND browser page reload (brand new WorkbenchStore).
            h.hibernateAll()
            yield* assertWorkbenchShowsLiveGoals(2, 5)

            // 9. Compact the SQLite shard, hibernate, write one more tail node via MCP, then reload Workbench again:
            //    Workbench must merge the compacted snapshot AND the post-compaction tail entry cleanly.
            h.hibernateAll()
            const shardId = planShardId("smithersai", "smithers")
            const compactDb = openStorage(h.sqlitePathFor(shardId))
            try {
              const hub = yield* PlanTreeShard.make(
                compactDb.storage,
                shardId,
                Principal.make({ verify: Principal.sessions({}) }),
              ).pipe(Effect.provide(Reactivity.layer))
              expect(yield* hub.compact).toMatchObject({ seq: 4 })
            } finally {
              compactDb.hibernate()
            }

            const postCompactWrite = yield* h.postMcp(
              mcpPath,
              {
                jsonrpc: "2.0",
                id: "req-6",
                method: "tools/call",
                params: {
                  name: "plan_tree_update",
                  arguments: {
                    idempotencyKey: "post-compact-node",
                    command: {
                      _tag: "UpsertPlanNode",
                      id: "goal-verify",
                      parent: "goal-cutover",
                      title: "Verify post-compaction tail",
                      milestone: "M2",
                      sources: [],
                      assumptions: [],
                      dodFast: "pnpm test",
                      order: 2,
                      expectedRevision: 4,
                    },
                  },
                },
              },
              maintainer.bearer,
            )
            expect(postCompactWrite.status).toBe(200)
            yield* assertWorkbenchShowsLiveGoals(3, 6)
          }),
        ),
      )
    } finally {
      h.hibernateAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("enforces scoped role checks, OAuth scopes, repo isolation, ops-repo fencing, idempotency, and person-only done approvals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-e2e-security-"))
    const h = makeTestHarness(dir)
    const guest = h.registerToken("1", {
      tokenId: "tok-guest",
      personId: "p-guest",
      login: "guestuser",
      repoScope: null,
      scopes: ["mcp:read", "mcp:write"],
    })
    const member = h.registerToken("2", {
      tokenId: "tok-member",
      personId: "p-member",
      login: "memberuser",
      repoScope: null,
      scopes: ["mcp:read", "mcp:write"],
    })
    const maintReadOnly = h.registerToken("3", {
      tokenId: "tok-maint-ro",
      personId: "p-maint",
      login: "maintuser",
      repoScope: null,
      scopes: ["mcp:read"],
    })
    const maintWriteOnly = h.registerToken("4", {
      tokenId: "tok-maint-wo",
      personId: "p-maint",
      login: "maintuser",
      repoScope: null,
      scopes: ["mcp:write"],
    })
    const maintAlphaPinned = h.registerToken("5", {
      tokenId: "tok-alpha",
      personId: "p-maint",
      login: "maintuser",
      repoScope: "github/acme/alpha",
      scopes: ["mcp:read", "mcp:write"],
    })
    const maintUnpinned = h.registerToken("6", {
      tokenId: "tok-unpinned",
      personId: "p-maint",
      login: "maintuser",
      repoScope: null,
      scopes: ["mcp:read", "mcp:write"],
    })
    const opsAdmin = h.registerToken("7", {
      tokenId: "tok-ops",
      personId: "p-admin",
      login: "williamcory",
      repoScope: null,
      scopes: ["mcp:read", "mcp:write"],
    })

    h.setRole("p-guest", "acme/alpha", "guest")
    h.setRole("p-member", "acme/alpha", "member")
    h.setRole("p-maint", "acme/alpha", "maintainer")
    h.setRole("p-maint", "acme/beta", "maintainer")
    h.setRole("p-admin", "smithersai/smithers-ops", "admin")

    const alphaMcp = repoMcpRoute("acme", "alpha")
    const betaMcp = repoMcpRoute("acme", "beta")
    const opsMcp = repoMcpRoute("smithersai", "Smithers-Ops")

    const upsertCmd = (id: string, title: string, expectedRevision: number | null = null) => ({
      _tag: "UpsertPlanNode" as const,
      id,
      parent: null,
      title,
      milestone: "M0" as const,
      sources: [],
      assumptions: [],
      dodFast: "",
      order: 0,
      expectedRevision,
    })

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Anonymous: hidden from tools/list, and calling triggers 401 RFC 9728 OAuth challenge.
            const anonList = yield* h.postMcp(alphaMcp, { jsonrpc: "2.0", id: 1, method: "tools/list" })
            expect((anonList.json.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("plan_tree_read")
            expect((anonList.json.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("plan_tree_update")
            const anonRead = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            })
            expect(anonRead.status).toBe(401)
            expect(anonRead.headers.get("www-authenticate")).toContain("Bearer")
            const anonWrite = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 3, method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("x", "x") } },
            })
            expect(anonWrite.status).toBe(401)

            // Guest (even with mcp:read + mcp:write): hidden and refused forbidden.
            const guestList = yield* h.postMcp(alphaMcp, { jsonrpc: "2.0", id: 4, method: "tools/list" }, guest.bearer)
            expect((guestList.json.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("plan_tree_read")
            const guestRead = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, guest.bearer)
            expect(guestRead.json.result.isError).toBe(true)
            expect(guestRead.json.result.content[0].text).toContain("forbidden")

            // Member: sees plan_tree_read only, can read, cannot write.
            const memberList = yield* h.postMcp(alphaMcp, { jsonrpc: "2.0", id: 6, method: "tools/list" }, member.bearer)
            const memberNames = (memberList.json.result.tools as Array<{ name: string }>).map((t) => t.name)
            expect(memberNames).toContain("plan_tree_read")
            expect(memberNames).not.toContain("plan_tree_update")
            const memberRead = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, member.bearer)
            expect(memberRead.json.result.isError).toBeUndefined()
            const memberWrite = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 8, method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("x", "x") } },
            }, member.bearer)
            expect(memberWrite.json.result.isError).toBe(true)
            expect(memberWrite.json.result.content[0].text).toContain("forbidden")

            // Read-only maintainer token: can read, cannot write. Write-only maintainer token: can write, cannot read.
            const roWrite = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 9, method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("x", "x") } },
            }, maintReadOnly.bearer)
            expect(roWrite.json.result.isError).toBe(true)
            expect(roWrite.json.result.content[0].text).toContain("forbidden")
            const woRead = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maintWriteOnly.bearer)
            expect(woRead.json.result.isError).toBe(true)
            expect(woRead.json.result.content[0].text).toContain("forbidden")

            // Repo isolation: token pinned to acme/alpha cannot touch acme/beta via route OR via /api/mcp arguments.
            const beforeCalls = h.forwardCalls.length
            const pinnedWrongRoute = yield* h.postMcp(betaMcp, {
              jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maintAlphaPinned.bearer)
            expect(pinnedWrongRoute.status).toBe(403)
            const pinnedCrossArg = yield* h.postMcp("/api/mcp", {
              jsonrpc: "2.0", id: 12, method: "tools/call",
              params: { name: "plan_tree_update", arguments: { repository: "acme/beta", command: upsertCmd("leak", "Leak") } },
            }, maintAlphaPinned.bearer)
            expect(pinnedCrossArg.json.result.isError).toBe(true)
            expect(pinnedCrossArg.json.result.content[0].text).toContain("forbidden")
            expect(h.forwardCalls.length).toBe(beforeCalls)

            // Ops repo fencing: Smithers-Ops is hidden from tools/list and returns not_found even for deployment admin.
            const opsList = yield* h.postMcp(opsMcp, { jsonrpc: "2.0", id: 13, method: "tools/list" }, opsAdmin.bearer)
            expect((opsList.json.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("plan_tree_read")
            const opsRead = yield* h.postMcp(opsMcp, {
              jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, opsAdmin.bearer)
            expect(opsRead.json.result.isError).toBe(true)
            expect(opsRead.json.result.content[0].text).toContain("not_found")
            const opsWrite = yield* h.postMcp(opsMcp, {
              jsonrpc: "2.0", id: 15, method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("ops", "Ops") } },
            }, opsAdmin.bearer)
            expect(opsWrite.json.result.isError).toBe(true)
            expect(opsWrite.json.result.content[0].text).toContain("not_found")

            // Write on acme/alpha is isolated from acme/beta, and idempotency works end-to-end across retries + restarts.
            const firstAlpha = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: "same-rpc-id", method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("alpha-1", "Alpha Goal", 0) } },
            }, maintAlphaPinned.bearer)
            expect(firstAlpha.json.result.isError).toBeUndefined()
            const receipt1 = JSON.parse(firstAlpha.json.result.content[0].text)
            expect(receipt1.journalSeq).toBe(1)

            // Retry with same JSON-RPC id (default idempotency key) after DO restart returns identical receipt.
            h.hibernateAll()
            const retryAlpha = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: "same-rpc-id", method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("alpha-1", "Alpha Goal", 0) } },
            }, maintAlphaPinned.bearer)
            expect(JSON.parse(retryAlpha.json.result.content[0].text)).toEqual(receipt1)

            // Reuse same idempotency key with different command -> conflict!
            const conflictAlpha = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: "same-rpc-id", method: "tools/call",
              params: { name: "plan_tree_update", arguments: { command: upsertCmd("alpha-1", "Changed", 0) } },
            }, maintAlphaPinned.bearer)
            expect(conflictAlpha.json.result.isError).toBe(true)
            expect(conflictAlpha.json.result.content[0].text).toContain("conflict")

            // acme/beta shard remains completely empty (repo isolation!).
            const betaRead = yield* h.postMcp(betaMcp, {
              jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maintUnpinned.bearer)
            expect(JSON.parse(betaRead.json.result.content[0].text).nodes).toEqual([])

            // Person-only approval: MCP agent CANNOT set status to "done", while a real person via GuiAdapter CAN!
            const agentDone = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 17, method: "tools/call",
              params: {
                name: "plan_tree_update",
                arguments: {
                  idempotencyKey: "try-done",
                  command: { _tag: "SetNodeStatus", nodeId: "alpha-1", status: "done", expectedRevision: 1 },
                },
              },
            }, maintAlphaPinned.bearer)
            expect(agentDone.json.result.isError).toBe(true)
            expect(agentDone.json.result.content[0].text).toContain("person_only")

            // Verify node is still pending, then approve it as a person via GuiAdapter.hostStrip.press(plan/review).
            const beforePerson = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maintAlphaPinned.bearer)
            expect(JSON.parse(beforePerson.json.result.content[0].text).nodes[0].status).toBe("pending")

            h.hibernateAll()
            const alphaShard = planShardId("acme", "alpha")
            const personDb = openStorage(h.sqlitePathFor(alphaShard))
            try {
              const caps = [PlanTreeShard.readCapability(alphaShard), PlanTreeShard.writeCapability(alphaShard)]
              const creds = Principal.make({
                verify: Principal.sessions({
                  person: { kind: "gui", door: "person", subject: "p-maint", session: "person", capabilities: caps },
                  frame: { kind: "gui", door: "frame", plugin: "plan", subject: "p-maint", session: "frame", capabilities: caps },
                }, { plan: caps }),
              })
              const hub = yield* PlanTreeShard.make(personDb.storage, alphaShard, creds).pipe(Effect.provide(Reactivity.layer))
              const gui = yield* GuiAdapter.make({
                engine: hub.engine,
                frame: { session: "frame", plugin: "plan" },
                person: { session: "person" },
              })
              yield* gui.hostStrip.press(PlanTreeShard.review, {
                command: { _tag: "SetNodeStatus", nodeId: "alpha-1", status: "done", expectedRevision: 1 },
              })
            } finally {
              personDb.hibernate()
            }

            const afterPerson = yield* h.postMcp(alphaMcp, {
              jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maintAlphaPinned.bearer)
            expect(JSON.parse(afterPerson.json.result.content[0].text).nodes[0].status).toBe("done")
          }),
        ),
      )
    } finally {
      h.hibernateAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("validates bounds, maps shard errors and faults cleanly, and keeps secrets/payloads out of observability logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-e2e-faults-"))
    const h = makeTestHarness(dir)
    const maint = h.registerToken("f", {
      tokenId: "tok-fault",
      personId: "p-fault",
      login: "secret-login-name",
      repoScope: null,
      scopes: ["mcp:read", "mcp:write"],
    })
    h.setRole("p-fault", "acme/proj", "maintainer")
    const mcpPath = repoMcpRoute("acme", "proj")
    const capturedLogs: Array<string> = []
    const captureLogger = Logger.make((logOptions) => {
      capturedLogs.push(JSON.stringify(StructuredLogger.formatStructured.log(logOptions)))
    })

    const callUpdate = (args: Record<string, unknown>, id: string | number = 1) =>
      h.postMcp(mcpPath, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "plan_tree_update", arguments: args } }, maint.bearer)

    try {
      expect(PLAN_TREE_TOOL_NAMES).toEqual(["plan_tree_read", "plan_tree_update"])
      expect(PLAN_TREE_TOOL_DESCRIPTORS).toHaveLength(2)
      expect(isPlanTreeTool("plan_tree_read")).toBe(true)
      expect(isPlanTreeTool("plan_tree_update")).toBe(true)
      expect(isPlanTreeTool("plan_review")).toBe(false)
      expect(visibleDescriptors(Option.none(), "admin")).toEqual([])
      expect(visibleDescriptors(Option.some(maint.principal), "admin", { owner: "smithersai", name: "Smithers-Ops" }, h.policy)).toEqual([])

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Schema decode failure, explicit owner+repo on /api/mcp, partial owner on repo endpoint, and repository vs repo conflict.
            const badSchema = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 100, method: "tools/call",
              params: { name: "plan_tree_read", arguments: { owner: 123 } },
            }, maint.bearer)
            expect(badSchema.json.result.content[0].text).toContain("invalid_params")

            const explicitOwnerRepo = yield* h.postMcp("/api/mcp", {
              jsonrpc: "2.0", id: 101, method: "tools/call",
              params: { name: "plan_tree_read", arguments: { owner: "acme", repo: "proj" } },
            }, maint.bearer)
            expect(explicitOwnerRepo.json.result.isError).toBeUndefined()

            const partialOnRepo = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 102, method: "tools/call",
              params: { name: "plan_tree_read", arguments: { owner: "acme" } },
            }, maint.bearer)
            expect(partialOnRepo.json.result.content[0].text).toContain("invalid_params")

            const mismatchRepoName = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 103, method: "tools/call",
              params: { name: "plan_tree_read", arguments: { repository: "acme/proj", repo: "other" } },
            }, maint.bearer)
            expect(mismatchRepoName.json.result.content[0].text).toContain("invalid_params")

            // Unscoped /api/mcp without repo args -> invalid_params; conflicting repository vs owner -> invalid_params.
            const missingRepo = yield* h.postMcp("/api/mcp", {
              jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maint.bearer)
            expect(missingRepo.json.result.content[0].text).toContain("invalid_params")

            const mismatchRepo = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 2, method: "tools/call",
              params: { name: "plan_tree_read", arguments: { repository: "acme/proj", owner: "other" } },
            }, maint.bearer)
            expect(mismatchRepo.json.result.content[0].text).toContain("invalid_params")

            // Bound checks: empty title, control char, negative expectedRevision, too many sources, MovePlanNode/ToggleAssumption/AttachArtifact bounds.
            const baseUpsert = {
              _tag: "UpsertPlanNode", id: "n1", parent: null, title: "SENSITIVE_GOAL_TITLE_NEVER_LOG",
              milestone: "M0", sources: [], assumptions: [], dodFast: "", order: 0, expectedRevision: null,
            }
            for (const badCmd of [
              { ...baseUpsert, expectedRevision: -1 },
              { ...baseUpsert, id: "" },
              { ...baseUpsert, parent: "" },
              { ...baseUpsert, title: "" },
              { ...baseUpsert, sources: Array.from({ length: 101 }, (_, i) => `s${i}`) },
              { ...baseUpsert, sources: [""] },
              { ...baseUpsert, assumptions: Array.from({ length: 101 }, (_, i) => `a${i}`) },
              { ...baseUpsert, assumptions: ["bad\u0000text"] },
              { ...baseUpsert, dodFast: "a".repeat(1001) },
              { _tag: "MovePlanNode", id: "", newParent: null, order: 0, expectedRevision: null },
              { _tag: "MovePlanNode", id: "n1", newParent: "", order: 0, expectedRevision: null },
              { _tag: "ToggleAssumption", nodeId: "", index: 0, expectedRevision: null },
              { _tag: "ToggleAssumption", nodeId: "n1", index: -1, expectedRevision: null },
              { _tag: "SetNodeStatus", nodeId: "", status: "in_progress", expectedRevision: null },
              { _tag: "AttachArtifact", nodeId: "", artifactId: "a1", expectedRevision: null },
              { _tag: "AttachArtifact", nodeId: "n1", artifactId: "", expectedRevision: null },
            ]) {
              const res = yield* callUpdate({ command: badCmd })
              expect(res.json.result.isError).toBe(true)
              expect(res.json.result.content[0].text).toContain("invalid_params")
            }

            // Unpaired surrogate in JSON-RPC id when idempotencyKey omitted -> invalid_params.
            const badReqId = yield* Effect.flip(
              callPlanTreeTool(
                "plan_tree_update",
                { command: baseUpsert },
                { principal: Option.some(maint.principal), defaultRepo: { owner: "acme", name: "proj" }, requestId: "\ud800", origin: "https://smithers.sh" },
                { policy: h.policy, forward: h.forward },
                h.authService,
              ),
            )
            expect(badReqId.code).toBe("invalid_params")

            // Create node then exercise domain refusals: revision_mismatch -> conflict, parent_missing/node_missing -> not_found,
            // parent_mismatch -> invalid_params, duplicate AttachArtifact -> conflict (invalid_event_count).
            expect((yield* callUpdate({ idempotencyKey: "k-create", command: baseUpsert })).json.result.isError).toBeUndefined()
            const revMismatch = yield* callUpdate({ idempotencyKey: "k-rev", command: { ...baseUpsert, expectedRevision: 0 } })
            expect(revMismatch.json.result.content[0].text).toContain("conflict")
            const parentMissing = yield* callUpdate({
              idempotencyKey: "k-pm",
              command: { ...baseUpsert, id: "n2", parent: "nope" },
            })
            expect(parentMissing.json.result.content[0].text).toContain("not_found")
            const nodeMissing = yield* callUpdate({
              idempotencyKey: "k-nm",
              command: { _tag: "SetNodeStatus", nodeId: "nope", status: "failed", expectedRevision: null },
            })
            expect(nodeMissing.json.result.content[0].text).toContain("not_found")
            const parentMismatch = yield* callUpdate({
              idempotencyKey: "k-pmis",
              command: { ...baseUpsert, id: "n1", parent: "other" },
            })
            expect(parentMismatch.json.result.content[0].text).toContain("invalid_params")

            expect((yield* callUpdate({
              idempotencyKey: "k-move",
              command: { _tag: "MovePlanNode", id: "n1", newParent: null, order: 2, expectedRevision: null },
            })).json.result.isError).toBeUndefined()
            expect((yield* callUpdate({
              idempotencyKey: "k-art1",
              command: { _tag: "AttachArtifact", nodeId: "n1", artifactId: "art-1", expectedRevision: null },
            })).json.result.isError).toBeUndefined()
            const dupArtifact = yield* callUpdate({
              idempotencyKey: "k-art2",
              command: { _tag: "AttachArtifact", nodeId: "n1", artifactId: "art-1", expectedRevision: null },
            })
            expect(dupArtifact.json.result.content[0].text).toContain("conflict")

            // Injected faults on the shard forward seam map to clean typed errors.
            for (const [fault, expectedCode] of [
              ["defect", "unavailable"],
              ["http500", "unavailable"],
              ["http401", "authentication"],
              ["http403", "forbidden"],
              ["http413", "invalid_params"],
              ["bad-json", "unavailable"],
              ["rpc-error", "unavailable"],
              ["bad-read-shape", "unavailable"],
            ] as const) {
              h.setFaultMode(fault)
              const res = yield* h.postMcp(mcpPath, {
                jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
              }, maint.bearer)
              expect(res.json.result.isError).toBe(true)
              expect(res.json.result.content[0].text).toContain(expectedCode)
            }
            h.setFaultMode("bad-update-shape")
            const badUpdate = yield* callUpdate({
              idempotencyKey: "k-bad-shape",
              command: { _tag: "SetNodeStatus", nodeId: "n1", status: "in_progress", expectedRevision: null },
            })
            expect(badUpdate.json.result.content[0].text).toContain("unavailable")
            h.setFaultMode("none")

            // Unreadable response stream, malformed shard error content, empty rows fallback, and all shard error mappings.
            h.setCustomReply(() => HttpServerResponse.stream(Stream.fail(new Error("stream broken"))))
            const streamFail = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 110, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maint.bearer)
            expect(streamFail.json.result.content[0].text).toContain("unavailable")

            h.setCustomReply(() =>
              HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: { noCode: true } } }),
            )
            const badErrShape = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 111, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maint.bearer)
            expect(badErrShape.json.result.content[0].text).toContain("unavailable")

            for (const [structuredContent, expectedCode] of [
              [{ code: "person_only" }, "person_only"],
              [{ code: "wrong_operation" }, "person_only"],
              [{ code: "capability_exceeded" }, "forbidden"],
              [{ code: "invalid_command" }, "invalid_params"],
              [{ code: "invalid_idempotency_key", detail: "bad key" }, "invalid_params"],
              [{ code: "invalid_payload" }, "invalid_params"],
              [{ code: "some_unknown_error" }, "unavailable"],
            ] as const) {
              h.setCustomReply(() =>
                HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent } }),
              )
              const mapped = yield* h.postMcp(mcpPath, {
                jsonrpc: "2.0", id: 112, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
              }, maint.bearer)
              expect(mapped.json.result.isError).toBe(true)
              expect(mapped.json.result.content[0].text).toContain(expectedCode)
            }

            h.setCustomReply(() =>
              HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { structuredContent: { rows: [], cursor: "0" } } }),
            )
            const emptyRows = yield* h.postMcp(mcpPath, {
              jsonrpc: "2.0", id: 113, method: "tools/call", params: { name: "plan_tree_read", arguments: {} },
            }, maint.bearer)
            expect(emptyRows.json.result.isError).toBeUndefined()
            expect(JSON.parse(emptyRows.json.result.content[0].text).revision).toBe(0)
            h.setCustomReply(null)

            // OBS-5: logs recorded mcp.plan_tree events without leaking bearer token, login, or sensitive goal title.
            const allLogs = capturedLogs.join("\n")
            expect(allLogs).toContain("mcp.plan_tree")
            expect(allLogs).not.toContain(maint.bearer)
            expect(allLogs).not.toContain("secret-login-name")
            expect(allLogs).not.toContain("SENSITIVE_GOAL_TITLE_NEVER_LOG")
          }).pipe(Effect.provide(Logger.layer([captureLogger]))),
        ),
      )
    } finally {
      h.hibernateAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
