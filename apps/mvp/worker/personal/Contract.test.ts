// The personal model contract's routing and checks, pure (src/features/personal-model/contract.ts): the order a list is
// read in, who writes a `todo` run, and what a save may keep. The routes prove the same rules end to end
// (worker/personal/Connections.test.ts); here every branch is on the table at once.
import { describe, expect, test } from "vitest"
import {
  checkSave,
  codingChoice,
  type ConnectionKind,
  DEFAULTS,
  isConnectionKind,
  jevOf,
  MAX_CONNECTIONS,
  resolveTier,
  type SavedConnection,
  writeExecutionId,
} from "../../src/features/personal-model/contract.ts"

const row = (id: string, kind: ConnectionKind, fields: Partial<SavedConnection> = {}): SavedConnection => ({
  id,
  kind,
  active: true,
  protocol: null,
  baseUrl: null,
  fastModel: null,
  implementModel: null,
  hardModel: null,
  ...fields,
})
const key = (id: string, fields: Partial<SavedConnection> = {}) =>
  row(id, "api_key", { protocol: "openai-chat", baseUrl: "https://models.example.com", ...fields })
const claude = (id = "claude", fields: Partial<SavedConnection> = {}) => row(id, "claude_subscription", fields)
const codex = (id = "codex", fields: Partial<SavedConnection> = {}) => row(id, "codex_subscription", fields)

describe("codingChoice", () => {
  test("an empty list, or one with nothing active, is the Smithers agent", () => {
    expect(codingChoice([])).toEqual({ agent: "smithers", connectionId: undefined })
    expect(codingChoice([claude("c", { active: false }), key("k", { active: false })]))
      .toEqual({ agent: "smithers", connectionId: undefined })
  })

  test("the first subscription wins, by the agent its kind runs", () => {
    expect(codingChoice([claude()])).toEqual({ agent: "claude-code", connectionId: "claude" })
    expect(codingChoice([codex(), claude()])).toEqual({ agent: "codex", connectionId: "codex" })
    expect(codingChoice([claude(), codex()])).toEqual({ agent: "claude-code", connectionId: "claude" })
  })

  test("a connection that serves `implement` ahead of a subscription keeps the Smithers agent", () => {
    expect(codingChoice([key("k", { implementModel: "m" }), claude()])).toEqual({ agent: "smithers", connectionId: undefined })
    // By its host's preset as much as by name.
    const openai = key("k", { baseUrl: "https://api.openai.com" })
    expect(codingChoice([openai, claude()])).toEqual({ agent: "smithers", connectionId: undefined })
  })

  test("a connection that doesn't serve `implement` is passed over, as a Jev or an inactive one is", () => {
    expect(codingChoice([key("k", { fastModel: "m" }), claude()]).agent).toBe("claude-code")
    expect(codingChoice([row("j", "jev"), claude()]).agent).toBe("claude-code")
    expect(codingChoice([key("k", { implementModel: "m", active: false }), claude()]).agent).toBe("claude-code")
    expect(codingChoice([claude("c", { active: false }), codex()]).agent).toBe("codex")
  })

  test("a model alone is the Smithers agent, on that tier's model", () => {
    expect(codingChoice([key("k", { fastModel: "m" })])).toEqual({ agent: "smithers", connectionId: undefined })
  })
})

describe("jevOf", () => {
  test("the active Jev connection, none when it is off or absent", () => {
    const jev = row("j", "jev")
    expect(jevOf([key("k"), jev])).toBe(jev)
    expect(jevOf([row("off", "jev", { active: false }), jev])).toBe(jev)
    expect(jevOf([row("off", "jev", { active: false })])).toBeUndefined()
    expect(jevOf([])).toBeUndefined()
  })
})

describe("resolveTier", () => {
  test("names beat presets within a tier, and each tier's fallbacks are read in turn", () => {
    const openai = key("o", { baseUrl: "https://api.openai.com" })
    const named = key("n", { fastModel: "named" })
    expect(resolveTier([openai, named], "fast")).toMatchObject({ connectionId: "n", modelId: "named", preset: false })
    expect(resolveTier([openai], "fast")).toEqual({ tier: "fast", connectionId: "o", protocol: "openai-chat", modelId: "gpt-6-luna", preset: true })
    expect(resolveTier([key("h", { hardModel: "strong" })], "fast")).toMatchObject({ tier: "hard", modelId: "strong" })
  })

  test("a subscription, a Jev or an inactive connection serves no tier", () => {
    expect(resolveTier([claude(), row("j", "jev"), key("k", { fastModel: "m", active: false })], "fast")).toBeUndefined()
    expect(resolveTier([], "hard")).toBeUndefined()
  })

  test("a preset needs both its host and its protocol", () => {
    expect(resolveTier([key("o", { baseUrl: "https://api.anthropic.com" })], "hard")).toBeUndefined()
  })
})

