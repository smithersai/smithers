import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { encodeStored } from "../../src/SealedSnapshot"
import { classifyDurableObject, type ChargeRow, type StripeGrant } from "./drain"
import { completeTelemetry, deploymentWindow, parseTelemetryEvents, reconcileMetering, type MeteringEvidence, type TelemetryEvent } from "./metering"

const t0 = Date.parse("2026-09-25T10:00:00.000Z"), iso = (ms: number) => new Date(ms).toISOString()
const expected = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech" }
// Admission at t0; fences deploy at +30 min; each fence is confirmed refusing at +31 min.
const watermarks = { "smithers-cloud-billing": iso(t0 + 31 * 60_000), "smithers-cloud-chat-canary": iso(t0 + 31 * 60_000), "smithers-cloud-chat": iso(t0 + 31 * 60_000) }
const event = (at: number, service: string, patch: Partial<TelemetryEvent>): TelemetryEvent => ({ id: randomUUID(), at, service, trigger: null, statusCode: null, message: null, versionId: null, truncated: false, ...patch })
const evidence = (patch: Partial<MeteringEvidence> = {}): MeteringEvidence => ({
  schema: "smithers-cutover-metering-evidence/v1", ...expected, collectedAt: iso(t0 + 40 * 60_000),
  windows: Object.keys(watermarks).map(worker => ({ worker, admissionVersion: randomUUID(), admissionAt: iso(t0), fenceVersion: randomUUID(), fenceAt: iso(t0 + 30 * 60_000) })),
  telemetry: { from: t0, to: t0 + 35 * 60_000, services: Object.keys(watermarks), events: [
    event(t0 + 60_000, "smithers-cloud-billing", { trigger: "POST /api/billing/charges", statusCode: 200 }),
    event(t0 + 120_000, "smithers-cloud-chat-canary", { message: "metering_rejected message=m1 response=resp_9 reason=billing refused (HTTP 400)" }),
    event(t0 + 180_000, "smithers-cloud-chat-canary", { message: "metering_enqueue_failed reason=Queue send failed" }),
    event(t0 + 190_000, "smithers-cloud-chat-canary", { message: "metering_retry message=m2 response=resp_2 reason=billing answered HTTP 503" }),
    event(t0 + 32 * 60_000, "smithers-cloud-billing", { trigger: "POST /api/billing/charges", statusCode: 503 }),
    event(t0 + 32 * 60_000, "smithers-cloud-billing", { trigger: "POST /__maintenance/state-export", statusCode: 200 })
  ] },
  queueOperations: { from: t0, fenceAt: t0 + 31 * 60_000, to: t0 + 35 * 60_000, operations: [{ queue: "smithers-metering-canary", phase: "window", actionType: "WriteMessage", outcome: null, count: 4 }] },
  queueFinal: [{ name: "smithers-metering-canary", backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 }, { name: "smithers-metering-canary-dlq", backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 }],
  checkout: { createdGte: Math.floor(t0 / 1000) - 86_400, sessions: [
    { id: "cs_paid", created: t0 / 1000, expiresAt: t0 / 1000 + 3600, status: "complete", paymentStatus: "paid", paymentIntent: "pi_1", topup: true },
    { id: "cs_lost", created: t0 / 1000, expiresAt: t0 / 1000 + 3600, status: "complete", paymentStatus: "paid", paymentIntent: "pi_2", topup: true },
    { id: "cs_open", created: t0 / 1000, expiresAt: t0 / 1000 + 86_000, status: "open", paymentStatus: "unpaid", paymentIntent: null, topup: true },
    { id: "cs_plue", created: t0 / 1000, expiresAt: t0 / 1000 + 3600, status: "complete", paymentStatus: "paid", paymentIntent: "pi_9", topup: false }
  ] }, ...patch })
const charge = (at: number, id: string = randomUUID()): ChargeRow => ({ objectId: "f".repeat(64), id, createdAt: iso(at), amountNanos: 1000, resource: "inference.output_tokens", runId: null })
const ledger = (charges: ChargeRow[] = [charge(t0 + 60_000, "resp_1:inference.output_tokens"), charge(t0 - 86_400_000)], stripeGrants: StripeGrant[] = [{ objectId: "f".repeat(64), id: "stripe:pi_1", createdAt: iso(t0) }]) => ({ charges, stripeGrants })

