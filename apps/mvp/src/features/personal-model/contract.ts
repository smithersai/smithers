// A person's own model's contract between the browser, ChatApi, the flows and the tests (decision 0096,
// docs/features/personal-model.md). Nothing here imports a library, so every side can.
//
// Each signed-in person may save one model of their own: its protocol, base URL, model id and key. ChatApi seals the
// key under SECRETS_KEY and never returns it; the model endpoint answers that person's own calls with it instead of the
// deployment's model, outside the deployment's daily budget.

/** `PUT` saves the person's model, `DELETE` removes it. Both answer `202` once their flow started. */
export const PERSONAL_MODEL_ROUTE = "/api/me/model"

/** `POST`: one tiny real call with the person's saved model, answered `200` with a {@link TestResult}. */
export const PERSONAL_MODEL_TEST_ROUTE = "/api/me/model/test"

/** ChatApi's Electric shape proxy for the person's own row, never another person's: `GET`. */
export const PERSONAL_MODEL_SHAPE_ROUTE = "/api/shapes/personal-model"

/** The Postgres table of saved models (db/migrations/0056_personal_models.ts). */
export const PERSONAL_MODELS_TABLE = "personal_models"

/** The only columns the shape sends: never `ciphertext`, `nonce` or `key_version`. */
export const PERSONAL_MODEL_SHAPE_COLUMNS = [
  "person_id",
  "protocol",
  "base_url",
  "model_id",
  "key_last4",
  "failure_status",
  "failed_at",
  "updated_at",
] as const

/**
 * The wires a saved model may speak, by the protocol name the model package plans (`@smthrs/rpc` ConfiguredModel):
 * OpenAI-compatible Chat Completions, and Anthropic-compatible Messages.
 */
export const PROTOCOLS = ["openai-chat", "anthropic-messages"] as const
export type Protocol = (typeof PROTOCOLS)[number]

/** Whether `value` is one of {@link PROTOCOLS}. */
export const isProtocol = (value: unknown): value is Protocol => (PROTOCOLS as ReadonlyArray<unknown>).includes(value)

/**
 * The model roles a person's own model answers: their chat (the agent, the views it renders, its judgments) and their
 * TODO runs (`coding`). Timeline summaries, which the app asks for on its own, stay on the deployment's model (decision
 * 0096, amended 2026-10-25).
 */
export const OWN_MODEL_ROLES: ReadonlyArray<string> = ["agent", "coding", "renderer", "judge"]

/** `PUT` body: `{ protocol, baseUrl, modelId, key }`. A key is at most 16 KiB, so 32 KiB holds any valid body. */
export const MAX_PUT_BODY_BYTES = 32 * 1024

/** The longest base URL a person may save. */
export const MAX_BASE_URL_LENGTH = 512

/** The longest model id a person may save, as the model package plans one (`@smthrs/rpc` `MODEL_ID`). */
export const MAX_MODEL_ID_LENGTH = 81

/** How many of the key's last characters the shape shows. */
export const KEY_TAIL = 4

/**
 * The fewest characters a key may have: so the {@link KEY_TAIL} characters the browser sees again are a small part of
 * it, whatever bytes they are (eight bytes of `é` are only four characters).
 */
export const MIN_KEY_CHARACTERS = 16

/** Whether `key` has at least {@link MIN_KEY_CHARACTERS} characters. */
export const longEnough = (key: string): boolean => [...key].length >= MIN_KEY_CHARACTERS

/** The key's last {@link KEY_TAIL} characters: all the browser ever sees of it again. */
export const keyTail = (key: string): string => [...key].slice(-KEY_TAIL).join("")

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Whether `hostname` is a public DNS name: two or more labels, at most 253 characters, its last label not all digits. */
const isDnsName = (hostname: string): boolean => {
  if (hostname.length > 253) return false
  const labels = hostname.split(".")
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels.at(-1)!)
}

/**
 * `raw` as the base URL a saved model may have, or `undefined`: `https:` only, to one exact public DNS name (no IP
 * address, no single label such as `localhost`, no port, no user, query or fragment), at most
 * {@link MAX_BASE_URL_LENGTH} characters. It is trimmed, its host lowercased, and its trailing slashes and one trailing
 * `/v1` dropped, since the protocol's own path (`/v1/chat/completions`, `/v1/messages`) follows it: so
 * `https://api.openai.com/v1/` is `https://api.openai.com`.
 */
export const baseUrlOf = (raw: string): string | undefined => {
  const text = raw.trim()
  if (text.length === 0 || text.length > MAX_BASE_URL_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return undefined
  if (url.search !== "" || url.hash !== "" || text.includes("?") || text.includes("#")) return undefined
  if (!isDnsName(url.hostname)) return undefined
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "")
  return `https://${url.hostname}${path}`
}

/** The host a saved base URL names: what a failure names as the provider. */
export const hostOf = (baseUrl: string): string => new URL(baseUrl).hostname

/**
 * Whether `modelId` may be saved: 1 to {@link MAX_MODEL_ID_LENGTH} letters, digits, `.`, `_`, `/`, `:` and `-`, starting
 * with a letter or digit, as the model package plans one.
 */
export const isModelId = (modelId: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/.test(modelId)

/** The execution id of one write: `model-put:<id>` or `model-delete:<id>`, the request's own id. */
export const writeExecutionId = (op: "put" | "delete", id: string): string => `model-${op}:${id}`

/** Why a write or a test was refused: what the browser shows, one code per answer (`{ code }`). */
export const REFUSALS = [
  "authentication",
  "forbidden",
  "invalid",
  "invalid_protocol",
  "invalid_base_url",
  "invalid_model",
  "too_short",
  "too_long",
  "control_character",
  "malformed_text",
  "too_large",
  "none",
  "off",
  "unavailable",
] as const
export type Refusal = (typeof REFUSALS)[number]

/**
 * The provider statuses that mean the person's key itself was refused or ran out, recorded on their row: a 429 only when
 * its error says the key ran out (worker/personal/Usage.ts `refusedKey`).
 */
export const KEY_REFUSALS: ReadonlyArray<number> = [401, 402, 403, 429]

/**
 * What `POST /api/me/model/test` answers: the call went through (`ok`, with the model's first words, scrubbed and cut
 * to 80 characters), or it failed with a `ModelError` code (`unusable` when the saved model couldn't be built, such as a
 * key that no longer opens), the provider's HTTP status when there was one, and the provider's host.
 */
export type TestResult =
  | { readonly ok: true; readonly latencyMs: number; readonly sample: string }
  | {
    readonly ok: false
    readonly latencyMs: number
    readonly code: string
    readonly status: number | null
    readonly host: string
  }

/** The prompt of a test: one word back. */
export const TEST_PROMPT = "Reply with the single word: ok"

/** A test's output cap: room for a reasoning model to answer one word. */
export const TEST_MAX_TOKENS = 64

/** The browser's records of the person's model (src/telemetry.ts): outcomes and codes; never a key, URL or model id. */
export const PERSONAL_MODEL_TELEMETRY = {
  records: ["personal_model.put", "personal_model.delete", "personal_model.test", "smithers_web_personal_model_writes"],
  fields: ["op", "outcome", "code", "status"],
} as const
