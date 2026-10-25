// What the Your model section and its toast show (docs/features/personal-model.md#the-settings-section), as the pure
// rules their views read: who sees the section, the one status line, when a write landed, when the buttons wait, and
// when the failure toast shows. Every word is checked here too.
import { describe, expect, test } from "vitest"
import { PROTOCOLS, REFUSALS } from "./contract"
import { codeText, keyPlaceholder, LATE, OK, PROTOCOL_LABEL, REFUSAL_COPY, REMOVING, SAVING, UNKNOWN, YOUR_MODEL } from "./copy"
import { type Form, type FormState, type PersonalModelRow, type TestRow, testResultMatchesContract } from "./schema"
import { awaiting, busy, canSave, landed, onItsWay, refusalText, statusOf, testText, toastOf } from "./view"

const row = (fields: Partial<PersonalModelRow> = {}): PersonalModelRow => ({
  personId: "person-member",
  protocol: "openai-chat",
  baseUrl: "https://api.openai.com",
  modelId: "gpt-5",
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
  sent: { protocol: "openai-chat", baseUrl: "https://api.openai.com", modelId: "gpt-5" },
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

  test("a remove landed once there is no row", () => {
    expect(landed(form({ op: "remove", sent: null }), undefined)).toBe(true)
    expect(landed(form({ op: "remove", sent: null }), row())).toBe(false)
  })

  test("a save landed once the row has what it sent and a new updatedAt; the server's clock is never compared", () => {
    const before = "2026-10-24T10:00:00.000Z"
    const later = { updatedAt: "2026-10-24T10:00:05.000Z" }
    expect(landed(form({ before: null }), undefined)).toBe(false)
    expect(landed(form({ before: null }), row())).toBe(true)
    expect(landed(form({ before }), row())).toBe(false)
    expect(landed(form({ before }), row(later))).toBe(true)
    // Another device's save, with other values, isn't this one.
    expect(landed(form({ before }), row({ ...later, protocol: "anthropic-messages" }))).toBe(false)
    expect(landed(form({ before }), row({ ...later, baseUrl: "https://api.anthropic.com" }))).toBe(false)
    expect(landed(form({ before }), row({ ...later, modelId: "gpt-5-mini" }))).toBe(false)
    expect(landed(form({ before, sent: null }), row(later))).toBe(false)
  })

  test("the buttons wait while a write is on its way or a test runs", () => {
    expect(busy(undefined, undefined)).toBe(false)
    expect(STATES.filter((state) => busy(form({ state }), undefined))).toEqual(["sending", "confirming"])
    expect(busy(undefined, tested({ state: "testing", result: null }))).toBe(true)
    expect(busy(form({ state: "done" }), tested())).toBe(false)
  })
})

