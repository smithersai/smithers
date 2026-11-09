import { Otlp } from "@smthrs/observability"
import { Effect, Metric, Result } from "effect"
import * as RunCredentials from "../worker/RunCredentials.ts"
import { testFile, recorded } from "../worker/test/harness.ts"
import { signInHarness } from "../worker/test/signIn.ts"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { dropped } from "./features/attention/actions"
import { BROWSER_TELEMETRY, EXPORTED_SPANS, WITHHELD } from "./telemetry"
import { captured, ORIGIN, relay, relayed } from "./test/relay"

test("the real relay removes sensitive values from HTTP URL fields", async () => {
  const secret = "private-session-credential"
  const attributes = Object.entries({
    "url.full": `https://person:${secret}@example.com/api/${secret}?token=${secret}#${secret}`,
    "url.query": `token=${secret}`,
  }).map(([key, stringValue]) => ({ key, value: { stringValue } }))
  const lines = await Effect.runPromise(relay([{
    path: "/v1/traces",
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
      name: "GET", traceId: "a".repeat(32), spanId: "b".repeat(16),
      startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", attributes,
    }] }] }] }),
  }], BROWSER_TELEMETRY))
  expect(lines).toHaveLength(1)
  expect(JSON.stringify(lines)).not.toContain(secret)
  expect(lines[0]!.name).toBe("GET")
})

test("exported spans are exactly the permitted records minus the withheld intersection", () => {
  const withheld = new Set<string>(WITHHELD.spans)
  expect(EXPORTED_SPANS).toEqual(BROWSER_TELEMETRY.records.filter((name) => !withheld.has(name)))
  expect(EXPORTED_SPANS.length).toBe(BROWSER_TELEMETRY.records.length - BROWSER_TELEMETRY.records.filter((name) => withheld.has(name)).length)
})

test("the relay preserves pending-act failures, silent doors and report refusal reasons", async () => {
  const exported = captured(Otlp.layerFetch({ baseUrl: `${ORIGIN}/api/telemetry`, serviceName: "smithers-web" }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* Effect.logWarning("notifications.pending").pipe(Effect.annotateLogs({
      subject: "run:attention-relay", version: 1, act: "hide", outcome: "dropped", reason: "@smthrs/mvp/attention/ActRefused",
    }))
    yield* Metric.update(Metric.withAttributes(dropped, { act: "hide", reason: "@smthrs/mvp/attention/ActRefused" }), 1)
    yield* Effect.logInfo("branch.write.identity").pipe(Effect.annotateLogs({
      runId: "operation-round", parentRunId: "operation-start", flow: "branch/operation/program",
      principal: "Session", identity: "person",
    }))
    yield* Effect.logWarning("auth.run_credential").pipe(Effect.annotateLogs({ flow: "notification/ack", outcome: "door_timeout" }))
    for (const reason of ["settled", "other_launcher", "no_row"]) {
      yield* Effect.logInfo("agent.status.report").pipe(Effect.annotateLogs({
        runId: "attention-relay", status: 409, errorCode: "not_writable", reason,
      }))
    }
  }).pipe(Effect.provide(exported.layer), Effect.provideService(Metric.MetricRegistry, new Map()))))
  const { kept, dropped: removed } = await Effect.runPromise(relayed(exported.exports, BROWSER_TELEMETRY))
  expect([...removed.records]).toEqual([])
  expect([...removed.fields.values()].flatMap((fields) =>
    [...fields].filter((field) => !(WITHHELD.fields as ReadonlyArray<string>).includes(field))
  )).toEqual([])
  const fields = (name: string) => kept.filter((line) => line.name === name).map((line) => line.fields)
  expect(fields("notifications.pending")).toContainEqual(expect.objectContaining({
    subject: "run:attention-relay", version: 1, act: "hide", outcome: "dropped", reason: "@smthrs/mvp/attention/ActRefused",
  }))
  expect(fields("smithers_notification_acts_dropped")).toContainEqual(expect.objectContaining({
    act: "hide", reason: "@smthrs/mvp/attention/ActRefused", "otlp.value": 1,
  }))
  expect(fields("branch.write.identity")).toContainEqual(expect.objectContaining({
    runId: "operation-round", parentRunId: "operation-start", flow: "branch/operation/program",
    principal: "Session", identity: "person",
  }))
  expect(fields("auth.run_credential")).toContainEqual(expect.objectContaining({ flow: "notification/ack", outcome: "door_timeout" }))
  expect(fields("agent.status.report").map((line) => line.reason)).toEqual(["settled", "other_launcher", "no_row"])
})

