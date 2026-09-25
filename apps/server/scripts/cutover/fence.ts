import { createHash, randomUUID } from "node:crypto"
import { lstatSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, relative } from "node:path"
import { accountURL, api, type Settings } from "./cloudflare"
import { stable, requireExportVersion } from "./deployment"
import { authorityOrigins } from "./fence-routes"
import { fenceModule } from "./fence-module"
import type { FenceIdentity } from "../../src/MaintenanceFence"

export const CLOUDFLARE_PRODUCERS = ["smithers-mvp-web", "smithers-cloud-identity", "smithers-cloud-billing", "smithers-cloud-chat", "smithers-cloud-chat-canary", "smithers-cloud-cron", "smithers-cloud-sync", "smithers-cloud-webhooks", "smithers-cloud-reco", "smithers-flows-flows", "smithers-multi-williamcory", "smithers-canary-canary", "smithers-code-prod", "plue-ts"] as const
export interface FenceExpected { executionID: string; smithersRevision: string; plueRevision: string; endpoint: string }
export interface ArtifactReference { path: string; sha256: string }
export interface FenceAuthority {
  worker: string; version: string; sourceVersion: string; sourceArtifactSHA256: string
  settingsSHA256: string; modulesSHA256: string; observedAt: string
  refusals: Array<{ origin: string; observedAt: string; nonce: string; status: number; bodySHA256: string }>
  evidence: ArtifactReference
}
export interface CloudflareFenceReceipt extends FenceExpected {
  schema: "smithers-cloudflare-fence/v1"; startedAt: string; finishedAt: string
  authorities: FenceAuthority[]; confirmation: FenceAuthority[]
  queues: Array<{ name: string; id: string; samples: Array<{ observedAt: string; backlogCount: number; backlogBytes: number; oldestMessageTimestamp: number }> }>
  // A separate domain collector must provide actual drain facts. Absence never
  // becomes an inferred zero merely because the Worker now refuses admission.
  drain: { state: "unverified"; reasons: string[] }
}
interface Plan {
  identity: FenceIdentity; version: string; settingsSHA256: string
  originalEntry: string; originalSettings: ArtifactReference
  originalModules: Array<ArtifactReference & { name: string }>
  objects: Array<{ binding: string; className: string }>
  helper: ArtifactReference
  origins: string[]
}
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex")
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const sha = /^[a-f0-9]{40}$/, digest = /^[a-f0-9]{64}$/
const validExpected = (e: FenceExpected) => {
  if (!uuid.test(e.executionID) || !sha.test(e.smithersRevision) || !sha.test(e.plueRevision) || e.endpoint !== "https://api.jjhub.tech") throw new Error("CF_FENCE_IDENTITY_INVALID")
}
const sameExpected = (actual: FenceExpected, expected: FenceExpected) => {
  for (const name of ["executionID", "smithersRevision", "plueRevision", "endpoint"] as const) if (actual[name] !== expected[name]) throw new Error("CF_FENCE_CANDIDATE_MISMATCH")
}
export const privateArtifact = (root: string, ref: ArtifactReference): Buffer => {
  if (!digest.test(ref.sha256) || !ref.path || ref.path.startsWith("/") || relative(root, resolve(root, ref.path)).startsWith("..")) throw new Error("CF_FENCE_ARTIFACT_PATH_INVALID")
  const path = resolve(root, ref.path)
  // Check every component; a safe-looking child under a symlink is not safe.
  let current = resolve(root)
  for (const part of ["", ...relative(root, path).split("/")]) {
    if (part) current = resolve(current, part)
    const st = lstatSync(current)
    if (st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("CF_FENCE_ARTIFACT_PERMISSIONS")
  }
  const bytes = readFileSync(path)
  if (hash(bytes) !== ref.sha256) throw new Error("CF_FENCE_ARTIFACT_DIGEST_MISMATCH")
  return bytes
}
export const save = (root: string, file: string, value: unknown): ArtifactReference => {
  const bytes = JSON.stringify(value)
  writeFileSync(resolve(root, file), bytes, { mode: 0o600, flag: "wx" })
  return { path: file, sha256: hash(bytes) }
}
const observeAuthority = async (root: string, plan: Plan, expected: FenceExpected): Promise<FenceAuthority> => {
  sameExpected(plan.identity, expected)
  if (!(CLOUDFLARE_PRODUCERS as readonly string[]).includes(plan.identity.worker)) throw new Error("CF_FENCE_UNKNOWN_AUTHORITY")
  const original = plan.originalModules.map(item => ({ name: item.name, sha256: hash(privateArtifact(root, item)) })).sort((a,b) => a.name.localeCompare(b.name))
  if (hash(stable({ entry: plan.originalEntry, modules: original })) !== plan.identity.sourceArtifactSHA256) throw new Error("CF_FENCE_ORIGINAL_SOURCE_MISMATCH")
  const oldSettings = JSON.parse(privateArtifact(root, plan.originalSettings).toString()) as Settings
  const helper = privateArtifact(root, plan.helper)
  const built = await Bun.build({ entrypoints: [new URL("../../src/MaintenanceFence.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true })
  if (!built.success || built.outputs.length !== 1 || hash(await built.outputs[0]!.text()) !== hash(helper)) throw new Error("CF_FENCE_HELPER_SOURCE_MISMATCH")
  const entry = fenceModule(plan.identity, plan.objects)
  const expectedModules = [...original, { name: "cutover-fence-entry.js", sha256: hash(entry) }, { name: "cutover-fence-helper.js", sha256: hash(helper) }].sort((a,b) => a.name.localeCompare(b.name))
  const base = `/workers/scripts/${plan.identity.worker}`
  const current = async () => (await api<{ deployments: Array<{ id: string; versions: Array<{ version_id: string; percentage: number }> }> }>(base + "/deployments")).result.deployments[0]
  const before = await current()
  requireExportVersion(before, plan.version)
  // Script content/settings describe the newest upload, which may never have served.
  const requireDeployedContent = async () => {
    const newest = (await api<{ items: Array<{ id: string }> }>(base + "/versions?per_page=1")).result.items[0]?.id
    if (newest !== plan.version) throw new Error("CF_FENCE_CONTENT_NOT_DEPLOYED")
  }
  await requireDeployedContent()
  const settings = (await api<Settings>(base + "/settings")).result
  if (hash(stable(settings)) !== plan.settingsSHA256) throw new Error("CF_FENCE_SETTINGS_CHANGED")
  const objects = (s: Settings) => s.bindings.filter(b => b.type === "durable_object_namespace").sort((a,b) => a.name.localeCompare(b.name))
  if (stable(objects(settings)) !== stable(objects(oldSettings))) throw new Error("CF_FENCE_STORAGE_IDENTITY_CHANGED")
  const actualObjects = objects(settings).map(b => ({ binding: b.name, className: b.class_name })).sort((a,b) => a.binding.localeCompare(b.binding))
  if (stable(actualObjects) !== stable([...plan.objects].sort((a,b) => a.binding.localeCompare(b.binding)))) throw new Error("CF_FENCE_CLASS_COVERAGE_INCOMPLETE")
  const source = await fetch(accountURL + base + "/content/v2", { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(60_000) })
  if (!source.ok || source.headers.get("cf-entrypoint") !== "cutover-fence-entry.js") throw new Error("CF_FENCE_ENTRY_NOT_ACTIVE")
  const modules = []
  for (const [name, part] of await source.formData()) {
    if (typeof part === "string") throw new Error("CF_FENCE_MODULE_INVALID")
    modules.push({ name, sha256: hash(new Uint8Array(await part.arrayBuffer())) })
  }
  modules.sort((a,b) => a.name.localeCompare(b.name))
  if (stable(modules) !== stable(expectedModules)) throw new Error("CF_FENCE_MODULES_CHANGED")
  if (stable(await authorityOrigins(plan.identity.worker)) !== stable([...plan.origins].sort())) throw new Error("CF_FENCE_ORIGINS_CHANGED")
  const refusals = []
  for (const origin of plan.origins) {
    const url = new URL(origin)
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("CF_FENCE_ORIGIN_INVALID")
    const nonce = randomUUID()
    // Deliberately a mutation method. The fixed temporary entry must refuse
    // before any legacy route, auth, constructor, namespace or queue operation.
    const response = await fetch(`${origin}/__cutover_write_probe/${nonce}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000), body: "{}", headers: { "content-type": "application/json" } })
    const body = await response.text()
    if (response.status !== 503 || response.headers.get("cache-control") !== "no-store" || body !== JSON.stringify({ code: "cutover_maintenance", ...plan.identity })) throw new Error("CF_FENCE_EXTERNAL_WRITE_NOT_REFUSED")
    refusals.push({ origin, nonce, status: response.status, bodySHA256: hash(body), observedAt: new Date().toISOString() })
  }
  const after = await current()
  requireExportVersion(after, plan.version)
  await requireDeployedContent()
  if (before?.id !== after?.id) throw new Error("CF_FENCE_DEPLOYMENT_CHANGED")
  const observedAt = new Date().toISOString()
  const evidence = save(root, `${plan.identity.worker}-${randomUUID()}.json`, { observedAt, before, after, settings, modules, refusals })
  return { worker: plan.identity.worker, version: plan.version, sourceVersion: plan.identity.sourceVersion, sourceArtifactSHA256: plan.identity.sourceArtifactSHA256,
    settingsSHA256: plan.settingsSHA256, modulesSHA256: hash(stable(modules)), observedAt, refusals, evidence }
}

/** GET-only provider observations plus harmless refusal probes; never deploys or edits storage. */
export const collectCloudflareFence = async (input: FenceExpected & { privateDirectory: string }): Promise<CloudflareFenceReceipt> => {
  validExpected(input)
  const root = resolve(input.privateDirectory), stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("CF_FENCE_DIRECTORY_NOT_PRIVATE")
  const startedAt = new Date().toISOString()
  const plans: Plan[] = CLOUDFLARE_PRODUCERS.map(name => {
    const path = resolve(root, `${name}.plan.json`), st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > 1_000_000) throw new Error("CF_FENCE_PLAN_INVALID")
    const plan = JSON.parse(readFileSync(path, "utf8")) as Plan
    if (plan.identity.worker !== name) throw new Error("CF_FENCE_PLAN_WRONG_AUTHORITY")
    return plan
  })
  const authorities = []
  for (const plan of plans) authorities.push(await observeAuthority(root, plan, input))
  const allQueues = (await api<Array<{ queue_id: string; queue_name: string; producers: unknown[]; consumers: unknown[] }>>("/queues")).result
  const queues = []
  for (const name of ["smithers-metering-canary", "smithers-metering-canary-dlq"]) {
    const matches = allQueues.filter(q => q.queue_name === name)
    if (matches.length !== 1) throw new Error("CF_FENCE_QUEUE_INVENTORY_CHANGED")
    const q = matches[0]!, samples = []
    for (let i = 0; i < 2; i++) {
      const metrics = (await api<{ backlog_count: number; backlog_bytes: number; oldest_message_timestamp_ms: number }>(`/queues/${q.queue_id}/metrics`)).result
      for (const value of Object.values(metrics)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("CF_FENCE_QUEUE_METRICS_INVALID")
      samples.push({ observedAt: new Date().toISOString(), backlogCount: metrics.backlog_count, backlogBytes: metrics.backlog_bytes, oldestMessageTimestamp: metrics.oldest_message_timestamp_ms })
    }
    queues.push({ name, id: q.queue_id, samples })
  }
  const confirmation = []
  for (const plan of plans) confirmation.push(await observeAuthority(root, plan, input))
  const receipt: CloudflareFenceReceipt = { schema: "smithers-cloudflare-fence/v1", executionID: input.executionID, smithersRevision: input.smithersRevision, plueRevision: input.plueRevision, endpoint: input.endpoint,
    startedAt, finishedAt: new Date().toISOString(), authorities, confirmation, queues,
    drain: { state: "unverified", reasons: ["A fence receipt alone is not drain evidence; see cutover-evidence.ts"] } }
  return receipt
}

/**
 * Fence-only checks. Queue backlog is recorded, not required to be zero: a
 * fenced consumer retries without ACK, so late messages from old invocations
 * stay preserved and the metering reconciliation must list them.
 */
export const requireFence = (receipt: CloudflareFenceReceipt, expected: FenceExpected, clock: { now: number; maxAgeMs: number | null }): void => {
  validExpected(expected)
  sameExpected(receipt, expected)
  const started = Date.parse(receipt.startedAt), finished = Date.parse(receipt.finishedAt)
  if (receipt.schema !== "smithers-cloudflare-fence/v1" || !Number.isFinite(started) || !Number.isFinite(finished) || started > finished || finished > clock.now + 5_000 ||
    clock.maxAgeMs !== null && clock.now - finished > clock.maxAgeMs) throw new Error("CF_FENCE_OBSERVATION_STALE")
  for (const rows of [receipt.authorities, receipt.confirmation]) {
    if (rows.length !== CLOUDFLARE_PRODUCERS.length || new Set(rows.map(r => r.worker)).size !== rows.length || CLOUDFLARE_PRODUCERS.some(name => !rows.some(r => r.worker === name))) throw new Error("CF_FENCE_AUTHORITY_INCOMPLETE")
  }
  for (const first of receipt.authorities) {
    const last = receipt.confirmation.find(r => r.worker === first.worker)!
    const at = Date.parse(first.observedAt)
    if (!Number.isFinite(at) || at < started || Date.parse(last.observedAt) < at || Date.parse(last.observedAt) > finished) throw new Error("CF_FENCE_OBSERVATION_STALE")
    if (first.version !== last.version || first.modulesSHA256 !== last.modulesSHA256 || first.settingsSHA256 !== last.settingsSHA256 || first.sourceArtifactSHA256 !== last.sourceArtifactSHA256 ||
      !first.refusals.length || !last.refusals.length || [...first.refusals, ...last.refusals].some(r => r.status !== 503)) throw new Error("CF_FENCE_AUTHORITY_CHANGED")
  }
  if (receipt.queues.length !== 2 || new Set(receipt.queues.map(q => q.name)).size !== 2 || receipt.queues.some(q => !["smithers-metering-canary", "smithers-metering-canary-dlq"].includes(q.name) || q.samples.length !== 2 ||
    q.samples.some(s => [s.backlogCount, s.backlogBytes, s.oldestMessageTimestamp].some(v => !Number.isSafeInteger(v) || v < 0)) ||
    stable({ ...q.samples[0], observedAt: 0 }) !== stable({ ...q.samples[1], observedAt: 0 }))) throw new Error("CF_FENCE_QUEUE_UNSTABLE")
}

/** No caller-supplied true/zero flag can authorize cutover; a fence receipt alone never does. */
export const validateCloudflareFence = (receipt: CloudflareFenceReceipt, expected: FenceExpected): void => {
  requireFence(receipt, expected, { now: Date.now(), maxAgeMs: 120_000 })
  // Acceptance requires validateCutoverEvidence: sealed drain snapshots plus metering reconciliation.
  throw new Error("CF_FENCE_DURABLE_DRAIN_UNVERIFIED")
}
