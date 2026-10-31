import { expect, test } from "vitest"
import type { SavedConnection } from "./contract"
import { testDraftProblem } from "./testDraft"
import type { SaveForm } from "./view"

const saved: ReadonlyArray<SavedConnection> = [{
  id: "connection-1",
  kind: "api_key",
  active: true,
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com",
  fastModel: "gpt-test",
  implementModel: null,
  hardModel: null,
}]
const kept = { id: "connection-1", kind: "api_key", protocol: "openai-chat", baseUrl: "https://api.openai.com/v1/", models: { fast: "gpt-test" } }
const draft: SaveForm = { connections: [kept] }
const anthropic: SavedConnection = {
  ...saved[0]!,
  id: "connection-2",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  fastModel: null,
  hardModel: "claude-test",
}
const keptAnthropic = { id: "connection-2", kind: "api_key", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: { hard: "claude-test" } }

test("Test validates a list's URLs and fields before testing a saved connection", () => {
  for (const baseUrl of ["not a url", "https://exa mple.test/v1"]) {
    expect(testDraftProblem({ connections: [{ ...kept, baseUrl }] }, saved)).toBe("invalid_base_url")
  }
  expect(testDraftProblem({ connections: [] }, saved)).toBe("invalid")
  expect(testDraftProblem({ connections: [{ ...kept, key: "short" }] }, saved)).toBe("too_short")
})

test("Test requires saving any changed key, URL, tier, order, activity or removed connection", () => {
  expect(testDraftProblem({ connections: [{ ...kept, key: "sk-new-key-sentinel" }] }, saved)).toBe("unsaved")
  expect(testDraftProblem({ connections: [{ ...kept, baseUrl: "https://other.example.com", key: "sk-new-key-sentinel" }] }, saved)).toBe("unsaved")
  expect(testDraftProblem(draft, [{ ...saved[0]!, baseUrl: "https://other.example.com" }])).toBe("key_required")
  expect(testDraftProblem(draft, [...saved, anthropic])).toBe("unsaved")
  expect(testDraftProblem({ connections: [{ ...kept, models: { fast: "changed" } }] }, saved)).toBe("unsaved")
  expect(testDraftProblem({ connections: [{ ...kept, models: {} }] }, saved)).toBe("unsaved")
  expect(testDraftProblem({ connections: [{ ...kept, active: false }] }, saved)).toBe("unsaved")
  expect(testDraftProblem({ connections: [keptAnthropic, kept] }, [...saved, anthropic])).toBe("unsaved")
})

test("a list that is the saved one, in its order, passes, a Kimi connection's deployment endpoint included", () => {
  expect(testDraftProblem(draft, saved)).toBeUndefined()
  expect(testDraftProblem({ connections: [kept, keptAnthropic] }, [...saved, anthropic])).toBeUndefined()
  const kimi: SavedConnection = {
    ...saved[0]!,
    id: "connection-3",
    kind: "moonshot",
    baseUrl: "https://api.moonshot.cn",
    fastModel: "kimi-k3",
    implementModel: "kimi-k3",
    hardModel: "kimi-k3",
  }
  const models = { fast: "kimi-k3", implement: "kimi-k3", hard: "kimi-k3" }
  expect(testDraftProblem({ connections: [{ id: "connection-3", kind: "moonshot", models }] }, [kimi])).toBeUndefined()
})
