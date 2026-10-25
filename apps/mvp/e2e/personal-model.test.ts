import { afterEach, expect, test } from "vitest"
import { personalModelConfig } from "./personal-model"

const names = ["E2E_PERSONAL_MODEL_PROTOCOL", "E2E_PERSONAL_MODEL_BASE_URL", "E2E_PERSONAL_MODEL_ID", "E2E_PERSONAL_MODEL_KEY"] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name]
    else process.env[name] = original[name]
  }
})

test("personal model defaults and overrides contain configuration only, never the credential", () => {
  for (const name of names) delete process.env[name]
  process.env.E2E_PERSONAL_MODEL_KEY = "test-only-secret"
  expect(personalModelConfig()).toEqual({ protocol: "openai-chat", baseUrl: "https://api.openai.com", modelId: "gpt-4.1-mini" })
  process.env.E2E_PERSONAL_MODEL_PROTOCOL = "anthropic-messages"
  process.env.E2E_PERSONAL_MODEL_BASE_URL = "https://api.anthropic.com"
  process.env.E2E_PERSONAL_MODEL_ID = "custom-model"
  expect(personalModelConfig()).toEqual({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", modelId: "custom-model" })
  process.env.E2E_PERSONAL_MODEL_PROTOCOL = "invalid"
  expect(() => personalModelConfig()).toThrow("E2E_PERSONAL_MODEL_PROTOCOL must be openai-chat or anthropic-messages")
})
