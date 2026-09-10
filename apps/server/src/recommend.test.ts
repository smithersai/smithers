import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { memoryStorage } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { transportLayer } from "./Http"
import {
  cerebrasChat,
  filterAnswer,
  handleRecommend,
  handleRecommendOutcome,
  memoryRecommendStorage,
  parseAnswer,
  readRecommendLog,
  RECOMMEND_ADDRESS_MAX,
  RECOMMEND_ALL_KEY,
  RECOMMEND_ALL_MAX,
  RECOMMEND_ANSWER_MAX,
  RECOMMEND_COMMAND_NAME_MAX_CHARS,
  RECOMMEND_COMMAND_SUMMARY_MAX_CHARS,
  RECOMMEND_LOG_LIMIT,
  RECOMMEND_LOG_NAME,
  RECOMMEND_OUTCOME_BODY_MAX_BYTES,
  RECOMMEND_TAIL_MAX_CHARS,
  RECOMMEND_TAIL_MAX_ENTRIES,
  RECOMMEND_TIMEOUT_MS,
  RecommendLog,
  recommendLogLayer,
  recommendMessages
} from "./recommend"
import type { RecommendLogRow } from "./recommend"
import { turnLimitsLayer, TurnRateLimiter } from "./turnLimit"

/*
 * The command recommender. These tests hold the route to its contract: an
 * ordered, filtered answer from the model; honest refusals (400, 413, 429,
 * 503) with never an invented list; one outcome per recommendation; and a
 * log the scorer can read newest first.
 */

const memoryLog = (): NativeNamespace & { readonly names: () => Array<string> } => {
  const logs = new Map<string, RecommendLog>()
  return {
    names: () => [...logs.keys()],
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let log = logs.get(name)
      if (log === undefined) {
        log = new RecommendLog({ storage: memoryRecommendStorage() })
        logs.set(name, log)
      }
      return { fetch: (request) => log.fetch(request) }
    }
  }
}

