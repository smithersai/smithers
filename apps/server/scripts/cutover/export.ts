import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { EXPORT_PATH } from "../../src/MaintenanceExport"
import type { SealedSnapshot } from "../../src/SealedSnapshot"
import { WORKER_IDENTITY } from "../../src/workerIdentity"
import { api, listObjects, scriptPath, validateBindings, type Settings } from "./cloudflare"
import { Inventory } from "./inventory"
import { openSnapshot } from "./sealed"
import { verifyVaultRecovery } from "./vault"
import { requireExportVersion } from "./deployment"

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) throw new Error("Usage: bun scripts/cutover/export.ts PRIVATE_DIRECTORY")
const privateFile = resolve(directory, "recipient.json")
for (const path of [directory, privateFile]) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Export directory and recipient must be owner-only")
}
const recipient = JSON.parse(readFileSync(privateFile, "utf8")) as { migrationId: string; token: string; expiresAt: string; privateJwk: JsonWebKey }
const plan = JSON.parse(readFileSync(resolve(directory, "prepared/plan.json"), "utf8")) as { sourceRevision: string; sourceVersion: string }
const applied = JSON.parse(readFileSync(resolve(directory, "prepared/verified.json"), "utf8")) as { version: string }
const guardVersion = async () => {
  const deployments = (await api<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(scriptPath + "/deployments")).result.deployments
  requireExportVersion(deployments[0], applied.version)
}
if (!(Date.parse(recipient.expiresAt) > Date.now()) || !recipient.privateJwk.d || recipient.token.length < 43) throw new Error("Recipient is invalid or expired")
await guardVersion()
const settings = (await api<Settings>(scriptPath + "/settings")).result
const namespaces = validateBindings(settings)
const destination = resolve(directory, "web-snapshots")
mkdirSync(destination, { mode: 0o700 })
const inventory = new Inventory()
const manifest: Array<{ binding: string; objectId: string; capturedAt: string; sha256: string; bytes: number }> = []
let emptyAtListing = 0
const vaultRecovery = { objectsWithKey: 0, objectsWithoutKey: 0, sealedEntries: 0, decryptVerified: 0, decryptFailed: 0, unclassified: 0 }
const startedAt = new Date().toISOString()
for (const namespace of namespaces) {
  const objects = await listObjects(namespace.namespace_id!)
  for (const object of objects) {
    if (!object.hasStoredData) { emptyAtListing++; continue }
    await guardVersion()
    const response = await fetch(`https://${WORKER_IDENTITY.domain.name}${EXPORT_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${recipient.token}`, "content-type": "application/json" },
      body: JSON.stringify({ migrationId: recipient.migrationId, binding: namespace.name, objectId: object.id }) })
    if (!response.ok) throw new Error(`Snapshot refused (${response.status}); partial sealed files retained`)
    const text = await response.text()
    if (text.length > 12_000_000) throw new Error("Snapshot exceeds operator limit")
    const sealed = JSON.parse(text) as SealedSnapshot
    if (sealed.metadata.binding !== namespace.name || sealed.metadata.objectId !== object.id || sealed.metadata.migrationId !== recipient.migrationId ||
      sealed.metadata.sourceRevision !== plan.sourceRevision || sealed.metadata.sourceVersion !== plan.sourceVersion ||
      !Number.isFinite(Date.parse(sealed.metadata.capturedAt))) throw new Error("Snapshot provenance mismatch")
    const payload = await openSnapshot(sealed, recipient.privateJwk)
    if (namespace.name === "MODEL_VAULTS") {
      const recovery = await verifyVaultRecovery(payload)
      vaultRecovery[recovery.keyAvailable ? "objectsWithKey" : "objectsWithoutKey"]++
      for (const name of ["sealedEntries", "decryptVerified", "decryptFailed", "unclassified"] as const) vaultRecovery[name] += recovery[name]
    }
    inventory.include(namespace.name, payload, sealed.metadata.capturedAt)
    writeFileSync(resolve(destination, `${namespace.name}-${object.id}.json`), text, { mode: 0o600, flag: "wx" })
    manifest.push({ binding: namespace.name, objectId: object.id, capturedAt: sealed.metadata.capturedAt,
      sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) })
  }
  console.log(JSON.stringify({ binding: namespace.name, exportedObjects: manifest.filter(item => item.binding === namespace.name).length }))
}
// This is an inventory snapshot while the old service is live, not a drain receipt.
await guardVersion()
const report = { migrationId: recipient.migrationId, sourceRevision: plan.sourceRevision, sourceVersion: plan.sourceVersion, startedAt, finishedAt: new Date().toISOString(),
  completeForListedStoredObjects: true, globallyQuiescent: false, credentialMigrationReady: false, verifiedCanonicalIdentityMappings: 0,
  emptyObjectsSkippedAtListing: emptyAtListing, counts: inventory.summary(), vaultRecovery }
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({ report, objects: manifest }, null, 2), { mode: 0o600, flag: "wx" })
writeFileSync(resolve(destination, "counts.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" })
console.log(JSON.stringify(report))
