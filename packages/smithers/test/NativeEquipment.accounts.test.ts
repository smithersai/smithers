import { Seat } from "@smthrs/agent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Stream } from "effect"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

const fakeHome = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => fakeHome.value ?? actual.homedir() }
})

const executor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("account resolution must not call model transport"))
})
const directories: Array<string> = []
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-account-seat-"))
  directories.push(directory)
  return directory
}
/** A fabricated access token: only its expiry is ever read. */
const access = (account: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: expiresAt, account })).toString("base64url")}.signature`
/** One signed-in Codex login directory: the `auth.json` that `codex login` writes. */
const login = (accounts: string, account: string, token = access(account)) => {
  const directory = join(accounts, account)
  mkdirSync(directory)
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: token, refresh_token: `refresh-${account}`, account_id: `id-${account}` }
    }),
    { mode: 0o600 }
  )
  return token
}
const chatgpt = "https://chatgpt.com/backend-api/codex/responses"
// A pooled deployment serving both subscription routes: a pinned seat names one
// local login, so it must never be handed to the pool or the model proxy.
const ambientPool = {
  SMITHERS_ACCOUNT_POOL_URL: "https://ambient-pool.invalid",
  SMITHERS_ACCOUNT_POOL_KEY: "ambient-pool-key",
  SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic,chatgpt",
  SMITHERS_MODEL_PROXY_URL: "https://ambient-proxy.invalid"
}
const resolve = (environment: Readonly<Record<string, string | undefined>>, declared: string) =>
  Effect.scoped(NodeControl.seatResolver({ PATH: "/nonexistent", ...environment }, executor).resolve(declared))
const prepared = (seat: Seat.Seat) =>
  Effect.runPromise(seat.route.prepare({
    modelId: seat.modelId,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    params: {}
  } as never))

afterEach(() => {
  fakeHome.value = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("native account-pinned seat resolution", () => {
  it.each(["sol@codex-3", "openai:gpt-6.1-sol@codex-3"])(
    "routes %s through the selected subscription and preserves its declared id",
    async (declared) => {
      const accounts = fixture()
      login(accounts, "codex-3")
      const environment = {
        SMITHERS_ACCOUNTS_DIR: accounts,
        CODEX_HOME: fixture(),
        OPENAI_API_KEY: "ambient-api-key",
        SMITHERS_OPENAI_AUTH: "api-key",
        ...ambientPool
      }
      const resolved = await Effect.runPromise(resolve(environment, declared))
      expect(resolved.id).toBe(declared)
      expect(resolved.modelId).toBe(
        declared.startsWith("sol@") ? Seat.modelIdOf(Providers.expandSeat("sol")) : "gpt-6.1-sol"
      )
      // The selected login's own backend, never the ambient pool or proxy.
      const request = await prepared(resolved)
      expect(request.routeId).toBe("openai-chatgpt")
      expect(request.url).toBe(chatgpt)
      expect(JSON.stringify(request)).not.toContain("ambient-api-key")
      expect(environment.SMITHERS_OPENAI_AUTH).toBe("api-key")
    }
  )

  it.each([
    ["sol@codex-missing", "codex-missing"],
    ["sol@codex-empty", "codex-empty"],
    ["sol@codex-invalid", "codex-invalid"],
    ["sol@codex-keyonly", "codex-keyonly"],
    ["sol@codex-broken", "codex-broken"],
    ["sol@missing", "missing"],
    ["sol@../codex-3", "../codex-3"],
    ["sol@codex-3@codex-4", "codex-3@codex-4"],
    ["sol@", "(empty)"],
    ["@codex-3", "codex-3"],
    ["jev@codex-3", "codex-3"],
    ["anthropic:claude-opus-5@codex-3", "codex-3"],
    ["openai:gpt-6.1-sol@claude-2", "claude-2"],
    ["anthropic:claude-opus-5@claude-2", "claude-2"]
  ])("refuses %s with an account-specific typed error", async (declared, account) => {
    const accounts = fixture()
    login(accounts, "codex-3")
    mkdirSync(join(accounts, "codex-empty"))
    mkdirSync(join(accounts, "codex-invalid"))
    mkdirSync(join(accounts, "codex-keyonly"))
    mkdirSync(join(accounts, "codex-broken"))
    mkdirSync(join(accounts, "claude-2"))
    writeFileSync(join(accounts, "codex-invalid", "auth.json"), "{}")
    writeFileSync(join(accounts, "codex-keyonly", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "wrong-login" }))
    writeFileSync(join(accounts, "codex-broken", "auth.json"), "{broken")
    const error = await Effect.runPromise(Effect.flip(resolve({
      SMITHERS_ACCOUNTS_DIR: accounts,
      OPENAI_API_KEY: "ambient-key",
      ANTHROPIC_API_KEY: "ambient-key"
    }, declared)))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe(declared)
    expect(error.message.toLowerCase()).toContain("account")
    expect(error.message).toContain(account)
  })

  it.each(["opus@claude-2", "claude-code:opus@claude-2"])(
    "selects the Claude login directory for %s despite ambient credentials and an account pool",
    async (declared) => {
      const accounts = fixture()
      const directory = join(accounts, "claude-2")
      mkdirSync(directory)
      const binary = fixture()
      writeFileSync(
        join(binary, "claude"),
        "#!/bin/sh\nprintf \"%s\\n\" \"$CLAUDE_CONFIG_DIR\" > \"${0%/*}/selected\"\n" +
          "if [ -n \"$CLAUDE_CODE_OAUTH_TOKEN$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$ANTHROPIC_BASE_URL$CLAUDE_CODE_USE_BEDROCK$CLAUDE_CODE_USE_VERTEX$CLAUDE_CODE_USE_FOUNDRY$ANTHROPIC_FOUNDRY_BASE_URL\" ]; then\n" +
          "echo '{\"loggedIn\":false}'\nelse\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'\nfi\n",
        { mode: 0o755 }
      )
      const resolved = await Effect.runPromise(resolve({
        SMITHERS_ACCOUNTS_DIR: accounts,
        PATH: binary,
        CLAUDE_CONFIG_DIR: fixture(),
        ANTHROPIC_API_KEY: "ambient-key",
        CLAUDE_CODE_OAUTH_TOKEN: "ambient-token",
        ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
        ANTHROPIC_BASE_URL: "https://ambient.invalid",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_BASE_URL: "https://ambient-foundry.invalid",
        ...ambientPool
      }, declared))
      expect(resolved.id).toBe(declared)
      expect(resolved.modelId).toBe("claude-opus-5-5")
      expect(readFileSync(join(binary, "selected"), "utf8")).toBe(`${directory}\n`)
    }
  )

  it("isolates Claude login status caches between pinned accounts", async () => {
    const accounts = fixture()
    mkdirSync(join(accounts, "claude-2"))
    mkdirSync(join(accounts, "claude-3"))
    const binary = fixture()
    writeFileSync(
      join(binary, "claude"),
      "#!/bin/sh\ncase \"$CLAUDE_CONFIG_DIR\" in\n" +
        "*claude-2) echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}' ;;\n" +
        "*) echo '{\"loggedIn\":false}' ;;\nesac\n",
      { mode: 0o755 }
    )
    const resolver = NodeControl.seatResolver({ SMITHERS_ACCOUNTS_DIR: accounts, PATH: binary }, executor)
    const signedIn = await Effect.runPromise(Effect.scoped(resolver.resolve("opus@claude-2")))
    expect(signedIn.id).toBe("opus@claude-2")
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(resolver.resolve("opus@claude-3"))))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe("opus@claude-3")
    expect(error.message).toContain("claude-3")
  })

  it("signs each pinned Codex seat with its selected login", async () => {
    const accounts = fixture()
    // Deliberately differ from freshly generated credentials, so comparing to
    // a new token fails deterministically even within the same second.
    const expiresAt = Math.floor(Date.now() / 1000) + 7200
    const tokens: Record<string, string> = {
      "codex-3": login(accounts, "codex-3", access("codex-3", expiresAt)),
      "codex-4": login(accounts, "codex-4", access("codex-4", expiresAt + 1))
    }
    const signed: Array<Readonly<Record<string, string | undefined>>> = []
    const recording = RequestExecutor.RequestExecutor.of({
      execute: (request) => {
        signed.push({
          url: request.url,
          authorization: request.headers["authorization"],
          account: request.headers["chatgpt-account-id"]
        })
        return Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", usage: {} } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } }
          )
        ))
      }
    })
    const resolver = NodeControl.seatResolver({
      SMITHERS_ACCOUNTS_DIR: accounts,
      PATH: "/nonexistent",
      CODEX_HOME: fixture(),
      OPENAI_API_KEY: "ambient-key",
      CODEX_API_KEY: "ambient-key",
      OPENAI_BASE_URL: "https://ambient.invalid"
    }, recording)
    for (const account of ["codex-3", "codex-4", "codex-3"]) {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const seat = yield* resolver.resolve(`sol@${account}`)
        yield* seat.model.stream({
          modelId: seat.modelId,
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [],
          params: {}
        }).pipe(Stream.runCollect)
      })))
    }
    expect(signed).toEqual(["codex-3", "codex-4", "codex-3"].map((account) => ({
      url: chatgpt,
      authorization: `Bearer ${tokens[account]}`,
      account: `id-${account}`
    })))
    expect(JSON.stringify(signed)).not.toContain("ambient")
  })

  it("refuses a signed-out Codex account without reusing another account's cached login", async () => {
    const accounts = fixture()
    login(accounts, "codex-3")
    mkdirSync(join(accounts, "codex-4"))
    const resolver = NodeControl.seatResolver({ SMITHERS_ACCOUNTS_DIR: accounts, PATH: "/nonexistent" }, executor)
    expect((await Effect.runPromise(Effect.scoped(resolver.resolve("sol@codex-3")))).id).toBe("sol@codex-3")
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(resolver.resolve("sol@codex-4"))))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toContain("codex-4")
    expect(error.seat).toBe("sol@codex-4")
  })

  it("defaults the accounts directory to the selected home", async () => {
    const home = fixture()
    fakeHome.value = home
    const accounts = join(home, ".smithers", "accounts")
    mkdirSync(accounts, { recursive: true })
    login(accounts, "codex-3")
    const seat = await Effect.runPromise(resolve({}, "sol@codex-3"))
    expect(seat.id).toBe("sol@codex-3")
    expect((await prepared(seat)).url).toBe(chatgpt)
  })

  it("selects ~/.codex for codex-default even with an accounts directory override", async () => {
    const home = fixture()
    fakeHome.value = home
    login(home, ".codex")
    const seat = await Effect.runPromise(resolve({
      SMITHERS_ACCOUNTS_DIR: fixture(),
      CODEX_HOME: fixture()
    }, "openai:gpt-6.1-sol@codex-default"))
    expect(seat.id).toBe("openai:gpt-6.1-sol@codex-default")
    expect((await prepared(seat)).url).toBe(chatgpt)
  })
})
