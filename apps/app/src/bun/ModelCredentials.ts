import { createHash } from "node:crypto"
import { Redacted } from "effect"
import { z } from "zod"
import {
  hostModelCredentials, isBuiltinModelCredential, modelCredentialEnvName, ModelCredentialListingSchema,
  ModelCredentialResultSchema, modelOriginOf
} from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentialEnv, ModelCredentialListing } from "@smthrs/rpc/ConfiguredModel"
import type { ModelCredentials } from "@smthrs/model-host/LocalModel"
import { darwinKeychain, type CloudKeychain } from "./CloudAuth"

const vaultSchema = z.strictObject({ version: z.literal(1), entries: z.array(z.strictObject({
  name: ModelCredentialListingSchema.shape.name, origin: z.string(), value: z.string().nullable()
})).max(59), receipts: z.array(z.strictObject({ id: z.string(), result: ModelCredentialResultSchema })).max(128) })
type Vault = z.infer<typeof vaultSchema>

/** Scope isolates native, headless and test hosts without putting a path in the keychain account. */
export const modelKeychainAccount = (scope: string): string => createHash("sha256").update(scope).digest("hex")
export const MODEL_KEYCHAIN_SERVICE = "smithers-model-credentials"

/** Model values behind the host keychain vault, which is read only: the app no longer enrolls keys. */
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
  return { list, read, refresh: load }
}
