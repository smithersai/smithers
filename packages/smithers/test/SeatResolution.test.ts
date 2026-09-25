/**
 * The complete seat-resolution matrix: every supported provider crossed with
 * every state its API key variable can be in, plus the seat-string shapes the
 * parser has to separate — bare, prefixed, trailing-separator, and multiply
 * separated.
 *
 * The resolver is the agent's front door: a seat that resolves wrong routes a
 * run to the wrong provider, and a seat that fails to resolve must say which
 * variable to set.
 */
import { Seat } from "@smthrs/agent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const executor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("model transport was not expected"))
})

const resolve = (
  environment: Readonly<Record<string, string | undefined>>,
  seat: string
) => Effect.scoped(NodeControl.seatResolver(environment, executor).resolve(seat))

const keyed = {
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  OPENROUTER_API_KEY: "openrouter-key"
}

const prepared = (seat: Seat.Seat, modelId: string) =>
  Effect.runPromise(
    seat.route.prepare({
      modelId,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      params: {}
    } as never)
  )

describe("NodeControl.seatResolver providers", () => {
  it.each(
    [
      ["anthropic", "anthropic:claude-sonnet-4-5", "https://api.anthropic.com/v1/messages", 200_000],
      ["openai", "openai:gpt-5.6-sol", "https://api.openai.com/v1/responses", 400_000],
      ["openrouter", "openrouter:openai/gpt-5.6-sol", "https://openrouter.ai/api/v1/responses", 400_000]
    ] as const
  )("routes a keyed %s seat to its own endpoint", async (_provider, seat, url, tokens) => {
    const resolved = await Effect.runPromise(resolve(keyed, seat))

    expect(resolved.id).toBe(seat)
    expect(resolved.modelId).toBe(Seat.modelIdOf(seat))
    expect(resolved.contextWindowTokens).toBe(tokens)
    const request = await prepared(resolved, resolved.modelId)
    expect(request.url).toBe(url)
    // The credential is applied by Auth as the request leaves; it never enters
    // the sealed, credential-free view.
    expect(JSON.stringify(request.publicHeaders)).not.toContain("key")
  })

  it("routes a seat with no separator through Anthropic as a bare model id", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "claude-opus-4-1"))

    // The one provider convention this host assumes: no prefix means Anthropic.
    expect(resolved.id).toBe("claude-opus-4-1")
    expect(resolved.contextWindowTokens).toBe(200_000)
    expect((await prepared(resolved, "claude-opus-4-1")).url).toBe("https://api.anthropic.com/v1/messages")
  })

  it("keeps every separator after the first inside the model id", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "openrouter:anthropic/claude:beta"))

    // OpenRouter spells vendor and model with a slash, and a colon in a model
    // id belongs to the model, not to another provider prefix.
    expect(Seat.modelIdOf("openrouter:anthropic/claude:beta")).toBe("anthropic/claude:beta")
    expect(resolved.contextWindowTokens).toBe(200_000)
  })

  it("resolves a seat that is nothing but a provider prefix", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "openai:"))

    // A trailing separator is an empty model id, which no catalog pattern
    // matches, so the conservative floor applies rather than zero.
    expect(resolved.id).toBe("openai:")
    expect(resolved.contextWindowTokens).toBe(128_000)
  })

  it("gives a model the catalog has never met the conservative floor", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "anthropic:some-unreleased-model"))

    expect(resolved.contextWindowTokens).toBe(128_000)
  })

  it("refuses a provider prefix that names no route", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, "mystery:model-x")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe("mystery:model-x")
    expect(error.message).toBe("No route is configured for the mystery provider")
  })

  it("refuses an empty provider prefix rather than defaulting it", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, ":claude-sonnet-4-5")))

    // A leading separator is an explicit empty provider, which is not the same
    // as no separator at all.
    expect(error.message).toBe("No route is configured for the  provider")
  })

  it("refuses the empty seat", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({}, "")))

    // No separator, so the Anthropic route applies and the missing key is what
    // the operator hears about.
    expect(error.message).toBe("Set ANTHROPIC_API_KEY to run the  seat")
  })
})

