import { Cause, Context, Data, Effect, Layer, Redacted, Semaphore } from "effect"
import { z } from "zod"
import {
  failedModelCredential, MODEL_CREDENTIALS, ModelCredentialNameSchema, ModelCredentialRequestIdSchema,
  ModelCredentialRequestSchema, ModelCredentialResultSchema
} from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentialListing, ModelCredentialResult, ModelPlan } from "@smthrs/rpc/ConfiguredModel"
import { runDurable } from "./Boundary"
import { ServerConfig } from "./Config"
import type { ServerConfigShape } from "./Config"
import { DurableStorage, namespaceCall, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { readBoundedJson } from "./Http"
import type { Transport } from "./Http"
import { requireTurnSession } from "./identity"
import { logSeamFailure } from "./RefusalLog"
import { json, refuse } from "./Responses"

/** Cloud pins accept only canonical public HTTPS DNS origins, on port 443. */
export const cloudCredentialOrigin = (raw: string): string | undefined => {
  try {
    const url = new URL(raw), host = url.hostname
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || (raw !== url.origin && raw !== `${url.origin}/`)) return undefined
    const labels = host.split(".")
    if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/^[a-z][a-z0-9-]*$/.test(labels.at(-1)!)) return undefined
    if (labels.some(label => ["localhost", "localdomain", "local", "internal", "intranet", "private", "loopback", "link-local", "lan", "home", "corp"].includes(label)) ||
      host.endsWith(".arpa") || host.endsWith(".onion")) return undefined
    return url.origin
  } catch { return undefined }
}

const DEPLOYMENT_NAMES = ["CEREBRAS_API_KEY", "AI_GATEWAY_API_KEY"] as const
export const isDeploymentCredential = (name: string): boolean => (DEPLOYMENT_NAMES as readonly string[]).includes(name)
export const deploymentModelSecret = (config: ServerConfigShape, name: string): Redacted.Redacted<string> | undefined =>
  name === "CEREBRAS_API_KEY" ? config.cerebrasApiKey : name === "AI_GATEWAY_API_KEY" ? config.aiGatewayApiKey : undefined
export const workerModelCredentials = (config: ServerConfigShape): ReadonlyArray<ModelCredentialListing> => DEPLOYMENT_NAMES.map(name => ({
  name, present: deploymentModelSecret(config, name) !== undefined, origins: [...MODEL_CREDENTIALS.find(row => row.name === name)!.origins]
}))

const loginSchema = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
const sealedSchema = z.strictObject({ nonce: base64.length(16), ciphertext: base64.min(24).max(44_000) })
const entrySchema = z.strictObject({ name: ModelCredentialNameSchema, origin: z.string().max(512), sealed: sealedSchema.nullable() })
type Entry = z.infer<typeof entrySchema>
const receiptSchema = z.strictObject({ id: ModelCredentialRequestIdSchema, action: z.enum(["enroll", "rotate", "remove"]), name: ModelCredentialNameSchema,
  origin: z.string().optional(), result: ModelCredentialResultSchema })
const documentSchema = z.strictObject({ version: z.literal(1), login: loginSchema, entries: z.array(entrySchema).max(62), receipts: z.array(receiptSchema).max(128) })
type VaultDocument = z.infer<typeof documentSchema>
const commandSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("read"), login: loginSchema }),
  z.strictObject({ op: z.literal("write"), login: loginSchema, id: ModelCredentialRequestIdSchema, action: z.enum(["enroll", "rotate", "remove"]),
    name: ModelCredentialNameSchema, origin: z.string().max(512), sealed: sealedSchema.nullable() })
])
type Command = z.infer<typeof commandSchema>
const listing = (entry: Entry): ModelCredentialListing => ({ name: entry.name, origins: [entry.origin], present: entry.sealed !== null, managed: true })
const empty = (login: string): VaultDocument => ({ version: 1, login, entries: [], receipts: [] })
const publicResult = (result: unknown): Response => {
  const response = json(200, result)
  response.headers.set("cache-control", "no-store")
  return response
}
/**
 * Every vault failure. `reason` is fixed words or an inner failure's tag and
 * nothing else: it is what the logs read, and a platform exception's message
 * or a request body could carry a credential.
 */
