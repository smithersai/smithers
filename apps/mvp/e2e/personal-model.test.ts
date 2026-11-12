import { afterEach, expect, test } from "vitest"
import { checkSave } from "../src/features/personal-model/contract"
import { fixtureConnections, isFixture, personalModelConfig, type SavedRow } from "./personal-model"

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

const config = { protocol: "openai-chat", baseUrl: "https://api.openai.com", modelId: "gpt-4.1-mini" } as const
const key = "test-only-secret"
const row = (fields: Partial<SavedRow> & Pick<SavedRow, "id" | "kind" | "position">): SavedRow => ({
  active: "t",
  protocol: null,
  base_url: null,
  fast_model: null,
  key_last4: null,
  updated_at: "2026-11-12T00:00:00Z",
  ...fields,
})
const apiKey = row({ id: "a", kind: "api_key", position: "0", protocol: "openai-chat", base_url: "https://api.openai.com", fast_model: "gpt-4.1-mini", key_last4: "cret" })
const codex = row({ id: "c0dex", kind: "codex_subscription", position: "1", key_last4: "9z9z" })
const claude = row({ id: "c1aude", kind: "claude_subscription", position: "2", key_last4: "oat1" })
const asSaved = (rows: ReadonlyArray<SavedRow>) =>
  rows.map((each) => ({ id: each.id, kind: each.kind as never, protocol: each.protocol as never, baseUrl: each.base_url }))

test("a restore keeps the hand-linked Codex subscription by its id, without a key, and drops what a run left", () => {
  const connections = fixtureConnections([claude, codex, apiKey], config, key)
  expect(connections).toEqual([
    { kind: "api_key", protocol: "openai-chat", baseUrl: "https://api.openai.com", key, models: { fast: "gpt-4.1-mini" } },
    { id: "c0dex", kind: "codex_subscription", active: true },
  ])
  // The server keeps a connection's credential only when it is the saved one: the Codex tokens stay sealed where they are.
  const checked = checkSave({ connections }, asSaved([claude, codex, apiKey]))
  expect(typeof checked === "string" ? checked : checked.connections.map(({ id, kind, key }) => ({ id, kind, key }))).toEqual([
    { id: undefined, kind: "api_key", key },
    { id: "c0dex", kind: "codex_subscription", key: undefined },
  ])
  expect(fixtureConnections([row({ ...codex, active: "f" })], config, key)[1]).toEqual({ id: "c0dex", kind: "codex_subscription", active: false })
})

test("the fixture is the configured key first, then nothing but a linked Codex subscription", () => {
  expect(isFixture([apiKey], config, key)).toBe(true)
  expect(isFixture([codex, apiKey], config, key)).toBe(true)
  expect(isFixture([apiKey, codex, claude], config, key)).toBe(false)
  expect(isFixture([{ ...codex, position: "0" }, { ...apiKey, position: "1" }], config, key)).toBe(false)
  expect(isFixture([{ ...apiKey, active: "f" }], config, key)).toBe(false)
  expect(isFixture([{ ...apiKey, key_last4: "else" }], config, key)).toBe(false)
  expect(isFixture([], config, key)).toBe(false)
})
