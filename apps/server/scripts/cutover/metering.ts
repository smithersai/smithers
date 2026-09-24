/**
 * Cutover-window metering evidence. Billing has no reservation ledger: chat
 * authorizes a balance, then a stream tee (waitUntil) enqueues or posts usage
 * after the response. Queue 0/DLQ 0 therefore proves nothing about usage by
 * itself; poison and permanent 4xx messages are ACKed without a charge, and the
 * direct chat Worker swallows failed charge posts. The durable `chg:<id>` rows
 * in the billing AccountDurableObjects are authoritative. Everything the ledger
 * lacks is recorded as an explicit exception, never converted to a charge.
 */
import { lstatSync, readFileSync } from "node:fs"
import { accountURL, api } from "./cloudflare"
import { WORKER_IDENTITY } from "../../src/workerIdentity"
import { EXPORT_PATH } from "../../src/MaintenanceExport"
import type { FenceExpected } from "./fence"
import type { ChargeRow, StripeGrant } from "./drain"

export const METERING_SINK = "smithers-cloud-billing"
export const METERING_WORKERS = [METERING_SINK, "smithers-cloud-chat-canary", "smithers-cloud-chat"] as const
export const METERING_QUEUES = ["smithers-metering-canary", "smithers-metering-canary-dlq"] as const
const CHECKOUT_LIFETIME_S = 86_400 // Stripe Checkout sessions expire within 24 h.
export interface TelemetryEvent { id: string; at: number; service: string; trigger: string | null; statusCode: number | null; message: string | null; versionId: string | null; truncated: boolean }
export interface QueueOperation { queue: string; phase: "window" | "after-fence"; actionType: string; outcome: string | null; count: number }
export interface CheckoutSession { id: string; created: number; expiresAt: number; status: string; paymentStatus: string; paymentIntent: string | null; topup: boolean }
export interface MeteringWindow { worker: string; admissionVersion: string; admissionAt: string; fenceVersion: string; fenceAt: string }
export interface MeteringEvidence extends FenceExpected {
  schema: "smithers-cutover-metering-evidence/v1"; collectedAt: string; windows: MeteringWindow[]
  telemetry: { from: number; to: number; services: string[]; events: TelemetryEvent[] }
  queueOperations: { from: number; fenceAt: number; to: number; operations: QueueOperation[] }
  queueFinal: Array<{ name: string; backlogCount: number; backlogBytes: number; oldestMessageTimestamp: number }>
  checkout: { createdGte: number; sessions: CheckoutSession[] }
}
export type MeteringExceptionKind = "charge-attempt-refused" | "settlement-refused" | "enqueue-failed" | "poison-acknowledged" | "rejected-acknowledged" |
  "retry-unresolved" | "dead-lettered" | "queue-retained" | "paid-uncredited" | "pending-external-settlement"
export interface MeteringException { kind: MeteringExceptionKind; at: number | null; reference: string | null; count: number; afterFence: boolean | null }
export interface MeteringReceipt extends FenceExpected {
  schema: "smithers-cutover-metering/v1"; state: "reconciled-with-recorded-exceptions"
  window: { start: string; end: string; watermarks: Record<string, string> }
  ledger: { charges: number; amountNanos: number; chargeIDs: string[] }
  checkout: { sessions: number; topups: number; credited: number; foreign: number }
  exceptions: MeteringException[]
  /** Streams started before instrumentation have no producer registry and unbounded wall time. */
  streams: { disposition: "interrupted-unknown"; completed: false; liveCountObservable: false; scope: "streams admitted before admission closed whose usage is absent from the ledger at the final fence" }
}
const ms = (iso: string) => { const v = Date.parse(iso); if (!Number.isFinite(v)) throw new Error("CF_METERING_WINDOW_INVALID"); return v }
const field = (message: string | null, name: string) => message?.match(new RegExp(`\\b${name}=([^\\s]+)`))?.[1] ?? null
const ok = (status: number | null) => status !== null && status >= 200 && status < 400

