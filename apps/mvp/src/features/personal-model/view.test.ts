// What the Your model section show (docs/features/personal-model.md#the-settings-section), as the pure
// rules their views read: who sees the section, the status lines, when a write landed, what a row shows, what each press
// and form sends, when the buttons wait, and how failures read. Every word is checked here too.
import { describe, expect, test } from "vitest"
import { MODEL_TIERS } from "../model/contract"
import { CONNECTION_KINDS, PROTOCOLS, REFUSALS } from "./contract"
import {
  BASE_URL_PLACEHOLDER,
  codeText,
  KIND_LABEL,
  keyPlaceholder,
  LATE,
  LINK_EXPIRED,
  LINK_WAITING,
  OK,
  PROTOCOL_LABEL,
  REFUSAL_COPY,
  REMOVING,
  SAVING,
  TIER_LABEL,
  TIER_PURPOSE,
  UNKNOWN,
  YOUR_MODEL,
} from "./copy"
import {
  codexLinkMatchesContract,
  type Form,
  type FormState,
  type LinkRow,
  type PersonalModelRow,
  rowIsSavedConnection,
  type TestRow,
  testResultMatchesContract,
} from "./schema"
import {
  addKind,
  answers,
  awaiting,
  busy,
  canSave,
  defaultsFrom,
  FIELDS,
  landed,
  latestLink,
  latestUpdate,
  linked,
  linkView,
  listOf,
  onItsWay,
  readAdd,
  refusalText,
  rowDetail,
  rowStatusOf,
  statusOf,
  testable,
  testText,
  withActive,
  withAdded,
  withMoved,
  without,
} from "./view"

