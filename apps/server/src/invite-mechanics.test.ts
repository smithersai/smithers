import { describe, expect, test } from "bun:test"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

/**
 * End-to-end coverage of the invite path (readiness audit §7.9): a
 * signed-in, non-allowlisted user issues auth.request-access, an admin
 * reads and approves the queue entry, and the SAME login then passes the
 * allowlist gate on a real gated route. Every other apps/server test fakes
 * one route at a time with a static fixture; this file fakes the identity
 * worker STATEFULLY (a request queue + an allowlist set that the admin
 * write actually mutates) so the three steps prove they compose, not just
 * that each one individually parses.
 */

const assetsEnv = (): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) }
})

const ndjsonUpstream = (lines: ReadonlyArray<unknown>): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  )

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://mvp.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  })

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`https://mvp.test${path}`, { headers })

interface FakeSession {
  readonly login: string
  readonly admin: boolean
}

/**
 * A minimal stateful stand-in for the identity worker (a sibling deployment
 * outside this repo — apps/server only proxies to it). It models exactly the
 * three pieces of contract the invite path depends on: session validation by
 * cookie, a request-access queue, and an allowlist set that admin writes
 * mutate — enough to prove the wiring end to end without claiming to be the
 * real identity worker's full behavior.
 */
const identityDouble = (sessions: Record<string, FakeSession>, initiallyAllowlisted: ReadonlyArray<string> = []) => {
  const allowlist = new Set(initiallyAllowlisted)
  const queue: Array<{ login: string; note: string | null; createdAt: string }> = []
  const sessionFor = (request: Request): FakeSession | undefined => {
    const cookie = request.headers.get("cookie") ?? ""
    for (const [token, session] of Object.entries(sessions)) {
      if (cookie.includes(token)) return session
    }
    return undefined
  }

  const handle = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url)
    if (url.hostname !== "identity.test") return undefined

    if (url.pathname === "/api/identity/validate") {
      const session = sessionFor(request)
      if (session === undefined) {
        return new Response(JSON.stringify({ status: "error" }), { status: 401 })
      }
      return new Response(
        JSON.stringify({
          login: session.login,
          allowlisted: allowlist.has(session.login),
          admin: session.admin,
          scopes: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }

    if (url.pathname === "/api/identity/request-access" && request.method === "POST") {
      const session = sessionFor(request)
      if (session === undefined) return new Response(JSON.stringify({ status: "error" }), { status: 401 })
      queue.push({ login: session.login, note: null, createdAt: "2026-08-16T00:00:00.000Z" })
      return new Response(JSON.stringify({ status: "requested" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }

    if (url.pathname === "/api/identity/admin/requests" && request.method === "GET") {
      return new Response(JSON.stringify({ requests: queue }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }

    if (url.pathname === "/api/identity/admin/allowlist" && request.method === "POST") {
      const body = (await request.json()) as { login: string; action: "add" | "remove" }
      if (body.action === "add") allowlist.add(body.login)
      else allowlist.delete(body.login)
      return new Response(
        JSON.stringify({
          applied: true,
          action: body.action,
          login: body.login,
          requester: sessionFor(request)?.login
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    }

    return undefined
  }

  return { handle, allowlist, queue }
}

describe("invite mechanics: request-access -> admin approval -> allowlist gate", () => {
  const env: WorkerEnv = {
    ...assetsEnv(),
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "service-token-123",
    IDENTITY_ADMIN_TOKEN: "identity-admin-123",
    SMITHERS_CHAT_URL: "https://upstream.test/chat"
  }

  const withDouble = async <T>(
    double: ReturnType<typeof identityDouble>,
    run: () => Promise<T>,
    nonIdentityAnswer: (request: Request) => Response = () => ndjsonUpstream([{ type: "done" }])
  ): Promise<T> => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      const mocked = await double.handle(request)
      if (mocked !== undefined) return mocked
      return nonIdentityAnswer(request)
    }) as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  test("the full path: request-access queues the login, admin approval allowlists it, and the same session then passes the gate", async () => {
    // The admin is allowlisted, as every real admin is: the surface requires
    // BOTH claims now, so de-allowlisting one revokes it (repro access/1.5).
    const double = identityDouble(
      {
        "admin-session": { login: "will", admin: true },
        "stranger-session": { login: "octocat", admin: false }
      },
      ["will"]
    )

    await withDouble(double, async () => {
      // 1. octocat is signed in but not allowlisted: a gated route refuses them.
      const beforeTurn = await worker.fetch(
        post("/api/agent/turn", { runId: "r1", messages: [], instructions: "hi" }, {
          cookie: "smithers_session=stranger-session"
        }),
        env
      )
      expect(beforeTurn.status).toBe(403)

      // 2. octocat issues auth.request-access.
      const requestAccess = await worker.fetch(
        post("/api/identity/request-access", {}, { cookie: "smithers_session=stranger-session" }),
        env
      )
      expect(requestAccess.status).toBe(200)
      expect(double.queue.map((r) => r.login)).toEqual(["octocat"])

      // 3. The admin reads the queue and sees the request.
      const queueRead = await worker.fetch(
        get("/api/admin/requests", { cookie: "smithers_session=admin-session" }),
        env
      )
      expect(queueRead.status).toBe(200)
      const queueBody = (await queueRead.json()) as { requests: Array<{ login: string }> }
      expect(queueBody.requests.map((r) => r.login)).toEqual(["octocat"])

      // 4. The admin approves — exactly an allowlist add, attributed to the admin.
      const approve = await worker.fetch(
        post("/api/admin/allowlist", { login: "octocat", action: "add" }, { cookie: "smithers_session=admin-session" }),
        env
      )
      expect(approve.status).toBe(201)
      expect(double.allowlist.has("octocat")).toBe(true)

      // 5. octocat's session — same cookie, no new sign-in — now passes the gate.
      const afterTurn = await worker.fetch(
        post("/api/agent/turn", { runId: "r2", messages: [], instructions: "hi" }, {
          cookie: "smithers_session=stranger-session"
        }),
        env
      )
      expect(afterTurn.status).toBe(200)
      expect(await afterTurn.text()).toContain("\"type\":\"done\"")
    })
  })

  test("a non-admin cannot approve their own request: the allowlist write 404s, byte-identical to an unknown route", async () => {
    const double = identityDouble({ "stranger-session": { login: "octocat", admin: false } })

    await withDouble(double, async () => {
      await worker.fetch(post("/api/identity/request-access", {}, { cookie: "smithers_session=stranger-session" }), env)

      const selfApprove = await worker.fetch(
        post("/api/admin/allowlist", { login: "octocat", action: "add" }, {
          cookie: "smithers_session=stranger-session"
        }),
        env
      )
      const unknown = await worker.fetch(
        get("/api/definitely-not-a-route", { cookie: "smithers_session=stranger-session" }),
        env
      )
      expect(selfApprove.status).toBe(404)
      expect(await selfApprove.text()).toBe(await unknown.text())
      expect(double.allowlist.has("octocat")).toBe(false)
    })
  })

  /*
   * Repro apps/app/canary-repros/access/1.5: removing a login from the
   * allowlist has to revoke the ADMIN surface too. It did not — `admin` rides
   * ADMIN_LOGINS, so a revoked admin kept every /api/admin/* route, the
   * allowlist editor included, and could simply put itself back.
   */
  /*
   * The other half of that rule: because the allowlist is what carries admin,
   * a self-removal is a ONE-WAY door — it revokes the caller's own claim, and
   * this route is the only door that could restore it. The first admin to try
   * would lock the alpha out of its own product.
   */
  test("an admin cannot remove its own login, and the refusal names the route that works", async () => {
    const double = identityDouble({ "admin-session": { login: "will", admin: true } }, ["will"])

    await withDouble(double, async () => {
      for (const login of ["will", "WILL"]) {
        const selfRemove = await worker.fetch(
          post("/api/admin/allowlist", { login, action: "remove" }, { cookie: "smithers_session=admin-session" }),
          env
        )
        expect(selfRemove.status).toBe(409)
        const body = (await selfRemove.json()) as { message: string }
        expect(body.message).toContain("your own login")
        expect(body.message).toContain("admin token")
        expect(double.allowlist.has("will")).toBe(true)
      }
      // Removing SOMEONE ELSE is still the ordinary admin write.
      double.allowlist.add("octocat")
      const other = await worker.fetch(
        post("/api/admin/allowlist", { login: "octocat", action: "remove" }, {
          cookie: "smithers_session=admin-session"
        }),
        env
      )
      expect(other.status).toBe(201)
      expect(double.allowlist.has("octocat")).toBe(false)
    })
  })

  test("removing an admin from the allowlist revokes the admin surface, editor first", async () => {
    const double = identityDouble({ "admin-session": { login: "will", admin: true } }, ["will"])

    await withDouble(double, async () => {
      expect(
        (await worker.fetch(get("/api/admin/requests", { cookie: "smithers_session=admin-session" }), env)).status
      ).toBe(200)

      double.allowlist.delete("will")

      const unknown = await worker.fetch(get("/api/definitely-not-a-route"), env)
      const canonical = await unknown.text()
      const afterRead = await worker.fetch(
        get("/api/admin/requests", { cookie: "smithers_session=admin-session" }),
        env
      )
      expect(afterRead.status).toBe(404)
      expect(await afterRead.text()).toBe(canonical)

      const selfRestore = await worker.fetch(
        post("/api/admin/allowlist", { login: "will", action: "add" }, { cookie: "smithers_session=admin-session" }),
        env
      )
      expect(selfRestore.status).toBe(404)
      expect(double.allowlist.has("will")).toBe(false)
    })
  })

  test("removing a login from the allowlist revokes the gate immediately", async () => {
    const double = identityDouble(
      { "admin-session": { login: "will", admin: true }, "member-session": { login: "octocat", admin: false } },
      ["octocat", "will"]
    )

    await withDouble(double, async () => {
      const beforeRemove = await worker.fetch(
        post("/api/agent/turn", { runId: "r1", messages: [], instructions: "hi" }, {
          cookie: "smithers_session=member-session"
        }),
        env
      )
      expect(beforeRemove.status).toBe(200)

      const remove = await worker.fetch(
        post("/api/admin/allowlist", { login: "octocat", action: "remove" }, {
          cookie: "smithers_session=admin-session"
        }),
        env
      )
      expect(remove.status).toBe(201)

      const afterRemove = await worker.fetch(
        post("/api/agent/turn", { runId: "r2", messages: [], instructions: "hi" }, {
          cookie: "smithers_session=member-session"
        }),
        env
      )
      expect(afterRemove.status).toBe(403)
    })
  })
})