/** Pure: the validator re-runs this on the stored evidence and the ledger recomputed from sealed snapshots. */
export const reconcileMetering = (evidence: MeteringEvidence, ledger: { charges: ChargeRow[]; stripeGrants: StripeGrant[] }, watermarks: Record<string, string>): MeteringReceipt => {
  if (evidence.schema !== "smithers-cutover-metering-evidence/v1") throw new Error("CF_METERING_EVIDENCE_INVALID")
  const windows = new Map(evidence.windows.map(w => [w.worker, w]))
  if (windows.size !== METERING_WORKERS.length || evidence.windows.length !== windows.size || METERING_WORKERS.some(w => !windows.has(w) || !watermarks[w])) throw new Error("CF_METERING_WINDOW_INVALID")
  for (const w of evidence.windows) if (ms(w.admissionAt) >= ms(w.fenceAt) || ms(w.fenceAt) > ms(watermarks[w.worker]!)) throw new Error("CF_METERING_WINDOW_INVALID")
  const start = Math.min(...evidence.windows.map(w => ms(w.admissionAt)))
  const end = Math.max(...METERING_WORKERS.map(w => ms(watermarks[w]!)))
  const sinkMark = ms(watermarks[METERING_SINK]!)
  const t = evidence.telemetry
  if (t.from > start || t.to < end + 60_000 || t.to > ms(evidence.collectedAt) || METERING_WORKERS.some(w => !t.services.includes(w)) ||
    t.events.some(e => !t.services.includes(e.service) || e.at < t.from || e.at > t.to) || new Set(t.events.map(e => e.id)).size !== t.events.length) throw new Error("CF_METERING_TELEMETRY_INCOMPLETE")
  // A truncated producer invocation can hide metering_* lines; absence would then read as zero.
  if (t.events.some(e => e.truncated && e.service === "smithers-cloud-chat-canary")) throw new Error("CF_METERING_TELEMETRY_TRUNCATED")
  const q = evidence.queueOperations
  if (q.from > start || q.fenceAt !== ms(watermarks["smithers-cloud-chat-canary"]!) || q.to < end + 60_000 || q.to > ms(evidence.collectedAt) ||
    q.operations.some(o => !(METERING_QUEUES as readonly string[]).includes(o.queue) || !Number.isSafeInteger(o.count) || o.count < 0)) throw new Error("CF_METERING_QUEUE_EVIDENCE_INCOMPLETE")
  // Dead-letter detection keys on WriteMessage; an unrecognized action could hide one.
  if (q.operations.some(o => !["WriteMessage", "ReadMessage", "DeleteMessage"].includes(o.actionType))) throw new Error("CF_METERING_QUEUE_ACTION_UNKNOWN")
  if (evidence.queueFinal.length !== 2 || METERING_QUEUES.some(n => evidence.queueFinal.filter(f => f.name === n).length !== 1)) throw new Error("CF_METERING_QUEUE_EVIDENCE_INCOMPLETE")
  if (evidence.checkout.createdGte > Math.floor(start / 1000) - CHECKOUT_LIFETIME_S) throw new Error("CF_METERING_CHECKOUT_INCOMPLETE")

  // Negative write control at the ledger sink: nothing may land after the billing fence watermark.
  if (ledger.charges.some(c => ms(c.createdAt) > sinkMark)) throw new Error("CF_METERING_LATE_CHARGE_ADMITTED")
  for (const e of t.events) {
    const mark = ms(watermarks[e.service]!)
    if (e.at > mark && ok(e.statusCode) && !(e.trigger ?? "").includes(EXPORT_PATH)) throw new Error("CF_METERING_LATE_WRITE_ADMITTED")
  }
  const exceptions: MeteringException[] = []
  const add = (kind: MeteringExceptionKind, at: number | null, reference: string | null, count = 1, afterFence: boolean | null = null) => exceptions.push({ kind, at, reference, count, afterFence })
  let retries = 0
  for (const e of [...t.events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    if (e.at < start) continue
    if (e.service === METERING_SINK && e.statusCode !== null && !ok(e.statusCode)) {
      const trigger = e.trigger ?? ""
      if (trigger.includes("/api/billing/charges")) add("charge-attempt-refused", e.at, `HTTP ${e.statusCode}`, 1, e.at > sinkMark)
      else if (trigger.includes("/webhooks/stripe")) add("settlement-refused", e.at, `HTTP ${e.statusCode}`, 1, e.at > sinkMark)
    }
    if (e.service !== "smithers-cloud-chat-canary" || !e.message?.startsWith("metering_")) continue
    const kind = e.message.split(/\s/, 1)[0]
    const after = e.at > ms(watermarks[e.service]!)
    if (kind === "metering_enqueue_failed") add("enqueue-failed", e.at, null, 1, after)
    else if (kind === "metering_poison") add("poison-acknowledged", e.at, field(e.message, "message"), 1, after)
    else if (kind === "metering_rejected") add("rejected-acknowledged", e.at, field(e.message, "response"), 1, after)
    else if (kind === "metering_retry") retries++
    else throw new Error("CF_METERING_TELEMETRY_UNKNOWN_EVENT")
  }
  const final = new Map(evidence.queueFinal.map(f => [f.name, f]))
  const writes = (queue: string, phase?: QueueOperation["phase"]) => q.operations.filter(o => o.queue === queue && o.actionType === "WriteMessage" && (!phase || o.phase === phase)).reduce((n, o) => n + o.count, 0)
  const dlqWrites = writes("smithers-metering-canary-dlq")
  if (dlqWrites) add("dead-lettered", null, "smithers-metering-canary-dlq", dlqWrites)
  const lateWrites = writes("smithers-metering-canary", "after-fence")
  for (const name of METERING_QUEUES) {
    const f = final.get(name)!
    if (f.backlogCount || f.backlogBytes) add("queue-retained", f.oldestMessageTimestamp || null, name, f.backlogCount, name === "smithers-metering-canary" ? lateWrites > 0 : null)
  }
  // A retry resolves only through ACK (charged or logged rejection). Without an
  // empty queue and no dead letters the retried usage is not reconciled.
  if (retries && (dlqWrites || [...final.values()].some(f => f.backlogCount || f.backlogBytes))) add("retry-unresolved", null, null, retries)
  const grants = new Set(ledger.stripeGrants.map(g => g.id))
  let credited = 0, topups = 0
  for (const s of [...evidence.checkout.sessions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!s.topup) continue
    topups++
    if (s.status === "complete" && s.paymentStatus === "paid") {
      if (s.paymentIntent && grants.has(`stripe:${s.paymentIntent}`)) credited++
      else add("paid-uncredited", s.created * 1000, s.id)
    } else if (s.status === "open" && s.expiresAt * 1000 > sinkMark) add("pending-external-settlement", s.created * 1000, s.id)
  }
  const charges = ledger.charges.filter(c => ms(c.createdAt) >= start).sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(charges.map(c => c.objectId + "\0" + c.id)).size !== charges.length) throw new Error("CF_METERING_LEDGER_DUPLICATE")
  return {
    schema: "smithers-cutover-metering/v1", state: "reconciled-with-recorded-exceptions",
    executionID: evidence.executionID, smithersRevision: evidence.smithersRevision, plueRevision: evidence.plueRevision, endpoint: evidence.endpoint,
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), watermarks: Object.fromEntries(METERING_WORKERS.map(w => [w, watermarks[w]!])) },
    ledger: { charges: charges.length, amountNanos: charges.reduce((n, c) => n + c.amountNanos, 0), chargeIDs: charges.map(c => c.id) },
    checkout: { sessions: evidence.checkout.sessions.length, topups, credited, foreign: evidence.checkout.sessions.length - topups },
    exceptions,
    streams: { disposition: "interrupted-unknown", completed: false, liveCountObservable: false, scope: "streams admitted before admission closed whose usage is absent from the ledger at the final fence" }
  }
}

