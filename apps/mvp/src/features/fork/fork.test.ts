import { Effect, Layer, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { afterEach, describe, expect, test } from "vitest"
import { forkRoute, githubForkUrl, syncUpstreamRoute, upstreamCompareUrl } from "./contract"
import { Fork, forkKey } from "./store.vibe"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const rt of runtimes.splice(0).reverse()) await rt.dispose()
})

describe("fork contract & browser store", () => {
  test("builds encoded fork, sync, and cross-fork upstream PR URLs", () => {
    expect(forkRoute("smithersai", "smithers")).toBe("/api/repos/smithersai/smithers/fork")
    expect(syncUpstreamRoute("alice", "smithers")).toBe("/api/repos/alice/smithers/sync-upstream")
    expect(githubForkUrl("smithersai", "smithers")).toBe("https://github.com/smithersai/smithers/fork")
    expect(upstreamCompareUrl("smithersai", "smithers", "main", "alice", "feat")).toBe(
      "https://github.com/smithersai/smithers/compare/main...alice:feat?expand=1",
    )
  })

  test("loads fork state, forks repository, syncs upstream, and falls back to GitHub on 503", async () => {
    const opened: Array<string> = []
    let mode: "ok" | "not_configured" = "ok"
    const http = HttpClient.make((req) => {
      if (req.method === "GET" && req.url.endsWith("/fork")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({ status: "none", isFork: true, upstreamOwner: "smithersai", upstreamName: "smithers" }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      if (req.method === "POST" && req.url.endsWith("/fork")) {
        if (mode === "not_configured") {
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ code: "not_configured" }), { status: 503 })))
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({ forkId: "f-1", status: "forking", forkOwner: "alice", forkName: "smithers" }),
              { status: 202, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      if (req.method === "POST" && req.url.endsWith("/sync-upstream")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ synced: true, message: "Fast-forwarded main." }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 404 })))
    })

    const rt = ManagedRuntime.make(
      Fork.live({
        origin: "https://smithers.sh",
        within: "5 seconds",
        openExternal: (url) => opened.push(url),
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
    )
    runtimes.push(rt)
    const view = await rt.runPromise(Fork)

    await view.queries.all.preload()
    await view.actions.load("alice", "smithers")
    expect(view.queries.all.get(forkKey("alice", "smithers"))?.isFork).toBe(true)

    await view.actions.fork("smithersai", "smithers")
    expect(view.queries.all.get(forkKey("smithersai", "smithers"))).toMatchObject({
      status: "forking",
      forkOwner: "alice",
      forkName: "smithers",
    })

    await view.actions.syncUpstream("alice", "smithers", "main")
    expect(view.queries.all.get(forkKey("alice", "smithers"))?.syncMessage).toBe("Fast-forwarded main.")

    mode = "not_configured"
    await view.actions.fork("Effect-TS", "effect")
    expect(opened).toEqual(["https://github.com/Effect-TS/effect/fork"])
  })
})