describe("NodeControl.seatResolver credentials", () => {
  it.each(
    [
      ["anthropic", "anthropic:claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
      ["openai", "openai:gpt-5.6-sol", "OPENAI_API_KEY"],
      ["openrouter", "openrouter:openai/gpt-5.6-sol", "OPENROUTER_API_KEY"],
      ["a bare model id", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"]
    ] as const
  )("refuses %s with its key variable absent and with it empty, naming the variable", async (
    _provider,
    seat,
    variable
  ) => {
    const absent = await Effect.runPromise(Effect.flip(resolve({}, seat)))
    const empty = await Effect.runPromise(Effect.flip(resolve({ [variable]: "" }, seat)))

    // An empty string is treated exactly like an unset variable: a blank key
    // would otherwise reach the provider and fail as an opaque 401.
    expect(absent.message).toBe(`Set ${variable} to run the ${seat} seat`)
    expect(empty.message).toBe(absent.message)
    expect(absent.seat).toBe(seat)
  })

  it("reads only the variable its own provider owns", async () => {
    const wrongKey = await Effect.runPromise(Effect.flip(resolve({ OPENAI_API_KEY: "k" }, "anthropic:claude-3")))
    const rightKey = await Effect.runPromise(resolve({ ANTHROPIC_API_KEY: "k" }, "anthropic:claude-3"))

    expect(wrongKey.message).toBe("Set ANTHROPIC_API_KEY to run the anthropic:claude-3 seat")
    expect(rightKey.id).toBe("anthropic:claude-3")
  })

  it("accepts a single-character key as present", async () => {
    const resolved = await Effect.runPromise(resolve({ OPENAI_API_KEY: "k" }, "openai:gpt-5.6-sol"))

    // Length one is the boundary of the `length === 0` refusal.
    expect(resolved.id).toBe("openai:gpt-5.6-sol")
  })

  it("routes an explicitly configured OpenAI-compatible owner provider", async () => {
    const resolved = await Effect.runPromise(resolve({
      OPENAI_API_KEY: "owner-key",
      SMITHERS_OPENAI_COMPATIBLE_BASE_URL: "http://provider.internal:8080"
    }, "openai:scripted"))
    expect((await prepared(resolved, resolved.modelId)).url).toBe("http://provider.internal:8080/v1/chat/completions")
  })

  it("refuses a keyed provider when the environment record is empty", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({}, "openrouter:openai/gpt-5.6-sol")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
  })
})

describe("NodeControl.seatResolver ChatGPT mode", () => {
  const directories: Array<string> = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /** A codex home, provisioned with a fabricated session when asked. */
  const codexHome = (options: { readonly provisioned: boolean }): string => {
    const directory = mkdtempSync(join(tmpdir(), "flows-seat-codex-"))
    directories.push(directory)
    if (options.provisioned) {
      writeFileSync(
        join(directory, "auth.json"),
        `${
          JSON.stringify({
            OPENAI_API_KEY: null,
            auth_mode: "chatgpt",
            tokens: {
              id_token: "fake-id-token",
              access_token: "fake-access-token",
              refresh_token: "fake-refresh-token",
              account_id: "acct-fake-123"
            },
            last_refresh: "2026-08-19T19:35:39.648449Z"
          })
        }\n`,
        { mode: 0o600 }
      )
    }
    return directory
  }

  it("routes the unchanged openai seat over the ChatGPT backend, demanding no API key", async () => {
    const environment = { SMITHERS_OPENAI_AUTH: "chatgpt", CODEX_HOME: codexHome({ provisioned: true }) }

    const resolved = await Effect.runPromise(resolve(environment, "openai:gpt-5.6-sol"))

    // The seat string, and so the journaled seat and its committed price,
    // stays spelled exactly as the API-key mode spells it.
    expect(resolved.id).toBe("openai:gpt-5.6-sol")
    expect(resolved.contextWindowTokens).toBe(400_000)
    const request = await prepared(resolved, "gpt-5.6-sol")
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    // The codex client identity travels as route identity; the bearer and
    // account id do not exist until Auth signs the attempt.
    expect(request.publicHeaders).toMatchObject({ originator: "codex_cli_rs" })
    const sealed = JSON.stringify(request)
    expect(sealed).not.toContain("fake-access-token")
    expect(sealed).not.toContain("acct-fake-123")
  })

  it("refuses the mode without a provisioned session, naming the store and the login command", async () => {
    const home = codexHome({ provisioned: false })
    const environment = { SMITHERS_OPENAI_AUTH: "chatgpt", CODEX_HOME: home, OPENAI_API_KEY: "unused" }

    const error = await Effect.runPromise(Effect.flip(resolve(environment, "openai:gpt-5.6-sol")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toBe(
      `Sign in with \`codex login\` to run the openai:gpt-5.6-sol seat: no ChatGPT credentials at ${
        join(home, "auth.json")
      }`
    )
  })

  it("refuses a mode value it does not know rather than guessing a credential source", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({ SMITHERS_OPENAI_AUTH: "oauth" }, "openai:gpt-5.6-sol")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toBe(
      "SMITHERS_OPENAI_AUTH must be \"api-key\" or \"chatgpt\" to run the openai:gpt-5.6-sol seat"
    )
  })

  it("treats an empty mode exactly like an unset one: the API key path stays the default", async () => {
    const resolved = await Effect.runPromise(
      resolve({ SMITHERS_OPENAI_AUTH: "", OPENAI_API_KEY: "k" }, "openai:gpt-5.6-sol")
    )

    expect((await prepared(resolved, "gpt-5.6-sol")).url).toBe("https://api.openai.com/v1/responses")
  })

  it("scopes the mode to the openai provider: every other seat keeps its own key", async () => {
    const environment = {
      SMITHERS_OPENAI_AUTH: "chatgpt",
      CODEX_HOME: codexHome({ provisioned: false }),
      ANTHROPIC_API_KEY: "anthropic-key"
    }

    const resolved = await Effect.runPromise(resolve(environment, "anthropic:claude-sonnet-4-5"))

    expect((await prepared(resolved, "claude-sonnet-4-5")).url).toBe("https://api.anthropic.com/v1/messages")
  })
})

describe("NodeControl.seatResolver OpenAI-compatible providers", () => {
  it.each(
    [
      ["moonshot", "moonshot:kimi-k3", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/chat/completions"],
      [
        "gemini",
        "gemini:gemini-2.5-pro",
        "GEMINI_API_KEY",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      ],
      [
        "gemini via GOOGLE_API_KEY",
        "gemini:gemini-2.5-pro",
        "GOOGLE_API_KEY",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      ],
      ["cerebras", "cerebras:qwen-3.8-27b", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/chat/completions"]
    ] as const
  )("routes a keyed %s seat through Chat Completions at its own endpoint", async (_provider, seat, variable, url) => {
    const resolved = await Effect.runPromise(resolve({ [variable]: "key" }, seat))

    expect(resolved.id).toBe(seat)
    const request = await prepared(resolved, Seat.modelIdOf(seat))
    expect(request.url).toBe(url)
    expect(JSON.stringify(request.publicHeaders)).not.toContain("key")
  })

  it("names every variable the provider reads when none is set", async () => {
    const gemini = await Effect.runPromise(Effect.flip(resolve({ GEMINI_API_KEY: "" }, "gemini:gemini-2.5-pro")))
    const moonshot = await Effect.runPromise(Effect.flip(resolve({}, "moonshot:kimi-k3")))

    expect(gemini.message).toBe("Set GEMINI_API_KEY or GOOGLE_API_KEY to run the gemini:gemini-2.5-pro seat")
    expect(moonshot.message).toBe("Set MOONSHOT_API_KEY to run the moonshot:kimi-k3 seat")
  })
})

describe("NodeControl.seatResolver Claude subscription tokens", () => {
  it.each(["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const)(
    "routes an anthropic seat on %s as a Claude Code bearer when no API key is set",
    async (variable) => {
      const resolved = await Effect.runPromise(
        resolve({ [variable]: "sk-ant-oat01-subscription" }, "anthropic:claude-sonnet-4-6")
      )
      const request = await prepared(resolved, resolved.modelId)

      expect(request.url).toBe("https://api.anthropic.com/v1/messages")
      expect(request.publicHeaders["anthropic-beta"]).toBe("oauth-2025-04-20")
      expect(JSON.parse(request.bodyText).system[0].text).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude."
      )
      expect(JSON.stringify(request)).not.toContain("sk-ant-oat01-subscription")
    }
  )

  it("prefers ANTHROPIC_API_KEY over a subscription token", async () => {
    const resolved = await Effect.runPromise(
      resolve({ ANTHROPIC_API_KEY: "api-key", ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-x" }, "anthropic:claude-sonnet-4-6")
    )
    const request = await prepared(resolved, resolved.modelId)

    expect(request.publicHeaders["anthropic-beta"]).toBeUndefined()
    expect(JSON.parse(request.bodyText).system).toBeUndefined()
  })
})

describe("NodeControl.seatResolver behind SMITHERS_MODEL_PROXY_URL", () => {
  const proxy = "https://cloud.example.test/api/model/"

  it.each(
    [
      [
        "anthropic:claude-sonnet-4-5",
        "ANTHROPIC_API_KEY",
        "https://cloud.example.test/api/model/anthropic/v1/messages"
      ],
      ["claude-opus-4-1", "ANTHROPIC_API_KEY", "https://cloud.example.test/api/model/anthropic/v1/messages"],
      ["openai:gpt-5.6-sol", "OPENAI_API_KEY", "https://cloud.example.test/api/model/openai/v1/responses"],
      [
        "openrouter:openai/gpt-5.6-sol",
        "OPENROUTER_API_KEY",
        "https://cloud.example.test/api/model/openrouter/v1/responses"
      ],
      [
        "cerebras:qwen-3.8-27b",
        "CEREBRAS_API_KEY",
        "https://cloud.example.test/api/model/cerebras/v1/chat/completions"
      ],
      ["moonshot:kimi-k3", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/chat/completions"]
    ] as const
  )("sends a %s seat to the proxied origin", async (seat, variable, url) => {
    const resolved = await Effect.runPromise(
      resolve({ SMITHERS_MODEL_PROXY_URL: proxy, [variable]: "cloud-token" }, seat)
    )

    const request = await prepared(resolved, resolved.modelId)
    expect(request.url).toBe(url)
    expect(JSON.stringify(request.publicHeaders)).not.toContain("cloud-token")
  })

  it("sends a ChatGPT-mode openai seat to the proxied ChatGPT backend with the proxy credential", async () => {
    const resolved = await Effect.runPromise(
      resolve(
        { SMITHERS_MODEL_PROXY_URL: proxy, SMITHERS_OPENAI_AUTH: "chatgpt", OPENAI_API_KEY: "cloud-token" },
        "openai:gpt-6-luna"
      )
    )

    const request = await prepared(resolved, resolved.modelId)
    expect(request.url).toBe("https://cloud.example.test/api/model/chatgpt/codex/responses")
    expect(JSON.stringify(request)).not.toContain("cloud-token")
    expect(request.publicHeaders.originator).toBe("codex_cli_rs")
  })

  it("refuses a ChatGPT-mode seat behind the proxy without the proxy credential", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolve({ SMITHERS_MODEL_PROXY_URL: proxy, SMITHERS_OPENAI_AUTH: "chatgpt" }, "openai:gpt-6-luna"))
    )

    expect(error.message).toBe("Set OPENAI_API_KEY to run the openai:gpt-6-luna seat through SMITHERS_MODEL_PROXY_URL")
  })

  it("treats an empty proxy variable as unset", async () => {
    const resolved = await Effect.runPromise(
      resolve({ SMITHERS_MODEL_PROXY_URL: "", ANTHROPIC_API_KEY: "key" }, "anthropic:claude-sonnet-4-5")
    )

    expect((await prepared(resolved, resolved.modelId)).url).toBe("https://api.anthropic.com/v1/messages")
  })
})

describe("NodeControl.seatResolver aliases", () => {
  it.each(
    [
      ["sol", "gpt-6-sol", "https://api.openai.com/v1/responses"],
      ["astra", "gpt-6-astra", "https://api.openai.com/v1/responses"],
      ["luna", "gpt-6-luna", "https://api.openai.com/v1/responses"],
      ["opus", "claude-opus-5-5", "https://api.anthropic.com/v1/messages"],
      ["fable", "claude-fable-5-1", "https://api.anthropic.com/v1/messages"],
      ["Luna ", "gpt-6-luna", "https://api.openai.com/v1/responses"]
    ] as const
  )("resolves %j to its provider's route and keeps the declared id", async (alias, modelId, url) => {
    const resolved = await Effect.runPromise(resolve(keyed, alias))

    expect(resolved.id).toBe(alias)
    expect(resolved.modelId).toBe(modelId)
    expect((await prepared(resolved, resolved.modelId)).url).toBe(url)
  })

  it("reads the aliased provider's credential, naming the expanded seat", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({ ANTHROPIC_API_KEY: "k" }, "luna")))

    expect(error.message).toBe("Set OPENAI_API_KEY to run the openai:gpt-6-luna seat")
  })

  it.each(["jev", "typesafe-ai/jev", "openrouter:typesafe-ai/jev"])("refuses %j as an agent seat", async (seat) => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, seat)))

    expect(error.seat).toBe(seat)
    expect(error.message).toContain("classifier")
  })
})
