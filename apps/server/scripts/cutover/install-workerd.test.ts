import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { FakeCloudflare, type FakeVersion } from "./install-fake"
import { applyPhase, prepareInstall, readJournal } from "./install"
import { openDrainSnapshot } from "./drain"

const legacyChat = `import { DurableObject } from "cloudflare:workers";
export class ChatHistory extends DurableObject {
  async put(key) { await this.ctx.storage.put(key, true); return "stored"; }
  async get(key) { return (await this.ctx.storage.get(key)) ? "yes" : "no"; }
  async arm(at) { await this.ctx.storage.setAlarm(at); return String(await this.ctx.storage.getAlarm()); }
  async alarm() { await this.ctx.storage.put("alarm_ran", true); }
  async fetch() { await this.ctx.storage.put("legacy_fetch", true); return new Response("legacy"); }
}
export class PushSubscriptions extends DurableObject { async fetch() { return new Response("push"); } }
export default { async fetch() { return new Response("legacy chat"); }, async queue(batch) { for (const m of batch.messages) m.ack(); } };`
const saved = { token: process.env.CLOUDFLARE_API_TOKEN, hook: process.env.SMITHERS_CUTOVER_AUTHORIZE }
const roots: string[] = []
afterAll(() => { process.env.CLOUDFLARE_API_TOKEN = saved.token; process.env.SMITHERS_CUTOVER_AUTHORIZE = saved.hook; for (const r of roots) rmSync(r, { recursive: true, force: true }) })

test("real workerd runs the installer's exact uploads: admission keeps admitted RPC, the fence refuses HTTP/RPC/queue ACK and alarm writes, restore serves preserved state", async () => {
  process.env.CLOUDFLARE_API_TOKEN = "fake-control-plane-token"
  const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]) as CryptoKeyPair
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
  const root = mkdtempSync(join(tmpdir(), "cutover-install-workerd-")); roots.push(root); chmodSync(root, 0o700)
  const expected = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech" }
  writeFileSync(join(root, "expected.json"), JSON.stringify(expected), { mode: 0o600 })
  writeFileSync(join(root, "recipient.json"), JSON.stringify({ migrationId: expected.executionID, privateJwk, token: "t".repeat(48), expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString() }), { mode: 0o600 })
  writeFileSync(join(root, "hook.sh"), `#!/bin/sh\nexec bun -e 'const r=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({...r,schema:"smithers-cutover-phase-authorization/v1",decision:"authorized",issuedAt:new Date().toISOString(),deploymentLock:{tag:"t",token:"k"}}))'\n`, { mode: 0o700 })
  process.env.SMITHERS_CUTOVER_AUTHORIZE = join(root, "hook.sh")
  const fake = new FakeCloudflare({ "smithers-cloud-chat-canary": legacyChat }).install()
  let phases: Record<string, unknown>, plan
  try {
    const original = fake.live("smithers-cloud-chat-canary")
    const prepared = await prepareInstall(root); plan = prepared.plan
    await applyPhase(root, prepared.planSHA256, "admission")
    await applyPhase(root, prepared.planSHA256, "fence")
    const worker = fake.workers.get("smithers-cloud-chat-canary")!
    const admission = worker.versions.get(readJournal(root, prepared.planSHA256).find(e => e.worker === "smithers-cloud-chat-canary" && e.action === "admission" && e.event === "verified")!.version!)!
    const view = (v: FakeVersion) => ({ entry: v.entry, modules: v.modules.map(m => ({ name: m.name, source: new TextDecoder().decode(m.bytes) })),
      bindings: { ...Object.fromEntries(v.bindings.filter(b => b.type === "plain_text").map(b => [b.name, b.text])), ...v.secrets } })
    phases = { original: view(original), admission: view(admission), fence: view(fake.live("smithers-cloud-chat-canary")) }
  } finally { fake.restore() }
  const child = Bun.spawn(["node", new URL("./install-workerd.mjs", import.meta.url).pathname], { stdin: new Blob([JSON.stringify({ phases, migrationId: expected.executionID })]), stdout: "pipe", stderr: "pipe" })
  const [code, out, log] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(log).toContain("restore: original modules serve the preserved state")
  expect(code).toBe(0)
  const { sealed, objectId, alarmAt } = JSON.parse(out) as { sealed: string; objectId: string; alarmAt: number }
  const w = plan!.workers.find(x => x.worker === "smithers-cloud-chat-canary")!
  const opened = await openDrainSnapshot(sealed, { executionID: expected.executionID, binding: "CHAT_HISTORY", objectId, sourceVersion: w.originalVersion, sourceArtifactSHA256: w.sourceArtifactSHA256,
    notBefore: 0, credentialExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }, privateJwk)
  // The alarm fired under the fence without writing, and was not acknowledged away.
  expect(opened.payload.entries.map(([k]) => k)).toEqual(["kept"])
  expect(opened.payload.alarm).not.toBeNull()
  // The installer's own fence bytes leave the durable interrupted-alarm marker too.
  expect((opened.payload.cutoverAlarmMarkers ?? []).map(m => JSON.parse(m))).toEqual([expect.objectContaining({ executionID: expected.executionID, worker: "smithers-cloud-chat-canary", binding: "CHAT_HISTORY", objectId, state: "interrupted-unresolved" })])
  expect(opened.payload.alarm!).toBeGreaterThanOrEqual(alarmAt)
}, 120_000)
