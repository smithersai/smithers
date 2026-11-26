import { PERSON_ONLY_FLOWS } from "../../flows/personOnly"

// Narrow typed workflow bridge for sandboxed iframe playgrounds (M2 live blockchain & compiler playgrounds).
// Security by construction:
// - The iframe runs strictly with sandbox="allow-scripts" (opaque null origin, no same-origin, no top-navigation,
//   no forms, no popups).
// - Only primitive UTF-8 JSON strings cross the boundary, bounded by UTF-16 precheck and UTF-8 byte ceiling.
// - Every registered person-only flow (PERSON_ONLY_FLOWS) and every non-playground/ flow is unconditionally denied.
// - Error envelopes only emit members of the closed PlaygroundErrorCode union.

export const PLAYGROUND_PROTOCOL = "smithers-playground/v1"
export const PLAYGROUND_IFRAME_SANDBOX = "allow-scripts"
export const PLAYGROUND_FLOW_PREFIX = "playground/"
export const MAX_BRIDGE_PAYLOAD_BYTES = 16_384

const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
const FLOW_NAME_RE = /^[a-z0-9][a-z0-9/_-]{0,63}$/
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

export const PLAYGROUND_ERROR_CODES = [
  "payload_too_large",
  "invalid_envelope",
  "invalid_request_id",
  "invalid_flow",
  "flow_denied",
  "unsafe_input",
  "execution_failed",
  "bridge_error",
] as const

export type PlaygroundErrorCode = (typeof PLAYGROUND_ERROR_CODES)[number]
const VALID_ERROR_CODES: ReadonlySet<string> = new Set(PLAYGROUND_ERROR_CODES)

export interface PlaygroundPreset {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly allowedFlows: ReadonlyArray<string>
  readonly defaultFlow: string
}

export interface PlaygroundRequest {
  readonly protocol: typeof PLAYGROUND_PROTOCOL
  readonly requestId: string
  readonly kind: "workflow.invoke"
  readonly flow: string
  readonly input: Readonly<Record<string, unknown>>
}

export type PlaygroundDecodeResult =
  | { readonly ok: true; readonly request: PlaygroundRequest }
  | {
      readonly ok: false
      readonly requestId: string | null
      readonly code: Exclude<PlaygroundErrorCode, "execution_failed" | "bridge_error">
    }

export type PlaygroundResponse =
  | { readonly protocol: typeof PLAYGROUND_PROTOCOL; readonly requestId: string; readonly ok: true; readonly output: unknown }
  | { readonly protocol: typeof PLAYGROUND_PROTOCOL; readonly requestId: string; readonly ok: false; readonly code: PlaygroundErrorCode }

export interface PlaygroundMessageEventLike {
  readonly source: unknown
  readonly origin: string
}

const FIRST_PARTY_PRESETS: Readonly<Record<string, PlaygroundPreset>> = {
  "evmts/tevm-monorepo": {
    id: "tevm-evm",
    title: "Tevm Live Sandbox",
    summary: "Run deterministic EVM calls and inspect execution receipts in an isolated sandbox.",
    allowedFlows: ["playground/tevm-call", "playground/tevm-trace"],
    defaultFlow: "playground/tevm-call",
  },
  "evmts/tevm-effect": {
    id: "tevm-effect",
    title: "Tevm Effect Sandbox",
    summary: "Run typed Effect EVM actions with structured trace outputs.",
    allowedFlows: ["playground/tevm-call", "playground/tevm-trace"],
    defaultFlow: "playground/tevm-call",
  },
  "evmts/zevm": {
    id: "zevm-evm",
    title: "Zevm Live Sandbox",
    summary: "Step through bytecode execution and gas traces in an isolated Zig EVM sandbox.",
    allowedFlows: ["playground/zevm-trace"],
    defaultFlow: "playground/zevm-trace",
  },
  "smithersai/vibelang": {
    id: "vibelang-compiler",
    title: "VibeLang Compiler Playground",
    summary: "Compile bounded .vibe snippets and inspect emitted TypeScript and diagnostics.",
    allowedFlows: ["playground/vibe-check"],
    defaultFlow: "playground/vibe-check",
  },
  "smithersai/smithers": {
    id: "smithers-workflow",
    title: "Smithers Workflow Playground",
    summary: "Execute a credential-free workflow fixture and inspect step and cache receipts.",
    allowedFlows: ["playground/workflow-dry-run"],
    defaultFlow: "playground/workflow-dry-run",
  },
}

/** Look up the first-party interactive playground preset for a repository slug, if supported. */
export function playgroundPresetFor(repoSlug: string): PlaygroundPreset | undefined {
  const normalized = repoSlug.trim().toLowerCase()
  return Object.hasOwn(FIRST_PARTY_PRESETS, normalized) ? FIRST_PARTY_PRESETS[normalized] : undefined
}

