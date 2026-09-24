import { expect, test } from "bun:test"
import { encodeStored } from "../../src/SealedSnapshot"
import { verifyVaultRecovery } from "./vault"
import type { SnapshotPayload } from "./sealed"

test("recovery verifies original GCM AAD without exposing plaintext; missing/wrong keys fail", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"])
  const aad = new TextEncoder().encode(JSON.stringify([1, "private-login", "ANTHROPIC_API_KEY", "https://api.anthropic.com"]))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, new TextEncoder().encode("private-provider-key"))
  const base64 = (value: ArrayBuffer | Uint8Array) => Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64")
  const payload: SnapshotPayload = { alarm: null, migrationContext: { keyVersion: "model-vault:v1", modelVaultKey: base64(raw) }, entries: [["model-vault:v1", encodeStored({ version: 1,
    login: "private-login", entries: [{ name: "ANTHROPIC_API_KEY", origin: "https://api.anthropic.com", sealed: { nonce: base64(nonce), ciphertext: base64(ciphertext) } }] })]] }
  const recovered = await verifyVaultRecovery(payload)
  expect(recovered).toEqual({ keyAvailable: true, sealedEntries: 1, decryptVerified: 1, decryptFailed: 0, unclassified: 0 })
  expect(JSON.stringify(recovered)).not.toContain("private")
  expect(await verifyVaultRecovery({ ...payload, migrationContext: undefined })).toMatchObject({ keyAvailable: false, decryptVerified: 0, decryptFailed: 1 })
  expect(await verifyVaultRecovery({ ...payload, migrationContext: { keyVersion: "model-vault:v1", modelVaultKey: base64(new Uint8Array(32)) } })).toMatchObject({ keyAvailable: true, decryptVerified: 0, decryptFailed: 1 })
})
