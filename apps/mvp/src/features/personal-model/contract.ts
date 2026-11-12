import { MODEL_TIERS, type ModelTier, TIER_FALLBACKS } from "../model/contract"

// A person's own models' contract between the browser, ChatApi, the flows and the tests (decisions 0096 and 0107,
// docs/features/personal-model.md). It imports only the model endpoint's contract, so every side can.
//
// Each signed-in person keeps an ordered list of connections, as Amp's Model Routing (decision 0132): one credential plus
// its settings each, of a kind (`CONNECTION_KINDS`). For each tier, `fast`, `implement` and `hard`, the first active
// connection that names a model for it answers; a tier nobody named uses a preset at a connection's host, else the tier
// it falls back to (`TIER_FALLBACKS`). ChatApi seals each credential under SECRETS_KEY and never returns it; the model
// endpoint answers that person's own calls with the tier's model instead of the deployment's, outside the deployment's
// daily budget.

/** `PUT` saves the person's model, `DELETE` removes it. Both answer `202` once their flow started. */
export const PERSONAL_MODEL_ROUTE = "/api/me/model"

/** `POST`: one tiny real call with the person's saved model, answered `200` with a {@link TestResult}. */
export const PERSONAL_MODEL_TEST_ROUTE = "/api/me/model/test"

/** `POST`: starts a Codex subscription's device link, answered `202` with a {@link CodexLinkStart}. */
export const CODEX_LINK_ROUTE = "/api/me/model/codex"

/** `POST`: one Jev judgment on the person's own Jev connection; `404 none` when they have none (docs/features/jev.md). */
export const JEV_ROUTE = "/api/me/model/jev"

/** How long a person has to approve a device code, as OpenAI gives them: 15 minutes. */
export const LINK_SECONDS = 15 * 60

/** What starting a link answers: the code the person types at OpenAI. The connection arrives in the shape. */
export interface CodexLinkStart {
  readonly userCode: string
  readonly verificationUrl: string
  readonly expiresInSeconds: number
}

/** ChatApi's Electric shape proxy for the person's own row, never another person's: `GET`. */
export const PERSONAL_MODEL_SHAPE_ROUTE = "/api/shapes/personal-model"

/** The Postgres table of saved models (db/migrations/0056_personal_models.ts). */
export const PERSONAL_MODELS_TABLE = "personal_models"

