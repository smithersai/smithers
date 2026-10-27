import { expect, test } from "vitest"
import type { SavedKey } from "./contract"
import { testDraftProblem } from "./testDraft"
import type { SaveForm } from "./view"

const saved: ReadonlyArray<SavedKey> = [{ protocol: "openai-chat", baseUrl: "https://api.openai.com", fastModel: "gpt-test", implementModel: null, hardModel: null }]
const draft: SaveForm = { keys: [{ protocol: "openai-chat", baseUrl: "https://api.openai.com/v1/", key: "" }], models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } } }

test("Test validates draft URLs and missing fields before testing a saved model", () => {
  for (const baseUrl of ["not a url", "https://exa mple.test/v1"]) {
    expect(testDraftProblem({ ...draft, keys: [{ ...draft.keys[0]!, baseUrl }] }, saved)).toBe("invalid_base_url")
  }
  expect(testDraftProblem({ keys: [], models: {} }, saved)).toBe("invalid")
  expect(testDraftProblem({ ...draft, keys: [{ ...draft.keys[0]!, key: "short" }] }, saved)).toBe("too_short")
})

test("Test requires saving any changed key, URL, tier or removed protocol", () => {
  expect(testDraftProblem({ ...draft, keys: [{ ...draft.keys[0]!, key: "sk-new-key-sentinel" }] }, saved)).toBe("unsaved")
  expect(testDraftProblem({ ...draft, keys: [{ ...draft.keys[0]!, baseUrl: "https://other.example.com", key: "sk-new-key-sentinel" }] }, saved)).toBe("unsaved")
  expect(testDraftProblem(draft, [{ ...saved[0]!, baseUrl: "https://other.example.com" }])).toBe("key_required")
  expect(testDraftProblem(draft, [...saved, { ...saved[0]!, protocol: "anthropic-messages" }])).toBe("unsaved")
  expect(testDraftProblem({ ...draft, models: { fast: { protocol: "openai-chat", modelId: "changed" } } }, saved)).toBe("unsaved")
  expect(testDraftProblem({ ...draft, models: {} }, saved)).toBe("unsaved")
  expect(testDraftProblem(draft, saved)).toBeUndefined()
  const both = [...saved, { ...saved[0]!, protocol: "anthropic-messages" as const, baseUrl: "https://api.anthropic.com", fastModel: null, hardModel: "claude-test" }]
  expect(testDraftProblem({ keys: [...draft.keys, { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", key: "" }], models: { ...draft.models, hard: { protocol: "anthropic-messages", modelId: "claude-test" } } }, both)).toBeUndefined()
})
