import { MODEL_TIERS, type ModelTier, TIER_FALLBACKS } from "../model/contract"

// A person's own models' contract between the browser, ChatApi, the flows and the tests (decisions 0096 and 0107,
// docs/features/personal-model.md). It imports only the model endpoint's contract, so every side can.
//
// Each signed-in person may save one key per protocol (an OpenAI-compatible one and an Anthropic-compatible one), each
// with its base URL, and the model each tier uses: `fast`, `implement` and `hard`, each on one of their keys. A tier
// they didn't name uses a preset when one of their keys is at the preset's host, else the tier it falls back to
// (`TIER_FALLBACKS`). ChatApi seals each key under SECRETS_KEY and never returns it; the model endpoint answers that
// person's own calls with the tier's model instead of the deployment's, outside the deployment's daily budget.

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
  "fast_model",
  "implement_model",
  "hard_model",
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

/** `PUT` body: `{ keys, models }`. A key is at most 16 KiB, so 48 KiB holds any valid body with both keys. */
export const MAX_PUT_BODY_BYTES = 48 * 1024

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

/** Each tier's column on a saved key, camelCased: the model id the tier uses on that key, or `null`. */
export const TIER_FIELDS = {
  fast: "fastModel",
  implement: "implementModel",
  hard: "hardModel",
} as const satisfies Record<ModelTier, string>

/** A saved key as the tiers read it: its protocol and base URL, and the model each tier uses on it. Never the key. */
export interface SavedKey {
  readonly protocol: Protocol
  readonly baseUrl: string
  readonly fastModel: string | null
  readonly implementModel: string | null
  readonly hardModel: string | null
}

/** A tier's model a person didn't name, suggested for a key at `host` speaking `protocol`. */
export interface TierPreset {
  readonly protocol: Protocol
  readonly host: string
  readonly modelId: string
}

/**
 * The models a tier uses on a provider's own host when the person names none, the first whose key is saved winning
 * (decision 0107): a cheap model for `fast`, a coding model for `implement`, the strongest for `hard`. Data only: no
 * code path branches on a provider. A key at any other host (a gateway, a self-hosted server) needs its models named.
 */
export const TIER_PRESETS: Readonly<Record<ModelTier, ReadonlyArray<TierPreset>>> = {
  fast: [
    { protocol: "anthropic-messages", host: "api.anthropic.com", modelId: "claude-haiku-4-5" },
    { protocol: "openai-chat", host: "api.openai.com", modelId: "gpt-6-luna" },
  ],
  implement: [
    { protocol: "openai-chat", host: "api.openai.com", modelId: "gpt-6.1-sol" },
    { protocol: "anthropic-messages", host: "api.anthropic.com", modelId: "claude-sonnet-5" },
  ],
  hard: [
    { protocol: "anthropic-messages", host: "api.anthropic.com", modelId: "claude-opus-5-5" },
    { protocol: "openai-chat", host: "api.openai.com", modelId: "gpt-6-astra" },
  ],
}

/** The model a tier resolved to: the tier that answered it, the key's protocol, the model id, and whether it was a preset. */
export interface TierModel {
  readonly tier: ModelTier
  readonly protocol: Protocol
  readonly modelId: string
  readonly preset: boolean
}

/**
 * The model `tier` uses among `keys`: for each tier of its `TIER_FALLBACKS` in turn, the model a key names for it, else
 * that tier's first preset at a saved key's host; `undefined` when none does.
 */
export const resolveTier = (keys: ReadonlyArray<SavedKey>, tier: ModelTier): TierModel | undefined => {
  for (const each of TIER_FALLBACKS[tier]) {
    const field = TIER_FIELDS[each]
    const named = keys.find((key) => key[field] !== null)
    if (named !== undefined) return { tier: each, protocol: named.protocol, modelId: named[field]!, preset: false }
    for (const preset of TIER_PRESETS[each]) {
      if (keys.some((key) => key.protocol === preset.protocol && hostOf(key.baseUrl) === preset.host)) {
        return { tier: each, protocol: preset.protocol, modelId: preset.modelId, preset: true }
      }
    }
  }
  return undefined
}

