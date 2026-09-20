import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Redacted } from "effect"
import { z } from "zod"
import {
  failedModelCredential, hostModelCredentials, isBuiltinModelCredential, MODEL_CREDENTIALS,
  modelCredentialEnvName, ModelCredentialListingSchema, ModelCredentialRequestSchema,
  ModelCredentialResultSchema, modelOriginOf
} from "@smthrs/rpc/ConfiguredModel"
import type { ModelCatalog, ModelCredentialEnv, ModelCredentialListing, ModelCredentialResult } from "@smthrs/rpc/ConfiguredModel"
import { darwinKeychain, type CloudKeychain } from "./CloudAuth"

const vaultSchema = z.strictObject({ version: z.literal(1), entries: z.array(z.strictObject({
  name: ModelCredentialListingSchema.shape.name, origin: z.string(), value: z.string().nullable()
})).max(59), receipts: z.array(z.strictObject({ id: z.string(), result: ModelCredentialResultSchema })).max(128) })
type Vault = z.infer<typeof vaultSchema>

/** Model values stay behind this host-only interface. Listing and planning never hold one. */
export interface ModelCredentials {
  readonly refresh: () => Promise<void>
  readonly list: () => ReadonlyArray<ModelCredentialListing>
  readonly read: (name: string) => Redacted.Redacted<string> | undefined
  readonly enrollment: () => NonNullable<ModelCatalog["enrollment"]>
  readonly mutate: (input: unknown) => Promise<ModelCredentialResult>
  readonly receipt: (id: string) => Promise<{ state: "unknown" } | { state: "completed"; result: ModelCredentialResult }>
}

/** Scope isolates native, headless and test hosts without putting a path in the keychain account. */
export const modelKeychainAccount = (scope: string): string => createHash("sha256").update(scope).digest("hex")
export const MODEL_KEYCHAIN_SERVICE = "smithers-model-credentials"

export const createModelCredentials = async (options: {
  readonly env: ModelCredentialEnv
  readonly scope: string
  readonly keychain?: CloudKeychain
}): Promise<ModelCredentials> => {
  const keychain = options.keychain ?? (process.platform === "darwin" ? darwinKeychain(undefined, true) : undefined)
  const account = modelKeychainAccount(options.scope)
  const operator = hostModelCredentials(options.env)
  const owned = (name: string): boolean => operator.some(row => row.name === name && (row.present || !isBuiltinModelCredential(name)))
  let vault: Vault = { version: 1, entries: [], receipts: [] }
  let ready = false
  const load = async () => {
    if (!keychain) return
    try {
      const stored = await keychain.read(MODEL_KEYCHAIN_SERVICE, account)
      const parsed = stored === null ? vault : vaultSchema.parse(JSON.parse(stored))
      if (parsed.entries.some(row => modelOriginOf(row.origin) !== row.origin)) throw new Error("Invalid credential vault")
      vault = parsed
      ready = true
    } catch { ready = false /* A locked or unreadable vault cannot be overwritten with an empty one. */ }
  }
  await load()
  const listing = (entry: Vault["entries"][number]): ModelCredentialListing => ({ name: entry.name, origins: [entry.origin], present: entry.value !== null, managed: true })
  const list = (): ReadonlyArray<ModelCredentialListing> => {
    const rows = new Map(operator.map(row => [row.name, row]))
    if (ready) for (const entry of vault.entries) if (!owned(entry.name)) rows.set(entry.name, listing(entry))
    return [...rows.values()]
  }
  const read = (name: string): Redacted.Redacted<string> | undefined => {
    const value = owned(name) ? options.env[modelCredentialEnvName(name)]?.trim() : ready ? vault.entries.find(row => row.name === name)?.value : undefined
    return value ? Redacted.make(value) : undefined
  }
  let queue: Promise<unknown> = Promise.resolve()
  const mutate = (input: unknown): Promise<ModelCredentialResult> => {
    const operation = queue.then(async (): Promise<ModelCredentialResult> => {
      const parsed = ModelCredentialRequestSchema.safeParse(input)
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0]
        return failedModelCredential({ code: "invalid", field: field === "name" || field === "origin" || field === "value" || field === "requestId" ? field : "action" })
      }
      const request = parsed.data
      if (!keychain) return failedModelCredential({ code: "storage_unavailable" })
      // An empty SQLite file supplies an OS-released, cross-process writer lock.
      // It never receives rows, pins or values, and must not be unlinked while a
      // host is alive. Re-read inside the lock so a second host cannot repin.
      await mkdir(options.scope, { recursive: true, mode: 0o700 })
      const lock = new Database(join(options.scope, "model-credentials.lock.sqlite"))
      try {
        lock.exec("BEGIN IMMEDIATE")
        await load()
        if (!ready) return failedModelCredential({ code: "storage_unavailable" })
        const recorded = vault.receipts.find(row => row.id === request.requestId)
        if (recorded) return recorded.result
        if (owned(request.name)) return failedModelCredential({ code: "read_only" })
        const previous = vault.entries.find(row => row.name === request.name)
        let entry: Vault["entries"][number]
        if (request.action === "enroll") {
          if (previous) return failedModelCredential({ code: "exists" })
          const origin = modelOriginOf(request.origin)
          if (origin === undefined || origin !== request.origin.replace(/\/$/, "")) return failedModelCredential({ code: "invalid", field: "origin" })
          const builtin = MODEL_CREDENTIALS.find(row => row.name === request.name)
          if (builtin && !(builtin.origins as ReadonlyArray<string>).includes(origin)) return failedModelCredential({ code: "invalid", field: "origin" })
          if (vault.entries.length >= 59 || (!list().some(row => row.name === request.name) && list().length >= 64)) return failedModelCredential({ code: "storage_unavailable" })
          entry = { name: request.name, origin, value: request.value }
        } else {
          if (!previous) return failedModelCredential({ code: "unknown" })
          entry = { ...previous, value: request.action === "remove" ? null : request.value }
        }
        const result: ModelCredentialResult = { ok: true, credential: listing(entry) }
        const next: Vault = { version: 1, entries: [...vault.entries.filter(row => row.name !== entry.name), entry],
          receipts: [...vault.receipts, { id: request.requestId, result }].slice(-128) }
        try {
          await keychain.write(MODEL_KEYCHAIN_SERVICE, account, JSON.stringify(next))
        } catch { return failedModelCredential({ code: "storage_unavailable" }) }
        vault = next
        return result
      } finally { lock.close() }
    }).catch(() => failedModelCredential({ code: "storage_unavailable" }))
    queue = operation
    return operation
  }
  const refresh = (): Promise<void> => {
    const operation = queue.then(load)
    queue = operation
    return operation
  }
  return { list, read, mutate, refresh,
    enrollment: () => ready ? { available: true } : { available: false, reason: "keychain_unavailable" },
    receipt: async id => {
      await refresh()
      if (!ready) return { state: "unknown" }
      const row = vault.receipts.find(row => row.id === id)
      return row ? { state: "completed", result: row.result } : { state: "unknown" }
    }
  }
}