// ---- Collectors: GET-only provider reads plus read-only analytics queries. ----

interface Deployment { id: string; created_on: string; versions: Array<{ version_id: string; percentage: number }> }
/** Admission and fence times come from provider deployment history, never from the operator. */
export const deploymentWindow = (worker: string, deployments: Deployment[], admissionVersion: string, fenceVersion: string): MeteringWindow => {
  const sole = (d: Deployment | undefined, version: string) => d?.versions.length === 1 && d.versions[0]!.percentage === 100 && d.versions[0]!.version_id === version
  const ordered = [...deployments].sort((a, b) => ms(b.created_on) - ms(a.created_on))
  if (!sole(ordered[0], fenceVersion)) throw new Error("CF_METERING_FENCE_NOT_CURRENT")
  // Exactly admission -> fence; any intervening deployment could have re-opened writers.
  if (!sole(ordered[1], admissionVersion)) throw new Error("CF_METERING_WINDOW_INTERRUPTED")
  return { worker, admissionVersion, admissionAt: new Date(ms(ordered[1]!.created_on)).toISOString(), fenceVersion, fenceAt: new Date(ms(ordered[0]!.created_on)).toISOString() }
}
/**
 * Live shape observed 2026-09-24: `$metadata.{id,service,trigger,message}`,
 * HTTP status at `$workers.event.response.status`, serving version at
 * `$workers.scriptVersion.id`, and `$workers.truncated`. `$metadata.statusCode`
 * is documented but absent in practice, so it is only a fallback.
 */
