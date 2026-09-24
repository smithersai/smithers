/**
 * One-time Cloudflare cutover evidence operator and final validator.
 *
 *   bun scripts/cutover/cutover-evidence.ts collect  PRIVATE_DIR
 *   bun scripts/cutover/cutover-evidence.ts validate PRIVATE_DIR BUNDLE [--reconfirm]
 *
 * collect is read-only against production: Cloudflare GETs, analytics queries,
 * harmless refusal probes and sealed exports through the fenced Workers. It
 * never deploys, restores or edits storage; installing admission and the final
 * fence belongs to the cutover owner. validate recomputes every conclusion from
 * sealed snapshots and projected raw evidence; no stored flag or count is trusted.
 * Exit 0 prints an acceptance; exit 2 prints {"refused":"<CODE>"}.
 */
import { createHash, randomUUID } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { stable } from "./deployment"
import { CLOUDFLARE_PRODUCERS, collectCloudflareFence, privateArtifact, requireFence, save, type ArtifactReference, type CloudflareFenceReceipt, type FenceExpected } from "./fence"
import { addCounts, classifyDurableObject, collectDurableDrain, emptyCounts, openDrainSnapshot, orderRows, readRecipient, type ChargeRow, type Disposition, type DurableDrainObservation, type StripeGrant } from "./drain"
import { collectMeteringEvidence, METERING_QUEUES, METERING_WORKERS, reconcileMetering, type MeteringEvidence, type MeteringReceipt } from "./metering"

export interface CutoverEvidenceBundle extends FenceExpected {
  schema: "smithers-cloudflare-cutover/v1"; createdAt: string
  fence: ArtifactReference; drains: ArtifactReference[]; confirmation: ArtifactReference
  meteringEvidence: ArtifactReference; metering: ArtifactReference
}
export interface CutoverAcceptance extends FenceExpected {
  schema: "smithers-cloudflare-cutover-acceptance/v1"; bundleSHA256: string; validatedAt: string
  watermarks: Record<string, string>; credentialExpiresAt: string
  authorities: Array<{ worker: string; version: string; sourceVersion: string; sourceArtifactSHA256: string }>
  durable: { objects: number; rows: number; interruptedUnknown: Record<string, number> }
  metering: { charges: number; amountNanos: number; exceptions: Record<string, number>; streams: "interrupted-unknown" }
}
const json = <T>(root: string, ref: ArtifactReference): T => JSON.parse(privateArtifact(root, ref).toString()) as T
const tally = <T>(rows: T[], key: (row: T) => string, weight: (row: T) => number = () => 1) => {
  const out: Record<string, number> = {}
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + weight(row)
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}
const privateRoot = (directory: string) => {
  const root = resolve(directory), st = lstatSync(root)
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("CF_CUTOVER_DIRECTORY_NOT_PRIVATE")
  return root
}