class VaultFailure extends Data.TaggedError("VaultFailure")<{ readonly reason: string }> {}
const unavailable = (reason: string) => new VaultFailure({ reason })
// Never let a cause carrying a platform exception escape to a logger: keep its tag only.
const safe = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, VaultFailure, R> => work.pipe(
  Effect.catchCause(cause => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
    const failure = Cause.squash(cause)
    if (failure instanceof VaultFailure) return Effect.fail(failure)
    const tag = typeof failure === "object" && failure !== null && "_tag" in failure && typeof failure._tag === "string" ? failure._tag : "Defect"
    return Effect.fail(unavailable(tag))
  })
)
const pinAllowed = (name: string, origin: string) => cloudCredentialOrigin(origin) === origin &&
  (MODEL_CREDENTIALS.find(row => row.name === name)?.origins as readonly string[] | undefined)?.includes(origin) !== false
const decodeDocument = (raw: unknown, login: string): VaultDocument | undefined => {
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success || parsed.data.login !== login || new Set(parsed.data.entries.map(row => row.name)).size !== parsed.data.entries.length ||
    parsed.data.entries.some(row => isDeploymentCredential(row.name) || !pinAllowed(row.name, row.origin))) return undefined
  return parsed.data
}

/** Only ciphertext crosses this internal door. One object's lock covers its full read/modify/write. */
const vaultRequest = (request: Request, mutex: Semaphore.Semaphore): Effect.Effect<Response, never, DurableStorage> => safe(Effect.gen(function* () {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/vault") return new Response(null, { status: 404 })
  const parsed = commandSchema.safeParse(yield* readBoundedJson(request, 64 * 1024))
  if (!parsed.success) return new Response(null, { status: 400 })
  const command = parsed.data
  const storage = yield* DurableStorage
  return yield* mutex.withPermit(Effect.gen(function* () {
    const raw = yield* storage.get("model-vault:v1")
    const document = raw === undefined ? empty(command.login) : decodeDocument(raw, command.login)
    if (!document) return yield* Effect.fail(unavailable("document undecodable"))
    if (command.op === "read") return publicResult(document)
    const recorded = document.receipts.find(row => row.id === command.id)
    if (recorded) return publicResult(recorded.name === command.name && recorded.action === command.action &&
      (command.action !== "enroll" || recorded.origin === command.origin) ? recorded.result : failedModelCredential({ code: "invalid", field: "requestId" }))
    if (isDeploymentCredential(command.name)) return publicResult(failedModelCredential({ code: "read_only" }))
    const previous = document.entries.find(row => row.name === command.name)
    if (command.action === "enroll" && previous) return publicResult(failedModelCredential({ code: "exists" }))
    if (command.action !== "enroll" && !previous) return publicResult(failedModelCredential({ code: "unknown" }))
    if (!pinAllowed(command.name, command.origin) || (previous && previous.origin !== command.origin)) return publicResult(failedModelCredential({ code: "invalid", field: "origin" }))
    if ((command.action === "remove") !== (command.sealed === null)) return new Response(null, { status: 400 })
    const entry: Entry = { name: command.name, origin: command.origin, sealed: command.sealed }
    const result: ModelCredentialResult = { ok: true, credential: listing(entry) }
    const next: VaultDocument = { ...document, entries: [...document.entries.filter(row => row.name !== command.name), entry],
      receipts: [...document.receipts, { id: command.id, name: command.name, action: command.action,
        ...(command.action === "enroll" ? { origin: command.origin } : {}), result }].slice(-128) }
    if (next.entries.length > 62 || new TextEncoder().encode(JSON.stringify(next)).length > 120_000) return yield* Effect.fail(unavailable("document over its limit"))
    yield* storage.put("model-vault:v1", next)
    return publicResult(result)
  }))
})).pipe(Effect.catch(failure => Effect.sync(() => {
  logSeamFailure("model vault object", failure)
  return new Response(null, { status: 503 })
})))