export const parseTelemetryEvents = (result: unknown): TelemetryEvent[] => {
  const events = (result as { events?: { events?: unknown } } | null)?.events?.events
  if (!Array.isArray(events)) throw new Error("CF_METERING_TELEMETRY_SHAPE")
  return events.map(raw => {
    const event = raw as Record<string, unknown>, meta = event?.["$metadata"] as Record<string, unknown> | undefined
    const workers = event?.["$workers"] as { event?: { response?: { status?: unknown } }; scriptVersion?: { id?: unknown }; truncated?: unknown } | undefined
    const status = workers?.event?.response?.status ?? meta?.statusCode, version = workers?.scriptVersion?.id
    if (!meta || typeof meta.id !== "string" || !meta.id || typeof meta.service !== "string" || typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp) ||
      meta.trigger !== undefined && typeof meta.trigger !== "string" || status !== undefined && !Number.isInteger(status) ||
      meta.message !== undefined && typeof meta.message !== "string" || version !== undefined && typeof version !== "string" ||
      workers?.truncated !== undefined && typeof workers.truncated !== "boolean") throw new Error("CF_METERING_TELEMETRY_SHAPE")
    return { id: meta.id, at: event.timestamp, service: meta.service, trigger: (meta.trigger as string | undefined) ?? null, statusCode: (status as number | undefined) ?? null,
      message: typeof meta.message === "string" ? meta.message.slice(0, 500) : null, versionId: (version as string | undefined) ?? null, truncated: workers?.truncated === true }
  })
}
const LIMIT = 2000
export type TelemetryQuery = (service: string, from: number, to: number) => Promise<TelemetryEvent[]>
/** Splits any window that fills a page; completeness never depends on an undocumented cursor. */
export const completeTelemetry = async (query: TelemetryQuery, service: string, from: number, to: number): Promise<TelemetryEvent[]> => {
  const page = await query(service, from, to)
  if (page.some(e => e.service !== service)) throw new Error("CF_METERING_TELEMETRY_SHAPE")
  if (page.length < LIMIT) return page
  if (to - from <= 1000) throw new Error("CF_METERING_TELEMETRY_TRUNCATED")
  const middle = from + Math.floor((to - from) / 2)
  const seen = new Map<string, TelemetryEvent>()
  for (const e of [...await completeTelemetry(query, service, from, middle), ...await completeTelemetry(query, service, middle + 1, to)]) seen.set(e.id, e)
  return [...seen.values()]
}
export const cloudflareTelemetry: TelemetryQuery = async (service, from, to) => {
  // A read-scoped analytics token; CLOUDFLARE_API_TOKEN (deploy/control) lacks the observability scope.
  const token = process.env.CF_ANALYTICS_TOKEN
  if (!token) throw new Error("CF_METERING_TELEMETRY_UNAUTHORIZED")
  const response = await fetch(accountURL + "/workers/observability/telemetry/query", { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ queryId: `cutover-metering-${service}`, view: "events", limit: LIMIT, timeframe: { from, to },
      parameters: { datasets: ["cloudflare-workers"], filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: service }] } }) })
  // Requires "Workers Observability Write" (the query endpoint is a POST).
  if (response.status === 401 || response.status === 403) throw new Error("CF_METERING_TELEMETRY_UNAUTHORIZED")
  if (!response.ok) throw new Error(`CF_METERING_TELEMETRY_FAILED_${response.status}`)
  const body = await response.json() as { success?: boolean; result?: unknown }
  if (body.success !== true) throw new Error("CF_METERING_TELEMETRY_FAILED")
  return parseTelemetryEvents(body.result)
}
export const queueOperations = async (queueId: string, queue: string, phase: QueueOperation["phase"], from: number, to: number): Promise<QueueOperation[]> => {
  const query = `query($a:String!,$q:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$a}){queueMessageOperationsAdaptiveGroups(limit:1000,filter:{queueId:$q,datetime_geq:$from,datetime_leq:$to}){count dimensions{actionType outcome}}}}}`
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${process.env.CF_ANALYTICS_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { a: WORKER_IDENTITY.accountId, q: queueId, from: new Date(from).toISOString(), to: new Date(to).toISOString() } }) })
  const body = await response.json() as { errors?: unknown[]; data?: { viewer?: { accounts?: Array<{ queueMessageOperationsAdaptiveGroups?: Array<{ count: number; dimensions: { actionType: string; outcome?: string } }> }> } } }
  const groups = body.data?.viewer?.accounts?.[0]?.queueMessageOperationsAdaptiveGroups
  if (!response.ok || body.errors?.length || !Array.isArray(groups) || groups.length >= 1000) throw new Error("CF_METERING_QUEUE_ANALYTICS_UNAVAILABLE")
  return groups.map(g => ({ queue, phase, actionType: g.dimensions.actionType, outcome: g.dimensions.outcome ?? null, count: g.count }))
}
/** Owner-only key file; the key is used for GETs only and never logged or stored. */
export const stripeReadKey = (path = process.env.STRIPE_SECRET_KEY_FILE): string => {
  if (!path) throw new Error("CF_METERING_CHECKOUT_UNOBSERVED")
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > 512) throw new Error("CF_METERING_CHECKOUT_CREDENTIAL_UNSAFE")
  const key = readFileSync(path, "utf8").trim()
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) throw new Error("CF_METERING_CHECKOUT_UNOBSERVED")
  return key
}
/** Projection only: no customer email, name, address or amount leaves Stripe. */
export const stripeCheckoutSessions = async (createdGte: number, key = stripeReadKey()): Promise<CheckoutSession[]> => {
  const sessions: CheckoutSession[] = []
  let after = ""
  for (let page = 0; page < 200; page++) {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions?limit=100&created[gte]=${createdGte}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
      { redirect: "error", signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${key}` } })
    if (response.status === 401 || response.status === 403) throw new Error("CF_METERING_CHECKOUT_UNOBSERVED")
    if (!response.ok) throw new Error(`CF_METERING_CHECKOUT_FAILED_${response.status}`)
    const body = await response.json() as { data: Array<Record<string, unknown>>; has_more: boolean }
    for (const s of body.data) {
      const intent = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent as { id?: string } | null)?.id ?? null
      const metadata = (s.metadata ?? {}) as Record<string, unknown>
      if (typeof s.id !== "string" || typeof s.created !== "number" || typeof s.expires_at !== "number" || typeof s.status !== "string") throw new Error("CF_METERING_CHECKOUT_SHAPE")
      sessions.push({ id: s.id, created: s.created, expiresAt: s.expires_at, status: s.status, paymentStatus: String(s.payment_status), paymentIntent: intent,
        topup: typeof metadata.topupUsd === "string" && typeof s.client_reference_id === "string" })
    }
    if (!body.has_more) return sessions
    after = sessions.at(-1)!.id
  }
  throw new Error("CF_METERING_CHECKOUT_TRUNCATED")
}
export const collectMeteringEvidence = async (expected: FenceExpected, admission: Record<string, string>, fenceVersions: Record<string, string>, queueFinal: MeteringEvidence["queueFinal"], watermarks: Record<string, string>, query: TelemetryQuery = cloudflareTelemetry): Promise<MeteringEvidence> => {
  const windows: MeteringWindow[] = []
  for (const worker of METERING_WORKERS) {
    if (!admission[worker] || !fenceVersions[worker]) throw new Error("CF_METERING_ADMISSION_UNRECORDED")
    const deployments = (await api<{ deployments: Deployment[] }>(`/workers/scripts/${worker}/deployments`)).result.deployments
    windows.push(deploymentWindow(worker, deployments, admission[worker]!, fenceVersions[worker]!))
  }
  const start = Math.min(...windows.map(w => ms(w.admissionAt)))
  const end = Math.max(...METERING_WORKERS.map(w => ms(watermarks[w]!)))
  // Evidence must extend past the last watermark so late writes are visible.
  const wait = end + 61_000 - Date.now()
  if (wait > 0) await Bun.sleep(wait)
  const to = Date.now()
  const events: TelemetryEvent[] = []
  for (const service of METERING_WORKERS) events.push(...await completeTelemetry(query, service, start, to))
  const queues = (await api<Array<{ queue_id: string; queue_name: string }>>("/queues")).result
  const operations: QueueOperation[] = []
  const fenceAt = ms(watermarks["smithers-cloud-chat-canary"]!)
  for (const name of METERING_QUEUES) {
    const matches = queues.filter(q => q.queue_name === name)
    if (matches.length !== 1) throw new Error("CF_METERING_QUEUE_INVENTORY_CHANGED")
    operations.push(...await queueOperations(matches[0]!.queue_id, name, "window", start, fenceAt), ...await queueOperations(matches[0]!.queue_id, name, "after-fence", fenceAt + 1, to))
  }
  const createdGte = Math.floor(start / 1000) - CHECKOUT_LIFETIME_S
  const sessions = await stripeCheckoutSessions(createdGte)
  return { schema: "smithers-cutover-metering-evidence/v1", ...expected, collectedAt: new Date().toISOString(), windows,
    telemetry: { from: start, to, services: [...METERING_WORKERS], events: events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) },
    queueOperations: { from: start, fenceAt, to, operations }, queueFinal, checkout: { createdGte, sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)) } }
}
