import { Effect, Layer } from "effect"
import { HttpClientError } from "effect/http"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import {
  ATTACH_ROW_ID,
  attachPromptFor,
  PLAN_ROW_ID,
  planNodesFromTree,
  planSnapshotRoute,
  roleToAudience,
  WAITLIST_ROW_ID,
  Workbench,
  WorkbenchStore,
} from "./store.ts"

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

  test("attachPromptFor produces zero-secret prompts without semicolons or em dashes", () => {
    const local = attachPromptFor("local-stdio", "https://smithers.sh", "evmts", "voltaire", "main")
    const remote = attachPromptFor("remote-http", "https://smithers.sh", "evmts", "voltaire", "main")
    expect(local).toContain("smthrs attach --repo evmts/voltaire --branch main")
    expect(remote).toContain("https://smithers.sh/api/attach/mcp/evmts/voltaire/main")
    expect(local).not.toMatch(/[;—]/)
    expect(remote).not.toMatch(/[;—]/)
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

  test("attach transport toggle and waitlist submit update local collections cleanly", async () => {
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

          workbench.actions.setTransport("remote-http")
          workbench.actions.markCopied()
          expect(store.attach.tanstack.get(ATTACH_ROW_ID)).toMatchObject({
            id: ATTACH_ROW_ID,
            mode: "remote-http",
            state: "unattached",
            copied: true,
          })

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
})
