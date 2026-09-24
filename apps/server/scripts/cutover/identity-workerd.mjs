import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = await import(wrangler.resolve("miniflare"))
let text = ""
for await (const part of process.stdin) text += part
const { legacy, helper, wrapper } = JSON.parse(text)
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), token = "identity-test-only-token".repeat(3), migrationId = randomUUID()
const sourceVersion = randomUUID(), state = mkdtempSync(join(tmpdir(), "identity-export-workerd-"))
const seed = `export class IdentityDurableObject {
  constructor(ctx) { this.ctx = ctx }
  async fetch() { await this.ctx.storage.put({"account:42":{id:42,login:"fixture-owner",boundAt:"2026-09-24T00:00:00Z"},"loginid:fixture-owner":42,"ghtoken:id:42":{accessToken:"fixture-only-token"}});return new Response("seeded") }
} export default {fetch(){return new Response("seed")}}`
const options = (module, wrapped) => convertV4MiniflareOptions({
  modulesRoot: "/", modules: [...(wrapped ? [{ type: "ESModule", path: "sealed-export-entry.js", contents: wrapper }] : []), { type: "ESModule", path: "index.js", contents: module }, { type: "ESModule", path: "sealed-export-helper.js", contents: helper }],
  compatibilityDate: "2025-05-01", compatibilityFlags: ["nodejs_compat"], durableObjects: { IDENTITY: { className: "IdentityDurableObject", useSQLite: true } }, durableObjectsPersist: state,
  bindings: { SMITHERS_EXPORT_TOKEN: token, SMITHERS_EXPORT_RECIPIENT: JSON.stringify(pair.publicKey.export({ format: "jwk" })), SMITHERS_EXPORT_EXPIRES_AT: new Date(Date.now() + 60000).toISOString(), SMITHERS_EXPORT_SOURCE_REVISION: "a".repeat(40), SMITHERS_EXPORT_SOURCE_VERSION: sourceVersion }
})
const runtime = new Miniflare(options(seed, false))
try {
  let namespace = await runtime.getDurableObjectNamespace("IDENTITY"), id = namespace.idFromName("global").toString()
  assert.equal((await namespace.get(namespace.idFromString(id)).fetch("https://fixture/seed")).status, 200)
  const read = async () => {
    namespace = await runtime.getDurableObjectNamespace("IDENTITY")
    const response = await namespace.get(namespace.idFromString(id)).fetch("https://fixture/command", { method: "POST", body: JSON.stringify({ command: "accountByLogin", login: "fixture-owner" }) })
    return { status: response.status, text: await response.text() }
  }
  await runtime.setOptions(options(legacy, false)); const before = await read()
  assert.equal(before.status, 200)
  assert.equal(JSON.parse(before.text).id, 42)
  await runtime.setOptions(options(legacy, true))
  const body = JSON.stringify({ migrationId, binding: "IDENTITY", objectId: id })
  assert.equal((await runtime.dispatchFetch("https://identity.smithers.sh/__maintenance/state-export", { method: "POST", body })).status, 404)
  const response = await runtime.dispatchFetch("https://identity.smithers.sh/__maintenance/state-export", { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store")
  const sealed = await response.json()
  assert.equal(sealed.metadata.binding, "IDENTITY"); assert.equal(sealed.metadata.sourceVersion, sourceVersion)
  assert.ok(!JSON.stringify(sealed).includes("fixture-owner")); assert.ok(!JSON.stringify(sealed).includes("fixture-only-token"))
  const bytes = value => Uint8Array.from(Buffer.from(value, "base64"))
  const privateKey = await crypto.subtle.importKey("jwk", pair.privateKey.export({ format: "jwk" }), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"])
  const key = await crypto.subtle.unwrapKey("raw", bytes(sealed.wrappedKey), privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.nonce), additionalData: new TextEncoder().encode(JSON.stringify(sealed.metadata)) }, key, bytes(sealed.ciphertext)))
  try { assert.equal(JSON.parse(new TextDecoder().decode(plain)).entries.length, 3) } finally { plain.fill(0) }
  assert.deepEqual(await read(), before)
  console.log("workerd identity retained rows + sealed export + unchanged account lookup passed")
} finally { await runtime.dispose(); rmSync(state, { recursive: true, force: true }) }
