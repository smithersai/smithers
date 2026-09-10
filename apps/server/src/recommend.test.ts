import { describe, expect, test } from "bun:test"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import {
  filterAnswer,
  parseAnswer,
  RECOMMEND_ADDRESS_MAX,
  RECOMMEND_ALL_KEY,
  RECOMMEND_ALL_MAX,
  RECOMMEND_ANSWER_MAX,
  RECOMMEND_COMMAND_NAME_MAX_CHARS,
  RECOMMEND_COMMAND_SUMMARY_MAX_CHARS,
  RECOMMEND_LOG_LIMIT,
  RECOMMEND_OUTCOME_BODY_MAX_BYTES,
  RECOMMEND_TAIL_MAX_CHARS,
  RECOMMEND_TAIL_MAX_ENTRIES,
  RECOMMEND_TIMEOUT_MS,
  RecommendLog,
  recommendMessages
} from "./recommend"
import type { RecommendLogNamespace, RecommendLogRow, RecommendLogStorage } from "./recommend"
import { TurnRateLimiter } from "./turnLimit"
import type { TurnLimitNamespace, TurnLimitStorage } from "./turnLimit"

/*
 * The command recommender. These tests hold the route to its contract: an
 * ordered, filtered answer from the model; honest refusals (400, 413, 429,
 * 503) with never an invented list; one outcome per recommendation; and an
 * admin-only log the scorer can read newest first.
 */

const memoryLogStorage = (): RecommendLogStorage => {
  const data = new Map<string, unknown>()
  return {
    get: async (key) => data.get(key) as never,
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => data.delete(key),
    list: async ({ prefix, reverse, limit }) => {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort()
      if (reverse) keys.reverse()
      return new Map(keys.slice(0, limit).map((key) => [key, data.get(key) as never]))
    }
  }
}

const memoryLog = (): RecommendLogNamespace & { readonly names: () => Array<string> } => {
  const logs = new Map<string, RecommendLog>()
  return {
    names: () => [...logs.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        log = new RecommendLog({ storage: memoryLogStorage() })
        logs.set(name, log)
      }
      return { fetch: (request) => log.fetch(request) }
    }
  }
}

const memoryLimitStorage = (seed?: Record<string, unknown>): TurnLimitStorage => {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}))
  return {
    get: async (key) => data.get(key) as never,
    put: async (key, value) => void data.set(key, value)
  }
}

/** In-memory buckets; `spent` names buckets seeded at `count` so a test reaches the refusal directly. */
const memoryLimits = (
  spent: ReadonlyArray<{ readonly key: string; readonly count: number }> = []
): TurnLimitNamespace & { readonly keys: () => Array<string> } => {
  const buckets = new Map<string, TurnRateLimiter>()
  return {
    keys: () => [...buckets.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let bucket = buckets.get(name)
      if (bucket === undefined) {
        const seeded = spent.find((entry) => entry.key === name)
        bucket = new TurnRateLimiter({
          storage: seeded === undefined
            ? memoryLimitStorage()
            : memoryLimitStorage({ window: { start: Date.now(), count: seeded.count } })
        })
        buckets.set(name, bucket)
      }
      const limiter = bucket
      return { fetch: (request) => limiter.fetch(request) }
    }
  }
}

const COMMANDS = [
  { name: "repo.open", summary: "Open a repository" },
  { name: "run.start", summary: "Start a workflow run" },
  { name: "keys.list", summary: "List the secrets" },
  { name: "help", summary: "Show every command" }
]

