import { describe, expect, spyOn, test } from "bun:test"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import {
  ANONYMOUS_ALL_CEILING,
  ANONYMOUS_ALL_KEY,
  ANONYMOUS_ALL_TURN_MAX,
  ANONYMOUS_CEILING,
  ANONYMOUS_TURN_MAX,
  anonymousBucketAddress,
  anonymousTurnKey,
  spendTurn,
  TURN_WINDOW_MAX,
  TURN_WINDOW_MS,
  turnLimitResponse,
  TurnRateLimiter
} from "./turnLimit"
import type { TurnBudget, TurnLimitNamespace, TurnLimitStorage } from "./turnLimit"

/*
 * The per-login turn ceiling. Chat is comped during the alpha, so the balance
 * is not a spend limit and nothing else bounds what one session can cost. These
 * tests hold the ceiling to being an ABUSE guard: it must be invisible to a
 * person, it must not read like a paywall when it does fire, and it must never
 * lock someone out because our own infrastructure hiccuped.
 */

const memoryStorage = (seed?: Record<string, unknown>): TurnLimitStorage => {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}))
  return {
    get: async (key) => data.get(key) as never,
    put: async (key, value) => void data.set(key, value)
  }
}

/**
 * A namespace of in-memory buckets. `spent` names logins whose budget is
 * already exhausted — seeding the window is how a route test reaches the
 * refusal without driving `TURN_WINDOW_MAX` real turns through the seam,
 * which would make the suite slower every time the ceiling rises.
 */
const memoryLimits = (
  spent: ReadonlyArray<string> = []
): TurnLimitNamespace & { readonly logins: () => Array<string> } => {
  const buckets = new Map<string, TurnRateLimiter>()
  const bucketFor = (name: string): TurnRateLimiter => {
    let bucket = buckets.get(name)
    if (bucket === undefined) {
      bucket = new TurnRateLimiter({
        storage: spent.includes(name)
          ? memoryStorage({ window: { start: Date.now(), count: TURN_WINDOW_MAX } })
          : memoryStorage()
      })
      buckets.set(name, bucket)
    }
    return bucket
  }
  return {
    logins: () => [...buckets.keys()],
    idFromName: (name) => name,
    get: (id) => ({ fetch: (request) => bucketFor(String(id)).fetch(request) })
  }
}

const spend = async (limiter: TurnRateLimiter): Promise<TurnBudget> => {
  const response = await limiter.fetch(new Request("https://turn-limit.internal/spend", { method: "POST" }))
  return (await response.json()) as TurnBudget
}