test("reconciliation scopes to the cutover window and records every unreconciled item without inventing charges", () => {
  const receipt = reconcileMetering(evidence(), ledger(), watermarks)
  expect(receipt.ledger).toEqual({ charges: 1, amountNanos: 1000, chargeIDs: ["resp_1:inference.output_tokens"] })
  expect(receipt.exceptions.map(e => [e.kind, e.reference, e.afterFence])).toEqual([
    ["rejected-acknowledged", "resp_9", false], ["enqueue-failed", null, false], ["charge-attempt-refused", "HTTP 503", true],
    ["paid-uncredited", "cs_lost", null], ["pending-external-settlement", "cs_open", null]])
  expect(receipt.checkout).toEqual({ sessions: 4, topups: 3, credited: 1, foreign: 1 })
  expect(receipt.streams).toMatchObject({ disposition: "interrupted-unknown", completed: false, liveCountObservable: false })
  expect(receipt.state).toBe("reconciled-with-recorded-exceptions")
})
test("the ledger and billing sink refuse any write admitted after the fence watermark", () => {
  expect(() => reconcileMetering(evidence(), ledger([charge(t0 + 31 * 60_000 + 1)]), watermarks)).toThrow("CF_METERING_LATE_CHARGE_ADMITTED")
  const late = evidence(); late.telemetry.events.push(event(t0 + 33 * 60_000, "smithers-cloud-billing", { trigger: "POST /webhooks/stripe", statusCode: 200 }))
  expect(() => reconcileMetering(late, ledger(), watermarks)).toThrow("CF_METERING_LATE_WRITE_ADMITTED")
  const chat = evidence(); chat.telemetry.events.push(event(t0 + 33 * 60_000, "smithers-cloud-chat", { trigger: "POST /api/chat", statusCode: 200 }))
  expect(() => reconcileMetering(chat, ledger(), watermarks)).toThrow("CF_METERING_LATE_WRITE_ADMITTED")
})
test("retained queue messages and dead letters stay explicit and keep retries unresolved", () => {
  const e = evidence({ queueFinal: [{ name: "smithers-metering-canary", backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 }, { name: "smithers-metering-canary-dlq", backlogCount: 2, backlogBytes: 400, oldestMessageTimestamp: t0 + 32 * 60_000 }] })
  e.queueOperations.operations.push({ queue: "smithers-metering-canary-dlq", phase: "after-fence", actionType: "WriteMessage", outcome: null, count: 2 }, { queue: "smithers-metering-canary", phase: "after-fence", actionType: "WriteMessage", outcome: null, count: 2 })
  const kinds = reconcileMetering(e, ledger(), watermarks).exceptions.map(x => [x.kind, x.count])
  expect(kinds).toContainEqual(["dead-lettered", 2]); expect(kinds).toContainEqual(["queue-retained", 2]); expect(kinds).toContainEqual(["retry-unresolved", 1])
})
test("incomplete evidence refuses instead of reading as zero", () => {
  expect(() => reconcileMetering(evidence({ telemetry: { ...evidence().telemetry, to: t0 + 31 * 60_000 } }), ledger(), watermarks)).toThrow("CF_METERING_TELEMETRY_INCOMPLETE")
  expect(() => reconcileMetering(evidence({ telemetry: { ...evidence().telemetry, services: ["smithers-cloud-billing"] } }), ledger(), watermarks)).toThrow("CF_METERING_TELEMETRY_INCOMPLETE")
  expect(() => reconcileMetering(evidence({ checkout: { createdGte: Math.floor(t0 / 1000), sessions: [] } }), ledger(), watermarks)).toThrow("CF_METERING_CHECKOUT_INCOMPLETE")
  expect(() => reconcileMetering(evidence({ queueFinal: [] }), ledger(), watermarks)).toThrow("CF_METERING_QUEUE_EVIDENCE_INCOMPLETE")
  const action = evidence(); action.queueOperations.operations.push({ queue: "smithers-metering-canary-dlq", phase: "window", actionType: "Enqueue", outcome: null, count: 1 })
  expect(() => reconcileMetering(action, ledger(), watermarks)).toThrow("CF_METERING_QUEUE_ACTION_UNKNOWN")
  expect(() => reconcileMetering(evidence(), ledger(), { ...watermarks, "smithers-cloud-chat": "" })).toThrow("CF_METERING_WINDOW_INVALID")
  const truncated = evidence(); truncated.telemetry.events.push(event(t0 + 1, "smithers-cloud-chat-canary", { truncated: true }))
  expect(() => reconcileMetering(truncated, ledger(), watermarks)).toThrow("CF_METERING_TELEMETRY_TRUNCATED")
  const unknown = evidence(); unknown.telemetry.events.push(event(t0 + 1, "smithers-cloud-chat-canary", { message: "metering_something_new" }))
  expect(() => reconcileMetering(unknown, ledger(), watermarks)).toThrow("CF_METERING_TELEMETRY_UNKNOWN_EVENT")
})
test("the window comes from provider deployment history and refuses an interrupted admission", () => {
  const d = (at: number, version: string) => ({ id: randomUUID(), created_on: iso(at), versions: [{ version_id: version, percentage: 100 }] })
  expect(deploymentWindow("w", [d(t0 - 10, "orig"), d(t0 + 5, "fence"), d(t0, "adm")], "adm", "fence")).toMatchObject({ admissionAt: iso(t0), fenceAt: iso(t0 + 5) })
  expect(() => deploymentWindow("w", [d(t0, "adm"), d(t0 + 1, "orig"), d(t0 + 2, "fence")], "adm", "fence")).toThrow("CF_METERING_WINDOW_INTERRUPTED")
  expect(() => deploymentWindow("w", [d(t0, "adm"), d(t0 + 2, "orig")], "adm", "fence")).toThrow("CF_METERING_FENCE_NOT_CURRENT")
})
test("telemetry pages that fill the limit are split until complete, and an unsplittable full page refuses", async () => {
  const all = Array.from({ length: 5000 }, (_, i) => event(t0 + i * 100, "s", {}))
  const query = async (service: string, from: number, to: number) => all.filter(e => e.service === service && e.at >= from && e.at <= to).slice(0, 2000)
  expect((await completeTelemetry(query, "s", t0, t0 + 500_000)).length).toBe(5000)
  const dense = Array.from({ length: 2000 }, () => event(t0, "s", {}))
  await expect(completeTelemetry(async () => dense, "s", t0, t0 + 1000)).rejects.toThrow("CF_METERING_TELEMETRY_TRUNCATED")
  expect(() => parseTelemetryEvents({ events: { events: [{ $metadata: { service: "s" } }] } })).toThrow("CF_METERING_TELEMETRY_SHAPE")
  // Shape of a live smithers-cloud-billing invocation event (values synthetic).
  const live = { timestamp: t0, dataset: "cloudflare-workers", source: { level: "info", message: "POST /api/billing/charges" },
    $metadata: { id: "x", service: "s", trigger: "POST /api/billing/charges", message: "POST /api/billing/charges", type: "cf-worker-event", level: "info" },
    $workers: { eventType: "fetch", outcome: "ok", truncated: false, scriptVersion: { id: "880ae457-dd96-42f7-b390-cb46f3c4ef0e" }, event: { request: { method: "POST", path: "/api/billing/charges" }, response: { status: 503 } } } }
  expect(parseTelemetryEvents({ events: { events: [live] } }))
    .toEqual([{ id: "x", at: t0, service: "s", trigger: "POST /api/billing/charges", statusCode: 503, message: "POST /api/billing/charges", versionId: "880ae457-dd96-42f7-b390-cb46f3c4ef0e", truncated: false }])
  expect(() => parseTelemetryEvents({ events: { events: [{ ...live, $workers: { ...live.$workers, event: { response: { status: "503" } } } }] } })).toThrow("CF_METERING_TELEMETRY_SHAPE")
})
test("fenced durable state is dispositioned as interrupted-unknown, never completed", () => {
  const row = (key: string, value: unknown): [string, unknown] => [key, encodeStored(value)]
  const now = t0 + 3_600_000
  const turn = classifyDurableObject("TURN_CANCELS", "a".repeat(64), [row("state", { state: "active", at: now - 1000 }), row("turn-journal:v1:head", { terminal: false })], now + 5, now)
  expect(turn.dispositions.map(d => [d.key, d.reason, d.disposition])).toEqual([[null, "alarm-pending", "interrupted-unknown"], ["state", "active-at-fence", "interrupted-unknown"], ["turn-journal:v1:head", "open-journal", "interrupted-unknown"]])
  expect(classifyDurableObject("TURN_CANCELS", "a".repeat(64), [row("state", { state: "active", at: now - 700_000 })], null, now).dispositions[0]!.reason).toBe("expired-registration")
  const setup = classifyDurableObject("GATEWAY_SESSIONS", "b".repeat(64), [row("repository-setup:pending", { requests: { r2: {}, r1: {} } })], null, now)
  expect(setup.dispositions.map(d => d.key)).toEqual(["repository-setup:pending#r1", "repository-setup:pending#r2"])
  const account = classifyDurableObject("ACCOUNTS", "c".repeat(64), [
    row("chg:r:inference.output_tokens", { id: "r:inference.output_tokens", createdAt: iso(t0), amountNanos: 7, resource: "inference.output_tokens", runId: null }),
    row("chg:bad", { id: "other", createdAt: iso(t0), amountNanos: 7, resource: "x", runId: null }),
    row("ledger", { grants: [{ id: "stripe:pi_1", createdAt: iso(t0) }, { id: "promo:u", createdAt: iso(t0) }] })], null, now)
  expect(account.charges.map(c => c.id)).toEqual(["r:inference.output_tokens"]); expect(account.counts.invalidRows).toBe(1)
  expect(account.stripeGrants.map(g => g.id)).toEqual(["stripe:pi_1"])
  expect(classifyDurableObject("HOOKS", "d".repeat(64), [row("k", 1)], null, now).dispositions[0]!.reason).toBe("unclassified-retained")
})