export class AccountModelVault {
  private readonly mutex = Semaphore.makeUnsafe(1)
  private readonly storage: Layer.Layer<DurableStorage>
  constructor(ctx: { readonly storage: NativeStorage }) { this.storage = storageLayer(ctx.storage) }
  fetch(request: Request): Promise<Response> { return runDurable(vaultRequest(request, this.mutex).pipe(Effect.provide(this.storage))) } // effect-policy: boundary
}

interface VaultStore {
  readonly available: boolean
  readonly call: (command: Command) => Effect.Effect<unknown, VaultFailure>
}
export class ModelVault extends Context.Service<ModelVault, VaultStore>()("smithers-server/ModelVault") {}
export const modelVaultLayer = (namespace: NativeNamespace | undefined): Layer.Layer<ModelVault> => Layer.succeed(ModelVault, {
  available: namespace !== undefined,
  call: command => namespace === undefined ? Effect.fail(unavailable("vault not bound")) : safe(Effect.gen(function* () {
    const response = yield* namespaceCall("model vault", namespace, command.login, new Request("https://model-vault.internal/vault", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
    }))
    if (!response.ok) return yield* Effect.fail(unavailable(`the vault object answered ${response.status}`))
    return yield* readBoundedJson(response, 128 * 1024)
  }))
})

const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const encoded = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value)))
const aad = (login: string, name: string, origin: string) => new TextEncoder().encode(JSON.stringify([1, login, name, origin]))
const encryptionKey = (config: ServerConfigShape): Effect.Effect<CryptoKey | undefined> => safe(Effect.gen(function* () {
  if (!config.modelVaultKey) return undefined
  const value = Redacted.value(config.modelVaultKey)
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined
  const material = yield* Effect.try(() => bytes(value))
  if (material.length !== 32) return undefined
  return yield* Effect.tryPromise({ try: () => crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]), catch: () => unavailable("key import") })
})).pipe(Effect.catch(() => Effect.succeed(undefined)))
const seal = (key: CryptoKey, login: string, name: string, origin: string, value: Redacted.Redacted<string>) => safe(Effect.gen(function* () {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = yield* Effect.tryPromise({ try: () => crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(login, name, origin), tagLength: 128 }, key,
    new TextEncoder().encode(Redacted.value(value))), catch: () => unavailable("seal") })
  return { nonce: encoded(nonce), ciphertext: encoded(ciphertext) }
}))
const unseal = (key: CryptoKey, login: string, entry: Entry) => safe(Effect.gen(function* () {
  if (!entry.sealed) return yield* Effect.fail(unavailable("sealed value missing"))
  const { nonce, ciphertext } = entry.sealed
  const value = yield* Effect.tryPromise({ try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(nonce), additionalData: aad(login, entry.name, entry.origin), tagLength: 128 }, key, bytes(ciphertext)), catch: () => unavailable("unseal") })
  return Redacted.make(new TextDecoder("utf-8", { fatal: true }).decode(value))
}))

/** The session is captured by the router, never accepted from a request body. */
export const sameModelAccount = (request: Request, login: string): Effect.Effect<Response | undefined, never, ServerConfig | Transport> => Effect.gen(function* () {
  const session = yield* requireTurnSession(request)
  return !(session instanceof Response) && session?.login.toLowerCase() === login ? undefined : refuse("sign_in_required", "Sign in to use this credential.")
})

export interface AccountCredentials {
  readonly listings: ReadonlyArray<ModelCredentialListing>
  readonly available: boolean
  readonly configured: boolean
  readonly current: Effect.Effect<Response | undefined, never, ServerConfig | Transport>
  readonly read: (plan: ModelPlan) => Effect.Effect<Redacted.Redacted<string> | undefined>
}