const goodBody = {
  repo: "smithersai/smithers",
  tail: [
    { role: "user", text: "How do I run the tests here?" },
    { role: "assistant", text: "The repo runs bun test from apps/server." }
  ],
  commands: COMMANDS
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`https://mvp.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const env = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) },
  CEREBRAS_API_KEY: "csk-test",
  ...overrides
})

/** A Cerebras chat completion whose content is `content`. */
const completion = (content: string, model = "gpt-oss-120b"): Response =>
  new Response(JSON.stringify({ model, choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

/**
 * Stand in for the network. `cerebras` answers the model call; identity
 * answers a session probe when `session` is given, else 401.
 */
const withNetwork = async (
  cerebras: (request: Request) => Promise<Response>,
  run: (calls: Array<Request>) => Promise<void>,
  session?: { readonly login: string; readonly admin: boolean }
): Promise<void> => {
  const original = globalThis.fetch
  const calls: Array<Request> = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = typeof input === "string" ? new Request(input, init) : (input as Request)
    const host = new URL(request.url).hostname
    if (host === "api.cerebras.ai") {
      calls.push(request)
      return cerebras(request)
    }
    if (host === "identity.test") {
      return session === undefined
        ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify({ ...session, allowlisted: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    }
    throw new Error(`unexpected fetch to ${request.url}`)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

describe("POST /api/recommend", () => {
  test("a good answer is ordered as the model ranked it, hallucinations dropped, capped at five", async () => {
    const logs = memoryLog()
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["run.start", "made.up", "repo.open", "run.start", "help", "keys.list", "extra"] })),
      async (calls) => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env({ RECOMMEND_LOG: logs }))
        expect(response.status).toBe(200)
        const body = (await response.json()) as { id: string; commands: Array<string>; model: string }
        expect(body.commands).toEqual(["run.start", "repo.open", "help", "keys.list"])
        expect(body.commands.length).toBeLessThanOrEqual(RECOMMEND_ANSWER_MAX)
        expect(body.model).toBe("gpt-oss-120b")
        expect(body.id).not.toBe("")

        // The call carried the contract: temperature 0, strict JSON, the key, every command.
        expect(calls.length).toBe(1)
        expect(calls[0]!.headers.get("authorization")).toBe("Bearer csk-test")
        const sent = (await calls[0]!.json()) as {
          temperature: number
          model: string
          response_format: { type: string }
          messages: Array<{ role: string; content: string }>
        }
        expect(sent.temperature).toBe(0)
        expect(sent.model).toBe("gpt-oss-120b")
        expect(sent.response_format.type).toBe("json_schema")
        const prompt = sent.messages.map((message) => message.content).join("\n")
        for (const command of COMMANDS) expect(prompt).toContain(`${command.name}: ${command.summary}`)
        expect(prompt).toContain("How do I run the tests here?")
      }
    )
  })

  test("every name hallucinated is an honest empty list, not a 503", async () => {
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["nothing.real", "also.fake"] })),
      async () => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env())
        expect(response.status).toBe(200)
        expect(((await response.json()) as { commands: Array<string> }).commands).toEqual([])
      }
    )
  })

  test("a provider that refuses the JSON schema is asked once more without it and its prose is parsed", async () => {
    await withNetwork(
      async (request) => {
        const sent = (await request.json()) as { response_format?: unknown }
        return sent.response_format !== undefined
          ? new Response(JSON.stringify({ message: "incompatible", code: "wrong_api_format" }), { status: 400 })
          : completion("Sure. Here you go: {\"commands\": [\"help\", \"repo.open\"]} Hope that helps.")
      },
      async (calls) => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env())
        expect(response.status).toBe(200)
        expect(((await response.json()) as { commands: Array<string> }).commands).toEqual(["help", "repo.open"])
        expect(calls.length).toBe(2)
      }
    )
  })

  test("a malformed body is 400 and never reaches the model", async () => {
    await withNetwork(
      async () => {
        throw new Error("must not be called")
      },
      async (calls) => {
        const cases: Array<unknown> = [
          "not json",
          [],
          { repo: 7, tail: [], commands: COMMANDS },
          { repo: null, tail: [{ role: "robot", text: "hi" }], commands: COMMANDS },
          { repo: null, tail: [{ role: "user" }], commands: COMMANDS },
          { repo: null, tail: [], commands: [{ name: "", summary: "x" }] },
          { repo: null, tail: [], commands: "help" }
        ]
        for (const body of cases) {
          const response = await worker.fetch(post("/api/recommend", body), env())
          expect(response.status).toBe(400)
          expect(((await response.json()) as { status: string }).status).toBe("error")
        }
        expect(calls.length).toBe(0)
      }
    )
  })

  test("repo is owner/name or null, and a command name or summary past its cap is 400, so the log and the prompt hold only what the contract names", async () => {
    await withNetwork(
      async () => {
        throw new Error("must not be called")
      },
      async (calls) => {
        const badRepos = ["smithers", "a/b/c", "owner/na me", "-owner/name", `${"o".repeat(40)}/name`, `owner/${"n".repeat(101)}`, "x".repeat(4000)]
        for (const repo of badRepos) {
          const response = await worker.fetch(post("/api/recommend", { ...goodBody, repo }), env())
          expect(response.status).toBe(400)
          expect(((await response.json()) as { message: string }).message).toContain("owner/name")
        }
        const longName = [{ name: "c".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS + 1), summary: "s" }]
        const longSummary = [{ name: "c", summary: "s".repeat(RECOMMEND_COMMAND_SUMMARY_MAX_CHARS + 1) }]
        for (const commands of [longName, longSummary]) {
          const response = await worker.fetch(post("/api/recommend", { ...goodBody, commands }), env())
          expect(response.status).toBe(400)
        }
        expect(calls.length).toBe(0)
      }
    )
    // The shape admits real repositories at the caps, with dots, underscores and hyphens.
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["help"] })),
      async () => {
        for (const repo of ["smithersai/smithers", "my-org/my.repo_v2", `${"o".repeat(39)}/${"n".repeat(100)}`, null]) {
          const response = await worker.fetch(post("/api/recommend", { ...goodBody, repo }), env())
          expect(response.status).toBe(200)
        }
        const atCaps = [{ name: "c".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS), summary: "s".repeat(RECOMMEND_COMMAND_SUMMARY_MAX_CHARS) }]
        expect((await worker.fetch(post("/api/recommend", { ...goodBody, commands: atCaps }), env())).status).toBe(200)
      }
    )
  })

  test("an oversize body is 413: too many tail messages, too much tail text, too many commands", async () => {
    await withNetwork(
      async () => {
        throw new Error("must not be called")
      },
      async (calls) => {
        const longTail = Array.from({ length: RECOMMEND_TAIL_MAX_ENTRIES + 1 }, () => ({ role: "user", text: "x" }))
        const bigText = [{ role: "user", text: "x".repeat(RECOMMEND_TAIL_MAX_CHARS + 1) }]
        const manyCommands = Array.from({ length: 301 }, (_, index) => ({ name: `c${index}`, summary: "s" }))
        for (const body of [{ ...goodBody, tail: longTail }, { ...goodBody, tail: bigText }, { ...goodBody, commands: manyCommands }]) {
          const response = await worker.fetch(post("/api/recommend", body), env())
          expect(response.status).toBe(413)
        }
        // A declared length past the byte cap is refused before a byte is read.
        const declared = await worker.fetch(post("/api/recommend", goodBody, { "content-length": String(10 * 1024 * 1024) }), env())
        expect(declared.status).toBe(413)
        expect(calls.length).toBe(0)
      }
    )
  })

  test("a GET is 405", async () => {
    const response = await worker.fetch(new Request("https://mvp.test/api/recommend"), env())
    expect(response.status).toBe(405)
  })

  test("without CEREBRAS_API_KEY the route is an honest 503 that spends no ceiling", async () => {
    const limits = memoryLimits()
    await withNetwork(
      async () => {
        throw new Error("must not be called")
      },
      async () => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env({ CEREBRAS_API_KEY: undefined, TURN_LIMITS: limits }))
        expect(response.status).toBe(503)
        const body = (await response.json()) as { status: string; message: string }
        expect(body.status).toBe("error")
        expect(body.message).toContain("CEREBRAS_API_KEY")
        expect(limits.keys()).toEqual([])
      }
    )
  })

  test("a model that does not answer within the deadline is a 503, never a list", async () => {
    const original = RECOMMEND_TIMEOUT_MS
    expect(original).toBe(6000)
    await withNetwork(
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        }),
      async () => {
        const started = Date.now()
        // The deadline is real time; the test does not wait six seconds for it.
        // It proves the abort path by cancelling from the stub through the
        // request's own signal, which is what the deadline timer does.
        const pending = worker.fetch(post("/api/recommend", goodBody), env())
        const response = await Promise.race([
          pending,
          new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 599 })), RECOMMEND_TIMEOUT_MS + 500))
        ])
        expect(response.status).toBe(503)
        expect(Date.now() - started).toBeGreaterThanOrEqual(RECOMMEND_TIMEOUT_MS - 50)
        expect(((await response.json()) as { message: string }).message).toContain("did not answer within 6s")
      }
    )
  }, RECOMMEND_TIMEOUT_MS + 2000)

  test("a model error, an unreadable answer, or an unreachable host is a 503", async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => new Response("upstream down", { status: 502 }),
      async () => completion("I would suggest opening the repository first."),
      async () => {
        throw new TypeError("fetch failed")
      }
    ]
    for (const answer of answers) {
      await withNetwork(answer, async () => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env())
        expect(response.status).toBe(503)
        expect(((await response.json()) as { status: string }).status).toBe("error")
      })
    }
  })

  test("a visitor spends an address bucket and the deployment bucket; the spent one is 429 in the turn_rate_limited shape", async () => {
    const limits = memoryLimits()
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["help"] })),
      async () => {
        const first = await worker.fetch(post("/api/recommend", goodBody), env({ TURN_LIMITS: limits }))
        expect(first.status).toBe(200)
        const keys = limits.keys()
        expect(keys).toContain(RECOMMEND_ALL_KEY)
        const address = keys.find((key) => key.startsWith("recommend:anonymous:"))
        expect(address).toBeDefined()
        expect(address).not.toContain("203.0.113.7")
        // A second visitor from the same IPv6 /64 shares the address bucket.
        const sibling = memoryLimits()
        const prefixed = (ip: string) => post("/api/recommend", goodBody, { "cf-connecting-ip": ip })
        await worker.fetch(prefixed("2001:db8:1:2::1"), env({ TURN_LIMITS: sibling }))
        await worker.fetch(prefixed("2001:db8:1:2:ffff::9"), env({ TURN_LIMITS: sibling }))
        expect(sibling.keys().filter((key) => key.startsWith("recommend:anonymous:")).length).toBe(1)
      }
    )
    const spentAddress = memoryLimits([{ key: limits.keys().find((key) => key.startsWith("recommend:anonymous:"))!, count: RECOMMEND_ADDRESS_MAX }])
    await withNetwork(
      async () => {
        throw new Error("must not be called")
      },
      async () => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env({ TURN_LIMITS: spentAddress }))
        expect(response.status).toBe(429)
        const body = (await response.json()) as { status: string; code: string; message: string; retryAt: string }
        expect(body.code).toBe("turn_rate_limited")
        expect(body.message).toContain("Chat keeps working")
        expect(new Date(body.retryAt).getTime()).toBeGreaterThan(Date.now())
        expect(response.headers.get("retry-after")).not.toBeNull()
        // The address refusal never draws down everyone's bucket.
        expect(spentAddress.keys()).not.toContain(RECOMMEND_ALL_KEY)
      }
    )
    const spentAll = memoryLimits([{ key: RECOMMEND_ALL_KEY, count: RECOMMEND_ALL_MAX }])
    await withNetwork(
      async () => {
        throw new Error("must not be called")
      },
      async () => {
        const response = await worker.fetch(post("/api/recommend", goodBody), env({ TURN_LIMITS: spentAll }))
        expect(response.status).toBe(429)
      }
    )
  })

  test("a signed-in caller is keyed by login, apart from every turn bucket", async () => {
    const limits = memoryLimits()
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["help"] })),
      async () => {
        const response = await worker.fetch(
          post("/api/recommend", goodBody, { cookie: "smithers_session=abc" }),
          env({ TURN_LIMITS: limits, IDENTITY_UPSTREAM_URL: "https://identity.test" })
        )
        expect(response.status).toBe(200)
        expect(limits.keys()).toContain("recommend:login:will")
        expect(limits.keys()).not.toContain("will")
      },
      { login: "will", admin: false }
    )
  })

  test("a cross-origin request is refused like every other API route", async () => {
    const response = await worker.fetch(post("/api/recommend", goodBody, { origin: "https://elsewhere.test" }), env())
    expect(response.status).toBe(403)
  })
})

describe("POST /api/recommend/outcome", () => {
  test("an outcome is 204 once, 409 the second time, and lands on the row", async () => {
    const logs = memoryLog()
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["run.start", "help"] })),
      async () => {
        const recommended = await worker.fetch(post("/api/recommend", goodBody), env({ RECOMMEND_LOG: logs }))
        const { id } = (await recommended.json()) as { id: string }
        const first = await worker.fetch(post("/api/recommend/outcome", { id, command: "help" }), env({ RECOMMEND_LOG: logs }))
        expect(first.status).toBe(204)
        const second = await worker.fetch(post("/api/recommend/outcome", { id, command: "run.start" }), env({ RECOMMEND_LOG: logs }))
        expect(second.status).toBe(409)
        const rows = await readRows(logs)
        expect(rows[0]!.outcome?.command).toBe("help")
      }
    )
  })

  test("an unknown id is 404, a malformed outcome is 400", async () => {
    const logs = memoryLog()
    const unknown = await worker.fetch(post("/api/recommend/outcome", { id: "zz-0000", command: "help" }), env({ RECOMMEND_LOG: logs }))
    expect(unknown.status).toBe(404)
    const garbage = await worker.fetch(post("/api/recommend/outcome", { id: "not a seq!", command: "help" }), env({ RECOMMEND_LOG: logs }))
    expect(garbage.status).toBe(404)
    const malformed = await worker.fetch(post("/api/recommend/outcome", { id: 5 }), env({ RECOMMEND_LOG: logs }))
    expect(malformed.status).toBe(400)
    const unbound = await worker.fetch(post("/api/recommend/outcome", { id: "1-abc", command: "help" }), env())
    expect(unbound.status).toBe(404)
  })

  test("an oversize outcome is 413 and a command longer than a name is 400, before the log is touched", async () => {
    const logs = memoryLog()
    let touched = 0
    const counted: RecommendLogNamespace = {
      idFromName: (name) => logs.idFromName(name),
      get: (id) => {
        const stub = logs.get(id)
        return {
          fetch: (request) => {
            touched += 1
            return stub.fetch(request)
          }
        }
      }
    }
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["help"] })),
      async () => {
        const recommended = await worker.fetch(post("/api/recommend", goodBody), env({ RECOMMEND_LOG: counted }))
        const { id } = (await recommended.json()) as { id: string }
        expect(touched).toBe(1)
        const huge = { id, command: "h".repeat(RECOMMEND_OUTCOME_BODY_MAX_BYTES + 1) }
        expect((await worker.fetch(post("/api/recommend/outcome", huge), env({ RECOMMEND_LOG: counted }))).status).toBe(413)
        const declared = post("/api/recommend/outcome", { id, command: "help" }, { "content-length": String(RECOMMEND_OUTCOME_BODY_MAX_BYTES + 1) })
        expect((await worker.fetch(declared, env({ RECOMMEND_LOG: counted }))).status).toBe(413)
        const long = { id, command: "h".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS + 1) }
        expect((await worker.fetch(post("/api/recommend/outcome", long), env({ RECOMMEND_LOG: counted }))).status).toBe(400)
        expect((await worker.fetch(post("/api/recommend/outcome", "null"), env({ RECOMMEND_LOG: counted }))).status).toBe(400)
        expect(touched).toBe(1)
        // The row is untouched: the real outcome still lands once.
        const real = await worker.fetch(post("/api/recommend/outcome", { id, command: "help" }), env({ RECOMMEND_LOG: counted }))
        expect(real.status).toBe(204)
        expect((await readRows(logs))[0]!.outcome?.command).toBe("help")
      }
    )
  })

  test("an id with the right sequence but the wrong random tail is 404, so ids cannot be guessed", async () => {
    const logs = memoryLog()
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["help"] })),
      async () => {
        const recommended = await worker.fetch(post("/api/recommend", goodBody), env({ RECOMMEND_LOG: logs }))
        const { id } = (await recommended.json()) as { id: string }
        const forged = `${id.split("-")[0]}-0000000000000000`
        const response = await worker.fetch(post("/api/recommend/outcome", { id: forged, command: "help" }), env({ RECOMMEND_LOG: logs }))
        expect(response.status).toBe(404)
      }
    )
  })
})

const readRows = async (logs: RecommendLogNamespace, limit?: number): Promise<ReadonlyArray<RecommendLogRow>> => {
  const stub = logs.get(logs.idFromName("recommendations"))
  const response = await stub.fetch(new Request(`https://recommend-log.internal/read${limit === undefined ? "" : `?limit=${limit}`}`))
  return ((await response.json()) as { rows: ReadonlyArray<RecommendLogRow> }).rows
}

