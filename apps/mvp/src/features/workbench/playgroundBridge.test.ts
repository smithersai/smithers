import { describe, expect, it } from "vitest"
import { PERSON_ONLY_FLOWS } from "../../flows/personOnly"
import {
  decodePlaygroundRequest,
  isHardDeniedPlaygroundFlow,
  isTrustedPlaygroundEvent,
  PLAYGROUND_IFRAME_SANDBOX,
  PLAYGROUND_PROTOCOL,
  playgroundErrorResponse,
  playgroundOkResponse,
  playgroundPresetFor,
} from "./playgroundBridge"

const ALLOWED = new Set(["playground/tevm-call", "playground/vibe-check"])

describe("workbench playgroundBridge", () => {
  it("pins iframe sandbox strictly to allow-scripts and validates exact sender window + opaque null origin", () => {
    expect(PLAYGROUND_IFRAME_SANDBOX).toBe("allow-scripts")
    const frameWindow = { id: "sandbox-1" }
    const otherWindow = { id: "sandbox-2" }
    expect(isTrustedPlaygroundEvent({ source: frameWindow, origin: "null" }, frameWindow)).toBe(true)
    expect(isTrustedPlaygroundEvent({ source: otherWindow, origin: "null" }, frameWindow)).toBe(false)
    expect(isTrustedPlaygroundEvent({ source: frameWindow, origin: "https://smithers.sh" }, frameWindow)).toBe(false)
    expect(isTrustedPlaygroundEvent({ source: frameWindow, origin: "null" }, null)).toBe(false)
  })

  it("resolves first-party M2 playground presets case-insensitively and avoids prototype hits", () => {
    expect(playgroundPresetFor("Evmts/Tevm-Monorepo")?.id).toBe("tevm-evm")
    expect(playgroundPresetFor("evmts/tevm-effect")?.id).toBe("tevm-effect")
    expect(playgroundPresetFor("evmts/zevm")?.id).toBe("zevm-evm")
    expect(playgroundPresetFor("smithersai/vibelang")?.id).toBe("vibelang-compiler")
    expect(playgroundPresetFor("smithersai/smithers")?.id).toBe("smithers-workflow")
    expect(playgroundPresetFor("unknown/repo")).toBeUndefined()
    expect(playgroundPresetFor("toString")).toBeUndefined()
  })

  it("accepts valid primitive JSON string requests for allowlisted playground/ flows", () => {
    const payload = {
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_123",
      kind: "workflow.invoke",
      flow: "playground/tevm-call",
      input: { calldata: "0xdeadbeef", nested: [{ a: 1 }, null] },
    }
    expect(decodePlaygroundRequest(JSON.stringify(payload), ALLOWED)).toEqual({ ok: true, request: payload })
  })

  it("rejects non-string objects (including ArrayBuffer payloads) at the message boundary", () => {
    const payload = {
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_obj",
      kind: "workflow.invoke",
      flow: "playground/tevm-call",
      input: { buf: new ArrayBuffer(65_536) },
    }
    expect(decodePlaygroundRequest(payload, ALLOWED)).toEqual({
      ok: false,
      requestId: null,
      code: "invalid_envelope",
    })
    expect(decodePlaygroundRequest(42, ALLOWED)).toEqual({
      ok: false,
      requestId: null,
      code: "invalid_envelope",
    })
  })

  it("rejects oversized ASCII and multi-byte UTF-8 JSON strings before parsing", () => {
    expect(decodePlaygroundRequest("x".repeat(65), ALLOWED, 64)).toEqual({
      ok: false,
      requestId: null,
      code: "payload_too_large",
    })
    // 20 emoji chars have UTF-16 length 40 <= 64, but UTF-8 byteLength 80 > 64.
    expect(decodePlaygroundRequest("🔥".repeat(20), ALLOWED, 64)).toEqual({
      ok: false,
      requestId: null,
      code: "payload_too_large",
    })
  })

  it("rejects malformed JSON, non-object envelopes, and invalid request IDs or flow names", () => {
    expect(decodePlaygroundRequest("{bad json", ALLOWED)).toEqual({
      ok: false,
      requestId: null,
      code: "invalid_envelope",
    })
    expect(decodePlaygroundRequest("[]", ALLOWED)).toEqual({
      ok: false,
      requestId: null,
      code: "invalid_envelope",
    })
    expect(decodePlaygroundRequest(JSON.stringify({ protocol: "wrong", kind: "workflow.invoke" }), ALLOWED)).toEqual({
      ok: false,
      requestId: null,
      code: "invalid_envelope",
    })
    expect(decodePlaygroundRequest(JSON.stringify({}), ALLOWED)).toEqual({
      ok: false,
      requestId: null,
      code: "invalid_envelope",
    })
    expect(
      decodePlaygroundRequest(
        JSON.stringify({
          protocol: PLAYGROUND_PROTOCOL,
          kind: "workflow.invoke",
          requestId: "bad id!",
          flow: "playground/tevm-call",
          input: {},
        }),
        ALLOWED,
      ),
    ).toEqual({ ok: false, requestId: null, code: "invalid_request_id" })
    expect(
      decodePlaygroundRequest(
        JSON.stringify({
          protocol: PLAYGROUND_PROTOCOL,
          kind: "workflow.invoke",
          requestId: "req-1",
          flow: "../escape",
          input: {},
        }),
        ALLOWED,
      ),
    ).toEqual({ ok: false, requestId: "req-1", code: "invalid_flow" })
  })

  it("denies every registered PERSON_ONLY_FLOWS entry and non-playground flows even under a permissive allowlist", () => {
    const personOnlyNames = Object.keys(PERSON_ONLY_FLOWS)
    expect(personOnlyNames.length).toBeGreaterThan(10)
    const permissive = new Set([...personOnlyNames, "secret/read", "branch/merge", "playground/tevm-call"])

    for (const flow of personOnlyNames) {
      expect(isHardDeniedPlaygroundFlow(flow)).toBe(true)
      expect(
        decodePlaygroundRequest(
          JSON.stringify({
            protocol: PLAYGROUND_PROTOCOL,
            kind: "workflow.invoke",
            requestId: "req-po",
            flow,
            input: {},
          }),
          permissive,
        ),
      ).toEqual({ ok: false, requestId: "req-po", code: "flow_denied" })
    }

    expect(isHardDeniedPlaygroundFlow("secret/read")).toBe(true)
    expect(isHardDeniedPlaygroundFlow("playground/tevm-call")).toBe(false)

    // Unallowlisted playground/ flow is still denied.
    expect(
      decodePlaygroundRequest(
        JSON.stringify({
          protocol: PLAYGROUND_PROTOCOL,
          kind: "workflow.invoke",
          requestId: "req-2",
          flow: "playground/zevm-trace",
          input: {},
        }),
        ALLOWED,
      ),
    ).toEqual({ ok: false, requestId: "req-2", code: "flow_denied" })
  })

  it("rejects JSON-parsed own __proto__ / constructor keys, non-object inputs, and overly deep structures", () => {
    expect(
      decodePlaygroundRequest(
        JSON.stringify({
          protocol: PLAYGROUND_PROTOCOL,
          kind: "workflow.invoke",
          requestId: "req-4",
          flow: "playground/tevm-call",
          input: [],
        }),
        ALLOWED,
      ),
    ).toEqual({ ok: false, requestId: "req-4", code: "unsafe_input" })

    const rawProtoJson = `{"protocol":"${PLAYGROUND_PROTOCOL}","kind":"workflow.invoke","requestId":"req-proto","flow":"playground/tevm-call","input":{"__proto__":{"polluted":true}}}`
    expect(decodePlaygroundRequest(rawProtoJson, ALLOWED)).toEqual({
      ok: false,
      requestId: "req-proto",
      code: "unsafe_input",
    })

    const poisonedJson = JSON.stringify({
      protocol: PLAYGROUND_PROTOCOL,
      kind: "workflow.invoke",
      requestId: "req-5",
      flow: "playground/tevm-call",
      input: { nested: { constructor: "evil" } },
    })
    expect(decodePlaygroundRequest(poisonedJson, ALLOWED)).toEqual({
      ok: false,
      requestId: "req-5",
      code: "unsafe_input",
    })

    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 10; i++) deep = { next: deep }
    expect(
      decodePlaygroundRequest(
        JSON.stringify({
          protocol: PLAYGROUND_PROTOCOL,
          kind: "workflow.invoke",
          requestId: "req-6",
          flow: "playground/tevm-call",
          input: deep,
        }),
        ALLOWED,
      ),
    ).toEqual({ ok: false, requestId: "req-6", code: "unsafe_input" })
  })

  it("formats typed ok responses and clamps unknown error codes and invalid request IDs cleanly", () => {
    expect(playgroundOkResponse("req-7", { gasUsed: 21000 })).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req-7",
      ok: true,
      output: { gasUsed: 21000 },
    })
    expect(playgroundErrorResponse("req-7", "flow_denied")).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req-7",
      ok: false,
      code: "flow_denied",
    })
    expect(playgroundErrorResponse(null, "Error: stack trace leaked")).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "unknown",
      ok: false,
      code: "bridge_error",
    })
    expect(playgroundErrorResponse(42, undefined)).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "unknown",
      ok: false,
      code: "bridge_error",
    })
    expect(playgroundErrorResponse("bad id!", "flow_denied")).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "unknown",
      ok: false,
      code: "flow_denied",
    })
  })
})