/** The final gate. Returns only when every producer is fenced, drained and metered from real evidence. */
export const validateCutoverEvidence = async (directory: string, bundle: CutoverEvidenceBundle, expected: FenceExpected, clock: { now?: number; maxAgeMs?: number; reconfirmation?: CloudflareFenceReceipt } = {}): Promise<CutoverAcceptance> => {
  const root = privateRoot(directory), now = clock.now ?? Date.now()
  if (bundle.schema !== "smithers-cloudflare-cutover/v1" || (["executionID", "smithersRevision", "plueRevision", "endpoint"] as const).some(k => bundle[k] !== expected[k])) throw new Error("CF_CUTOVER_BUNDLE_INVALID")
  const fence = json<CloudflareFenceReceipt>(root, bundle.fence), confirmation = json<CloudflareFenceReceipt>(root, bundle.confirmation)
  requireFence(fence, expected, { now, maxAgeMs: null })
  requireFence(confirmation, expected, { now, maxAgeMs: clock.reconfirmation ? null : clock.maxAgeMs ?? 900_000 })
  const live = clock.reconfirmation
  if (live) requireFence(live, expected, { now, maxAgeMs: 120_000 })
  const authority = new Map(fence.authorities.map(a => [a.worker, a]))
  for (const later of [confirmation, ...live ? [live] : []]) for (const a of later.confirmation) {
    const first = authority.get(a.worker)!
    if (a.version !== first.version || a.modulesSHA256 !== first.modulesSHA256 || a.settingsSHA256 !== first.settingsSHA256 || a.sourceArtifactSHA256 !== first.sourceArtifactSHA256) throw new Error("CF_CUTOVER_FENCE_CHANGED")
  }
  if (Date.parse(confirmation.startedAt) < Date.parse(fence.finishedAt)) throw new Error("CF_CUTOVER_ORDER_INVALID")
  const recipient = readRecipient(root, expected.executionID)

  if (bundle.drains.length !== CLOUDFLARE_PRODUCERS.length) throw new Error("CF_DRAIN_AUTHORITY_INCOMPLETE")
  const drains = bundle.drains.map(ref => json<DurableDrainObservation>(root, ref))
  const charges: ChargeRow[] = [], stripeGrants: StripeGrant[] = [], dispositions: Disposition[] = [], totals = emptyCounts()
  let lastDrain = 0
  for (const worker of CLOUDFLARE_PRODUCERS) {
    const matches = drains.filter(d => d.worker === worker), a = authority.get(worker)!
    if (matches.length !== 1) throw new Error("CF_DRAIN_AUTHORITY_INCOMPLETE")
    const d = matches[0]!
    if (d.schema !== "smithers-durable-drain/v3" || d.complete !== true || (["executionID", "smithersRevision", "plueRevision", "endpoint"] as const).some(k => d[k] !== expected[k]) ||
      d.version !== a.version || d.sourceVersion !== a.sourceVersion || d.sourceArtifactSHA256 !== a.sourceArtifactSHA256) throw new Error("CF_DRAIN_NOT_UNDER_FENCE")
    if (Date.parse(d.startedAt) < Date.parse(fence.finishedAt) || Date.parse(d.finishedAt) > Date.parse(confirmation.startedAt) || Date.parse(d.startedAt) > Date.parse(d.finishedAt)) throw new Error("CF_CUTOVER_ORDER_INVALID")
    if (d.credentialExpiresAt !== recipient.expiresAt) throw new Error("CF_DRAIN_CREDENTIAL_EPOCH_MISMATCH")
    lastDrain = Math.max(lastDrain, Date.parse(d.finishedAt))
    // The namespaces read must be exactly the ones the fence observation saw bound.
    const settings = (json<{ settings: { bindings: Array<{ type: string; name: string; namespace_id?: string }> } }>(root, a.evidence)).settings
    const bound = settings.bindings.filter(b => b.type === "durable_object_namespace").map(b => ({ binding: b.name, namespaceId: b.namespace_id })).sort((x, y) => x.binding.localeCompare(y.binding))
    if (stable(bound) !== stable(d.namespaces.map(n => ({ binding: n.binding, namespaceId: n.namespaceId })).sort((x, y) => x.binding.localeCompare(y.binding)))) throw new Error("CF_DRAIN_NAMESPACE_COVERAGE")
    if (d.snapshots.length + d.emptyAtListing !== d.namespaces.reduce((n, x) => n + x.listed, 0) ||
      new Set(d.snapshots.map(s => s.binding + "\0" + s.objectId)).size !== d.snapshots.length || d.snapshots.some(s => !d.namespaces.some(n => n.binding === s.binding))) throw new Error("CF_DRAIN_OBJECT_COVERAGE")
    const counts = emptyCounts(), rows = { dispositions: [] as Disposition[], charges: [] as ChargeRow[], stripeGrants: [] as StripeGrant[] }
    for (const snapshot of d.snapshots) {
      const opened = await openDrainSnapshot(privateArtifact(root, snapshot).toString(), { executionID: expected.executionID, binding: snapshot.binding, objectId: snapshot.objectId,
        sourceVersion: a.sourceVersion, sourceArtifactSHA256: a.sourceArtifactSHA256, notBefore: Date.parse(a.observedAt), credentialExpiresAt: recipient.expiresAt }, recipient.privateJwk)
      if (opened.capturedAt !== snapshot.capturedAt) throw new Error("CF_DRAIN_SNAPSHOT_PROVENANCE")
      const c = classifyDurableObject(snapshot.binding, snapshot.objectId, opened.payload.entries, opened.payload.alarm, Date.parse(opened.capturedAt), opened.payload.cutoverAlarmMarkers ?? [], worker)
      addCounts(counts, c.counts); rows.dispositions.push(...c.dispositions); rows.charges.push(...c.charges); rows.stripeGrants.push(...c.stripeGrants)
    }
    const recomputed = orderRows(rows)
    if (stable(counts) !== stable(d.counts) || stable(recomputed) !== stable(orderRows(d))) throw new Error("CF_DRAIN_RECEIPT_MISMATCH")
    // Unknown persisted shapes mean classification is incomplete, not quiet.
    if (counts.invalidRows) throw new Error("CF_DRAIN_INVALID_ROWS")
    addCounts(totals, counts); dispositions.push(...recomputed.dispositions); charges.push(...recomputed.charges); stripeGrants.push(...recomputed.stripeGrants)
  }

  const evidence = json<MeteringEvidence>(root, bundle.meteringEvidence), stored = json<MeteringReceipt>(root, bundle.metering)
  if ((["executionID", "smithersRevision", "plueRevision", "endpoint"] as const).some(k => evidence[k] !== expected[k])) throw new Error("CF_METERING_EVIDENCE_INVALID")
  if (Date.parse(evidence.collectedAt) < Date.parse(confirmation.finishedAt) || Date.parse(evidence.collectedAt) > Date.parse(bundle.createdAt) || lastDrain > Date.parse(confirmation.startedAt)) throw new Error("CF_CUTOVER_ORDER_INVALID")
  for (const w of evidence.windows) if (w.fenceVersion !== authority.get(w.worker)?.version) throw new Error("CF_METERING_WINDOW_INVALID")
  const finalQueues = METERING_QUEUES.map(name => { const s = confirmation.queues.find(q => q.name === name)!.samples.at(-1)!; return { name, backlogCount: s.backlogCount, backlogBytes: s.backlogBytes, oldestMessageTimestamp: s.oldestMessageTimestamp } })
  if (stable(finalQueues) !== stable([...evidence.queueFinal].sort((x, y) => x.name.localeCompare(y.name)))) throw new Error("CF_METERING_QUEUE_EVIDENCE_INCOMPLETE")
  const watermarks = Object.fromEntries(METERING_WORKERS.map(w => [w, authority.get(w)!.observedAt]))
  const metering = reconcileMetering(evidence, { charges, stripeGrants }, watermarks)
  if (stable(metering) !== stable(stored)) throw new Error("CF_METERING_RECEIPT_MISMATCH")

  return { schema: "smithers-cloudflare-cutover-acceptance/v1", executionID: expected.executionID, smithersRevision: expected.smithersRevision, plueRevision: expected.plueRevision, endpoint: expected.endpoint,
    bundleSHA256: createHash("sha256").update(stable(bundle)).digest("hex"), validatedAt: new Date(now).toISOString(),
    watermarks: Object.fromEntries(fence.authorities.map(a => [a.worker, a.observedAt]).sort(([x], [y]) => x!.localeCompare(y!))), credentialExpiresAt: recipient.expiresAt,
    authorities: CLOUDFLARE_PRODUCERS.map(w => { const a = authority.get(w)!; return { worker: w, version: a.version, sourceVersion: a.sourceVersion, sourceArtifactSHA256: a.sourceArtifactSHA256 } }),
    durable: { objects: totals.objects, rows: totals.rows, interruptedUnknown: tally(dispositions, d => d.reason) },
    metering: { charges: metering.ledger.charges, amountNanos: metering.ledger.amountNanos, exceptions: tally(metering.exceptions, e => e.kind, e => e.count), streams: metering.streams.disposition } }
}

