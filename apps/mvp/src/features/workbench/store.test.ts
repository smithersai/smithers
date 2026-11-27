import { CauseReceipt } from "@smthrs/app-core"
import { emptyPlanTree } from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { RepoStore } from "../repo/store.vibe"
import {
  applyPlanDelivery,
  applyPlanDeliveryEffect,
  planPullRoute,
  planShardId,
  planSnapshotRoute,
} from "./planContract"
import {
  PLAN_ROW_ID,
  planNodesFromTree,
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

const sampleCause = (seq: number, shard: string, blockId: string): CauseReceipt.CauseReceipt =>
  CauseReceipt.stamp({
    outputRef: `out/run-${seq}`,
    runId: `run-${seq}`,
    nodeId: "plan/update",
    attempt: 1,
    journalSeq: seq,
    planRef: { page: shard, blockId, rev: String(seq - 1) },
    promptHash: `hash-${seq}`,
  })

const snapshotJson = (shard: string, seq: number, state: unknown, epoch = 0) => ({
  position: { shard, epoch, seq },
  state,
})

const pageJson = (
  shard: string,
  entries: ReadonlyArray<{
    readonly seq: number
    readonly epoch: number
    readonly key: readonly [string, string]
    readonly stream: string
    readonly events: ReadonlyArray<unknown>
  }>,
  through: number,
  head: number,
  done = through === head,
  epoch = 0,
) => ({
  _tag: "Page",
  shard,
  epoch,
  entries,
  through,
  head,
  done,
})

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


  test("planSnapshotRoute and planPullRoute build canonical lowercase shard URLs", () => {
    expect(planSnapshotRoute("https://smithers.sh", "evmts", "voltaire")).toBe(
      "https://smithers.sh/api/repos/evmts/voltaire/plan/snapshot?shard=repo%3Aevmts%2Fvoltaire",
    )
    expect(planSnapshotRoute("https://smithers.sh", "SmithersAI", "Smithers")).toBe(
      "https://smithers.sh/api/repos/SmithersAI/Smithers/plan/snapshot?shard=repo%3Asmithersai%2Fsmithers",
    )
    const shard = planShardId("SmithersAI", "Smithers")
    expect(shard).toBe("repo:smithersai/smithers")
    expect(
      planPullRoute("https://smithers.sh", "SmithersAI", "Smithers", {
        version: 2,
        shard,
        epoch: 0,
        after: 0,
        limit: 256,
      }),
    ).toBe(
      "https://smithers.sh/api/repos/SmithersAI/Smithers/plan/pull?v=2&shard=repo%3Asmithersai%2Fsmithers&epoch=0&after=0&limit=256",
    )
  })

  test("applyPlanDelivery and applyPlanDeliveryEffect fold resets and entries identically", async () => {
    const shard = planShardId("smithersai", "smithers")
    const emptyReset = {
      _tag: "Reset" as const,
      snapshot: { position: { shard, epoch: 0, seq: 0 }, state: null },
    }
    expect(applyPlanDelivery(emptyPlanTree, emptyReset)).toEqual(emptyPlanTree)
    expect(await Effect.runPromise(applyPlanDeliveryEffect(emptyPlanTree, emptyReset))).toEqual(emptyPlanTree)

    const created = {
      event: {
        _tag: "PlanNodeCreated" as const,
        id: "goal-1",
        parent: null,
        title: "Ship cutover",
        milestone: "M0" as const,
        sources: ["docs/cutover.md"],
        assumptions: ["Tests green"],
        dodFast: "pnpm test",
        order: 0,
      },
      cause: sampleCause(1, shard, "goal-1"),
    }
    const entriesDelivery = {
      _tag: "Entries" as const,
      entries: [{ seq: 1, epoch: 0, key: ["plan", "run-1"] as [string, string], stream: shard, events: [created] }],
      through: { shard, epoch: 0, seq: 1 },
    }
    const syncTree = applyPlanDelivery(emptyPlanTree, entriesDelivery)
    const effTree = await Effect.runPromise(applyPlanDeliveryEffect(emptyPlanTree, entriesDelivery))
    expect(effTree).toEqual(syncTree)
    expect(effTree.nodes["goal-1"]?.title).toBe("Ship cutover")

    const stateReset = {
      _tag: "Reset" as const,
      snapshot: { position: { shard, epoch: 0, seq: 1 }, state: { tree: effTree, receipts: [created.cause] } },
    }
    expect(applyPlanDelivery(emptyPlanTree, stateReset)).toEqual(effTree)
    expect(await Effect.runPromise(applyPlanDeliveryEffect(emptyPlanTree, stateReset))).toEqual(effTree)
  })

  test("loadPlan reconstructs uncompacted goals from snapshot(state:null) + pull tail and handles 404/403", async () => {
    const shard = "repo:evmts/voltaire"
    let mode: "uncompacted" | "compacted-plus-tail" | "404" | "403" = "uncompacted"
    const cause1 = sampleCause(1, shard, "plan/root")
    const cause2 = sampleCause(2, shard, "plan/root")
    const cause3 = sampleCause(3, shard, "plan/child")
    const layer = Workbench.live({ origin: "https://smithers.sh" }).pipe(
      Layer.provideMerge(WorkbenchStore.layer),
      Layer.provide(
        httpLayer((request) => {
          if (mode === "404") return new Response("{}", { status: 404 })
          if (mode === "403") return new Response("{}", { status: 403 })
          const url = new URL(request.url)
          if (url.pathname.endsWith("/plan/snapshot")) {
            if (mode === "uncompacted") {
              return new Response(JSON.stringify(snapshotJson(shard, 0, null)), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            }
            return new Response(
              JSON.stringify(
                snapshotJson(shard, 2, {
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
                  receipts: [cause1, cause2],
                }),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          }
          if (mode === "uncompacted") {
            return new Response(
              JSON.stringify(
                pageJson(
                  shard,
                  [
                    {
                      seq: 1,
                      epoch: 0,
                      key: ["plan", "run-1"],
                      stream: shard,
                      events: [
                        {
                          event: {
                            _tag: "PlanNodeCreated",
                            id: "plan/root",
                            parent: null,
                            title: "Smithers release",
                            milestone: "M0",
                            sources: [".smithers/plan-tree/INDEX.md"],
                            assumptions: [],
                            dodFast: "fast-check",
                            order: 0,
                          },
                          cause: cause1,
                        },
                      ],
                    },
                    {
                      seq: 2,
                      epoch: 0,
                      key: ["plan", "run-2"],
                      stream: shard,
                      events: [
                        {
                          event: { _tag: "NodeStatusSet", id: "plan/root", status: "in_progress" },
                          cause: cause2,
                        },
                      ],
                    },
                  ],
                  2,
                  2,
                ),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          }
          return new Response(
            JSON.stringify(
              pageJson(
                shard,
                [
                  {
                    seq: 3,
                    epoch: 0,
                    key: ["plan", "run-3"],
                    stream: shard,
                    events: [
                      {
                        event: {
                          _tag: "PlanNodeCreated",
                          id: "plan/child",
                          parent: "plan/root",
                          title: "Ship MCP tools",
                          milestone: "M1",
                          sources: ["worker/mcp/PlanTreeTools.vibe"],
                          assumptions: ["Scoped roles enforced"],
                          dodFast: "vitest",
                          order: 1,
                        },
                        cause: cause3,
                      },
                    ],
                  },
                ],
                3,
                3,
              ),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workbench = yield* Workbench
          const store = yield* WorkbenchStore

          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          const uncompacted = store.plan.tanstack.get(PLAN_ROW_ID)
          expect(uncompacted?.status).toBe("ready")
          expect(uncompacted?.totalFrames).toBe(3)
          expect(uncompacted?.nodes).toHaveLength(1)
          expect(uncompacted?.nodes[0]).toMatchObject({
            id: "plan/root",
            title: "Smithers release",
            status: "in_progress",
          })

          mode = "compacted-plus-tail"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          const combined = store.plan.tanstack.get(PLAN_ROW_ID)
          expect(combined?.status).toBe("ready")
          expect(combined?.totalFrames).toBe(4)
          expect(combined?.nodes.map((n) => [n.id, n.depth])).toEqual([
            ["plan/root", 0],
            ["plan/child", 1],
          ])

          mode = "404"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("empty")

          mode = "403"
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

  test("loadPlan handles 401, 500, invalid snapshot/json/shard/entry, empty null-state, empty tree, resync, runaway resync, transport failure, and timeout", async () => {
    const shard = "repo:evmts/voltaire"
    const cause1 = sampleCause(1, shard, "r1")
    type Mode =
      | "401"
      | "500"
      | "invalid-json"
      | "invalid-schema"
      | "wrong-shard"
      | "wrong-pull-shard"
      | "invalid-entry"
      | "null-state"
      | "empty-tree"
      | "multi-page"
      | "resync-ok"
      | "resync-wrong-shard"
      | "resync-loop"
      | "transport"
      | "timeout"
    let mode: Mode = "401"
    let resyncCount = 0
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        if (mode === "transport") {
          return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
        }
        if (mode === "timeout") return Effect.never
        if (mode === "401") return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 401 })))
        if (mode === "500") return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 500 })))
        if (mode === "invalid-json") {
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("not-json{", { status: 200 })))
        }
        const url = new URL(request.url)
        const isSnap = url.pathname.endsWith("/plan/snapshot")
        if (mode === "invalid-schema") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ hubSeq: 1, state: null }), { status: 200 })),
          )
        }
        if (mode === "wrong-shard") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(snapshotJson("repo:other/repo", 0, null)), { status: 200 }),
            ),
          )
        }
        if (mode === "wrong-pull-shard") {
          const payload = isSnap
            ? snapshotJson(shard, 0, null)
            : pageJson("repo:other/repo", [], 0, 0)
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
        }
        if (mode === "invalid-entry") {
          const payload = isSnap
            ? snapshotJson(shard, 0, null)
            : pageJson(shard, [{ seq: 1, epoch: 0, key: ["plan", "run-1"], stream: shard, events: [{ bad: true }] }], 1, 1)
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
        }
        if (mode === "null-state") {
          const payload = isSnap ? snapshotJson(shard, 0, null) : pageJson(shard, [], 0, 0)
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
        }
        if (mode === "empty-tree") {
          const payload = isSnap
            ? snapshotJson(shard, 2, { tree: { revision: 0, nodes: {} }, receipts: [] })
            : pageJson(shard, [], 2, 2)
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
        }
        if (mode === "multi-page") {
          if (isSnap) {
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(snapshotJson(shard, 0, null)), { status: 200 })))
          }
          const after = Number(url.searchParams.get("after") ?? "0")
          if (after === 0) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify(
                    pageJson(
                      shard,
                      [
                        {
                          seq: 1,
                          epoch: 0,
                          key: ["plan", "run-p1"],
                          stream: shard,
                          events: [
                            {
                              event: {
                                _tag: "PlanNodeCreated",
                                id: "p1",
                                parent: null,
                                title: "Page one goal",
                                milestone: "M0",
                                sources: [],
                                assumptions: [],
                                dodFast: "",
                                order: 0,
                              },
                              cause: cause1,
                            },
                          ],
                        },
                      ],
                      1,
                      2,
                      false,
                    ),
                  ),
                  { status: 200 },
                ),
              ),
            )
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify(
                  pageJson(
                    shard,
                    [
                      {
                        seq: 2,
                        epoch: 0,
                        key: ["plan", "run-p2"],
                        stream: shard,
                        events: [
                          {
                            event: {
                              _tag: "PlanNodeCreated",
                              id: "p2",
                              parent: "p1",
                              title: "Page two goal",
                              milestone: "M1",
                              sources: [],
                              assumptions: [],
                              dodFast: "",
                              order: 0,
                            },
                            cause: cause1,
                          },
                        ],
                      },
                    ],
                    2,
                    2,
                    true,
                  ),
                ),
                { status: 200 },
              ),
            ),
          )
        }
        if (mode === "resync-ok") {
          if (isSnap) {
            const payload = resyncCount === 0
              ? snapshotJson(shard, 0, null, 0)
              : snapshotJson(shard, 1, {
                  tree: {
                    revision: 1,
                    nodes: {
                      r1: {
                        id: "r1",
                        parent: null,
                        title: "After resync",
                        milestone: "M1",
                        status: "pending",
                        sources: [],
                        assumptions: [],
                        dodFast: "",
                        artifactIds: [],
                        order: 0,
                      },
                    },
                  },
                  receipts: [cause1],
                }, 1)
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
          }
          if (resyncCount === 0) {
            resyncCount += 1
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ _tag: "Resync", shard, epoch: 1, snapshotSeq: 1 }), { status: 200 }),
              ),
            )
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(pageJson(shard, [], 1, 1, true, 1)), { status: 200 })),
          )
        }
        if (mode === "resync-wrong-shard") {
          if (isSnap) {
            const payload = resyncCount === 0 ? snapshotJson(shard, 0, null, 0) : snapshotJson("repo:other/repo", 1, null, 1)
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
          }
          resyncCount += 1
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ _tag: "Resync", shard, epoch: 1, snapshotSeq: 1 }), { status: 200 }),
            ),
          )
        }
        // resync-loop: server keeps asking for Resync forever; client bounds request count.
        const payload = isSnap ? snapshotJson(shard, 0, null, 0) : { _tag: "Resync", shard, epoch: 1, snapshotSeq: 0 }
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload), { status: 200 })))
      }),
    )

    const layer = Workbench.live({ origin: "https://smithers.sh", within: "100 millis" }).pipe(
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

          mode = "invalid-json"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "invalid-schema"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "wrong-shard"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "wrong-pull-shard"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "invalid-entry"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "null-state"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("empty")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBeNull()

          mode = "empty-tree"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("empty")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.totalFrames).toBe(3)

          mode = "multi-page"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("ready")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.nodes.map((n) => n.title)).toEqual(["Page one goal", "Page two goal"])
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.totalFrames).toBe(3)

          mode = "resync-ok"
          resyncCount = 0
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("ready")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.nodes[0]?.title).toBe("After resync")

          mode = "resync-wrong-shard"
          resyncCount = 0
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("invalid_snapshot")

          mode = "resync-loop"
          yield* Effect.promise(() => workbench.actions.loadPlan("evmts", "voltaire"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.status).toBe("failed")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.error).toBe("unavailable")

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

  test("stale earlier loadPlan response cannot overwrite a newer repository load", async () => {
    const releaseSlow = Deferred.makeUnsafe<void>()
    const slowShard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:acme/slow")
    const fastShard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:acme/fast")
    const client = Layer.succeed(WorkbenchClient, {
      fetchPlan: (_owner, repo) =>
        repo === "slow"
          ? Effect.andThen(
              Deferred.await(releaseSlow),
              Effect.succeed({
                position: { shard: slowShard, epoch: 0, seq: 1 },
                tree: {
                  revision: 1,
                  nodes: {
                    old: {
                      id: "old",
                      parent: null,
                      title: "Stale slow repo goal",
                      milestone: "M0" as const,
                      status: "pending" as const,
                      sources: [],
                      assumptions: [],
                      dodFast: "",
                      artifactIds: [],
                      order: 0,
                    },
                  },
                },
              }),
            )
          : Effect.succeed({
              position: { shard: fastShard, epoch: 0, seq: 2 },
              tree: {
                revision: 1,
                nodes: {
                  fresh: {
                    id: "fresh",
                    parent: null,
                    title: "Current fast repo goal",
                    milestone: "M1" as const,
                    status: "in_progress" as const,
                    sources: [],
                    assumptions: [],
                    dodFast: "",
                    artifactIds: [],
                    order: 0,
                  },
                },
              },
            }),
      joinWaitlist: () => Effect.succeed({ position: 1 }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workbench = yield* Workbench
          const store = yield* WorkbenchStore
          const slowFiber = yield* Effect.forkChild(Effect.promise(() => workbench.actions.loadPlan("acme", "slow")))
          yield* Effect.yieldNow
          yield* Effect.promise(() => workbench.actions.loadPlan("acme", "fast"))
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.nodes[0]?.title).toBe("Current fast repo goal")

          yield* Deferred.succeed(releaseSlow, undefined)
          yield* Fiber.join(slowFiber)
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.repoSlug).toBe("acme/fast")
          expect(store.plan.tanstack.get(PLAN_ROW_ID)?.nodes[0]?.title).toBe("Current fast repo goal")
        }).pipe(Effect.provide(Workbench.layer.pipe(Layer.provideMerge(WorkbenchStore.layer), Layer.provide(client)))),
      ),
    )
  })

  test("saves and restores distinct pane state and drafts per conversation across A -> B -> Back", async () => {
    const shard = planShardId("evmts", "voltaire")
    const wb = await Effect.runPromise(
      Effect.scoped(
        Workbench.pipe(
          Effect.provide(Workbench.layer),
          Effect.provide(
            Layer.succeed(WorkbenchClient, {
              fetchPlan: () => Effect.succeed({ position: { shard, epoch: 0, seq: 1 }, tree: null }),
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
    const shard = "repo:acme/private"
    const body = snapshotJson(shard, 1, {
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
      receipts: [sampleCause(1, shard, "root")],
    })
    const layer = Workbench.live({ origin: "https://smithers.sh" }).pipe(
      Layer.provideMerge(WorkbenchStore.layer.pipe(Layer.provide(repos))),
      Layer.provide(
        httpLayer((request) => {
          const url = new URL(request.url)
          const payload = url.pathname.endsWith("/plan/snapshot") ? body : pageJson(shard, [], 1, 1)
          return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
        }),
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
