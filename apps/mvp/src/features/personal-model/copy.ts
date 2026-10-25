import type { Protocol, Refusal } from "./contract"

// What the Your model section and its toast say (docs/features/personal-model.md#the-settings-section): the fewest
// words to act, in product words.

/** The section's heading, and the toast's word. */
export const YOUR_MODEL = "Your model"

/** The fields. */
export const PROTOCOL = "Protocol"
export const BASE_URL = "Base URL"
export const MODEL = "Model"
export const KEY = "Key"

/** The base URL field's example. */
export const BASE_URL_PLACEHOLDER = "https://api.openai.com"

/** Each protocol as the select names it. */
export const PROTOCOL_LABEL: Record<Protocol, string> = {
  "openai-chat": "OpenAI-compatible",
  "anthropic-messages": "Anthropic-compatible",
}

/** The buttons. */
export const SAVE = "Save"
export const REMOVE = "Remove"
export const TEST = "Test"

/** A save on its way. */
export const SAVING = "Saving"

/** A remove on its way. */
export const REMOVING = "Removing"

/** A test that went through. */
export const OK = "OK"

/** The key field's placeholder once a model is saved: its last characters behind dots. */
export const keyPlaceholder = (keyLast4: string): string => `····${keyLast4}`

/** Why ChatApi refused a write or a test, one phrase per refusal. */
export const REFUSAL_COPY: Record<Refusal, string> = {
  authentication: "Sign in to use your model",
  forbidden: "Only Members can use their own model",
  invalid: "Your model wasn't saved",
  invalid_protocol: "Choose a protocol",
  invalid_base_url: "Base URLs are https:// on a public host, with no port",
  invalid_model: "Model ids are letters, digits and . _ / : -, at most 81",
  too_short: "Keys are at least 16 characters",
  too_long: "Keys are at most 16 KiB",
  control_character: "Keys can't contain line breaks or control characters",
  malformed_text: "Keys must be plain text",
  too_large: "Keys are at most 16 KiB",
  none: "No model saved",
  off: "Your own model is off on this deployment",
  unavailable: "Unavailable; try again",
}

/** No whole answer came to a save, so it may or may not have landed. */
export const UNKNOWN = "Couldn't confirm the save"

/** ChatApi took the write, and the row hasn't shown it within the deadline. */
export const LATE = "It hasn't shown up yet"

/** A failed test with no HTTP status, by the model error's code: why, in two or three words. */
const CODE_COPY: Record<string, string> = {
  invalid_request: "request refused",
  context_overflow: "context too long",
  no_route: "model not found",
  authentication: "key refused",
  rate_limited: "rate limited",
  quota_exceeded: "quota used up",
  out_of_credit: "out of credit",
  content_policy: "content refused",
  provider_internal: "provider error",
  transport: "unreachable",
  call_timeout: "timed out",
  invalid_provider_output: "unreadable answer",
  unusable: "save the key again",
}

/** A model error's code as a short phrase; one this build doesn't know reads `failed`. */
export const codeText = (code: string): string => (Object.hasOwn(CODE_COPY, code) ? CODE_COPY[code]! : "failed")
