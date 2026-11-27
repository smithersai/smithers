import { Effect, Layer } from "effect"
import { RepoStore } from "../repo/store.vibe"
import { HttpClientError } from "effect/http"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import {
  PLAN_ROW_ID,
  planNodesFromTree,
  planSnapshotRoute,
  roleToAudience,
  WAITLIST_ROW_ID,
  Workbench,
  WorkbenchClient,
  WorkbenchStore,
} from "./store.vibe"

const httpLayer = (respond: (request: { readonly url: string; readonly method: string }) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)))),
  )

describe("workbench store and helpers", () => {
  test("planNodesFromTree orders siblings by order then id and computes hierarchy depth", () => {
    const nodes = planNodesFromTree({
      revision: 3,
      nodes: {
        "m0/b": {
          id: "m0/b",
          parent: "root",
          title: "Second child",
          milestone: "M0",
          status: "done",
          sources: ["docs/b.md"],
          assumptions: [{ text: "Verified check", verified: true }],
          dodFast: "vitest",
          artifactIds: [],
          order: 2,
        },
        root: {
          id: "root",
          parent: null,
          title: "Release root",
          milestone: "M0",
          status: "in_progress",
          sources: ["INDEX.md"],
          assumptions: [],
          dodFast: "fast-check",
          artifactIds: [],
          order: 0,
        },
        "m0/a": {
          id: "m0/a",
          parent: "root",
          title: "First child",
          milestone: "M0",
          status: "pending",
          sources: [],
          assumptions: [{ text: "Pending check", verified: false }],
          dodFast: "vitest",
          artifactIds: [],
          order: 1,
        },
      },
    })
    expect(nodes.map((n) => [n.id, n.depth])).toEqual([
      ["root", 0],
      ["m0/a", 1],
      ["m0/b", 1],
    ])
    expect(nodes[2]?.assumptions).toEqual([{ id: "m0/b#0", text: "Verified check", verified: true }])
  })

  test("roleToAudience clamps strictly downward", () => {
    expect(roleToAudience("admin")).toBe("maintainer")
    expect(roleToAudience("maintainer")).toBe("maintainer")
    expect(roleToAudience("member")).toBe("contributor")
    expect(roleToAudience("guest")).toBe("visitor")
    expect(roleToAudience(null)).toBe("visitor")
    expect(roleToAudience(undefined)).toBe("visitor")
  })


  test("planSnapshotRoute builds canonical repository shard URL", () => {
    expect(planSnapshotRoute("https://smithers.sh", "evmts", "voltaire")).toBe(
      "https://smithers.sh/api/repos/evmts/voltaire/plan/snapshot?shard=repo%3Aevmts%2Fvoltaire",
    )
  })

  test("loadPlan populates PlanRow from live snapshot and handles 404 and 403 honestly", async () => {
    let status = 200
    let body: unknown = {
      hubSeq: 4,
      state: {
        tree: {
          revision: 2,
          nodes: {
            "plan/root": {
              id: "plan/root",
              parent: null,
              title: "Smithers release",
              milestone: "M0",
              status: "in_progress",
              sources: [".smithers/plan-tree/INDEX.md"],
              assumptions: [],
              dodFast: "fast-check",
              artifactIds: [],
              order: 0,
            },
          },
        },
      },
    }
    const layer = Workbench.live({ origin: "https://smithers.sh" }).pipe(
      Layer.provideMerge(WorkbenchStore.layer),
      Layer.provide(
        httpLayer(() => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workbench = yield* Workbench
          const store = yield* WorkbenchStore
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          const ready = store.plan.tanstack.get(PLAN_ROW_ID)
          expect(ready?.status).toBe("ready")
          expect(ready?.totalFrames).toBe(5)
          expect(ready?.nodes).toHaveLength(1)

          status = 404
          body = {}
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("empty")

          status = 403
          yield* Effect.promise(() => workbench.actions.loadPlan("smithersai", "Smithers-Ops"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("failed")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("forbidden")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("waitlist submit updates the local collection", async () => {
    let waitlistStatus = 200
    let waitlistBody: unknown = { status: "submitted", repoUrl: "https://github.com/evmts/voltaire", position: 12 }
    const layer = Workbench.live({ origin: "https://smithers.sh" }).pipe(
      Layer.provideMerge(WorkbenchStore.layer),
      Layer.provide(
        httpLayer(() =>
          new Response(JSON.stringify(waitlistBody), {
            status: waitlistStatus,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workbench = yield* Workbench
          const store = yield* WorkbenchStore


          workbench.actions.setWaitlistRepoUrl("https://github.com/evmts/voltaire")
          workbench.actions.setWaitlistWorkflowNote(".smithers/workflows/ci.vibe")
          yield* Effect.promise(() => workbench.actions.submitWaitlist())
          expect(store.waitlist.tanstack.get(WAITLIST_ROW_ID)?.status).toBe("submitted")
          expect(store.waitlist.tanstack.get(WAITLIST_ROW_ID)?.position).toBe(12)

          waitlistStatus = 429
          waitlistBody = { error: "rate_limited" }
          yield* Effect.promise(() => workbench.actions.submitWaitlist())
          expect(store.waitlist.tanstack.get(WAITLIST_ROW_ID)?.status).toBe("error")
          expect(store.waitlist.tanstack.get(WAITLIST_ROW_ID)?.errorMessage).toContain("Too many requests")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})

describe("workbench store boundary and failure cases", () => {
  test("planNodesFromTree breaks cycles and sorts equal-order siblings by id", () => {
    const nodes = planNodesFromTree({
      revision: 1,
      nodes: {
        b: {
          id: "b",
          parent: "missing-parent",
          title: "B",
          milestone: "M0",
          status: "pending",
          sources: [],
          assumptions: [],
          dodFast: "fast",
          artifactIds: [],
          order: 1,
        },
        a: {
          id: "a",
          parent: null,
          title: "A",
          milestone: "M0",
          status: "pending",
          sources: [],
          assumptions: [],
          dodFast: "fast",
          artifactIds: [],
          order: 1,
        },
      },
    })
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"])
  })

  test("loadPlan handles 401, 500, invalid snapshot, empty tree, null state, transport failure, and timeout", async () => {
    let mode: "401" | "500" | "invalid" | "null-state" | "empty-tree" | "transport" | "timeout" = "401"
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        if (mode === "transport") {
          return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
        }
        if (mode === "timeout") {
          return Effect.never
        }
        if (mode === "401") return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 401 })))
        if (mode === "500") return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 500 })))
        if (mode === "invalid") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ nope: true }), { status: 200 })),
          )
        }
        if (mode === "null-state") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ hubSeq: 0, state: null }), { status: 200 })),
          )
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ hubSeq: 2, state: { tree: { revision: 0, nodes: {} } } }), { status: 200 }),
          ),
        )
      }),
    )

    const layer = Workbench.live({ origin: "https://smithers.sh", within: "20 millis" }).pipe(
      Layer.provideMerge(WorkbenchStore.layer),
      Layer.provide(clientLayer),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workbench = yield* Workbench
          const store = yield* WorkbenchStore

          mode = "401"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("sign_in_required")

          mode = "500"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("unavailable")

          mode = "invalid"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "null-state"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("empty")

          mode = "empty-tree"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("empty")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.totalFrames).toBe(3)

          mode = "transport"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("unavailable")

          mode = "timeout"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("timeout")

          // Blank workflowNote branch in submitWaitlistDraft
          workbench.actions.setWaitlistRepoUrl("https://github.com/evmts/voltaire")
          workbench.actions.setWaitlistWorkflowNote("   ")
          mode = "500"
          yield* Effect.promise(() => workbench.actions.submitWaitlist())
          expect(store.waitlist.tanstack.get(WAITLIST_ROW_ID)?.status).toBe("error")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("saves and restores distinct pane state and drafts per conversation across A -> B -> Back", async () => {
    const wb = await Effect.runPromise(
      Effect.scoped(
        Workbench.pipe(
          Effect.provide(Workbench.layer),
          Effect.provide(
            Layer.succeed(WorkbenchClient, {
              fetchPlan: () => Effect.succeed({ hubSeq: 1, tree: null }),
              joinWaitlist: () => Effect.succeed({ position: 1 }),
            }),
          ),
        ),
      ),
    )

    wb.actions.saveConversation(
      "evmts/voltaire",
      { pane: "diff", size: "side", frame: 3, audience: "maintainer", diffScope: "branch" },
      "Draft A",
      "conv-a",
    )
    wb.actions.saveConversation(
      "evmts/voltaire",
      { pane: "attach", size: "full", frame: "live", audience: "maintainer", diffScope: "turn" },
      "Draft B",
      "conv-b",
    )
    wb.actions.saveConversation(
      "evmts/voltaire",
      { pane: "workflow", size: "side", frame: 3, audience: "maintainer", diffScope: "branch" },
      undefined,
      "conv-a",
    )

    const backToA = wb.actions.restoreConversation("evmts/voltaire", {}, "maintainer", "conv-a")
    expect(backToA.layout.pane).toBe("workflow")
    expect(backToA.draft).toBe("Draft A")

    const atB = wb.actions.restoreConversation("evmts/voltaire", {}, "maintainer", "conv-b")
    expect(atB.layout.pane).toBe("attach")
    expect(atB.draft).toBe("Draft B")
  })

  // Will's wipe rule (repoStores.ts): a refusal on a repository wipes every store of its rows, the plan row included.
  test("a refusal on the repository the plan row holds returns it to idle; another repository's refusal keeps it", async () => {
    const wipes = new Map<string, (id: string) => Effect.Effect<void, unknown>>()
    const repos = Layer.succeed(RepoStore, {
      registerCache: (families: ReadonlyArray<string>, wipe: (id: string) => Effect.Effect<void, unknown>) =>
        Effect.sync(() => families.forEach((family) => wipes.set(family, wipe))),
    } as unknown as RepoStore["Service"])
    const body = {
      hubSeq: 1,
      state: {
        tree: {
          revision: 1,
          nodes: {
            root: {
              id: "root",
              parent: null,
              title: "Private plan",
              milestone: "M0",
              status: "pending",
              sources: [],
              assumptions: [],
              dodFast: "fast-check",
              artifactIds: [],
              order: 0,
            },
          },
        },
      },
    }
    const layer = Workbench.live({ origin: "https://smithers.sh" }).pipe(
      Layer.provideMerge(WorkbenchStore.layer.pipe(Layer.provide(repos))),
      Layer.provide(
        httpLayer(() => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workbench = yield* Workbench
          const store = yield* WorkbenchStore
          const wipe = wipes.get("workbench-plan")
          expect(wipe).toBeDefined()
          yield* Effect.promise(() => workbench.actions.loadPlan("Acme", "Private"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.nodes).toHaveLength(1)

          yield* wipe!("github/acme/other")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("ready")

          yield* wipe!("github/acme/private")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)).toMatchObject({
            id: PLAN_ROW_ID,
            repoSlug: "",
            status: "idle",
            nodes: [],
            totalFrames: 1,
            error: null,
          })
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})