/** In-memory buckets; `spent` names buckets seeded at `count` so a test reaches the refusal directly. */
const memoryLimits = (
  spent: ReadonlyArray<{ readonly key: string; readonly count: number }> = []
): NativeNamespace & { readonly keys: () => Array<string> } => {
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
            ? memoryStorage()
            : memoryStorage({ window: { start: Date.now(), count: seeded.count } })
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

const HEADERS = { "x-isolation": "1" }

/** A Cerebras chat completion whose content is `content`. */
const completion = (content: string, model = "gpt-oss-120b"): Response =>
  new Response(JSON.stringify({ model, choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

/** Stand in for the network: `cerebras` answers the model call, and every call is recorded. */
const network = (cerebras: (request: Request) => Promise<Response>) => {
  const calls: Array<Request> = []
  return {
    calls,
    layer: transportLayer(async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
      if (new URL(request.url).hostname !== "api.cerebras.ai") throw new Error(`unexpected fetch to ${request.url}`)
      calls.push(request)
      return cerebras(request)
    })
  }
}

const never = (): Promise<Response> => {
  throw new Error("must not be called")
}

interface Deps {
  readonly cerebras?: (request: Request) => Promise<Response>
  readonly config?: Partial<ServerConfigShape>
  readonly limits?: NativeNamespace
  readonly logs?: NativeNamespace
  readonly login?: string
}

const KEY = { cerebrasApiKey: Redacted.make("csk-test") }

/** The route with its dependencies injected: the key is set unless `config` says otherwise. */
const recommend = (request: Request, deps: Deps = {}): Promise<{ readonly response: Response; readonly calls: Array<Request> }> => {
  const net = network(deps.cerebras ?? never)
  return Effect.runPromise(
    handleRecommend(request, deps.login, HEADERS).pipe(
      Effect.provide(Layer.mergeAll(
        net.layer,
        testConfigLayer({ ...KEY, ...deps.config }),
        turnLimitsLayer(deps.limits),
        recommendLogLayer(deps.logs)
      )),
      Effect.map((response) => ({ response, calls: net.calls }))
    )
  )
}

const outcome = (request: Request, logs?: NativeNamespace): Promise<Response> =>
  Effect.runPromise(handleRecommendOutcome(request, HEADERS).pipe(Effect.provide(recommendLogLayer(logs))))

const readRows = (logs: NativeNamespace | undefined, limit?: number): Promise<ReadonlyArray<RecommendLogRow>> =>
  Effect.runPromise(readRecommendLog(limit).pipe(Effect.provide(recommendLogLayer(logs))))

describe("POST /api/recommend", () => {
  test("a good answer is ordered as the model ranked it, hallucinations dropped, capped at five", async () => {
    const logs = memoryLog()
    const { response, calls } = await recommend(post("/api/recommend", goodBody), {
      cerebras: async () => completion(JSON.stringify({ commands: ["run.start", "made.up", "repo.open", "run.start", "help", "keys.list", "extra"] })),
      logs
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-isolation")).toBe("1")
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
  })

  test("CEREBRAS_MODEL names the model asked", async () => {
    const { calls } = await recommend(post("/api/recommend", goodBody), {
      cerebras: async () => completion(JSON.stringify({ commands: ["help"] }), "llama-fast"),
      config: { cerebrasModel: "llama-fast" }
    })
    expect(((await calls[0]!.json()) as { model: string }).model).toBe("llama-fast")
  })

  test("every name hallucinated is an honest empty list, not a 503", async () => {
    const { response } = await recommend(post("/api/recommend", goodBody), {
      cerebras: async () => completion(JSON.stringify({ commands: ["nothing.real", "also.fake"] }))
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { commands: Array<string> }).commands).toEqual([])
  })

  test("a provider that refuses the JSON schema is asked once more without it and its prose is parsed", async () => {
    const { response, calls } = await recommend(post("/api/recommend", goodBody), {
      cerebras: async (request) => {
        const sent = (await request.json()) as { response_format?: unknown }
        return sent.response_format !== undefined
          ? new Response(JSON.stringify({ message: "incompatible", code: "wrong_api_format" }), { status: 400 })
          : completion("Sure. Here you go: {\"commands\": [\"help\", \"repo.open\"]} Hope that helps.")
      }
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { commands: Array<string> }).commands).toEqual(["help", "repo.open"])
    expect(calls.length).toBe(2)
  })

  test("a malformed body is 400 and never reaches the model", async () => {
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
      const { response, calls } = await recommend(post("/api/recommend", body))
      expect(response.status).toBe(400)
      expect(((await response.json()) as { status: string }).status).toBe("error")
      expect(calls.length).toBe(0)
    }
    const { response } = await recommend(post("/api/recommend", "not json"))
    expect(((await response.json()) as { message: string }).message).toBe("The recommendation request is not JSON.")
  })

  test("an unreadable body is 400 and says so", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"))
      }
    })
    const request = new Request("https://mvp.test/api/recommend", { method: "POST", body, headers: { "cf-connecting-ip": "203.0.113.7" } })
    const { response } = await recommend(request)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toBe("The recommendation request could not be read.")
  })

  test("repo is owner/name or null, and a command name or summary past its cap is 400, so the log and the prompt hold only what the contract names", async () => {
    const badRepos = ["smithers", "a/b/c", "owner/na me", "-owner/name", `${"o".repeat(40)}/name`, `owner/${"n".repeat(101)}`, "x".repeat(4000)]
    for (const repo of badRepos) {
      const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, repo }))
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toContain("owner/name")
      expect(calls.length).toBe(0)
    }
    const longName = [{ name: "c".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS + 1), summary: "s" }]
    const longSummary = [{ name: "c", summary: "s".repeat(RECOMMEND_COMMAND_SUMMARY_MAX_CHARS + 1) }]
    for (const commands of [longName, longSummary]) {
      const { response, calls } = await recommend(post("/api/recommend", { ...goodBody, commands }))
      expect(response.status).toBe(400)
      expect(calls.length).toBe(0)
    }
    // The shape admits real repositories at the caps, with dots, underscores and hyphens.
    const cerebras = async () => completion(JSON.stringify({ commands: ["help"] }))
    for (const repo of ["smithersai/smithers", "my-org/my.repo_v2", `${"o".repeat(39)}/${"n".repeat(100)}`, null]) {
      const { response } = await recommend(post("/api/recommend", { ...goodBody, repo }), { cerebras })
      expect(response.status).toBe(200)
    }
    const atCaps = [{ name: "c".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS), summary: "s".repeat(RECOMMEND_COMMAND_SUMMARY_MAX_CHARS) }]
    expect((await recommend(post("/api/recommend", { ...goodBody, commands: atCaps }), { cerebras })).response.status).toBe(200)
  })

  test("an oversize body is 413: too many tail messages, too much tail text, too many commands", async () => {
    const longTail = Array.from({ length: RECOMMEND_TAIL_MAX_ENTRIES + 1 }, () => ({ role: "user", text: "x" }))
    const bigText = [{ role: "user", text: "x".repeat(RECOMMEND_TAIL_MAX_CHARS + 1) }]
    const manyCommands = Array.from({ length: 301 }, (_, index) => ({ name: `c${index}`, summary: "s" }))
    for (const body of [{ ...goodBody, tail: longTail }, { ...goodBody, tail: bigText }, { ...goodBody, commands: manyCommands }]) {
      const { response, calls } = await recommend(post("/api/recommend", body))
      expect(response.status).toBe(413)
      expect(calls.length).toBe(0)
    }
    // A declared length past the byte cap is refused before a byte is read.
    const declared = await recommend(post("/api/recommend", goodBody, { "content-length": String(10 * 1024 * 1024) }))
    expect(declared.response.status).toBe(413)
    expect(((await declared.response.json()) as { message: string }).message).toBe("The recommendation request is too large.")
    // So is a chunked body that grows past it.
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 30; index += 1) controller.enqueue(new Uint8Array(10 * 1024))
        controller.close()
      }
    })
    const streamed = await recommend(new Request("https://mvp.test/api/recommend", { method: "POST", body: chunks }))
    expect(streamed.response.status).toBe(413)
    expect(declared.calls.length + streamed.calls.length).toBe(0)
  })

  test("without CEREBRAS_API_KEY the route is an honest 503 that spends no ceiling", async () => {
    const limits = memoryLimits()
    const { response, calls } = await recommend(post("/api/recommend", goodBody), { config: { cerebrasApiKey: undefined }, limits })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { status: string; message: string }
    expect(body.status).toBe("error")
    expect(body.message).toContain("CEREBRAS_API_KEY")
    expect(limits.keys()).toEqual([])
    expect(calls.length).toBe(0)
  })

  test("a model that does not answer within the deadline is a 503, never a list, and the call is aborted", async () => {
    expect(RECOMMEND_TIMEOUT_MS).toBe(6000)
    let aborted = false
    const net = network((request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    )
    // The deadline is the Effect clock's, so the test moves the clock instead
    // of waiting six seconds: once the provider call is in flight, six seconds
    // pass, the fetch is aborted, and the route answers.
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(handleRecommend(post("/api/recommend", goodBody), undefined, HEADERS))
        while (net.calls.length === 0) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* TestClock.adjust(RECOMMEND_TIMEOUT_MS - 1)
        expect(aborted).toBe(false)
        yield* TestClock.adjust(1)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(net.layer, testConfigLayer(KEY), turnLimitsLayer(undefined), recommendLogLayer(undefined), TestClock.layer())))
    )
    expect(response.status).toBe(503)
    expect(((await response.json()) as { message: string }).message).toContain("did not answer within 6s")
    expect(aborted).toBe(true)
  })

  test("a model error, an unreadable answer, or an unreachable host is a 503", async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => new Response("upstream down", { status: 502 }),
      async () => completion("I would suggest opening the repository first."),
      async () => {
        throw new TypeError("fetch failed")
      }
    ]
    for (const cerebras of answers) {
      const { response } = await recommend(post("/api/recommend", goodBody), { cerebras })
      expect(response.status).toBe(503)
      expect(((await response.json()) as { status: string }).status).toBe("error")
    }
  })

  test("a visitor spends an address bucket and the deployment bucket; the spent one is 429 in the turn_rate_limited shape", async () => {
    const limits = memoryLimits()
    const cerebras = async () => completion(JSON.stringify({ commands: ["help"] }))
    const first = await recommend(post("/api/recommend", goodBody), { cerebras, limits })
    expect(first.response.status).toBe(200)
    const keys = limits.keys()
    expect(keys).toContain(RECOMMEND_ALL_KEY)
    const address = keys.find((key) => key.startsWith("recommend:anonymous:"))
    expect(address).toBeDefined()
    expect(address).not.toContain("203.0.113.7")
    // A second visitor from the same IPv6 /64 shares the address bucket.
    const sibling = memoryLimits()
    const prefixed = (ip: string) => post("/api/recommend", goodBody, { "cf-connecting-ip": ip })
    await recommend(prefixed("2001:db8:1:2::1"), { cerebras, limits: sibling })
    await recommend(prefixed("2001:db8:1:2:ffff::9"), { cerebras, limits: sibling })
    expect(sibling.keys().filter((key) => key.startsWith("recommend:anonymous:")).length).toBe(1)

    const spentAddress = memoryLimits([{ key: address!, count: RECOMMEND_ADDRESS_MAX }])
    const refused = await recommend(post("/api/recommend", goodBody), { limits: spentAddress })
    expect(refused.response.status).toBe(429)
    expect(refused.calls.length).toBe(0)
    const body = (await refused.response.json()) as { status: string; code: string; message: string; retryAt: string }
    expect(body.code).toBe("turn_rate_limited")
    expect(body.message).toContain("Chat keeps working")
    expect(new Date(body.retryAt).getTime()).toBeGreaterThan(Date.now())
    expect(refused.response.headers.get("retry-after")).not.toBeNull()
    expect(refused.response.headers.get("x-isolation")).toBe("1")
    // The address refusal never draws down everyone's bucket.
    expect(spentAddress.keys()).not.toContain(RECOMMEND_ALL_KEY)

    const spentAll = memoryLimits([{ key: RECOMMEND_ALL_KEY, count: RECOMMEND_ALL_MAX }])
    const everyone = await recommend(post("/api/recommend", goodBody), { limits: spentAll })
    expect(everyone.response.status).toBe(429)
    expect(everyone.calls.length).toBe(0)
  })

  test("the salt changes the address bucket, so buckets are not linkable across deployments", async () => {
    const cerebras = async () => completion(JSON.stringify({ commands: ["help"] }))
    const a = memoryLimits()
    const b = memoryLimits()
    await recommend(post("/api/recommend", goodBody), { cerebras, limits: a, config: { anonymousTurnSalt: Redacted.make("salt-a") } })
    await recommend(post("/api/recommend", goodBody), { cerebras, limits: b, config: { anonymousTurnSalt: Redacted.make("salt-b") } })
    const addressOf = (limits: { keys: () => Array<string> }) => limits.keys().find((key) => key.startsWith("recommend:anonymous:"))
    expect(addressOf(a)).toBeDefined()
    expect(addressOf(a)).not.toBe(addressOf(b))
  })

  test("a signed-in caller is keyed by login, apart from every turn bucket", async () => {
    const limits = memoryLimits()
    const { response } = await recommend(post("/api/recommend", goodBody), {
      cerebras: async () => completion(JSON.stringify({ commands: ["help"] })),
      limits,
      login: "will"
    })
    expect(response.status).toBe(200)
    expect(limits.keys()).toContain("recommend:login:will")
    expect(limits.keys()).not.toContain("will")
  })

  test("with no TURN_LIMITS binding the route still answers", async () => {
    const { response } = await recommend(post("/api/recommend", goodBody), {
      cerebras: async () => completion(JSON.stringify({ commands: ["help"] }))
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { id: string }).id).toMatch(/^unlogged-/)
  })
})