test("the browser relay refuses server-only session diagnostics and counters", async () => {
  const exported = captured(Otlp.layerFetch({ baseUrl: `${ORIGIN}/api/telemetry`, serviceName: "auth-contract" }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    for (const name of ["smithers_auth_session", "smithers_auth_issue", "smithers_auth_key_rotations", "smithers_auth_session_prior", "smithers_auth_session_ends", "smithers_device_principal_refusals", "smithers_auth_reauth", "smithers_auth_token_cleanup", "smithers_auth_token_store"]) {
      yield* Metric.update(Metric.withAttributes(Metric.counter(name, { incremental: true }), { outcome: "credential_stale" }), 1)
    }
    for (const name of ["auth.session", "auth.issue", "auth.key_rotation", "auth.session_prior", "auth.session_end", "auth.session_retention", "auth.device_principal", "auth.reauth", "auth.token_store", "auth.token_cleanup", "auth.token_cleanup.failure"]) {
      yield* Effect.logInfo(name).pipe(Effect.annotateLogs({ outcome: "completed", step: "cease", cookie: "credential-sentinel", secret: "secret-sentinel" }))
    }
  }).pipe(Effect.provide(exported.layer), Effect.provideService(Metric.MetricRegistry, new Map()))))
  const { kept, dropped } = await Effect.runPromise(relayed(exported.exports, BROWSER_TELEMETRY))
  for (const name of ["smithers_auth_session", "smithers_auth_issue", "smithers_auth_key_rotations", "smithers_auth_session_prior", "smithers_auth_session_ends", "smithers_device_principal_refusals", "smithers_auth_reauth", "smithers_auth_token_cleanup", "smithers_auth_token_store", "auth.session", "auth.issue", "auth.key_rotation", "auth.session_prior", "auth.session_end", "auth.session_retention", "auth.device_principal", "auth.reauth", "auth.token_store", "auth.token_cleanup", "auth.token_cleanup.failure"]) {
    expect(kept.filter(line => line.name === name), name).toEqual([])
    expect([...dropped.records], name).toContain(name)
    expect(EXPORTED_SPANS, name).not.toContain(name)
  }
  expect(JSON.stringify(kept)).not.toContain("credential-sentinel")
  expect(JSON.stringify(kept)).not.toContain("secret-sentinel")
})

// The response tag is a correlation credential, so it must never become an exported attribute.
test("session tags are stripped from logs, traces, metrics and URL attributes", async () => {
  const tag = "8bcf97586ae0484686ce3750ac941946"
  const exported = captured(Otlp.layerFetch({ baseUrl: `${ORIGIN}/api/telemetry`, serviceName: "tag-privacy" }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* Effect.logInfo("auth.session_refresh").pipe(Effect.annotateLogs({ outcome: "signed_in", session_tag: tag, sessionTag: tag, session: tag }))
    yield* Effect.void.pipe(Effect.withSpan("auth.session_refresh", { attributes: { session_tag: tag, sessionTag: tag, session: tag, "url.full": `https://example.com/${tag}?tag=${tag}` } }))
    yield* Metric.update(Metric.withAttributes(Metric.counter("smithers_auth_session_refreshes", { incremental: true }), { outcome: "signed_in", session_tag: tag, sessionTag: tag, session: tag }), 1)
  }).pipe(Effect.provide(exported.layer), Effect.provideService(Metric.MetricRegistry, new Map()))))
  const { kept } = await Effect.runPromise(relayed(exported.exports, BROWSER_TELEMETRY))
  expect(kept.filter(line => line.name === "auth.session_refresh")).toHaveLength(2)
  expect(kept.filter(line => line.name === "smithers_auth_session_refreshes")).toHaveLength(1)
  expect(JSON.stringify(kept)).not.toContain(tag)
})

const tagRuntime = testFile("session_tag_privacy")
test("a real session tag stays out of run credentials, route URLs and raw diagnostics", async () => {
  const h = await signInHarness(tagRuntime)
  const signed = await h.signInAs()
  const answer = await h.session(signed.cookies) as { session: string }
  const [row] = await tagRuntime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql =>
    sql<{ id: string; person: string }>`SELECT id, person_id AS person FROM sessions`))
  const claims = RunCredentials.claimsFor({ subject: { kind: "person", id: row!.person }, role: "member", session: row!.id }, "tag-privacy", { flow: "repo/Clone" }, Date.now())
  expect(Result.isSuccess(claims)).toBe(true)
  expect(JSON.stringify(claims)).not.toContain(answer.session)
  expect(recorded(h)).not.toContain(answer.session)
  expect(signed.response.url + signed.started.location + signed.response.headers.get("location")).not.toContain(answer.session)
})