describe("checkSave", () => {
  const api = { kind: "api_key", protocol: "openai-chat", baseUrl: "https://models.example.com", key: "k".repeat(16) }

  test("a kept connection needs its id, kind, protocol and base URL unchanged", () => {
    const saved = [{ id: "a", kind: "api_key" as const, protocol: "openai-chat" as const, baseUrl: "https://models.example.com" }]
    const { key: _key, ...kept } = api
    expect(checkSave({ connections: [{ ...kept, id: "a" }] }, saved)).toMatchObject({ connections: [{ id: "a", key: undefined }] })
    expect(checkSave({ connections: [{ ...kept, id: "b" }] }, saved)).toBe("key_required")
    expect(checkSave({ connections: [{ ...kept, id: "a", protocol: "anthropic-messages" }] }, saved)).toBe("key_required")
    expect(checkSave({ connections: [{ ...kept, id: "a", baseUrl: "https://else.example.com" }] }, saved)).toBe("key_required")
    expect(checkSave({ connections: [{ ...kept, id: "a", key: "" }] }, saved)).toMatchObject({ connections: [{ key: undefined }] })
  })

  test("an empty id is a new connection, and active defaults to true", () => {
    expect(checkSave({ connections: [{ ...api, id: "" }] }, [])).toMatchObject({ connections: [{ id: undefined, active: true }] })
    expect(checkSave({ connections: [{ ...api, active: false }] }, [])).toMatchObject({ connections: [{ active: false }] })
  })

  test("the list holds one to MAX_CONNECTIONS, a single kind's second active counts only when active", () => {
    expect(checkSave({ connections: [] }, [])).toBe("invalid")
    expect(checkSave({ connections: Array.from({ length: MAX_CONNECTIONS }, () => api) }, [])).toMatchObject({})
    expect(checkSave({ connections: Array.from({ length: MAX_CONNECTIONS + 1 }, () => api) }, [])).toBe("invalid")
    const jev = { kind: "jev", key: "j".repeat(16) }
    expect(checkSave({ connections: [{ ...jev, active: false }, jev] }, [])).toMatchObject({ connections: [{}, {}] })
    expect(checkSave({ connections: [jev, jev] }, [])).toBe("invalid")
    // Two model connections are as many as the person likes.
    expect(checkSave({ connections: [api, api] }, [])).toMatchObject({ connections: [{}, {}] })
  })

  test("Moonshot's fields come from the defaults it is given", () => {
    const defaults = { moonshot: { baseUrl: "https://kimi.example.com/v1", modelId: "kimi-test" } }
    expect(checkSave({ connections: [{ kind: "moonshot", key: "k".repeat(16) }] }, [], undefined, defaults)).toMatchObject({
      connections: [{
        protocol: "openai-chat",
        baseUrl: "https://kimi.example.com",
        models: { fast: "kimi-test", implement: "kimi-test", hard: "kimi-test" },
      }],
    })
    expect(checkSave({ connections: [{ kind: "moonshot", key: "k".repeat(16) }] }, [])).toMatchObject({
      connections: [{ baseUrl: DEFAULTS.moonshot.baseUrl }],
    })
    expect(checkSave({ connections: [{ kind: "moonshot", key: "k".repeat(16) }] }, [], undefined, {
      moonshot: { baseUrl: "http://not-https.example.com", modelId: "m" },
    })).toBe("invalid_base_url")
  })

  test("a sent key's text is checked before its length and its prefix", () => {
    expect(checkSave({ connections: [{ ...api, key: "short" }] }, [])).toBe("too_short")
    expect(checkSave({ connections: [{ ...api, key: "short" }] }, [], () => "control_character")).toBe("control_character")
    expect(checkSave({ connections: [{ kind: "claude_subscription", key: "x".repeat(16) }] }, [])).toBe("invalid_token")
  })
})

test("the small names", () => {
  expect(isConnectionKind("jev")).toBe(true)
  expect(isConnectionKind("gemini")).toBe(false)
  expect(writeExecutionId("link", "x")).toBe("model-link:x")
})