const readPrivateJSON = <T>(root: string, name: string): T => {
  const path = resolve(root, name), st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > 1_000_000) throw new Error("CF_CUTOVER_INPUT_INVALID")
  return JSON.parse(readFileSync(path, "utf8")) as T
}
/** Order: fence -> drains under the fence -> fence confirmation -> metering evidence -> bundle. */
export const collectCutoverEvidence = async (directory: string): Promise<CutoverEvidenceBundle> => {
  const root = privateRoot(directory)
  const expected = readPrivateJSON<FenceExpected>(root, "expected.json")
  const admission = readPrivateJSON<Record<string, string>>(root, "admission.json")
  const fence = await collectCloudflareFence({ ...expected, privateDirectory: root })
  const fenceRef = save(root, `cf-fence-${randomUUID()}.json`, fence)
  const drains: ArtifactReference[] = []
  for (const a of fence.authorities) {
    const plan = readPrivateJSON<{ origins: string[] }>(root, `${a.worker}.plan.json`)
    const drain = await collectDurableDrain({ ...expected, worker: a.worker, version: a.version, sourceVersion: a.sourceVersion, sourceArtifactSHA256: a.sourceArtifactSHA256,
      origin: plan.origins[0]!, privateDirectory: root, fencedAt: a.observedAt })
    drains.push(save(root, `drain-receipt-${a.worker}-${randomUUID()}.json`, drain))
  }
  const confirmation = await collectCloudflareFence({ ...expected, privateDirectory: root })
  const confirmationRef = save(root, `cf-fence-confirmation-${randomUUID()}.json`, confirmation)
  const versions = Object.fromEntries(fence.authorities.map(a => [a.worker, a.version]))
  const watermarks = Object.fromEntries(fence.authorities.map(a => [a.worker, a.observedAt]))
  const queueFinal = METERING_QUEUES.map(name => { const s = confirmation.queues.find(q => q.name === name)!.samples.at(-1)!; return { name, backlogCount: s.backlogCount, backlogBytes: s.backlogBytes, oldestMessageTimestamp: s.oldestMessageTimestamp } })
  const evidence = await collectMeteringEvidence(expected, admission, versions, queueFinal, watermarks)
  const evidenceRef = save(root, `metering-evidence-${randomUUID()}.json`, evidence)
  const ledger = { charges: [] as ChargeRow[], stripeGrants: [] as StripeGrant[] }
  for (const ref of drains) { const d = json<DurableDrainObservation>(root, ref); ledger.charges.push(...d.charges); ledger.stripeGrants.push(...d.stripeGrants) }
  const meteringRef = save(root, `metering-${randomUUID()}.json`, reconcileMetering(evidence, ledger, watermarks))
  const bundle: CutoverEvidenceBundle = { schema: "smithers-cloudflare-cutover/v1", ...expected, createdAt: new Date().toISOString(),
    fence: fenceRef, drains, confirmation: confirmationRef, meteringEvidence: evidenceRef, metering: meteringRef }
  save(root, `cutover-evidence-${randomUUID()}.json`, bundle)
  return bundle
}

