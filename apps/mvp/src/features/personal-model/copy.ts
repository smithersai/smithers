import type { ModelTier } from "../model/contract"
import type { ConnectionKind, Protocol, Refusal } from "./contract"

// What the Your model section say (docs/features/personal-model.md#the-settings-section): the fewest
// words to act, in product words.

/** The section's heading. */
export const YOUR_MODEL = "Your model"

/** Each key's fields. */
export const BASE_URL = "Base URL"
export const KEY = "Key"

/** The Base URL field's example. */
export const BASE_URL_PLACEHOLDER = "https://api.openai.com"

/** The protocol select's name. */
export const PROTOCOL = "Protocol"

/** Add, and each kind as its entry, its dialog's title and its row name it. */
export const ADD = "Add"
export const KIND_LABEL: Record<ConnectionKind, string> = {
  api_key: "API key",
  moonshot: "Kimi K3",
  claude_subscription: "Claude subscription",
  codex_subscription: "Codex subscription",
  jev: "Jev",
}

/** A row's controls. */
export const ACTIVE = "Active"
export const MOVE_UP = "Move up"
export const MOVE_DOWN = "Move down"

/** Claude's form: what to run, its copy button, its two steps and its field. */
export const CLAUDE_COMMAND = "claude setup-token"
export const COPY_COMMAND = "Copy command"
export const CLAUDE_RUN = "Run"
export const CLAUDE_PASTE = "Paste"
export const TOKEN = "Token"

/** Codex's form. */
export const LINK = "Link"
export const COPY_CODE = "Copy code"
export const OPEN_OPENAI = "Open OpenAI"
export const LINK_WAITING = "Waiting"
export const LINK_EXPIRED = "Code expired"

/** Each protocol as the protocol select names it. */
export const PROTOCOL_LABEL: Record<Protocol, string> = {
  "openai-chat": "OpenAI-compatible",
  "anthropic-messages": "Anthropic-compatible",
}

/** Each tier's model field. */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast: "Fast",
  implement: "Implement",
  hard: "Hard",
}

/** The work each model tier answers. */
export const TIER_PURPOSE: Record<ModelTier, string> = {
  fast: "Chat",
  implement: "Coding",
  hard: "Plans and reviews",
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

/** A saved credential: its last characters behind dots. */
export const keyPlaceholder = (keyLast4: string): string => `····${keyLast4}`

/** Why a write or test was refused, including an unsaved local draft. */
export const REFUSAL_COPY: Record<Refusal | "unsaved", string> = {
  unsaved: "Save first",
  authentication: "Sign in to use your model",
  // Anyone signed in saves their own (ruling AUTH-8); only someone acting for them is refused.
  forbidden: "Only you can save your model",
  invalid: "Your model wasn't saved",
  invalid_protocol: "Choose a protocol",
  invalid_base_url: "Base URLs are https:// on a public host, with no port",
  invalid_model: "Model ids are letters, digits and . _ / : -, at most 81",
  too_short: "Keys are at least 16 characters",
  too_long: "Keys are at most 16 KiB",
  control_character: "Keys can't contain line breaks or control characters",
  malformed_text: "Keys must be plain text",
  non_ascii: "Keys must use ASCII characters",
  surrounding_space: "Keys can't start or end with a space",
  too_large: "Keys are at most 16 KiB",
  key_required: "Enter the key",
  invalid_token: "Tokens start with sk-ant-oat",
  link_expired: LINK_EXPIRED,
  link_refused: "OpenAI refused the link",
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
