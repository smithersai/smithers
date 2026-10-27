// What the Your model section show (docs/features/personal-model.md#the-settings-section), as the pure
// rules their views read: who sees the section, the one status line, when a write landed, what each key and tier field
// shows, what the form sends, when the buttons wait, and how failures read. Every word is checked here too.
import { describe, expect, test } from "vitest"
import { MODEL_TIERS } from "../model/contract"
import { PROTOCOLS, REFUSALS } from "./contract"
import {
  BASE_URL_PLACEHOLDER,
  codeText,
  keyPlaceholder,
  LATE,
  OK,
  PROTOCOL_LABEL,
  REFUSAL_COPY,
  REMOVING,
  SAVING,
  TIER_LABEL,
  tierKeyLabel,
  UNKNOWN,
  YOUR_MODEL,
} from "./copy"
import { type Form, type FormState, type PersonalModelRow, rowIsSavedKey, type TestRow, testResultMatchesContract } from "./schema"
import {
  awaiting,
  busy,
  canSave,
  FIELDS,
  keyOf,
  landed,
  lastFailure,
  latestUpdate,
  onItsWay,
  readForm,
  refusalText,
  statusOf,
  testText,
  tierView,
} from "./view"

const row = (fields: Partial<PersonalModelRow> = {}): PersonalModelRow => ({
  personId: "person-member",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com",
  fastModel: "gpt-5",
  implementModel: null,
  hardModel: null,
  keyLast4: "x7Qz",
  failureStatus: null,
  failedAt: null,
  updatedAt: "2026-10-24T10:00:00.000Z",
  ...fields,
})

const failed = (fields: Partial<PersonalModelRow> = {}) =>
  row({ failureStatus: 401, failedAt: "2026-10-24T11:00:00.000Z", ...fields })

const form = (fields: Partial<Form> = {}): Form => ({
  id: "form",
  op: "save",
  state: "sending",
  failure: null,
  before: null,
  sent: {
    keys: [{ protocol: "openai-chat", baseUrl: "https://api.openai.com" }],
    models: { fast: { protocol: "openai-chat", modelId: "gpt-5" } },
  },
  saved: 0,
  quiet: false,
  ...fields,
})

const tested = (fields: Partial<TestRow> = {}): TestRow => ({
  id: "test",
  state: "done",
  result: { ok: true, latencyMs: 300, sample: "ok" },
  failure: null,
  failedAt: null,
  ...fields,
})

const STATES: ReadonlyArray<FormState> = ["sending", "confirming", "late", "done", "failed", "unknown"]

describe("who saves a model", () => {
  test("a person signed in as a Member or above; nobody else, nor anyone while sign-in doesn't know", () => {
    const seen = (status: string, role: "admin" | "maintainer" | "member" | "guest" | null) => canSave({ status, role })
    expect([seen("signed_in", "admin"), seen("signed_in", "maintainer"), seen("signed_in", "member")]).toEqual([true, true, true])
    expect([seen("signed_in", "guest"), seen("signed_in", null), seen("signed_out", null), seen("loading", null)]).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(canSave(undefined)).toBe(false)
  })
})