describe("POST /api/recommend/outcome", () => {
  const cerebras = async () => completion(JSON.stringify({ commands: ["run.start", "help"] }))

  test("an outcome is 204 once, 409 the second time, and lands on the row", async () => {
    const logs = memoryLog()
    const recommended = await recommend(post("/api/recommend", goodBody), { cerebras, logs })
    const { id } = (await recommended.response.json()) as { id: string }
    const first = await outcome(post("/api/recommend/outcome", { id, command: "help" }), logs)
    expect(first.status).toBe(204)
    expect(first.headers.get("x-isolation")).toBe("1")
    const second = await outcome(post("/api/recommend/outcome", { id, command: "run.start" }), logs)
    expect(second.status).toBe(409)
    const rows = await readRows(logs)
    expect(rows[0]!.outcome?.command).toBe("help")
  })

  test("an unknown id is 404, a malformed outcome is 400", async () => {
    const logs = memoryLog()
    const unknown = await outcome(post("/api/recommend/outcome", { id: "zz-0000", command: "help" }), logs)
    expect(unknown.status).toBe(404)
    const garbage = await outcome(post("/api/recommend/outcome", { id: "not a seq!", command: "help" }), logs)
    expect(garbage.status).toBe(404)
    const malformed = await outcome(post("/api/recommend/outcome", { id: 5 }), logs)
    expect(malformed.status).toBe(400)
    const notJson = await outcome(post("/api/recommend/outcome", "not json"), logs)
    expect(notJson.status).toBe(400)
    expect(((await notJson.json()) as { message: string }).message).toBe("An outcome is { id, command }, both strings.")
    const unbound = await outcome(post("/api/recommend/outcome", { id: "1-abc", command: "help" }))
    expect(unbound.status).toBe(404)
    expect(((await unbound.json()) as { message: string }).message).toContain("No recommendation log on this deployment")
  })

  test("an oversize outcome is 413 and a command longer than a name is 400, before the log is touched", async () => {
    const logs = memoryLog()
    let touched = 0
    const counted: NativeNamespace = {
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
    const recommended = await recommend(post("/api/recommend", goodBody), { cerebras: async () => completion(JSON.stringify({ commands: ["help"] })), logs: counted })
    const { id } = (await recommended.response.json()) as { id: string }
    expect(touched).toBe(1)
    const huge = { id, command: "h".repeat(RECOMMEND_OUTCOME_BODY_MAX_BYTES + 1) }
    expect((await outcome(post("/api/recommend/outcome", huge), counted)).status).toBe(413)
    const declared = post("/api/recommend/outcome", { id, command: "help" }, { "content-length": String(RECOMMEND_OUTCOME_BODY_MAX_BYTES + 1) })
    expect((await outcome(declared, counted)).status).toBe(413)
    const long = { id, command: "h".repeat(RECOMMEND_COMMAND_NAME_MAX_CHARS + 1) }
    expect((await outcome(post("/api/recommend/outcome", long), counted)).status).toBe(400)
    expect((await outcome(post("/api/recommend/outcome", "null"), counted)).status).toBe(400)
    expect(touched).toBe(1)
    // The row is untouched: the real outcome still lands once.
    const real = await outcome(post("/api/recommend/outcome", { id, command: "help" }), counted)
    expect(real.status).toBe(204)
    expect((await readRows(logs))[0]!.outcome?.command).toBe("help")
  })

  test("an id with the right sequence but the wrong random tail is 404, so ids cannot be guessed", async () => {
    const logs = memoryLog()
    const recommended = await recommend(post("/api/recommend", goodBody), { cerebras, logs })
    const { id } = (await recommended.response.json()) as { id: string }
    const forged = `${id.split("-")[0]}-0000000000000000`
    const response = await outcome(post("/api/recommend/outcome", { id: forged, command: "help" }), logs)
    expect(response.status).toBe(404)
  })

  test("a log that cannot be reached is a 500 that says the outcome was not recorded", async () => {
    const down: NativeNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => {
          throw new Error("durable object unavailable")
        }
      })
    }
    const response = await outcome(post("/api/recommend/outcome", { id: "1-abc", command: "help" }), down)
    expect(response.status).toBe(500)
    expect(((await response.json()) as { message: string }).message).toContain("did not record")
  })
})

