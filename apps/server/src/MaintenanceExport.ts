import { Effect } from "effect"
import { z } from "zod"
import { runDurable, runRequest } from "./Boundary"
import { storageFrom, type NativeStorage } from "./DurableStorage"
import type { WorkerEnv } from "./Environment"
import { readBoundedJson } from "./Http"
import { authenticatedExport, encodeStored, sealSnapshot, SnapshotFailure } from "./SealedSnapshot"
import type { NativeRecommendStorage } from "./recommend"

export const EXPORT_PATH = "/__maintenance/state-export"
export const EXPORT_BINDINGS = ["TURN_CANCELS", "GATEWAY_SESSIONS", "TURN_LIMITS", "CLIENT_ERRORS", "RECOMMEND_LOG", "MODEL_VAULTS"] as const
export interface ExportSettings {
  readonly SMITHERS_EXPORT_TOKEN?: string
  readonly SMITHERS_EXPORT_RECIPIENT?: string
  readonly SMITHERS_EXPORT_EXPIRES_AT?: string
  readonly SMITHERS_EXPORT_SOURCE_REVISION?: string
  readonly SMITHERS_EXPORT_SOURCE_VERSION?: string
  readonly MODEL_VAULT_KEY?: string
}
export type MaintenanceEnv = WorkerEnv & ExportSettings
interface SnapshotStorage extends NativeStorage, NativeRecommendStorage {
  readonly getAlarm: () => Promise<number | null>
  readonly delete: (key: string) => Promise<boolean>
  readonly put: (key: string | Record<string, unknown>, value?: unknown) => Promise<void>
  readonly list: <T>(options: { prefix: string; limit: number; startAfter?: string; reverse?: boolean }) => Promise<Map<string, T>>
}
interface ExportContext {
  readonly id: { readonly toString: () => string }
  readonly storage: SnapshotStorage
  readonly blockConcurrencyWhile: <T>(body: () => Promise<T>) => Promise<T>
}
interface LegacyObject {
  fetch(request: Request): Promise<Response>
  alarm?(): Promise<void>
}
type LegacyClass = new (ctx: ExportContext, env: MaintenanceEnv) => LegacyObject

const Input = z.object({ binding: z.enum(EXPORT_BINDINGS), objectId: z.string().regex(/^[a-f0-9]{64}$/), migrationId: z.uuid() }).strict()
type ExportInput = z.infer<typeof Input>
const response = (status: number, code: string) => Response.json({ code }, { status, headers: { "cache-control": "no-store" } })
const enabled = (env: ExportSettings): boolean => {
  const expires = Date.parse(env.SMITHERS_EXPORT_EXPIRES_AT ?? "")
  const remaining = expires - Date.now()
  return remaining > 0 && remaining <= 86_400_000 && !!env.SMITHERS_EXPORT_RECIPIENT &&
    /^[a-f0-9]{40}$/.test(env.SMITHERS_EXPORT_SOURCE_REVISION ?? "") &&
    z.uuid().safeParse(env.SMITHERS_EXPORT_SOURCE_VERSION).success
}
const authorized = (request: Request, env: ExportSettings) =>
  enabled(env) ? authenticatedExport(request.headers.get("authorization"), env.SMITHERS_EXPORT_TOKEN) : Effect.succeed(false)

const decode = (request: Request) => readBoundedJson(request, 2048).pipe(
  Effect.flatMap(body => {
    const parsed = Input.safeParse(body)
    return parsed.success ? Effect.succeed(parsed.data) : Effect.fail(new SnapshotFailure({ code: "invalid_export_request" }))
  }),
  Effect.catch(() => Effect.fail(new SnapshotFailure({ code: "invalid_export_request" })))
)