/** One key a save sends: its protocol and base URL, and the key unless the one saved at that base URL stays. */
export interface KeyPut {
  readonly protocol: string
  readonly baseUrl: string
  readonly key?: string | undefined
}

/** A tier's model as a save names it: which key, by its protocol, and the provider's model id. */
export interface TierChoice {
  readonly protocol: Protocol
  readonly modelId: string
}

/**
 * `PUT` body: every key the person keeps (a saved key it leaves out is removed) and the model of each tier they name.
 * A tier left out uses its preset or falls back.
 */
export interface ModelsPut {
  readonly keys: ReadonlyArray<KeyPut>
  readonly models: Readonly<Record<string, { readonly protocol: string; readonly modelId: string }>>
}

/** A save once checked: each key's protocol, normalized base URL and the key, if sent; and the tiers' models. */
export interface CheckedSave {
  readonly keys: ReadonlyArray<{ readonly protocol: Protocol; readonly baseUrl: string; readonly key: string | undefined }>
  readonly models: Readonly<Partial<Record<ModelTier, TierChoice>>>
}

/**
 * `put` checked against the keys the person has saved, or the refusal ChatApi answers: one to two keys, one per
 * protocol (`invalid`, `invalid_protocol`, `invalid_base_url`); each with a key of at least
 * {@link MIN_KEY_CHARACTERS} (`too_short`) unless it keeps the one saved at the same base URL (`key_required`); each
 * named tier on one of those keys (`no_key`) with a model id (`invalid_model`); and some tier with a model, named or
 * preset (`no_model`). `problem` checks a sent key's text first: the server passes `@smthrs/secrets`'
 * `Binding.valueProblem`.
 */
export const checkSave = (
  put: ModelsPut,
  saved: ReadonlyArray<Pick<SavedKey, "protocol" | "baseUrl">>,
  problem: (key: string) => Refusal | undefined = () => undefined,
): CheckedSave | Refusal => {
  if (put.keys.length === 0 || put.keys.length > PROTOCOLS.length) return "invalid"
  const keys: Array<CheckedSave["keys"][number]> = []
  for (const sent of put.keys) {
    if (!isProtocol(sent.protocol)) return "invalid_protocol"
    const protocol = sent.protocol
    if (keys.some((key) => key.protocol === protocol)) return "invalid"
    const baseUrl = baseUrlOf(sent.baseUrl)
    if (baseUrl === undefined) return "invalid_base_url"
    const key = sent.key === undefined || sent.key === "" ? undefined : sent.key
    // A saved key goes only to the base URL it was saved for: a new base URL needs the key typed again.
    if (key === undefined && !saved.some((each) => each.protocol === protocol && each.baseUrl === baseUrl)) {
      return "key_required"
    }
    if (key !== undefined) {
      const refused = problem(key) ?? (longEnough(key) ? undefined : "too_short")
      if (refused !== undefined) return refused
    }
    keys.push({ protocol, baseUrl, key })
  }
  const models: Partial<Record<ModelTier, TierChoice>> = {}
  for (const [tier, choice] of Object.entries(put.models)) {
    if (!(MODEL_TIERS as ReadonlyArray<string>).includes(tier)) return "invalid"
    if (!isProtocol(choice.protocol)) return "invalid_protocol"
    const modelId = choice.modelId.trim()
    if (!isModelId(modelId)) return "invalid_model"
    if (!keys.some((key) => key.protocol === choice.protocol)) return "no_key"
    models[tier as ModelTier] = { protocol: choice.protocol, modelId }
  }
  const tiers = keys.map((key): SavedKey => ({
    protocol: key.protocol,
    baseUrl: key.baseUrl,
    fastModel: models.fast?.protocol === key.protocol ? models.fast.modelId : null,
    implementModel: models.implement?.protocol === key.protocol ? models.implement.modelId : null,
    hardModel: models.hard?.protocol === key.protocol ? models.hard.modelId : null,
  }))
  if (resolveTier(tiers, "fast") === undefined) return "no_model"
  return { keys, models }
}

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
  "key_required",
  "no_key",
  "no_model",
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