describe("the recommendation log", () => {
  test("a row holds the contract's fields and a digest of the tail, never the text", async () => {
    const logs = memoryLog()
    await recommend(post("/api/recommend", goodBody), { cerebras: async () => completion(JSON.stringify({ commands: ["keys.list", "help"] })), logs })
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
    expect(logs.names()).toEqual([RECOMMEND_LOG_NAME])
    expect(RECOMMEND_LOG_NAME).toBe("recommendations")
  })

  test("the scorer reads the rows newest first, bounded by limit; an unbound log is empty", async () => {
    const logs = memoryLog()
    let calls = 0
    const cerebras = async () => completion(JSON.stringify({ commands: [COMMANDS[calls++ % COMMANDS.length]!.name] }))
    for (let index = 0; index < 3; index += 1) await recommend(post("/api/recommend", goodBody), { cerebras, logs })
    expect((await readRows(logs)).map((row) => row.commands[0])).toEqual(["keys.list", "run.start", "repo.open"])
    expect((await readRows(logs, 2)).length).toBe(2)
    expect(await readRows(undefined)).toEqual([])
  })

  test("is a ring: past the limit the oldest row goes and the newest stays", async () => {
    const storage = memoryRecommendStorage()
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
  }, 60_000)

  test("the object refuses a bad row, a bad outcome, and an unknown path in its own words", async () => {
    const log = new RecommendLog({ storage: memoryRecommendStorage() })
    expect((await log.fetch(new Request("https://recommend-log.internal/append", { method: "POST", body: "nope" }))).status).toBe(400)
    expect((await log.fetch(new Request("https://recommend-log.internal/outcome", { method: "POST", body: "{}" }))).status).toBe(400)
    expect((await log.fetch(new Request("https://recommend-log.internal/elsewhere"))).status).toBe(404)
  })

  test("a storage failure is the object's own 500", async () => {
    const log = new RecommendLog({
      storage: {
        ...memoryRecommendStorage(),
        get: async () => {
          throw new Error("storage unavailable")
        }
      }
    })
    const response = await log.fetch(
      new Request("https://recommend-log.internal/append", {
        method: "POST",
        body: JSON.stringify({ at: "2026-01-01T00:00:00.000Z", repo: null, tailDigest: "0", commandCount: 0, commands: [], model: "m", outcome: null })
      })
    )
    expect(response.status).toBe(500)
  })
})