const objectSnapshot = (ctx: ExportContext, env: ExportSettings, binding: string, request: Request) => Effect.gen(function* () {
  if (!(yield* authorized(request, env))) return response(404, "not_found")
  const input = yield* decode(request)
  if (input.binding !== binding || input.objectId !== ctx.id.toString()) return response(409, "export_object_mismatch")
  const storage = storageFrom(ctx.storage)
  const alarm = yield* Effect.tryPromise({ try: () => ctx.storage.getAlarm(), catch: () => new SnapshotFailure({ code: "snapshot_read_failed" }) })
  const entries: Array<readonly [string, unknown]> = []
  let cursor: string | undefined, bytes = 0
  for (;;) {
    const page = yield* storage.list<unknown>({ prefix: "", limit: 64, ...(cursor ? { startAfter: cursor } : {}) })
    for (const [key, value] of page) {
      const encoded = yield* Effect.try({ try: () => encodeStored(value), catch: () => new SnapshotFailure({ code: "unsupported_storage_value" }) })
      bytes += new TextEncoder().encode(JSON.stringify([key, encoded])).byteLength
      if (bytes > 8_000_000 || entries.length >= 50_000) return response(413, "snapshot_requires_paged_export")
      entries.push([key, encoded])
      cursor = key
    }
    if (page.size < 64) break
  }
  const recipient = yield* Effect.try({ try: () => JSON.parse(env.SMITHERS_EXPORT_RECIPIENT!) as JsonWebKey, catch: () => new SnapshotFailure({ code: "invalid_export_recipient" }) })
  const sealed = yield* sealSnapshot({ version: 1, schema: "smithers-do-storage/v1", keyVersion: binding === "MODEL_VAULTS" ? "model-vault:v1" : null,
    ...input, sourceRevision: env.SMITHERS_EXPORT_SOURCE_REVISION!, sourceVersion: env.SMITHERS_EXPORT_SOURCE_VERSION!, capturedAt: new Date().toISOString() },
    { entries, alarm, ...(binding === "MODEL_VAULTS" ? { migrationContext: { keyVersion: "model-vault:v1", modelVaultKey: env.MODEL_VAULT_KEY ?? null } } : {}) }, recipient)
  return Response.json(sealed, { headers: { "cache-control": "no-store" } })
}).pipe(Effect.catch(() => Effect.succeed(response(503, "snapshot_unavailable"))))

/** Inherit every legacy RPC, WebSocket hook and alarm; override only the temporary fetch path. */
export const withSealedExport = (Legacy: LegacyClass, binding: typeof EXPORT_BINDINGS[number]) => class extends Legacy {
  constructor(private readonly snapshotContext: ExportContext, private readonly exportEnv: MaintenanceEnv) {
    super(snapshotContext, exportEnv)
  }
  fetch(request: Request): Promise<Response> { // effect-policy: boundary
    if (new URL(request.url).pathname !== EXPORT_PATH) return super.fetch(request)
    return this.snapshotContext.blockConcurrencyWhile(() => runDurable(objectSnapshot(this.snapshotContext, this.exportEnv, binding, request)))
  }
}

interface ByIdNamespace {
  readonly idFromString: (id: string) => unknown
  readonly get: (id: unknown) => { readonly fetch: (request: Request) => Promise<Response> }
}

/** Temporary operator-only ciphertext export. No user cookie, OAuth token, or product bearer grants it. */
export const maintenanceExport = (request: Request, env: MaintenanceEnv): Promise<Response> => runRequest(Effect.gen(function* () {
  if (!(yield* authorized(request, env))) return response(404, "not_found")
  if (request.method !== "POST") return response(405, "method_not_allowed")
  const input: ExportInput = yield* decode(request)
  const namespace = env[input.binding] as unknown as ByIdNamespace | undefined
  if (!namespace || typeof namespace.idFromString !== "function") return response(503, "export_binding_unavailable")
  return yield* Effect.tryPromise({
    try: () => namespace.get(namespace.idFromString(input.objectId)).fetch(new Request(`https://state-export.internal${EXPORT_PATH}`, {
      method: "POST", headers: { authorization: `Bearer ${env.SMITHERS_EXPORT_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(input)
    })),
    catch: () => new SnapshotFailure({ code: "snapshot_unavailable" })
  })
}).pipe(Effect.catch(() => Effect.succeed(response(503, "snapshot_unavailable")))), request.signal)
