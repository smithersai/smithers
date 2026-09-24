import { decodeStored, type SnapshotPayload } from "./sealed"

const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export interface VaultRecovery { keyAvailable: boolean; sealedEntries: number; decryptVerified: number; decryptFailed: number; unclassified: number }
/** Cryptographic recoverability only. No identity authorization/import, plaintext output or files. */
export const verifyVaultRecovery = async (snapshot: SnapshotPayload): Promise<VaultRecovery> => {
  const result: VaultRecovery = { keyAvailable: false, sealedEntries: 0, decryptVerified: 0, decryptFailed: 0, unclassified: 0 }
  let key: CryptoKey | undefined
  const source = snapshot.migrationContext?.modelVaultKey
  if (source && snapshot.migrationContext?.keyVersion === "model-vault:v1") {
    try { const raw = bytes(source); try { if (raw.length === 32) key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]) } finally { raw.fill(0) } } catch { /* Count only; no source material or exception detail. */ }
  }
  result.keyAvailable = key !== undefined
  for (const [name, encoded] of snapshot.entries) {
    if (name !== "model-vault:v1") continue
    const value = record(decodeStored(encoded))
    if (!value || value.version !== 1 || typeof value.login !== "string" || !Array.isArray(value.entries)) { result.unclassified++; continue }
    for (const entry of value.entries) {
      const row = record(entry)
      if (row?.sealed === null) continue
      const sealed = record(row?.sealed)
      if (!row || !sealed || typeof row.name !== "string" || typeof row.origin !== "string" || typeof sealed.nonce !== "string" || typeof sealed.ciphertext !== "string") { result.unclassified++; continue }
      result.sealedEntries++
      try {
        if (!key) throw new Error("missing")
        const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.nonce),
          additionalData: new TextEncoder().encode(JSON.stringify([1, value.login, row.name, row.origin])) }, key, bytes(sealed.ciphertext)))
        plaintext.fill(0)
        result.decryptVerified++
      } catch { result.decryptFailed++ }
    }
  }
  return result
}