describe("the Cerebras client", () => {
  const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8, temperature: 0 }
  const chat = (cerebras: (request: Request) => Promise<Response>, config: Partial<ServerConfigShape> = KEY) =>
    Effect.runPromise(cerebrasChat(request, 1000).pipe(Effect.provide(Layer.mergeAll(network(cerebras).layer, testConfigLayer(config)))))

  test("answers content and the provider's model, and names each failure", async () => {
    expect(await chat(async () => completion("hello", "served-model"))).toEqual({ ok: true, content: "hello", model: "served-model" })
    expect(await chat(async () => new Response("{}", { status: 200 }))).toEqual({ ok: false, reason: "empty" })
    expect(await chat(async () => new Response("slow down", { status: 429 }))).toEqual({ ok: false, reason: "http", status: 429 })
    expect(await chat(async () => {
      throw new TypeError("fetch failed")
    })).toEqual({ ok: false, reason: "unreachable", message: "fetch failed" })
    expect(await chat(async () => completion("x"), { cerebrasApiKey: undefined })).toEqual({ ok: false, reason: "unreachable", message: "CEREBRAS_API_KEY is unset." })
  })

  test("a refused response has its body cancelled", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("oops"))
      },
      cancel() {
        cancelled = true
      }
    })
    expect(await chat(async () => new Response(body, { status: 500 }))).toEqual({ ok: false, reason: "http", status: 500 })
    expect(cancelled).toBe(true)
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
