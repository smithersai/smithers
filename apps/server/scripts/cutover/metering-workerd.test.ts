import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { FenceIdentity } from "../../src/MaintenanceFence"
import { admissionModule, fenceModule } from "./fence-module"
import { classifyDurableObject, openDrainSnapshot } from "./drain"

const bundle = async (entry: string) => {
  const built = await Bun.build({ entrypoints: [new URL(entry, import.meta.url).pathname], target: "browser", format: "esm", minify: true })
  expect(built.success).toBe(true)
  return built.outputs[0]!.text()
}
test("real workerd: admission drains usage, the final fence refuses late charges/RPC/queue ACK, the ledger survives and restore is exact", async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey), privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
  const migrationId = randomUUID()
  const identity = (worker: string): FenceIdentity => ({ executionID: migrationId, smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech", worker, sourceVersion: randomUUID(), sourceArtifactSHA256: "c".repeat(64) })
  const billing = identity("smithers-cloud-billing"), chat = identity("smithers-cloud-chat-canary")
  const accounts = [{ binding: "ACCOUNTS", className: "AccountDurableObject" }]
  const input = {
    billing: { identity: billing, admission: admissionModule(billing, "index.js", accounts), fence: fenceModule(billing, accounts) },
    chat: { identity: chat, admission: admissionModule(chat, "index.js", []), fence: fenceModule(chat, []) },
    admissionHelper: await bundle("../../src/MaintenanceAdmission.ts"), fenceHelper: await bundle("../../src/MaintenanceFence.ts"), publicJwk, migrationId
  }
  const child = Bun.spawn(["node", new URL("./metering-workerd.mjs", import.meta.url).pathname], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" })
  const [code, out, log] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(log).toContain("restore: original ledger preserved")
  expect(code).toBe(0)
  const { sealed, objectId } = JSON.parse(out) as { sealed: string; objectId: string }
  // The same sealed-export and classification path the cutover collector uses.
  const opened = await openDrainSnapshot(sealed, { executionID: migrationId, binding: "ACCOUNTS", objectId, sourceVersion: billing.sourceVersion, sourceArtifactSHA256: billing.sourceArtifactSHA256,
    notBefore: 0, credentialExpiresAt: new Date(Date.now() + 600_000).toISOString() }, privateJwk)
  const classified = classifyDurableObject("ACCOUNTS", objectId, opened.payload.entries, opened.payload.alarm, Date.parse(opened.capturedAt))
  expect(classified.counts.invalidRows).toBe(0)
  expect(classified.charges.map(c => c.id).sort()).toEqual(["admitted-direct", "admitted-queued", "legacy-direct", "legacy-queued"])
}, 120_000)