if (import.meta.main) {
  const [mode, directory, bundlePath, flag] = process.argv.slice(2)
  try {
    if (mode === "collect" && directory && !bundlePath) {
      const bundle = await collectCutoverEvidence(directory)
      console.log(JSON.stringify(await validateCutoverEvidence(directory, bundle, bundle)))
    } else if (mode === "validate" && directory && bundlePath && (!flag || flag === "--reconfirm")) {
      const root = privateRoot(directory), expected = readPrivateJSON<FenceExpected>(root, "expected.json")
      const bundle = readPrivateJSON<CutoverEvidenceBundle>(root, bundlePath)
      const reconfirmation = flag ? await collectCloudflareFence({ ...expected, privateDirectory: root }) : undefined
      console.log(JSON.stringify(await validateCutoverEvidence(root, bundle, expected, { ...reconfirmation ? { reconfirmation } : {} })))
    } else throw new Error("CF_CUTOVER_USAGE")
  } catch (error) {
    // Codes only; provider responses and private values stay withheld.
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message
      : (error as { code?: string } | null)?.code === "ENOENT" ? "CF_CUTOVER_INPUT_MISSING" : "CF_CUTOVER_UNCLASSIFIED_FAILURE"
    console.log(JSON.stringify({ refused: code }))
    process.exit(2)
  }
}