describe("the status line", () => {
  test("says nothing with nothing to say", () => {
    expect(statusOf(undefined, undefined, undefined)).toEqual({ _tag: "None" })
    expect(statusOf(row(), form({ state: "done" }), undefined)).toEqual({ _tag: "None" })
  })

  test("Saving or Removing while a write is on its way, over everything else", () => {
    for (const state of ["sending", "confirming"] as const) {
      expect(statusOf(failed(), form({ state }), tested())).toEqual({ _tag: "Text", text: SAVING })
    }
    // A remove that waits, such as one pressed offline, says so while its flow tries again.
    expect(statusOf(row(), form({ op: "remove", state: "confirming" }), undefined)).toEqual({ _tag: "Text", text: REMOVING })
    expect(statusOf(row(), form({ op: "remove", state: "sending" }), undefined)).toEqual({ _tag: "Text", text: REMOVING })
  })

  test("a write's refusal, unknown outcome or lateness", () => {
    expect(statusOf(failed(), form({ state: "failed", failure: "invalid_base_url" }), undefined)).toEqual({
      _tag: "Text",
      text: "Base URLs are https:// on a public host, with no port",
    })
    expect(statusOf(row(), form({ op: "remove", state: "failed", failure: "unavailable" }), undefined)).toEqual({
      _tag: "Text",
      text: "Unavailable; try again",
    })
    expect(statusOf(undefined, form({ state: "unknown" }), undefined)).toEqual({ _tag: "Text", text: UNKNOWN })
    expect(statusOf(row(), form({ op: "remove", state: "late" }), undefined)).toEqual({ _tag: "Text", text: LATE })
    // A test since took the line.
    expect(statusOf(row(), form({ state: "failed", failure: "invalid", quiet: true }), tested())).toEqual({
      _tag: "Text",
      text: OK,
    })
  })

  test("the last test: OK, the host and status, the host and why, or why there was none", () => {
    expect(statusOf(row(), undefined, tested())).toEqual({ _tag: "Text", text: OK })
    const result = { ok: false as const, latencyMs: 90, code: "authentication", status: 401, host: "api.openai.com" }
    expect(statusOf(row(), undefined, tested({ result }))).toEqual({ _tag: "Text", text: "api.openai.com · HTTP 401" })
    expect(statusOf(row(), undefined, tested({ result: { ...result, code: "transport", status: null } }))).toEqual({
      _tag: "Text",
      text: "api.openai.com · unreachable",
    })
    expect(statusOf(row(), undefined, tested({ state: "failed", result: null, failure: "none" }))).toEqual({
      _tag: "Text",
      text: "No model saved",
    })
    // While it runs, nothing yet.
    expect(statusOf(row(), undefined, tested({ state: "testing", result: null }))).toEqual({ _tag: "None" })
  })

  test("the row's failure, with when, unless the last test came after it", () => {
    const at = Date.parse("2026-10-24T11:00:00.000Z")
    const failure = { _tag: "Failure", text: "api.openai.com refused · HTTP 401", at }
    expect(statusOf(failed(), undefined, undefined)).toEqual(failure)
    expect(statusOf(failed({ failureStatus: 429, baseUrl: "https://openrouter.ai/api" }), undefined, undefined)).toEqual({
      ...failure,
      text: "openrouter.ai refused · HTTP 429",
    })
    // The test saw this failure: its result is newer.
    expect(statusOf(failed(), undefined, tested({ failedAt: "2026-10-24T11:00:00.000Z" }))).toEqual({ _tag: "Text", text: OK })
    // A real call failed after the test: the failure is newer.
    expect(statusOf(failed(), undefined, tested({ failedAt: null }))).toEqual(failure)
    expect(statusOf(failed(), undefined, tested({ failedAt: "2026-10-24T10:30:00.000Z" }))).toEqual(failure)
    // A failed write's refusal is newer than either.
    expect(statusOf(failed(), form({ state: "failed", failure: "off" }), undefined)).toEqual({
      _tag: "Text",
      text: "Your own model is off on this deployment",
    })
  })
})

describe("the failure toast", () => {
  const session = { status: "signed_in", role: "member" as const }

  test("shows while the signed-in person's row records a failure this device hasn't hidden", () => {
    expect(toastOf(session, failed(), undefined)).toEqual({
      detail: "api.openai.com · HTTP 401",
      failedAt: "2026-10-24T11:00:00.000Z",
    })
    // A later failure than the one hidden shows again.
    expect(toastOf(session, failed(), { id: "failure", failedAt: "2026-10-24T09:00:00.000Z" })).toMatchObject({
      failedAt: "2026-10-24T11:00:00.000Z",
    })
  })

  test("hides once hidden, with no failure, with no row, and for anyone signed out", () => {
    expect(toastOf(session, failed(), { id: "failure", failedAt: "2026-10-24T11:00:00.000Z" })).toBeUndefined()
    expect(toastOf(session, row(), undefined)).toBeUndefined()
    expect(toastOf(session, row({ failureStatus: 401 }), undefined)).toBeUndefined()
    expect(toastOf(session, undefined, undefined)).toBeUndefined()
    expect(toastOf({ status: "signed_out", role: null }, failed(), undefined)).toBeUndefined()
    expect(toastOf(undefined, failed(), undefined)).toBeUndefined()
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

  test("the heading, the protocols and the saved key's placeholder", () => {
    expect(YOUR_MODEL).toBe("Your model")
    expect(PROTOCOLS.map((protocol) => PROTOCOL_LABEL[protocol])).toEqual(["OpenAI-compatible", "Anthropic-compatible"])
    expect(keyPlaceholder("x7Qz")).toBe("····x7Qz")
  })

  test("the test result's schema is the contract's type", () => {
    expect(testResultMatchesContract).toBe(true)
  })
})