const row = (fields: Partial<PersonalModelRow> = {}): PersonalModelRow => ({
  personId: "person-member",
  id: "connection-1",
  kind: "api_key",
  position: 0,
  active: true,
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

const sentOne = {
  id: null,
  kind: "api_key",
  active: true,
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com",
  models: { fast: "gpt-5" },
} as const

const form = (fields: Partial<Form> = {}): Form => ({
  id: "form",
  op: "save",
  state: "sending",
  failure: null,
  before: null,
  sent: { connections: [sentOne] },
  saved: 0,
  adding: false,
  quiet: false,
  ...fields,
})

const tested = (fields: Partial<TestRow> = {}): TestRow => ({
  id: "test",
  connection: "connection-1",
  state: "done",
  result: { ok: true, latencyMs: 300, sample: "ok" },
  failure: null,
  failedAt: null,
  ...fields,
})

const STATES: ReadonlyArray<FormState> = ["sending", "confirming", "late", "done", "failed", "unknown"]

describe("who saves a model", () => {
  test("anyone signed in, whatever their role (ruling AUTH-8); nobody signed out, nor anyone while sign-in doesn't know", () => {
    const seen = (status: string, role: "admin" | "maintainer" | "member" | "guest" | null) => canSave({ status, role })
    expect([seen("signed_in", "admin"), seen("signed_in", "member"), seen("signed_in", "guest"), seen("signed_in", null)])
      .toEqual([true, true, true, true])
    expect([seen("signed_out", null), seen("loading", null), seen("unreachable", "member")]).toEqual([false, false, false])
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
    expect(landed(form({ before }), [row({ ...later, kind: "moonshot" })])).toBe(false)
    expect(landed(form({ before }), [row({ ...later, active: false })])).toBe(false)
    expect(landed(form({ before, sent: null }), [row(later)])).toBe(false)
    // A connection it left out is still there: not yet.
    expect(landed(form({ before }), [row(later), row({ ...later, id: "connection-2" })])).toBe(false)
  })

  test("a save landed once its connections are in its order, each by id once it has one", () => {
    const before = "2026-10-24T10:00:00.000Z"
    const updatedAt = "2026-10-24T10:00:05.000Z"
    const first = { ...sentOne, id: "connection-1" }
    const second = { ...sentOne, id: "connection-2", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: { hard: "claude-opus-5-5" } } as const
    const one = row({ updatedAt })
    const two = row({ id: "connection-2", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", fastModel: null, hardModel: "claude-opus-5-5" })
    const sent: Form["sent"] = { connections: [second, first] }
    expect(landed(form({ before, sent }), [two, one])).toBe(true)
    // The order it sent isn't the rows' yet.
    expect(landed(form({ before, sent }), [one, two])).toBe(false)
    // Neither row moved past `before`.
    expect(landed(form({ before: updatedAt, sent }), [two, one])).toBe(false)
  })

  test("a Kimi connection's endpoint and models are the server's: a save doesn't wait for them", () => {
    const sent: Form["sent"] = {
      connections: [{ id: null, kind: "moonshot", active: true, protocol: "openai-chat", baseUrl: "https://api.moonshot.ai", models: { fast: "kimi-k3" } }],
    }
    expect(landed(form({ sent }), [row({ kind: "moonshot", baseUrl: "https://api.moonshot.cn", fastModel: "kimi-k9" })])).toBe(true)
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

describe("a Codex link", () => {
  const link = (fields: Partial<LinkRow> = {}): LinkRow => ({
    id: "link",
    state: "waiting",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
    failure: null,
    before: null,
    attempt: 1,
    ...fields,
  })
  const codex = row({ kind: "codex_subscription", protocol: null, baseUrl: null, fastModel: null })

  test("landed once a Codex row was written since it started, only while it waits", () => {
    expect(linked(link(), [row()])).toBe(false)
    expect(linked(link(), [codex])).toBe(true)
    expect(linked(link({ before: codex.updatedAt }), [codex])).toBe(false)
    expect(linked(link({ before: codex.updatedAt }), [{ ...codex, updatedAt: "2026-10-24T10:00:05.000Z" }])).toBe(true)
    expect(linked(link({ state: "expired" }), [codex])).toBe(false)
    expect([latestLink([row()]), latestLink([row(), codex])]).toEqual([null, codex.updatedAt])
  })

  test("shows the code while it waits; Link until it does, and again once it ended", () => {
    expect(linkView(undefined)).toEqual({ code: undefined, canLink: true, status: undefined })
    expect(linkView(link({ state: "starting", userCode: null, verificationUrl: null }))).toEqual({ code: undefined, canLink: false, status: undefined })
    expect(linkView(link())).toEqual({
      code: { userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device" },
      canLink: false,
      status: LINK_WAITING,
    })
    expect(linkView(link({ state: "expired" }))).toEqual({ code: undefined, canLink: true, status: LINK_EXPIRED })
    expect(linkView(link({ state: "failed", failure: "link_refused" }))).toEqual({
      code: undefined,
      canLink: true,
      status: "OpenAI refused the link",
    })
    expect(linkView(link({ state: "done" }))).toEqual({ code: undefined, canLink: true, status: undefined })
  })
})

describe("what a row shows", () => {
  test("its host, else its credential's last characters", () => {
    expect(rowDetail(row({ baseUrl: "https://api.openai.com/x" }))).toBe("api.openai.com")
    expect(rowDetail(row({ baseUrl: null }))).toBe("····x7Qz")
  })

  test("Test, but on a Claude subscription", () => {
    expect(CONNECTION_KINDS.filter((kind) => !testable({ kind }))).toEqual(["claude_subscription"])
  })

  test("Add's form is a kind's, never the menu's", () => {
    expect([addKind(undefined), addKind("closed"), addKind("menu"), addKind("jev")]).toEqual([undefined, undefined, undefined, "jev"])
  })
})

describe("which rows answer the composer", () => {
  const claude = row({ kind: "claude_subscription", protocol: null, baseUrl: null, fastModel: null })

  test("a tier resolves; a subscription, or a connection that's off, answers no tier", () => {
    expect(answers([])).toBe(false)
    expect(answers([claude])).toBe(false)
    expect(answers([row({ active: false })])).toBe(false)
    expect(answers([claude, row()])).toBe(true)
  })
})

describe("what a press sends", () => {
  const openai = row()
  const gateway = row({ id: "connection-2", protocol: "anthropic-messages", baseUrl: "https://gateway.example.com", fastModel: null, hardModel: "h-1" })
  const kimi = row({ id: "connection-3", kind: "moonshot", baseUrl: "https://api.moonshot.ai", fastModel: "kimi-k3", implementModel: "kimi-k3", hardModel: "kimi-k3" })
  const claude = row({ id: "connection-4", kind: "claude_subscription", protocol: null, baseUrl: "https://claude.example.com", fastModel: null })
  const codex = row({ id: "connection-5", kind: "codex_subscription", protocol: null, baseUrl: null, fastModel: null })
  const jev = row({ id: "connection-6", kind: "jev", protocol: null, baseUrl: null, fastModel: null, active: false })
  const list = listOf([openai, gateway])

  test("the saved list carries only what each kind keeps, and never a credential", () => {
    expect(listOf([openai, kimi, claude, codex, jev])).toEqual([
      { id: "connection-1", kind: "api_key", active: true, protocol: "openai-chat", baseUrl: "https://api.openai.com", models: { fast: "gpt-5" } },
      { id: "connection-3", kind: "moonshot", active: true, models: { fast: "kimi-k3", implement: "kimi-k3", hard: "kimi-k3" } },
      { id: "connection-4", kind: "claude_subscription", active: true, baseUrl: "https://claude.example.com" },
      { id: "connection-5", kind: "codex_subscription", active: true },
      { id: "connection-6", kind: "jev", active: false },
    ])
  })

  test("Move up and Move down swap neighbours; either end is as it was", () => {
    expect(withMoved(list, "connection-2", -1).map(({ id }) => id)).toEqual(["connection-2", "connection-1"])
    expect(withMoved(list, "connection-1", 1).map(({ id }) => id)).toEqual(["connection-2", "connection-1"])
    expect(withMoved(list, "connection-1", -1)).toBe(list)
    expect(withMoved(list, "connection-2", 1)).toBe(list)
  })

  test("Active sets one; turning on a kind that allows one active turns its other one off", () => {
    expect(withActive(list, "connection-1", false).map(({ active }) => active)).toEqual([false, true])
    const twoJevs = listOf([row({ ...jev, id: "a", active: true }), row({ ...jev, id: "b" }), openai])
    expect(withActive(twoJevs, "b", true).map(({ active }) => active)).toEqual([false, true, true])
    // Off touches nothing else, and a kind of many keeps its others on.
    expect(withActive(twoJevs, "a", false).map(({ active }) => active)).toEqual([false, false, true])
    expect(withActive(list, "connection-2", true).map(({ active }) => active)).toEqual([true, true])
  })

  test("Add goes last; a kind that allows one active takes over from the one saved", () => {
    expect(withAdded(list, { kind: "moonshot", key: "k" }).map(({ kind }) => kind)).toEqual(["api_key", "api_key", "moonshot"])
    expect(withAdded(listOf([claude]), { kind: "claude_subscription", key: "k" })).toEqual([
      { id: "connection-4", kind: "claude_subscription", active: false, baseUrl: "https://claude.example.com" },
      { kind: "claude_subscription", key: "k" },
    ])
    expect(withAdded(listOf([claude]), { kind: "claude_subscription", active: false }).map(({ active }) => active)).toEqual([true, false])
  })

  test("Remove leaves it out", () => {
    expect(without(list, "connection-1").map(({ id }) => id)).toEqual(["connection-2"])
  })

  test("a saved Kimi connection's endpoint is the deployment's, not this build's", () => {
    expect(defaultsFrom([{ kind: "moonshot", baseUrl: "https://api.moonshot.cn" }]).moonshot.baseUrl).toBe("https://api.moonshot.cn")
    expect(defaultsFrom([{ kind: "jev", baseUrl: null }]).moonshot.baseUrl).toBe("https://api.moonshot.ai")
    expect(defaultsFrom([]).moonshot.modelId).toBe("kimi-k3")
  })
})

describe("what an Add form sends", () => {
  test("an API key: its fields as typed, and each tier whose model is filled in", () => {
    const fields: Record<string, string> = {
      [FIELDS.protocol]: "openai-chat",
      [FIELDS.baseUrl]: "https://api.openai.com/v1",
      [FIELDS.key]: "sk-typed",
      [FIELDS.model("fast")]: " gpt-5 ",
      [FIELDS.model("implement")]: "  ",
      [FIELDS.model("hard")]: "gpt-6-astra",
    }
    expect(readAdd("api_key", (name) => fields[name] ?? "")).toEqual({
      kind: "api_key",
      protocol: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      key: "sk-typed",
      models: { fast: " gpt-5 ", hard: "gpt-6-astra" },
    })
  })

  test("any other kind: just its key", () => {
    for (const kind of ["moonshot", "claude_subscription", "jev"] as const) {
      expect(readAdd(kind, (name) => (name === FIELDS.key ? "typed" : "ignored"))).toEqual({ kind, key: "typed" })
    }
  })

  test("the fields' names", () => {
    expect([FIELDS.protocol, FIELDS.baseUrl, FIELDS.key, FIELDS.model("fast")]).toEqual(["protocol", "baseUrl", "key", "fastModel"])
  })
})

describe("the section's status line", () => {
  const anyone = (fields: Partial<TestRow> = {}) => tested({ connection: null, ...fields })

  test("says nothing with nothing to say", () => {
    expect(statusOf(undefined, undefined)).toEqual({ _tag: "None" })
    expect(statusOf(form({ state: "done" }), undefined)).toEqual({ _tag: "None" })
  })

  test("Saving or Removing while a write is on its way, over everything else", () => {
    for (const state of ["sending", "confirming"] as const) {
      expect(statusOf(form({ state }), anyone())).toEqual({ _tag: "Text", text: SAVING })
    }
    // A remove that waits, such as one pressed offline, says so while its flow tries again.
    expect(statusOf(form({ op: "remove", state: "confirming" }), undefined)).toEqual({ _tag: "Text", text: REMOVING })
    expect(statusOf(form({ op: "remove", state: "sending" }), undefined)).toEqual({ _tag: "Text", text: REMOVING })
  })

  test("a write's refusal, unknown outcome or lateness", () => {
    expect(statusOf(form({ state: "failed", failure: "invalid_base_url" }), undefined)).toEqual({
      _tag: "Text",
      text: "Base URLs are https:// on a public host, with no port",
    })
    expect(statusOf(form({ op: "remove", state: "failed", failure: "unavailable" }), undefined)).toEqual({
      _tag: "Text",
      text: "Unavailable; try again",
    })
    expect(statusOf(form({ state: "unknown" }), undefined)).toEqual({ _tag: "Text", text: UNKNOWN })
    expect(statusOf(form({ op: "remove", state: "late" }), undefined)).toEqual({ _tag: "Text", text: LATE })
    // A test or a dialog since took the line.
    expect(statusOf(form({ state: "failed", failure: "invalid", quiet: true }), anyone())).toEqual({ _tag: "Text", text: OK })
    expect(statusOf(form({ state: "failed", failure: "invalid", quiet: true }), undefined)).toEqual({ _tag: "None" })
  })

  test("a test of no one connection speaks here; a row's speaks on its row", () => {
    expect(statusOf(undefined, anyone({ state: "failed", result: null, failure: "none" }))).toEqual({
      _tag: "Text",
      text: "No model saved",
    })
    expect(statusOf(undefined, tested())).toEqual({ _tag: "None" })
  })
})

describe("a row's refusal line", () => {
  test("the last test of it: OK, the host and status, the host and why, or why there was none", () => {
    expect(rowStatusOf(row(), tested())).toEqual({ _tag: "Text", text: OK })
    const result = { ok: false as const, latencyMs: 90, code: "authentication", status: 401, host: "api.openai.com" }
    expect(rowStatusOf(row(), tested({ result }))).toEqual({ _tag: "Text", text: "api.openai.com · HTTP 401" })
    expect(rowStatusOf(row(), tested({ result: { ...result, code: "transport", status: null } }))).toEqual({
      _tag: "Text",
      text: "api.openai.com · unreachable",
    })
    expect(rowStatusOf(row(), tested({ state: "failed", result: null, failure: "unsaved" }))).toEqual({ _tag: "Text", text: "Save first" })
    // While it runs, nothing yet; another row's test says nothing here.
    expect(rowStatusOf(row(), tested({ state: "testing", result: null }))).toEqual({ _tag: "None" })
    expect(rowStatusOf(row(), tested({ connection: "connection-2" }))).toEqual({ _tag: "None" })
  })

  test("the row's failure, with when, unless the last test came after it", () => {
    const at = Date.parse("2026-10-24T11:00:00.000Z")
    const failure = { _tag: "Failure", text: "api.openai.com refused · HTTP 401", at }
    expect(rowStatusOf(failed(), undefined)).toEqual(failure)
    expect(rowStatusOf(failed({ failureStatus: 429, baseUrl: "https://openrouter.ai/api" }), undefined)).toEqual({
      ...failure,
      text: "openrouter.ai refused · HTTP 429",
    })
    // No host: its kind names it.
    expect(rowStatusOf(failed({ kind: "jev", baseUrl: null }), undefined)).toEqual({ ...failure, text: "Jev refused · HTTP 401" })
    // The test saw this failure: its result is newer.
    expect(rowStatusOf(failed(), tested({ failedAt: "2026-10-24T11:00:00.000Z" }))).toEqual({ _tag: "Text", text: OK })
    // A real call failed after the test: the failure is newer.
    expect(rowStatusOf(failed(), tested({ failedAt: null }))).toEqual(failure)
    expect(rowStatusOf(failed(), tested({ failedAt: "2026-10-24T10:30:00.000Z" }))).toEqual(failure)
    // A test still running leaves the failure showing.
    expect(rowStatusOf(failed(), tested({ state: "testing", result: null, failedAt: "2026-10-24T11:00:00.000Z" }))).toEqual(failure)
  })

  test("a failure needs both a recorded status and time", () => {
    expect(rowStatusOf(failed({ failedAt: null }), undefined)).toEqual({ _tag: "None" })
    expect(rowStatusOf(failed({ failureStatus: null }), undefined)).toEqual({ _tag: "None" })
  })
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
    expect(BASE_URL_PLACEHOLDER).toBe("https://api.openai.com")
    expect(MODEL_TIERS.map((tier) => TIER_LABEL[tier])).toEqual(["Fast", "Implement", "Hard"])
    expect(CONNECTION_KINDS.map((kind) => KIND_LABEL[kind])).toEqual(["API key", "Kimi K3", "Claude subscription", "Codex subscription", "Jev"])
    expect(MODEL_TIERS.map((tier) => TIER_PURPOSE[tier])).toEqual(["Chat", "Coding", "Plans and reviews"])
    expect(keyPlaceholder("x7Qz")).toBe("····x7Qz")
  })

  test("a key to type again, and a token or link refused", () => {
    expect([refusalText("key_required"), refusalText("invalid_token"), refusalText("link_expired"), refusalText("link_refused")]).toEqual([
      "Enter the key",
      "Tokens start with sk-ant-oat",
      "Code expired",
      "OpenAI refused the link",
    ])
  })

  test("a synced row is a saved connection as routing reads it", () => {
    expect(rowIsSavedConnection).toBe(true)
  })

  test("the Codex link's schema is the contract's type", () => {
    expect(codexLinkMatchesContract).toBe(true)
  })

  test("the test result's schema is the contract's type", () => {
    expect(testResultMatchesContract).toBe(true)
  })
})