describe("a write's state", () => {
  test("on its way while sent or taken; awaited while taken, late or unknown", () => {
    expect(STATES.filter((state) => onItsWay({ state }))).toEqual(["sending", "confirming"])
    expect(STATES.filter((state) => awaiting({ state }))).toEqual(["confirming", "late", "unknown"])
  })

  test("a remove landed once there are no rows", () => {
    expect(landed(form({ op: "remove", sent: null }), [])).toBe(true)
    expect(landed(form({ op: "remove", sent: null }), [row()])).toBe(false)
  })

  test("a save landed once the rows have what it sent and a new latest updatedAt; the server's clock is never compared", () => {
    const before = "2026-10-24T10:00:00.000Z"
    const later = { updatedAt: "2026-10-24T10:00:05.000Z" }
    expect(landed(form({ before: null }), [])).toBe(false)
    expect(landed(form({ before: null }), [row()])).toBe(true)
    expect(landed(form({ before }), [row()])).toBe(false)
    expect(landed(form({ before }), [row(later)])).toBe(true)
    // Another device's save, with other values, isn't this one.
    expect(landed(form({ before }), [row({ ...later, protocol: "anthropic-messages" })])).toBe(false)
    expect(landed(form({ before }), [row({ ...later, baseUrl: "https://api.anthropic.com" })])).toBe(false)
    expect(landed(form({ before }), [row({ ...later, fastModel: "gpt-5-mini" })])).toBe(false)
    expect(landed(form({ before }), [row({ ...later, implementModel: "gpt-5" })])).toBe(false)
    expect(landed(form({ before, sent: null }), [row(later)])).toBe(false)
    // A key it left out is still there: not yet.
    expect(landed(form({ before }), [row(later), row({ ...later, protocol: "anthropic-messages", fastModel: null })])).toBe(false)
  })

  test("a save of two keys landed once each has its row and its tiers, wherever they are", () => {
    const before = "2026-10-24T10:00:00.000Z"
    const sent: Form["sent"] = {
      keys: [{ protocol: "openai-chat", baseUrl: "https://api.openai.com" }, {
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }],
      models: {
        fast: { protocol: "anthropic-messages", modelId: "claude-haiku-4-5" },
        implement: { protocol: "openai-chat", modelId: "gpt-6.1-sol" },
      },
    }
    const openai = row({ fastModel: null, implementModel: "gpt-6.1-sol", updatedAt: "2026-10-24T10:00:05.000Z" })
    const anthropic = row({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", fastModel: "claude-haiku-4-5" })
    expect(landed(form({ before, sent }), [anthropic, openai])).toBe(true)
    // One key still missing, or Fast still on the other key.
    expect(landed(form({ before, sent }), [openai])).toBe(false)
    expect(landed(form({ before, sent }), [{ ...anthropic, fastModel: null }, { ...openai, fastModel: "claude-haiku-4-5" }]))
      .toBe(false)
    // Neither row moved past `before`.
    expect(landed(form({ before: "2026-10-24T10:00:05.000Z", sent }), [anthropic, openai])).toBe(false)
  })

  test("the latest updatedAt across the rows, none with no row", () => {
    expect(latestUpdate([])).toBeNull()
    expect(latestUpdate([row({ updatedAt: "2026-10-24T10:00:05.000Z" }), row()])).toBe("2026-10-24T10:00:05.000Z")
    expect(latestUpdate([row(), row({ updatedAt: "2026-10-24T10:00:05.000Z" })])).toBe("2026-10-24T10:00:05.000Z")
  })

  test("the buttons wait while a write is on its way or a test runs", () => {
    expect(busy(undefined, undefined)).toBe(false)
    expect(STATES.filter((state) => busy(form({ state }), undefined))).toEqual(["sending", "confirming"])
    expect(busy(undefined, tested({ state: "testing", result: null }))).toBe(true)
    expect(busy(form({ state: "done" }), tested())).toBe(false)
  })
})

describe("what each key and tier field shows", () => {
  const anthropic = (fields: Partial<PersonalModelRow> = {}) =>
    row({ protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", fastModel: null, ...fields })

  test("a key's fields show its saved row, by protocol", () => {
    expect(keyOf([row(), anthropic()], "anthropic-messages")).toMatchObject({ baseUrl: "https://api.anthropic.com" })
    expect(keyOf([row()], "anthropic-messages")).toBeUndefined()
  })

  test("with nothing saved, a tier shows nothing and starts on the first protocol", () => {
    for (const tier of MODEL_TIERS) {
      expect(tierView([], tier)).toEqual({ model: "", placeholder: undefined, protocol: "openai-chat" })
    }
  })

  test("a named tier shows its model; a tier left empty shows, as its placeholder, the preset its key's host has", () => {
    const rows = [row()]
    expect(tierView(rows, "fast")).toEqual({ model: "gpt-5", placeholder: "gpt-6-luna", protocol: "openai-chat" })
    expect(tierView(rows, "implement")).toEqual({ model: "", placeholder: "gpt-6.1-sol", protocol: "openai-chat" })
    expect(tierView(rows, "hard")).toEqual({ model: "", placeholder: "gpt-6-astra", protocol: "openai-chat" })
  })

  test("with both providers' keys and nothing named, each tier's preset picks its key", () => {
    const rows = [anthropic(), row({ fastModel: null })]
    expect(tierView(rows, "fast")).toEqual({ model: "", placeholder: "claude-haiku-4-5", protocol: "anthropic-messages" })
    expect(tierView(rows, "implement")).toEqual({ model: "", placeholder: "gpt-6.1-sol", protocol: "openai-chat" })
    expect(tierView(rows, "hard")).toEqual({ model: "", placeholder: "claude-opus-5-5", protocol: "anthropic-messages" })
  })

  test("at a host with no preset, an empty tier shows the tier it falls back to; a key nothing names starts the select", () => {
    const rows = [row({ baseUrl: "https://models.example.com", fastModel: "m-1" })]
    expect(tierView(rows, "fast")).toEqual({ model: "m-1", placeholder: undefined, protocol: "openai-chat" })
    expect(tierView(rows, "implement")).toEqual({ model: "", placeholder: "m-1", protocol: "openai-chat" })
    expect(tierView([anthropic({ baseUrl: "https://gateway.example.com", hardModel: "h-1" })], "implement")).toEqual({
      model: "",
      placeholder: "h-1",
      protocol: "anthropic-messages",
    })
    // Nothing would answer it, and its key is the only one saved.
    expect(tierView([anthropic({ baseUrl: "https://gateway.example.com", implementModel: "i-1" })], "implement")).toEqual({
      model: "i-1",
      placeholder: undefined,
      protocol: "anthropic-messages",
    })
    expect(tierView([anthropic({ baseUrl: "https://gateway.example.com" })], "fast")).toEqual({
      model: "",
      placeholder: undefined,
      protocol: "anthropic-messages",
    })
  })
})

describe("what the form sends", () => {
  test("each key whose base URL is filled in, with its key as typed; each tier whose model is, on its select's key", () => {
    const fields: Record<string, string> = {
      [FIELDS.baseUrl("openai-chat")]: "https://api.openai.com/v1",
      [FIELDS.key("openai-chat")]: "sk-typed",
      [FIELDS.baseUrl("anthropic-messages")]: "  ",
      [FIELDS.key("anthropic-messages")]: "ignored",
      [FIELDS.model("fast")]: " gpt-5 ",
      [FIELDS.tierKey("fast")]: "openai-chat",
      [FIELDS.model("implement")]: "",
      [FIELDS.tierKey("implement")]: "openai-chat",
      [FIELDS.model("hard")]: "claude-opus-5-5",
      [FIELDS.tierKey("hard")]: "anthropic-messages",
    }
    expect(readForm((name) => fields[name] ?? "")).toEqual({
      keys: [{ protocol: "openai-chat", baseUrl: "https://api.openai.com/v1", key: "sk-typed" }],
      models: {
        fast: { protocol: "openai-chat", modelId: " gpt-5 " },
        hard: { protocol: "anthropic-messages", modelId: "claude-opus-5-5" },
      },
    })
    expect(readForm(() => "")).toEqual({ keys: [], models: {} })
  })

  test("the fields' names", () => {
    expect([FIELDS.baseUrl("openai-chat"), FIELDS.key("anthropic-messages"), FIELDS.model("fast"), FIELDS.tierKey("hard")])
      .toEqual(["baseUrl:openai-chat", "key:anthropic-messages", "fastModel", "hardKey"])
  })
})

describe("the status line", () => {
  test("says nothing with nothing to say", () => {
    expect(statusOf([], undefined, undefined)).toEqual({ _tag: "None" })
    expect(statusOf([row()], form({ state: "done" }), undefined)).toEqual({ _tag: "None" })
  })

  test("Saving or Removing while a write is on its way, over everything else", () => {
    for (const state of ["sending", "confirming"] as const) {
      expect(statusOf([failed()], form({ state }), tested())).toEqual({ _tag: "Text", text: SAVING })
    }
    // A remove that waits, such as one pressed offline, says so while its flow tries again.
    expect(statusOf([row()], form({ op: "remove", state: "confirming" }), undefined)).toEqual({ _tag: "Text", text: REMOVING })
    expect(statusOf([row()], form({ op: "remove", state: "sending" }), undefined)).toEqual({ _tag: "Text", text: REMOVING })
  })

  test("a write's refusal, unknown outcome or lateness", () => {
    expect(statusOf([failed()], form({ state: "failed", failure: "invalid_base_url" }), undefined)).toEqual({
      _tag: "Text",
      text: "Base URLs are https:// on a public host, with no port",
    })
    expect(statusOf([row()], form({ op: "remove", state: "failed", failure: "unavailable" }), undefined)).toEqual({
      _tag: "Text",
      text: "Unavailable; try again",
    })
    expect(statusOf([], form({ state: "unknown" }), undefined)).toEqual({ _tag: "Text", text: UNKNOWN })
    expect(statusOf([row()], form({ op: "remove", state: "late" }), undefined)).toEqual({ _tag: "Text", text: LATE })
    // A test since took the line.
    expect(statusOf([row()], form({ state: "failed", failure: "invalid", quiet: true }), tested())).toEqual({
      _tag: "Text",
      text: OK,
    })
  })

  test("the last test: OK, the host and status, the host and why, or why there was none", () => {
    expect(statusOf([row()], undefined, tested())).toEqual({ _tag: "Text", text: OK })
    const result = { ok: false as const, latencyMs: 90, code: "authentication", status: 401, host: "api.openai.com" }
    expect(statusOf([row()], undefined, tested({ result }))).toEqual({ _tag: "Text", text: "api.openai.com · HTTP 401" })
    expect(statusOf([row()], undefined, tested({ result: { ...result, code: "transport", status: null } }))).toEqual({
      _tag: "Text",
      text: "api.openai.com · unreachable",
    })
    expect(statusOf([row()], undefined, tested({ state: "failed", result: null, failure: "none" }))).toEqual({
      _tag: "Text",
      text: "No model saved",
    })
    // While it runs, nothing yet.
    expect(statusOf([row()], undefined, tested({ state: "testing", result: null }))).toEqual({ _tag: "None" })
  })

  test("the row's failure, with when, unless the last test came after it", () => {
    const at = Date.parse("2026-10-24T11:00:00.000Z")
    const failure = { _tag: "Failure", text: "api.openai.com refused · HTTP 401", at }
    expect(statusOf([failed()], undefined, undefined)).toEqual(failure)
    expect(statusOf([failed({ failureStatus: 429, baseUrl: "https://openrouter.ai/api" })], undefined, undefined)).toEqual({
      ...failure,
      text: "openrouter.ai refused · HTTP 429",
    })
    // The test saw this failure: its result is newer.
    expect(statusOf([failed()], undefined, tested({ failedAt: "2026-10-24T11:00:00.000Z" }))).toEqual({ _tag: "Text", text: OK })
    // A real call failed after the test: the failure is newer.
    expect(statusOf([failed()], undefined, tested({ failedAt: null }))).toEqual(failure)
    expect(statusOf([failed()], undefined, tested({ failedAt: "2026-10-24T10:30:00.000Z" }))).toEqual(failure)
    // Of two keys' refusals, the latest: its host and status.
    const anthropic = failed({
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      failureStatus: 402,
      failedAt: "2026-10-24T12:00:00.000Z",
    })
    const latest = { _tag: "Failure", text: "api.anthropic.com refused · HTTP 402", at: Date.parse("2026-10-24T12:00:00.000Z") }
    expect(statusOf([failed(), anthropic], undefined, undefined)).toEqual(latest)
    expect(statusOf([anthropic, failed()], undefined, undefined)).toEqual(latest)
    expect(statusOf([anthropic, failed()], undefined, tested({ failedAt: "2026-10-24T11:00:00.000Z" }))).toEqual(latest)
    // A failed write's refusal is newer than either.
    expect(statusOf([failed()], form({ state: "failed", failure: "off" }), undefined)).toEqual({
      _tag: "Text",
      text: "Your own model is off on this deployment",
    })
  })
})

test("a settings failure needs both a recorded status and time", () => {
  expect(lastFailure([row(), failed({ failedAt: null })])).toBeUndefined()
})

describe("the words", () => {
  test("every refusal ChatApi answers reads in product words, never as its code", () => {
    for (const code of REFUSALS) {
      expect(refusalText(code)).toBe(REFUSAL_COPY[code])
      expect(refusalText(code).length).toBeGreaterThan(0)
      expect(refusalText(code)).not.toMatch(/[a-z]_[a-z]/)
    }
  })

  test("a failed test with no status says why in a few words; a code this build doesn't know reads failed", () => {
    for (const code of ["invalid_request", "context_overflow", "no_route", "authentication", "rate_limited", "quota_exceeded",
      "out_of_credit", "content_policy", "provider_internal", "transport", "call_timeout", "invalid_provider_output", "unusable"]) {
      expect([code, codeText(code) !== "failed" && !codeText(code).includes("_")]).toEqual([code, true])
    }
    expect([codeText("unknown"), codeText("constructor"), codeText("toString")]).toEqual(["failed", "failed", "failed"])
    expect(testText({ ok: false, latencyMs: 1, code: "call_timeout", status: null, host: "api.anthropic.com" })).toBe(
      "api.anthropic.com · timed out",
    )
  })

  test("the model id's rule, as the model package plans one", () => {
    expect(refusalText("invalid_model")).toBe("Model ids are letters, digits and . _ / : -, at most 81")
  })

  test("the heading, the protocols, their base URLs' examples, the tiers and the saved key's placeholder", () => {
    expect(YOUR_MODEL).toBe("Your model")
    expect(PROTOCOLS.map((protocol) => PROTOCOL_LABEL[protocol])).toEqual(["OpenAI-compatible", "Anthropic-compatible"])
    expect(PROTOCOLS.map((protocol) => BASE_URL_PLACEHOLDER[protocol])).toEqual([
      "https://api.openai.com",
      "https://api.anthropic.com",
    ])
    expect(MODEL_TIERS.map((tier) => [TIER_LABEL[tier], tierKeyLabel(tier)])).toEqual([
      ["Fast", "Fast key"],
      ["Implement", "Implement key"],
      ["Hard", "Hard key"],
    ])
    expect(keyPlaceholder("x7Qz")).toBe("····x7Qz")
  })

  test("the new refusals: a key to type again, a key to save, a model to name", () => {
    expect([refusalText("key_required"), refusalText("no_key"), refusalText("no_model")]).toEqual([
      "Enter the key for this base URL",
      "Save a key for that model",
      "Name a Fast model",
    ])
  })

  test("a synced row is a saved key as the tiers read it", () => {
    expect(rowIsSavedKey).toBe(true)
  })

  test("the test result's schema is the contract's type", () => {
    expect(testResultMatchesContract).toBe(true)
  })
})
