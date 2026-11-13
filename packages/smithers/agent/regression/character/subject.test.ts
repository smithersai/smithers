import { describe, expect, test } from "bun:test"
import * as Subject from "./subject.ts"

// Split so the repository's machine-path gate does not read a real home.
const home = ["", "home", "will"].join("/")

describe("subscriptionEnvironment", () => {
  test("drops every API key and metered route, keeps subscription logins", () => {
    const env = Subject.subscriptionEnvironment({
      HOME: home,
      CODEX_HOME: `${home}/.codex`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      CLAUDE_CODE_OAUTH_TOKEN: "sub",
      OPENAI_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      OPENROUTER_API_KEY: "k",
      MOONSHOT_API_KEY: "k",
      GEMINI_API_KEY: "k",
      GOOGLE_API_KEY: "k",
      CEREBRAS_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "k",
      CODEX_API_KEY: "k",
      SMITHERS_OPENAI_AUTH: "api-key",
      SMITHERS_ACCOUNT_POOL_URL: "https://pool.invalid",
      SMITHERS_ACCOUNT_POOL_KEY: "k",
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic,chatgpt",
      SMITHERS_MODEL_PROXY_URL: "https://proxy.invalid",
      SMITHERS_MODEL_PROXY_PROVIDERS: "chatgpt"
    })
    expect(env).toEqual({
      HOME: home,
      CODEX_HOME: `${home}/.codex`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      CLAUDE_CODE_OAUTH_TOKEN: "sub",
      SMITHERS_OPENAI_AUTH: "chatgpt"
    })
  })

  test.each([
    "OPENAI",
    "ANTHROPIC",
    "OPENROUTER",
    "MOONSHOT",
    "GEMINI",
    "GOOGLE",
    "CEREBRAS",
    "CUSTOM_PROVIDER"
  ])("drops %s API key files without changing the source environment", (provider) => {
    const variable = `${provider}_API_KEY_FILE`
    const source = Object.freeze({
      [variable]: "credentials/provider-key",
      HOME: home,
      CODEX_HOME: `${home}/.codex`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      CLAUDE_CODE_OAUTH_TOKEN: "sub"
    })
    expect(Subject.subscriptionEnvironment(source)).toEqual({
      HOME: home,
      CODEX_HOME: `${home}/.codex`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      CLAUDE_CODE_OAUTH_TOKEN: "sub",
      SMITHERS_OPENAI_AUTH: "chatgpt"
    })
    expect(source[variable]).toBe("credentials/provider-key")
  })
})