describe("the recommendation log", () => {
  test("a row holds the contract's fields and a digest of the tail, never the text", async () => {
    const logs = memoryLog()
    await withNetwork(
      async () => completion(JSON.stringify({ commands: ["keys.list", "help"] })),
      async () => {
        await worker.fetch(post("/api/recommend", goodBody), env({ RECOMMEND_LOG: logs }))
        const [row] = await readRows(logs)
        expect(row).toBeDefined()
        expect(Object.keys(row!).sort()).toEqual(["at", "commandCount", "commands", "id", "model", "outcome", "repo", "tailDigest"])
        expect(row!.repo).toBe("smithersai/smithers")
        expect(row!.commandCount).toBe(COMMANDS.length)
        expect(row!.commands).toEqual(["keys.list", "help"])
        expect(row!.model).toBe("gpt-oss-120b")
        expect(row!.outcome).toBeNull()
        expect(row!.tailDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(new Date(row!.at).toISOString()).toBe(row!.at)
        expect(JSON.stringify(row)).not.toContain("How do I run the tests")
        expect(logs.names()).toEqual(["recommendations"])
      }
    )
  })

  test("is a ring: past the limit the oldest row goes and the newest stays", async () => {
    const storage = memoryLogStorage()
    const log = new RecommendLog({ storage })
    const append = (index: number) =>
      log.fetch(
        new Request("https://recommend-log.internal/append", {
          method: "POST",
          body: JSON.stringify({ at: new Date(index).toISOString(), repo: null, tailDigest: "0", commandCount: 1, commands: [], model: "m", outcome: null })
        })
      )
    const overflow = 3
    for (let index = 0; index < RECOMMEND_LOG_LIMIT + overflow; index += 1) await append(index)
    const all = await storage.list<RecommendLogRow>({ prefix: "row:", reverse: true, limit: RECOMMEND_LOG_LIMIT * 2 })
    expect(all.size).toBe(RECOMMEND_LOG_LIMIT)
    const rows = [...all.values()]
    expect(rows[0]!.at).toBe(new Date(RECOMMEND_LOG_LIMIT + overflow - 1).toISOString())
    expect(rows[rows.length - 1]!.at).toBe(new Date(overflow).toISOString())
  })
})

describe("GET /api/admin/recommend/log", () => {
  const adminEnv = (logs?: RecommendLogNamespace): WorkerEnv =>
    env({ IDENTITY_UPSTREAM_URL: "https://identity.test", ...(logs === undefined ? {} : { RECOMMEND_LOG: logs }) })
  const read = (query = "") =>
    new Request(`https://mvp.test/api/admin/recommend/log${query}`, { headers: { cookie: "smithers_session=abc" } })

  test("an admin reads the rows newest first, bounded by limit", async () => {
    const logs = memoryLog()
    let calls = 0
    await withNetwork(
      async () => completion(JSON.stringify({ commands: [COMMANDS[calls++ % COMMANDS.length]!.name] })),
      async () => {
        for (let index = 0; index < 3; index += 1) {
          await worker.fetch(post("/api/recommend", goodBody), adminEnv(logs))
        }
        const response = await worker.fetch(read(), adminEnv(logs))
        expect(response.status).toBe(200)
        const body = (await response.json()) as { rows: Array<RecommendLogRow> }
        expect(body.rows.map((row) => row.commands[0])).toEqual(["keys.list", "run.start", "repo.open"])
        const limited = await worker.fetch(read("?limit=2"), adminEnv(logs))
        expect(((await limited.json()) as { rows: Array<unknown> }).rows.length).toBe(2)
      },
      { login: "will", admin: true }
    )
  })

  test("a non-admin and a visitor get the canonical unknown-route 404", async () => {
    const logs = memoryLog()
    await withNetwork(
      async () => completion("{}"),
      async () => {
        const response = await worker.fetch(read(), adminEnv(logs))
        expect(response.status).toBe(404)
        const unknown = await worker.fetch(
          new Request("https://mvp.test/api/definitely-not-a-route", { headers: { cookie: "smithers_session=abc" } }),
          adminEnv(logs)
        )
        expect(await response.text()).toBe(await unknown.text())
      },
      { login: "someone", admin: false }
    )
    await withNetwork(
      async () => completion("{}"),
      async () => {
        const response = await worker.fetch(new Request("https://mvp.test/api/admin/recommend/log"), adminEnv(logs))
        expect(response.status).toBe(404)
      }
    )
  })

  test("with no log bound the read says so instead of implying nothing was recommended", async () => {
    await withNetwork(
      async () => completion("{}"),
      async () => {
        const response = await worker.fetch(read(), adminEnv())
        const body = (await response.json()) as { rows: Array<unknown>; note?: string }
        expect(body.rows).toEqual([])
        expect(body.note).toContain("nothing is stored")
      },
      { login: "will", admin: true }
    )
  })
})

describe("the answer reading", () => {
  test("parseAnswer reads strict JSON, an object in prose, a bare array, and refuses prose alone", () => {
    expect(parseAnswer("{\"commands\":[\"a\",\"b\"]}")).toEqual(["a", "b"])
    expect(parseAnswer("Try these: {\"commands\": [\"a\"]} ok?")).toEqual(["a"])
    expect(parseAnswer("[\"a\", 3, \"b\"]")).toEqual(["a", "b"])
    expect(parseAnswer("open the repository")).toBeUndefined()
    expect(parseAnswer("{\"other\": 1}")).toBeUndefined()
  })

  test("filterAnswer keeps offered names in the model's order, once each, at most five", () => {
    const offered = Array.from({ length: 8 }, (_, index) => ({ name: `c${index}`, summary: "" }))
    expect(filterAnswer(["c3", " c1 ", "nope", "c3", "c0", "c7", "c2", "c5"], offered)).toEqual(["c3", "c1", "c0", "c7", "c2"])
  })

  test("the prompt says the job, lists every command, and marks an empty conversation as such", () => {
    const messages = recommendMessages({ repo: null, tail: [], commands: COMMANDS })
    expect(messages[0]!.role).toBe("system")
    expect(messages[0]!.content).toContain("next command")
    expect(messages[0]!.content).toContain("best first")
    expect(messages[1]!.content).toContain("(no messages yet)")
    for (const command of COMMANDS) expect(messages[1]!.content).toContain(command.name)
  })
})
