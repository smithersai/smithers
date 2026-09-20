import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { MODEL_CREDENTIAL_PATH, MODEL_CREDENTIAL_RECEIPT_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { launchModelProvider } from "../../e2e/real/support/model-provider-process"
import { PROVIDER_MODEL } from "../../e2e/real/support/model-provider-behaviors"
import { darwinKeychain } from "./CloudAuth"
import { MODEL_KEYCHAIN_SERVICE, modelKeychainAccount } from "./ModelCredentials"
import { startLocalServer } from "./server"

test.skipIf(process.platform !== "darwin")("real keychain and loopback host enroll, reject repinning, rotate and remove without logging a value", async () => {
  const key = "integration-keychain-fixture-012345"
  const provider = await launchModelProvider({ key })
  const root = await mkdtemp(join(tmpdir(), "smithers-enrollment-"))
  const stateDir = join(root, "state")
  await writeFile(join(root, "index.html"), "<!doctype html><title>Smithers</title>")
  const logs: string[] = []
  const options = { port: 0, distDir: root, stateDir, cloudMode: "offline" as const, env: {}, log: (line: string) => { logs.push(line) } }
  let server = await startLocalServer(options)
  const call = (path: string, body?: unknown, origin?: string) => fetch(`${server.origin}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json", ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const request = { action: "enroll", name: "ENROLLED", origin: provider.origin, value: key, requestId: "initial-request" }
  const model = { id: "real-enrolled", protocol: "openai-chat", baseUrl: provider.origin, modelId: PROVIDER_MODEL.answers, credential: "ENROLLED" }
  try {
    expect((await call(MODEL_CREDENTIAL_PATH, request, "https://attacker.example")).status).toBe(403)
    expect(await (await call(MODEL_CREDENTIAL_PATH, request)).json()).toMatchObject({ ok: true })
    await server.stop()
    server = await startLocalServer(options)
    expect(await (await call(`${MODEL_CREDENTIAL_RECEIPT_PATH}?id=initial-request`)).json()).toMatchObject({ state: "completed", result: { ok: true } })
    expect(await (await call(MODEL_TEST_PATH, { model })).json()).toMatchObject({ ok: true })
    expect(await (await call(MODEL_CREDENTIAL_PATH, { ...request, requestId: "repin-request", origin: "https://attacker.example" })).json()).toMatchObject({ ok: false, failure: { code: "exists" } })
    expect(await (await call(MODEL_CREDENTIAL_PATH, { action: "rotate", requestId: "bad-rotation", name: "ENROLLED", origin: "https://attacker.example", value: key })).json()).toMatchObject({ ok: false, failure: { code: "invalid" } })
    expect(await (await call(MODEL_CREDENTIAL_PATH, { action: "rotate", requestId: "rotate-request", name: "ENROLLED", value: "revoked-fixture-credential" })).json()).toMatchObject({ ok: true })
    expect(await (await call(MODEL_TEST_PATH, { model })).json()).toMatchObject({ ok: false, failure: { code: "refused", status: 401 } })
    expect(await (await call(MODEL_CREDENTIAL_PATH, { action: "remove", requestId: "remove-request", name: "ENROLLED" })).json()).toMatchObject({ ok: true, credential: { present: false } })
    expect(await (await call(MODEL_TEST_PATH, { model })).json()).toMatchObject({ ok: false, failure: { code: "credential_missing" } })
    const journal = await provider.journal()
    expect(journal).toHaveLength(2)
    expect(journal[0]?.credentialSha256).toBe(createHash("sha256").update(key).digest("hex"))
    expect(JSON.stringify([logs, journal])).not.toContain(key)
    expect(JSON.stringify([logs, journal])).not.toContain("revoked-fixture-credential")
  } finally {
    await server.stop()
    await provider.close()
    await darwinKeychain(undefined, true).remove(MODEL_KEYCHAIN_SERVICE, modelKeychainAccount(stateDir))
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