describe("the per-login turn ceiling (Durable Object state)", () => {
  test("admits every turn up to the ceiling and counts down honestly", async () => {
    const limiter = new TurnRateLimiter({ storage: memoryStorage() })
    const first = await spend(limiter)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(TURN_WINDOW_MAX - 1)

    for (let turn = 2; turn <= TURN_WINDOW_MAX; turn += 1) {
      const budget = await spend(limiter)
      expect(budget.allowed).toBe(true)
      expect(budget.remaining).toBe(TURN_WINDOW_MAX - turn)
    }
    const over = await spend(limiter)
    expect(over.allowed).toBe(false)
    expect(over.remaining).toBe(0)
    expect(typeof over.retryAt).toBe("number")
  })

  test("a refused turn does not push its own reset further away", async () => {
    const opened = Date.now() - 30 * 60 * 1000
    const storage = memoryStorage({ window: { start: opened, count: TURN_WINDOW_MAX } })
    const limiter = new TurnRateLimiter({ storage })
    const first = await spend(limiter)
    const second = await spend(limiter)
    expect(first.allowed).toBe(false)
    expect(second.retryAt).toBe(first.retryAt)
    expect(first.retryAt).toBe(opened + TURN_WINDOW_MS)
  })

  test("a window older than the budget period starts a fresh one", async () => {
    const storage = memoryStorage({
      window: { start: Date.now() - TURN_WINDOW_MS - 1, count: TURN_WINDOW_MAX }
    })
    const budget = await spend(new TurnRateLimiter({ storage }))
    expect(budget.allowed).toBe(true)
    expect(budget.remaining).toBe(TURN_WINDOW_MAX - 1)
  })

  test("peek reports the state without spending anything", async () => {
    const limiter = new TurnRateLimiter({ storage: memoryStorage() })
    await spend(limiter)
    const peek = async (): Promise<TurnBudget> =>
      (await (await limiter.fetch(new Request("https://turn-limit.internal/peek"))).json()) as TurnBudget
    expect((await peek()).remaining).toBe(TURN_WINDOW_MAX - 1)
    expect((await peek()).remaining).toBe(TURN_WINDOW_MAX - 1)
  })

  test("with no namespace bound the ceiling fails open", async () => {
    const budget = await spendTurn(undefined, "will")
    expect(budget.allowed).toBe(true)
  })

  test("an unreadable answer from our own Durable Object admits the turn", async () => {
    const broken: TurnLimitNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("not json at all", { status: 500 }) })
    }
    expect((await spendTurn(broken, "will")).allowed).toBe(true)
  })

  test("a rejected Durable Object spend admits the turn and logs the cause", async () => {
    const cause = new Error("Durable Object reset because its code was updated.")
    const broken: TurnLimitNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => { throw cause } })
    }
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await spendTurn(broken, "will", ANONYMOUS_CEILING)).toEqual({
        allowed: true, remaining: ANONYMOUS_CEILING.max
      })
      expect(logged).toHaveBeenCalledWith("turn-limit spend failed:", cause)
    } finally {
      logged.mockRestore()
    }
  })

  test("each login has its own budget", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < TURN_WINDOW_MAX; turn += 1) await spendTurn(limits, "will")
    expect((await spendTurn(limits, "will")).allowed).toBe(false)
    expect((await spendTurn(limits, "someone-else")).allowed).toBe(true)
  })

  test("the refusal reads as a bug report, not a bill", () => {
    const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 600_000 }, {})
    expect(response.status).toBe(429)
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  test("the refusal never sends the user to billing", async () => {
    const response = turnLimitResponse({ allowed: false, remaining: 0, retryAt: Date.now() + 600_000 }, {})
    const body = (await response.json()) as { message: string; code: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain("looping")
    expect(body.message).toContain("balance is untouched")
    for (const word of ["upgrade", "billing", "pay", "plan", "$"]) {
      expect(body.message.toLowerCase()).not.toContain(word)
    }
  })
})

/*
 * The routes. A ceiling that let the upstream call happen first would not save
 * a dollar, so what matters is that a refusal costs nothing beyond one
 * Durable Object read.
 */