/** The only columns the shape sends: never `ciphertext`, `nonce` or `key_version`. */
export const PERSONAL_MODEL_SHAPE_COLUMNS = [
  "person_id",
  "id",
  "kind",
  "position",
  "active",
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

/** `PUT` body: `{ connections }`. A key is at most 16 KiB, so 192 KiB holds many of them; a real list is far smaller. */
export const MAX_PUT_BODY_BYTES = 192 * 1024

/** A Jev judgment's body: its largest flow's 50 items of 2,000 characters, and room for their questions. */
export const MAX_JEV_BODY_BYTES = 512 * 1024

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
    // expected: a base URL that isn't a URL is invalid input
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

/** Each tier's column on a saved connection, camelCased: the model id the tier uses on it, or `null`. */
export const TIER_FIELDS = {
  fast: "fastModel",
  implement: "implementModel",
  hard: "hardModel",
} as const satisfies Record<ModelTier, string>

/**
 * What a connection is (decision 0132). `api_key` is a key at any OpenAI- or Anthropic-compatible URL. `moonshot` is one
 * over the OpenAI-compatible wire with Moonshot's endpoint and Kimi K3 filled in. `claude_subscription` and
 * `codex_subscription` are a person's plan, which only the vendor's own agent may use: they serve their `todo` runs, and
 * no model call. `jev` is the key Jev is served with, and serves the `judge` role.
 */
export const CONNECTION_KINDS = ["api_key", "moonshot", "claude_subscription", "codex_subscription", "jev"] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

/** Whether `value` is one of {@link CONNECTION_KINDS}. */
export const isConnectionKind = (value: unknown): value is ConnectionKind =>
  (CONNECTION_KINDS as ReadonlyArray<unknown>).includes(value)

/** The kinds that call a model wire, so they carry a protocol, a base URL and tiers' models. */
export const MODEL_KINDS: ReadonlyArray<ConnectionKind> = ["api_key", "moonshot"]

/** The kinds a person may keep only one active of, as Amp's subscriptions (decision 0132). */
export const SINGLE_KINDS: ReadonlyArray<ConnectionKind> = ["claude_subscription", "codex_subscription", "jev"]

/** The agents a `todo` run's change is written by: the Smithers agent on a model, or a vendor's own in the sandbox. */
export const CODING_AGENTS = ["smithers", "claude-code", "codex"] as const
export type CodingAgent = (typeof CODING_AGENTS)[number]

/** The agent each subscription kind runs. */
export const SUBSCRIPTION_AGENTS = { claude_subscription: "claude-code", codex_subscription: "codex" } as const

/** How many connections one person may keep. */
export const MAX_CONNECTIONS = 16

/** What `claude setup-token` prints starts with this, as Amp's Settings says (`usualPrefix`). */
export const CLAUDE_TOKEN_PREFIX = "sk-ant-oat"

/** A saved connection as routing reads it. Never the credential. */
export interface SavedConnection {
  readonly id: string
  readonly kind: ConnectionKind
  readonly active: boolean
  readonly protocol: Protocol | null
  readonly baseUrl: string | null
  readonly fastModel: string | null
  readonly implementModel: string | null
  readonly hardModel: string | null
}

/** A connection that may answer a model call: active, on a model wire. */
type ModelConnection = SavedConnection & { readonly protocol: Protocol; readonly baseUrl: string }

const servesModels = (connection: SavedConnection): connection is ModelConnection =>
  connection.active && connection.protocol !== null && connection.baseUrl !== null

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

/** The model a tier resolved to: the tier that answered it, its connection, the model id, and whether it was a preset. */
export interface TierModel {
  readonly tier: ModelTier
  readonly connectionId: string
  readonly protocol: Protocol
  readonly modelId: string
  readonly preset: boolean
}

/** The preset `tier` gives `connection`, if its host has one. */
const presetOn = (tier: ModelTier, connection: ModelConnection) =>
  TIER_PRESETS[tier].find((preset) =>
    preset.protocol === connection.protocol && preset.host === hostOf(connection.baseUrl)
  )

/**
 * The model `tier` uses among `connections`, which are in the person's order: for each tier of its `TIER_FALLBACKS` in
 * turn, the first active connection that names a model for it, else that tier's first preset at an active connection's
 * host; `undefined` when none does.
 */
export const resolveTier = (connections: ReadonlyArray<SavedConnection>, tier: ModelTier): TierModel | undefined => {
  const models = connections.filter(servesModels)
  for (const each of TIER_FALLBACKS[tier]) {
    const field = TIER_FIELDS[each]
    const named = models.find((connection) => connection[field] !== null)
    if (named !== undefined) {
      return { tier: each, connectionId: named.id, protocol: named.protocol, modelId: named[field]!, preset: false }
    }
    for (const preset of TIER_PRESETS[each]) {
      const hosted = models.find((connection) =>
        connection.protocol === preset.protocol && hostOf(connection.baseUrl) === preset.host
      )
      if (hosted !== undefined) {
        return { tier: each, connectionId: hosted.id, protocol: preset.protocol, modelId: preset.modelId, preset: true }
      }
    }
  }
  return undefined
}

/** The connection the person's list puts first for coding: its kind and id. */
export interface CodingChoice {
  readonly agent: CodingAgent
  readonly connectionId: string | undefined
}

/**
 * Who writes a `todo` run's change: Amp's precedence over the `implement` tier. Going down the person's active
 * connections, the first subscription, or the first that serves `implement` itself, wins. A subscription means the
 * vendor's own agent in the sandbox; anything else, or an empty list, the Smithers agent on the tier's model.
 */
export const codingChoice = (connections: ReadonlyArray<SavedConnection>): CodingChoice => {
  for (const connection of connections) {
    if (!connection.active) continue
    if (connection.kind === "claude_subscription" || connection.kind === "codex_subscription") {
      return { agent: SUBSCRIPTION_AGENTS[connection.kind], connectionId: connection.id }
    }
    if (!servesModels(connection)) continue
    if (connection.implementModel !== null || presetOn("implement", connection) !== undefined) break
  }
  return { agent: "smithers", connectionId: undefined }
}

/** The person's active Jev connection, the one that answers their `judge` role. */
export const jevOf = (connections: ReadonlyArray<SavedConnection>): SavedConnection | undefined =>
  connections.find((connection) => connection.active && connection.kind === "jev")

/** What a kind's credential is when typed: Moonshot's and Jev's keys, and a Claude token. A Codex link has none. */
export interface Defaults {
  /** Moonshot's endpoint and the model every tier of a `moonshot` connection uses unless the person names one. */
  readonly moonshot: { readonly baseUrl: string; readonly modelId: string }
}

/** The defaults when no deployment sets its own: Moonshot's international endpoint and Kimi K3. */
export const DEFAULTS: Defaults = { moonshot: { baseUrl: "https://api.moonshot.ai", modelId: "kimi-k3" } }

/** One connection a save sends. `id` is a saved connection's; the credential is absent when the saved one stays. */
export interface ConnectionPut {
  readonly id?: string | undefined
  readonly kind: string
  readonly active?: boolean | undefined
  readonly protocol?: string | undefined
  readonly baseUrl?: string | undefined
  readonly key?: string | undefined
  readonly models?: Readonly<Record<string, string>> | undefined
}

/**
 * `PUT` body: every connection the person keeps, in their order. A saved one it leaves out is removed. `known` is the
 * ids of the saved connections the list was edited from: unless they are the saved ones still, the save is `stale`, so
 * a device that hasn't seen a connection saved elsewhere never removes it. Without `known` the list replaces whatever is
 * saved.
 */
export interface ModelsPut {
  readonly connections: ReadonlyArray<ConnectionPut>
  readonly known?: ReadonlyArray<string> | undefined
}

/** Whether `known` names exactly the `saved` connections, in any order: a list edited from them may replace them. */
export const knowsSaved = (known: ReadonlyArray<string>, saved: ReadonlyArray<{ readonly id: string }>): boolean =>
  new Set(known).size === saved.length && saved.every((row) => known.includes(row.id))

/** A connection once checked: normalized, with the key if one was typed and the model each tier names on it. */
export interface CheckedConnection {
  readonly id: string | undefined
  readonly kind: ConnectionKind
  readonly active: boolean
  readonly protocol: Protocol | null
  readonly baseUrl: string | null
  readonly key: string | undefined
  readonly models: Readonly<Partial<Record<ModelTier, string>>>
}

/** A save once checked. */
export interface CheckedSave {
  readonly connections: ReadonlyArray<CheckedConnection>
}

/** Whether a saved row may keep its credential under `next`: same kind, and a key stays at its host. */
const keeps = (
  saved: Pick<SavedConnection, "id" | "kind" | "protocol" | "baseUrl">,
  next: { readonly id: string | undefined; readonly kind: ConnectionKind; readonly protocol: Protocol | null; readonly baseUrl: string | null },
) => saved.id === next.id && saved.kind === next.kind && saved.protocol === next.protocol && saved.baseUrl === next.baseUrl

/**
 * `put` checked against what the person saved, or the refusal ChatApi answers. One to {@link MAX_CONNECTIONS}
 * connections, each a known kind (`invalid`), at most one active of each of {@link SINGLE_KINDS} (`invalid`). A model
 * kind needs a protocol and a base URL (`invalid_protocol`, `invalid_base_url`; `moonshot`'s come from `defaults`). A
 * connection keeps its credential only when its id, kind, protocol and base URL are the saved one's (`key_required`), so
 * no credential moves host unless the person types it again. A Codex subscription carries no key here: its link flow
 * saves it. Tiers' models are for model kinds (`invalid`, `invalid_model`). `problem` checks a sent key's text first: the
 * server passes `@smthrs/secrets`' `Binding.valueProblem`.
 */
export const checkSave = (
  put: ModelsPut,
  saved: ReadonlyArray<Pick<SavedConnection, "id" | "kind" | "protocol" | "baseUrl">>,
  problem: (key: string) => Refusal | undefined = () => undefined,
  defaults: Defaults = DEFAULTS,
): CheckedSave | Refusal => {
  if (put.connections.length === 0 || put.connections.length > MAX_CONNECTIONS) return "invalid"
  const connections: Array<CheckedConnection> = []
  for (const sent of put.connections) {
    if (!isConnectionKind(sent.kind)) return "invalid"
    const kind = sent.kind
    const active = sent.active ?? true
    const id = sent.id === undefined || sent.id === "" ? undefined : sent.id
    if (id !== undefined && connections.some((connection) => connection.id === id)) return "invalid"
    if (active && SINGLE_KINDS.includes(kind) && connections.some((each) => each.active && each.kind === kind)) {
      return "invalid"
    }
    const models = MODEL_KINDS.includes(kind)
    if (!models && sent.protocol !== undefined) return "invalid_protocol"
    if (kind === "jev" && sent.baseUrl !== undefined) return "invalid_base_url"
    if (kind === "codex_subscription" && (sent.baseUrl !== undefined || sent.key !== undefined)) return "invalid"
    const protocol = kind === "moonshot" ? "openai-chat" : kind === "api_key" ? sent.protocol ?? "" : null
    if (protocol !== null && !isProtocol(protocol)) return "invalid_protocol"
    const url = kind === "moonshot" ? defaults.moonshot.baseUrl : sent.baseUrl
    const baseUrl = url === undefined || url === "" ? null : baseUrlOf(url) ?? "invalid"
    if (baseUrl === "invalid" || (models && baseUrl === null)) return "invalid_base_url"
    const key = sent.key === undefined || sent.key === "" ? undefined : sent.key
    if (key === undefined && !saved.some((each) => keeps(each, { id, kind, protocol, baseUrl }))) return "key_required"
    if (key !== undefined) {
      const refused = problem(key) ?? (longEnough(key) ? undefined : "too_short")
      if (refused !== undefined) return refused
      if (kind === "claude_subscription" && !key.startsWith(CLAUDE_TOKEN_PREFIX)) return "invalid_token"
    }
    const named: Partial<Record<ModelTier, string>> = {}
    for (const [tier, raw] of Object.entries(sent.models ?? {})) {
      if (!models || !(MODEL_TIERS as ReadonlyArray<string>).includes(tier)) return "invalid"
      const modelId = raw.trim()
      if (!isModelId(modelId)) return "invalid_model"
      named[tier as ModelTier] = modelId
    }
    if (kind === "moonshot") for (const tier of MODEL_TIERS) named[tier] ??= defaults.moonshot.modelId
    connections.push({ id, kind, active, protocol, baseUrl, key, models: named })
  }
  return { connections }
}

/** The execution id of one write: `model-put:<id>`, `model-delete:<id>` or `model-link:<id>`, the request's own id. */
export const writeExecutionId = (op: "put" | "delete" | "link", id: string): string => `model-${op}:${id}`

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
  "non_ascii",
  "surrounding_space",
  "too_large",
  "key_required",
  "stale",
  "invalid_token",
  "link_expired",
  "link_refused",
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
  records: [
    "personal_model.put",
    "personal_model.delete",
    "personal_model.test",
    "personal_model.link",
    "smithers_web_personal_model_writes",
  ],
  fields: ["op", "outcome", "code", "status"],
} as const