/** Fresh per request, never an account-shared cache; only the selected planned record is decrypted. */
export const accountModelCredentials = (request: Request, login: string): Effect.Effect<AccountCredentials, never, ModelVault | ServerConfig> => Effect.gen(function* () {
  login = login.toLowerCase()
  const store = yield* ModelVault, key = yield* encryptionKey(yield* ServerConfig)
  const document = key && store.available && loginSchema.safeParse(login).success
    ? yield* store.call({ op: "read", login }).pipe(Effect.map(raw => decodeDocument(raw, login)), Effect.catch(() => Effect.succeed(undefined))) : undefined
  return { listings: document?.entries.map(listing) ?? [], available: document !== undefined, configured: key !== undefined && store.available,
    current: sameModelAccount(request, login),
    read: plan => {
      const entry = document?.entries.find(row => row.name === plan.credential && row.origin === plan.origin)
      return key && entry ? unseal(key, login, entry).pipe(Effect.catch(() => Effect.succeed(undefined))) : Effect.succeed(undefined)
    } }
})

/** The sole public plaintext ingress. No body or exception is forwarded to the object or logger. */
export const handleModelCredential = (request: Request, login: string, receiptId?: string): Effect.Effect<Response, never, ModelVault | ServerConfig | Transport> => safe(Effect.gen(function* () {
  login = login.toLowerCase()
  const store = yield* ModelVault, key = yield* encryptionKey(yield* ServerConfig)
  if (!key || !store.available) return publicResult(receiptId === undefined ? failedModelCredential({ code: "vault_unavailable" }, "infra") : { state: "unknown" })
  if (!loginSchema.safeParse(login).success) return refuse("sign_in_required", "Sign in to use this credential.")
  const document = decodeDocument(yield* store.call({ op: "read", login }), login)
  if (!document) return yield* Effect.fail(unavailable("document undecodable"))
  if (receiptId !== undefined) {
    const refusal = yield* sameModelAccount(request, login)
    if (refusal) return refusal
    const receipt = document.receipts.find(row => row.id === receiptId)
    return publicResult(receipt ? { state: "completed", result: receipt.result } : { state: "unknown" })
  }
  const input = yield* readBoundedJson(request, 40 * 1024).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const parsed = ModelCredentialRequestSchema.safeParse(input)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    return publicResult(failedModelCredential({ code: "invalid", field: field === "name" || field === "origin" || field === "value" || field === "requestId" ? field : "action" }))
  }
  const command = parsed.data
  const value = command.action === "remove" ? undefined : Redacted.make(command.value)
  if ("value" in command) command.value = ""
  if (typeof input === "object" && input !== null && "value" in input) input.value = ""
  if (isDeploymentCredential(command.name)) return publicResult(failedModelCredential({ code: "read_only" }))
  const recorded = document.receipts.find(row => row.id === command.requestId)
  const previous = document.entries.find(row => row.name === command.name)
  const origin = command.action === "enroll" ? cloudCredentialOrigin(command.origin) : previous?.origin
  if (recorded) {
    const refusal = yield* sameModelAccount(request, login)
    if (refusal) return refusal
    return publicResult(recorded.name === command.name && recorded.action === command.action &&
      (command.action !== "enroll" || recorded.origin === origin) ? recorded.result : failedModelCredential({ code: "invalid", field: "requestId" }))
  }
  if (command.action === "enroll" && previous) return publicResult(failedModelCredential({ code: "exists" }))
  if (command.action !== "enroll" && !previous) return publicResult(failedModelCredential({ code: "unknown" }))
  if (!origin || !pinAllowed(command.name, origin)) return publicResult(failedModelCredential({ code: "invalid", field: "origin" }))
  const sealed = value === undefined ? null : yield* seal(key, login, command.name, origin, value)
  const refusal = yield* sameModelAccount(request, login)
  if (refusal) return refusal
  const result = ModelCredentialResultSchema.safeParse(yield* store.call({ op: "write", login, id: command.requestId, name: command.name, action: command.action, origin, sealed }))
  if (!result.success) return yield* Effect.fail(unavailable("write result invalid"))
  const stale = yield* sameModelAccount(request, login)
  return stale ?? publicResult(result.data)
})).pipe(Effect.catch(() => Effect.succeed(publicResult(failedModelCredential({ code: "storage_unavailable" })))))