describe("the turn routes under the ceiling", () => {
  const identityEnv = (limits: TurnLimitNamespace): WorkerEnv => ({
    ...memoryDurableObjects(),
    ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    SMITHERS_CHAT_URL: "https://upstream.test/chat",
    TURN_LIMITS: limits
  })

  const signedIn = (path: string, runId: string): Request =>
    new Request(`https://mvp.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "smithers_session=abc" },
      body: JSON.stringify({ runId, messages: [{ role: "user", content: "hi" }], instructions: "Be brief." })
    })

  const withStubbedSeams = async (run: (upstreamCalls: () => number) => Promise<void>): Promise<void> => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      if (new URL(request.url).hostname === "identity.test") {
        return new Response(JSON.stringify({ login: "will", allowlisted: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      calls += 1
      return new Response("{\"type\":\"done\"}\n", { status: 200, headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    try {
      await run(() => calls)
    } finally {
      globalThis.fetch = original
    }
  }

  for (const path of ["/api/agent/turn", "/api/model/stream"]) {
    test(`a rejected Durable Object spend still reaches the model on ${path}`, async () => {
      const env = identityEnv({
        idFromName: (name) => name,
        get: () => ({ fetch: async () => { throw new Error("Durable Object reset") } })
      })
      await withStubbedSeams(async (upstreamCalls) => {
        const response = await worker.fetch(signedIn(path, `rejected-spend-${path}`), env)
        expect(response.status).toBe(200)
        await response.text()
        expect(upstreamCalls()).toBe(1)
      })
    })
  }

  test("a spent budget refuses the turn with 429 before any credential is spent", async () => {
    // A run id may be registered only once; the in-isolate cancel registry is
    // module state, so each test gets its own namespace.
    const lane = "spent-budget"
    const env = identityEnv(memoryLimits(["will"]))
    await withStubbedSeams(async (upstreamCalls) => {
      const refused = await worker.fetch(signedIn("/api/agent/turn", `${lane}-over`), env)
      expect(refused.status).toBe(429)
      // The whole point: nothing reached the upstream, so nothing was spent.
      expect(upstreamCalls()).toBe(0)
      expect(refused.headers.get("retry-after")).not.toBeNull()
    })
  })

  test("a budget with room admits the turn", async () => {
    const env = identityEnv(memoryLimits())
    await withStubbedSeams(async (upstreamCalls) => {
      const ok = await worker.fetch(signedIn("/api/agent/turn", "with-room-1"), env)
      expect(ok.status).toBe(200)
      expect(upstreamCalls()).toBe(1)
    })
  })

  test("the model-stream route shares the same budget", async () => {
    // A run id may be registered only once; the in-isolate cancel registry is
    // module state, so each test gets its own namespace.
    const lane = "model-stream"
    const env = identityEnv(memoryLimits(["will"]))
    await withStubbedSeams(async () => {
      const refused = await worker.fetch(signedIn("/api/model/stream", `${lane}-stream`), env)
      expect(refused.status).toBe(429)
    })
  })

  test("the budget is keyed by the validated login, never by anything a client sends", async () => {
    // A run id may be registered only once; the in-isolate cancel registry is
    // module state, so each test gets its own namespace.
    const lane = "keyed-by-login"
    const limits = memoryLimits()
    const env = identityEnv(limits)
    await withStubbedSeams(async () => {
      await worker.fetch(signedIn("/api/agent/turn", `${lane}-1`), env)
    })
    expect(limits.logins()).toEqual(["will"])
  })

  test("killing a turn is never rate limited", async () => {
    // A run id may be registered only once; the in-isolate cancel registry is
    // module state, so each test gets its own namespace.
    const lane = "cancel-unlimited"
    const env = identityEnv(memoryLimits(["will"]))
    await withStubbedSeams(async () => {
      // The budget is already spent, so a turn here would be refused.
      expect((await worker.fetch(signedIn("/api/agent/turn", `${lane}-turn`), env)).status).toBe(429)
      const cancel = await worker.fetch(signedIn("/api/agent/turn/cancel", `${lane}-1`), env)
      expect(cancel.status).not.toBe(429)
    })
  })

  test("an ordinary hour of chat never reaches the ceiling", async () => {
    // The guard is worthless if it fires on a real person. Sixty messages is
    // a heavy hour of conversation, and the browser chain authors several
    // links for each, so the ceiling has to clear sixty times a handful — it
    // sits at a thousand.
    // A run id may be registered only once; the in-isolate cancel registry is
    // module state, so each test gets its own namespace.
    const lane = "ordinary-hour"
    const limits = memoryLimits()
    const env = identityEnv(limits)
    await withStubbedSeams(async () => {
      for (let turn = 0; turn < 60; turn += 1) {
        const response = await worker.fetch(signedIn("/api/agent/turn", `${lane}-${turn}`), env)
        expect(response.status).toBe(200)
        // The chain's links for that message spend from the same budget.
        for (let link = 0; link < 8; link += 1) {
          const authored = await worker.fetch(signedIn("/api/model/stream", `${lane}-${turn}-${link}`), env)
          expect(authored.status).toBe(200)
        }
      }
    })
  })
})

/*
 * The anonymous ceiling (PUBLIC-REPOSITORIES.md): a signed-out visitor
 * exploring a catalog repository spends the deployment's credential, so the
 * bucket is a salted hash of the address, the ceiling is a day's worth of
 * questions, and the refusal names sign-in as the way on.
 */
describe("the anonymous ceiling", () => {
  const identityEnv = (limits: TurnLimitNamespace): WorkerEnv => ({
    ...memoryDurableObjects(),
    ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
    IDENTITY_UPSTREAM_URL: "https://identity.test",
    SMITHERS_CHAT_URL: "https://upstream.test/chat",
    ANONYMOUS_TURN_SALT: "test-salt",
    TURN_LIMITS: limits
  })

  const exploring = (ip: string, runId: string): Request =>
    new Request("https://mvp.test/api/agent/turn", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({
        runId,
        messages: [{ role: "user", content: "what is this repo?" }],
        instructions: "Be brief.",
        context: {
          version: 1,
          product: "smithers",
          capturedAt: 1786223000000,
          revision: 1,
          surface: "chat",
          theme: "light",
          selectedWorldDocument: null,
          connectors: [],
          activeRepository: "smithersai/smithers",
          github: { connected: false, login: null, repositories: null },
          worldState: { documentCount: 0, documents: [] },
          capabilities: [],
          limitations: []
        }
      })
    })

  const withSignedOutSeams = async (run: (upstreamCalls: () => number) => Promise<void>): Promise<void> => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : (input as Request)
      if (new URL(request.url).hostname === "identity.test") return new Response("{}", { status: 401 })
      calls += 1
      return new Response("{\"type\":\"done\"}\n", { status: 200, headers: { "content-type": "application/x-ndjson" } })
    }) as typeof fetch
    try {
      await run(() => calls)
    } finally {
      globalThis.fetch = original
    }
  }

  test("one address gets a day of questions, then the sign-in refusal, and nothing more is spent", async () => {
    const limits = memoryLimits()
    const env = identityEnv(limits)
    await withSignedOutSeams(async (upstreamCalls) => {
      for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
        const response = await worker.fetch(exploring("203.0.113.7", `anon-day-${turn}`), env)
        expect(response.status).toBe(200)
        await response.text()
      }
      expect(upstreamCalls()).toBe(ANONYMOUS_TURN_MAX)
      const refused = await worker.fetch(exploring("203.0.113.7", "anon-day-over"), env)
      expect(refused.status).toBe(429)
      expect(refused.headers.get("retry-after")).not.toBeNull()
      const body = (await refused.json()) as { code: string; message: string }
      expect(body.code).toBe("turn_rate_limited")
      expect(body.message).toContain("Sign in with GitHub")
      expect(body.message).not.toContain("looping")
      expect(upstreamCalls()).toBe(ANONYMOUS_TURN_MAX)
      // Another address is another bucket.
      const other = await worker.fetch(exploring("198.51.100.9", "anon-day-other"), env)
      expect(other.status).toBe(200)
      await other.text()
    })
    // The buckets are hashes under the anonymous prefix: no address, no login.
    // The third bucket is the deployment-wide one, charged for every turn.
    expect(limits.logins()).toContain(ANONYMOUS_ALL_KEY)
    const addressed = limits.logins().filter((key) => key !== ANONYMOUS_ALL_KEY)
    expect(addressed).toHaveLength(2)
    for (const key of addressed) {
      expect(key).toMatch(/^anonymous:[0-9a-f]{64}$/)
      expect(key).not.toContain("203.0.113.7")
    }
  })

  test("an IPv6 visitor's whole /64 is one bucket", () => {
    expect(anonymousBucketAddress("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64")
    expect(anonymousBucketAddress("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64")
    expect(anonymousBucketAddress("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(anonymousBucketAddress("::1")).toBe("0:0:0:0::/64")
    expect(anonymousBucketAddress("2001:db8:1:3::1")).not.toBe(anonymousBucketAddress("2001:db8:1:2::1"))
    expect(anonymousBucketAddress("203.0.113.7")).toBe("203.0.113.7")
    expect(anonymousBucketAddress("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  test("two addresses in one /64 spend the same day of questions", async () => {
    const limits = memoryLimits()
    const env = identityEnv(limits)
    await withSignedOutSeams(async (upstreamCalls) => {
      for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
        const response = await worker.fetch(exploring("2001:db8:1:2::1", `anon-v6-${turn}`), env)
        expect(response.status).toBe(200)
        await response.text()
      }
      // A sibling address in the same /64 finds the bucket already spent.
      const sibling = await worker.fetch(exploring("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "anon-v6-sibling"), env)
      expect(sibling.status).toBe(429)
      expect(((await sibling.json()) as { message: string }).message).toContain(`${ANONYMOUS_TURN_MAX} turns today`)
      expect(upstreamCalls()).toBe(ANONYMOUS_TURN_MAX)
      // The next /64 over is another visitor.
      const neighbour = await worker.fetch(exploring("2001:db8:1:3::1", "anon-v6-neighbour"), env)
      expect(neighbour.status).toBe(200)
      await neighbour.text()
    })
    expect(limits.logins().filter((key) => key !== ANONYMOUS_ALL_KEY)).toHaveLength(2)
  })

  test("the deployment-wide bucket refuses a fresh address once everyone's day is spent", async () => {
    const limits = memoryLimits([ANONYMOUS_ALL_KEY])
    const env = identityEnv(limits)
    await withSignedOutSeams(async (upstreamCalls) => {
      const refused = await worker.fetch(exploring("198.51.100.9", "anon-all-over"), env)
      expect(refused.status).toBe(429)
      expect(refused.headers.get("retry-after")).not.toBeNull()
      const body = (await refused.json()) as { code: string; message: string }
      expect(body.code).toBe("turn_rate_limited")
      expect(body.message).toContain("everyone")
      expect(body.message).toContain("Sign in with GitHub")
      expect(body.message).not.toContain(`${ANONYMOUS_TURN_MAX} turns today`)
      expect(upstreamCalls()).toBe(0)
    })
    // A login is not a visitor: its own bucket is untouched by the shared one.
    expect((await spendTurn(limits, "will")).allowed).toBe(true)
  })

  test("the deployment-wide ceiling counts every visitor together", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < ANONYMOUS_ALL_TURN_MAX; turn += 1) {
      expect((await spendTurn(limits, ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)).allowed).toBe(true)
    }
    expect((await spendTurn(limits, ANONYMOUS_ALL_KEY, ANONYMOUS_ALL_CEILING)).allowed).toBe(false)
    // The per-address bucket is untouched: the refusal above is independent of it.
    expect((await spendTurn(limits, "anonymous:abc", ANONYMOUS_CEILING)).remaining).toBe(ANONYMOUS_TURN_MAX - 1)
  })

  test("the bucket key is salted and never a user's login", async () => {
    const request = new Request("https://mvp.test/api/agent/turn", { headers: { "cf-connecting-ip": "203.0.113.7" } })
    const salted = await anonymousTurnKey(request, "salt-a")
    expect(salted).toMatch(/^anonymous:[0-9a-f]{64}$/)
    expect(await anonymousTurnKey(request, "salt-a")).toBe(salted)
    expect(await anonymousTurnKey(request, "salt-b")).not.toBe(salted)
    expect(await anonymousTurnKey(new Request("https://mvp.test/", { headers: { "cf-connecting-ip": "198.51.100.9" } }), "salt-a"))
      .not.toBe(salted)
  })

  test("the anonymous refusal names the day and sign-in, never a bug or a bill", async () => {
    const response = turnLimitResponse(
      { allowed: false, remaining: 0, retryAt: Date.now() + 5 * 60 * 60 * 1000 },
      {},
      ANONYMOUS_CEILING
    )
    expect(response.status).toBe(429)
    const body = (await response.json()) as { message: string; code: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain(`${ANONYMOUS_TURN_MAX} turns today`)
    expect(body.message).toContain("Sign in with GitHub")
    expect(body.message).toContain("hours")
    for (const word of ["looping", "upgrade", "billing", "pay", "plan", "$"]) {
      expect(body.message.toLowerCase()).not.toContain(word)
    }
  })

  test("a login's budget keeps its own ceiling beside the anonymous one", async () => {
    const limits = memoryLimits()
    for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
      expect((await spendTurn(limits, "will")).allowed).toBe(true)
    }
    // Twenty is nothing to a login; the same twenty spends an anonymous bucket.
    expect((await spendTurn(limits, "will")).remaining).toBe(TURN_WINDOW_MAX - ANONYMOUS_TURN_MAX - 1)
    for (let turn = 0; turn < ANONYMOUS_TURN_MAX; turn += 1) {
      expect((await spendTurn(limits, "anonymous:abc", ANONYMOUS_CEILING)).allowed).toBe(true)
    }
    expect((await spendTurn(limits, "anonymous:abc", ANONYMOUS_CEILING)).allowed).toBe(false)
  })
})
