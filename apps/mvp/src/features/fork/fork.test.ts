import { Effect, Layer, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { afterEach, describe, expect, test } from "vitest"
import { forkRoute, githubForkUrl, syncUpstreamRoute, upstreamCompareUrl } from "./contract"
import { Fork, forkKey } from "./store.vibe"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const rt of runtimes.splice(0).reverse()) await rt.dispose()
})

describe("fork contract", () => {
  test("builds canonical keys, API routes, GitHub fork URL, and upstream compare PR URL", () => {
    expect(forkKey("SmithersAI", "Smithers")).toBe("smithersai/smithers")
    expect(forkRoute("smithersai", "smithers")).toBe("/api/repos/smithersai/smithers/fork")
    expect(syncUpstreamRoute("alice", "smithers")).toBe("/api/repos/alice/smithers/sync-upstream")
    expect(githubForkUrl("smithersai", "smithers")).toBe("https://github.com/smithersai/smithers/fork")
    expect(upstreamCompareUrl("smithersai", "smithers", "main", "alice", "fix-bug")).toBe(
      "https://github.com/smithersai/smithers/compare/main...alice:fix-bug?expand=1",
    )
  })
})

describe("Fork browser store", () => {
  const makeForkStore = (
    handler: (req: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => ReturnType<Parameters<typeof HttpClient.make>[0]>,
    opened?: Array<string>,
  ) => {
    const http = HttpClient.make(handler)
    const rt = ManagedRuntime.make(
      Fork.live({
        origin: "https://smithers.sh",
        within: "5 seconds",
        ...(opened === undefined ? {} : { openExternal: (url) => opened.push(url) }),
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
    )
    runtimes.push(rt)
    return rt.runPromise(Fork)
  }

  test("loads fork state, starts a fork, and syncs upstream", async () => {
    const view = await makeForkStore((req) => {
      if (req.method === "GET" && req.url.endsWith(forkRoute("smithersai", "smithers"))) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({ status: "none", installUrl: "https://github.com/apps/smithers/installations/new" }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      if (req.method === "POST" && req.url.endsWith(forkRoute("smithersai", "smithers"))) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({
                forkId: "f-1",
                status: "forking",
                forkOwner: "alice",
                forkName: "smithers",
                installUrl: "https://github.com/apps/smithers/installations/new",
              }),
              { status: 202, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      if (req.method === "POST" && req.url.endsWith(syncUpstreamRoute("alice", "smithers"))) {
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
    await view.queries.all.preload()
    await view.actions.load("smithersai", "smithers")
    expect(view.queries.all.get("smithersai/smithers")?.status).toBe("none")

    await view.actions.fork("smithersai", "smithers")
    const afterFork = view.queries.all.get("smithersai/smithers")
    expect(afterFork?.status).toBe("forking")
    expect(afterFork?.forkOwner).toBe("alice")

    await view.actions.syncUpstream("alice", "smithers", "main")
    expect(view.queries.all.get("alice/smithers")?.syncMessage).toBe("Fast-forwarded main.")
  })

  test("handles 503 GitHub fallback, conflicts, invalid JSON, and network failures", async () => {
    const opened: Array<string> = []
    let mode: "503" | "400" | "409" | "500" | "badjson" | "badschema" | "200nonjson" | "net" = "503"
    const view = await makeForkStore((req) => {
      if (mode === "net") {
        return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req, cause: new Error("offline") }) }))
      }
      if (mode === "503") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 503 })))
      if (mode === "400") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 400 })))
      if (mode === "409") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 409 })))
      if (mode === "500") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 500 })))
      if (mode === "badjson") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not-json", { status: 200 })))
      if (mode === "200nonjson") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 })))
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ nope: true }), { status: 200 })))
    }, opened)
    await view.queries.all.preload()

    // load error paths are silent no-ops
    for (const m of ["500", "badjson", "badschema", "net"] as const) {
      mode = m
      await view.actions.load("smithersai", "smithers")
    }
    expect(view.queries.all.get("smithersai/smithers")).toBeUndefined()

    // fork 503 falls back to GitHub fork URL
    mode = "503"
    await view.actions.fork("smithersai", "smithers")
    expect(opened).toEqual(["https://github.com/smithersai/smithers/fork"])

    mode = "400"
    await view.actions.fork("smithersai", "smithers")
    expect(view.queries.all.get("smithersai/smithers")?.failure).toContain("Couldn't fork")

    mode = "badjson"
    await view.actions.fork("smithersai", "smithers")
    expect(view.queries.all.get("smithersai/smithers")?.failure).toContain("Unexpected")

    mode = "badschema"
    await view.actions.fork("smithersai", "smithers")
    expect(view.queries.all.get("smithersai/smithers")?.failure).toContain("Unexpected")

    mode = "net"
    await view.actions.fork("smithersai", "smithers")
    expect(view.queries.all.get("smithersai/smithers")?.failure).toContain("Couldn't reach")

    // syncUpstream error & fallback paths
    mode = "409"
    await view.actions.syncUpstream("alice", "smithers")
    expect(view.queries.all.get("alice/smithers")?.syncMessage).toContain("Merge conflict")

    mode = "500"
    await view.actions.syncUpstream("alice", "smithers")
    expect(view.queries.all.get("alice/smithers")?.syncMessage).toContain("Couldn't sync")

    mode = "net"
    await view.actions.syncUpstream("alice", "smithers")
    expect(view.queries.all.get("alice/smithers")?.syncMessage).toContain("Couldn't reach")

    mode = "200nonjson"
    await view.actions.syncUpstream("alice", "smithers")
    expect(view.queries.all.get("alice/smithers")?.syncMessage).toBe("Synced with upstream.")
  })
})