/**
 * Verify that an incoming browser MessageEvent originates from the exact expected sandboxed iframe
 * running with an opaque null origin (sandbox="allow-scripts").
 */
export function isTrustedPlaygroundEvent(
  event: PlaygroundMessageEventLike,
  expectedWindow: unknown,
): boolean {
  if (expectedWindow === null || expectedWindow === undefined) return false
  return event.source === expectedWindow && event.origin === "null"
}

/**
 * Returns true if a flow name is unconditionally blocked from iframe playground invocation.
 * Denies every registered person-only flow (PERSON_ONLY_FLOWS) and every flow outside the
 * dedicated `playground/` namespace.
 */
export function isHardDeniedPlaygroundFlow(flow: string): boolean {
  const lower = flow.toLowerCase()
  if (Object.hasOwn(PERSON_ONLY_FLOWS, lower)) return true
  return !lower.startsWith(PLAYGROUND_FLOW_PREFIX)
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function hasUnsafeKeys(value: unknown, depth = 0): boolean {
  if (depth > 8) return true
  if (value === null || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((item) => hasUnsafeKeys(item, depth + 1))
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true
    if (hasUnsafeKeys((value as Record<string, unknown>)[key], depth + 1)) return true
  }
  return false
}

/**
 * Decode and authorize an untrusted primitive JSON string payload from a sandboxed playground iframe.
 * Rejects non-strings immediately (eliminating ArrayBuffer smuggling, getters, and prototype tricks),
 * checks UTF-16 length before UTF-8 byte measurement, validates schema via own properties, enforces
 * authoritative person-only + playground/ namespace policy + explicit allowlist, and checks input depth/keys.
 */
export function decodePlaygroundRequest(
  raw: unknown,
  allowedFlows: ReadonlySet<string>,
  maxBytes: number = MAX_BRIDGE_PAYLOAD_BYTES,
): PlaygroundDecodeResult {
  if (typeof raw !== "string") {
    return { ok: false, requestId: null, code: "invalid_envelope" }
  }
  // Cheap O(1) UTF-16 lower-bound reject before allocating a UTF-8 buffer.
  if (raw.length > maxBytes || new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, requestId: null, code: "payload_too_large" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  // expected: untrusted iframe JSON string failed parsing
  } catch {
    return { ok: false, requestId: null, code: "invalid_envelope" }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, requestId: null, code: "invalid_envelope" }
  }

  const record = parsed as Record<string, unknown>
  if (ownField(record, "protocol") !== PLAYGROUND_PROTOCOL || ownField(record, "kind") !== "workflow.invoke") {
    return { ok: false, requestId: null, code: "invalid_envelope" }
  }

  const requestId = ownField(record, "requestId")
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
    return { ok: false, requestId: null, code: "invalid_request_id" }
  }

  const flow = ownField(record, "flow")
  if (typeof flow !== "string" || !FLOW_NAME_RE.test(flow)) {
    return { ok: false, requestId, code: "invalid_flow" }
  }

  if (isHardDeniedPlaygroundFlow(flow) || !allowedFlows.has(flow)) {
    return { ok: false, requestId, code: "flow_denied" }
  }

  const input = ownField(record, "input")
  if (input === null || typeof input !== "object" || Array.isArray(input) || hasUnsafeKeys(input)) {
    return { ok: false, requestId, code: "unsafe_input" }
  }

  return {
    ok: true,
    request: {
      protocol: PLAYGROUND_PROTOCOL,
      requestId,
      kind: "workflow.invoke",
      flow,
      input: input as Readonly<Record<string, unknown>>,
    },
  }
}

/** Build a typed response envelope for the sandboxed playground iframe. */
export function playgroundOkResponse(requestId: string, output: unknown): PlaygroundResponse {
  return { protocol: PLAYGROUND_PROTOCOL, requestId, ok: true, output }
}

/**
 * Build a redacted failure envelope carrying only a member of the closed PlaygroundErrorCode set
 * and a validated requestId. Unrecognized codes map to the fixed `bridge_error` fallback.
 */
export function playgroundErrorResponse(requestId: unknown, code: unknown): PlaygroundResponse {
  const safeId = typeof requestId === "string" && REQUEST_ID_RE.test(requestId) ? requestId : "unknown"
  const safeCode: PlaygroundErrorCode =
    typeof code === "string" && VALID_ERROR_CODES.has(code)
      ? (code as PlaygroundErrorCode)
      : "bridge_error"
  return { protocol: PLAYGROUND_PROTOCOL, requestId: safeId, ok: false, code: safeCode }
}
