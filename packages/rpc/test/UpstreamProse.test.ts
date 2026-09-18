import { describe, expect, test } from "vitest"
import { isCloudScopeRefusal } from "../src/UpstreamProse.ts"

/**
 * Smithers Cloud's refusal envelope in its own wire order: the machine-readable
 * verdict first, the sentence after (plue pkg/errors/errors.go `APIError`).
 */
const envelope = (code: string, fault: string, message: string) => JSON.stringify({ code, fault, message })

/** The sentence plue's `RequireScope` writes (internal/middleware/scope.go). */
const SCOPE_SENTENCE = "insufficient token scope"

describe("isCloudScopeRefusal", () => {
  test("plue's scope gate: its `forbidden` verdict carrying its own sentence", () => {
    expect(isCloudScopeRefusal(envelope("forbidden", "user", SCOPE_SENTENCE))).toBe(true)
  })

  test("the other refusals plue answers this route with are not a scope shortage", () => {
    // Three gates share the `forbidden` code, so the verdict alone cannot
    // separate them; two other codes carry the scope sentence in a body that
    // is not the scope gate's.
    for (
      const body of [
        envelope("forbidden", "user", "feature not available"),
        envelope("forbidden", "user", "repository-bound token cannot access resources outside its repository"),
        envelope("access_not_granted", "user", SCOPE_SENTENCE),
        envelope("org_membership_required", "user", SCOPE_SENTENCE)
      ]
    ) {
      expect(isCloudScopeRefusal(body)).toBe(false)
    }
  })

  test("a body carrying no plue verdict never classifies, whatever English it holds", () => {
    for (
      const body of [
        `{"message":"${SCOPE_SENTENCE}"}`,
        `{"error":{"message":"${SCOPE_SENTENCE}"}}`,
        `<!DOCTYPE html><title>403 Forbidden</title><p>${SCOPE_SENTENCE}</p>`,
        `{"code":"insufficient_scope","message":"${SCOPE_SENTENCE}"}`,
        SCOPE_SENTENCE,
        ""
      ]
    ) {
      expect(isCloudScopeRefusal(body)).toBe(false)
    }
  })

  test("the sentence is matched whole, never for the words it contains", () => {
    for (
      const message of [
        "Insufficient token scope",
        "insufficient token scope for this repository",
        "this token's scope is insufficient"
      ]
    ) {
      expect(isCloudScopeRefusal(envelope("forbidden", "user", message))).toBe(false)
    }
    // Surrounding whitespace is the one difference forgiven, because
    // `upstreamProse` trims before anyone reads the sentence.
    expect(isCloudScopeRefusal(envelope("forbidden", "user", `  ${SCOPE_SENTENCE}\n`))).toBe(true)
  })
})
