import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { FenceIdentity } from "../../src/MaintenanceFence"
import { fenceModule } from "./fence-module"
import { classifyDurableObject, openDrainSnapshot } from "./drain"

/**
 * Local workerd retry exhaustion only. Production retry timing is Cloudflare's
 * (docs: exponential backoff from 2 s, up to 6 retries); this proves the marker
 * outlives the runtime's own drop, a restart and an exact restore.
 */
test("real workerd: a fenced alarm leaves a durable interrupted marker that survives retries, restart, runtime drop and restore", async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey), privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
  const identity: FenceIdentity = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech", worker: "smithers-mvp-web", sourceVersion: randomUUID(), sourceArtifactSHA256: "c".repeat(64) }
  const built = await Bun.build({ entrypoints: [new URL("../../src/MaintenanceFence.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true })
  expect(built.success).toBe(true)
  const child = Bun.spawn(["node", new URL("./alarm-workerd.mjs", import.meta.url).pathname], {
    stdin: new Blob([JSON.stringify({ identity, publicJwk, privateJwk, helper: await built.outputs[0]!.text(), entry: fenceModule(identity, [{ binding: "TURN_CANCELS", className: "TurnCancelRegistry" }]) })]), stdout: "pipe", stderr: "pipe" })
  const [code, out, log] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  console.log(log.trim()) // timeline evidence: first delivery, restart, runtime drop, restore, re-fence
  expect(log).toContain("re-fenced export still carries the marker")
  expect(code).toBe(0)
  const { sealed, objectId, marker } = JSON.parse(out) as { sealed: string; objectId: string; marker: { observations: number; lastRetryCount: number } }
  expect(marker.observations).toBeGreaterThan(marker.lastRetryCount) // the restart reset the runtime's counter, not ours
  // The collector's own decrypt + classification path sees it as interrupted, not completed, not product data.
  const opened = await openDrainSnapshot(sealed, { executionID: identity.executionID, binding: "TURN_CANCELS", objectId, sourceVersion: identity.sourceVersion, sourceArtifactSHA256: identity.sourceArtifactSHA256,
    notBefore: 0, credentialExpiresAt: new Date(Date.now() + 600_000).toISOString() }, privateJwk)
  const classified = classifyDurableObject("TURN_CANCELS", objectId, opened.payload.entries, opened.payload.alarm, Date.parse(opened.capturedAt), opened.payload.cutoverAlarmMarkers ?? [], "smithers-mvp-web")
  expect(classified.counts.invalidRows).toBe(0)
  expect(opened.payload.entries.map(([k]) => k)).toEqual(["after_restore", "kept"])
  expect(classified.dispositions).toEqual([{ binding: "TURN_CANCELS", objectId, key: `alarm-marker#${identity.executionID}`, reason: "alarm-interrupted", disposition: "interrupted-unknown",
    marker: expect.objectContaining({ executionID: identity.executionID, observations: marker.observations, lastRetryCount: marker.lastRetryCount }) }])
}, 330_000)
