import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createCloudAuth } from "./CloudAuth"
import type { CloudKeychain } from "./CloudAuth"
import { createNativeShutdown } from "./NativeShutdown"
import { childEnv } from "./Pty"
import { createTargetRunHistory } from "./TargetRunHistory"
import { startLocalServer } from "./server"
import { createAgentStore } from "./routes/agents"
import { createLspSession } from "./lsp/LspSession"
import { TYPESCRIPT_SERVER } from "./lsp/LanguageServers"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const directory = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-regression-")))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  await writeFile(join(path, "index.html"), "<!doctype html><head></head>")
  return path
}
const keychain = () => {
  let value: string | null = null
  const api: CloudKeychain = { read: async () => value, write: async (_s, _a, next) => { value = next }, remove: async () => { value = null } }
  return { api, value: () => value }
}
const credentials = { token: "review-test-token", username: "test", email: null, expiresAt: "2099-01-01T00:00:00Z" }

test("a duplicate active chat request preserves the first response stream", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    stream = controller
    controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", kind: "text", text: "first" })}\n`))
  } })) })
  cleanup.push(() => { upstream.stop(true) })
  const server = await startLocalServer({ distDir: await directory(), node: null, cloudMode: "hybrid", cloudApi: null, identityUpstream: null,
    chat: { chatUrl: `http://127.0.0.1:${upstream.port}` }, log: () => {} })
  cleanup.push(() => server.stop())
  const headers = { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json" }
  const body = JSON.stringify({ runId: "duplicate", messages: [], instructions: "" })
  const first = await fetch(`${server.origin}/api/chat/turn`, { method: "POST", headers, body })
  const original = first.text()
  expect((await fetch(`${server.origin}/api/chat/turn`, { method: "POST", headers, body })).status).toBe(409)
  stream!.enqueue(encoder.encode(`${JSON.stringify({ type: "done", reason: "stop" })}\n`)); stream!.close()
  const result = await Promise.race([original, Bun.sleep(1000).then(() => "TIMED OUT")])
  expect(result).toContain('"type":"done"'); expect(result).toContain('"text":"first"')
})

test("Linear's browser navigation consumes only its one-use authorization", async () => {
  const calls: Array<string> = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    calls.push(request.url)
    expect(request.headers.get("authorization")).toBe("Bearer test-cloud-token")
    return Response.redirect("https://linear.app/oauth/authorize", 302)
  } })
  cleanup.push(() => { upstream.stop(true) })
  const server = await startLocalServer({ distDir: await directory(), node: null, chatStub: true, cloudMode: "hybrid",
    cloudApi: `http://127.0.0.1:${upstream.port}`, cloudAuth: { token: () => "test-cloud-token", session: () => ({ state: "signed-in", username: "test", expiresAt: null }),
      start: async () => ({ error: "unused" }), signOut: async () => {}, stop: async () => {} }, log: () => {} })
  cleanup.push(() => server.stop())
  const response = await fetch(`${server.origin}/api/linear-auth/start`, { method: "POST", headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
  const { url } = await response.json() as { url: string }
  const missing = new URL(url); missing.searchParams.delete("handoff")
  expect((await fetch(missing)).status).toBe(401)
  const browser = await fetch(url, { redirect: "manual" })
  expect(browser.status).toBe(302); expect(browser.headers.get("location")).toBe("https://linear.app/oauth/authorize")
  expect(calls).toHaveLength(1); expect(calls[0]).not.toContain("handoff=")
  expect((await fetch(url, { redirect: "manual" })).status).toBe(401)
})

test("the native browser route is session-gated and enabled only in hybrid mode", async () => {
  for (const cloudMode of ["offline", "hybrid"] as const) {
    const server = await startLocalServer({ distDir: await directory(), node: null, cloudMode, cloudApi: null, identityUpstream: null, log: () => {} })
    cleanup.push(() => server.stop())
    const path = `${server.origin}/api/tools/browser-fetch`
    const body = JSON.stringify({ url: "https://127.0.0.1/" })
    expect((await fetch(path, { method: "POST", body })).status).toBe(401)
    const headers = { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json" }
    expect((await fetch(path, { method: "POST", headers, body })).status).toBe(cloudMode === "hybrid" ? 422 : 501)
    const bootstrap = await (await fetch(`${server.origin}/api/bootstrap`, { headers })).json() as { capabilities: Array<string> }
    expect(bootstrap.capabilities.includes("browser.read")).toBe(cloudMode === "hybrid")
  }
})

test("sign-out invalidates a callback waiting for its scope probe", async () => {
  const saved = keychain()
  let release!: () => void; let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const auth = await createCloudAuth({ api: "https://cloud.test", keychain: saved.api,
    fetchImpl: async () => { entered(); await gate; return new Response("[]") } })
  cleanup.push(() => auth.stop())
  const login = await auth.start(); if (!("url" in login)) throw new Error(login.error)
  const port = new URL(login.url).searchParams.get("callback_port")
  await fetch(`http://127.0.0.1:${port}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...credentials, callback_state: new URL(login.url).searchParams.get("callback_state") }) })
  await started; await auth.signOut(); release(); await Bun.sleep(20)
  expect(auth.session().state).toBe("signed-out"); expect(auth.token()).toBeUndefined(); expect(saved.value()).toBeNull()
})

test("expired credentials allow a fresh login and valid restores recheck scope", async () => {
  for (const expired of [true, false]) {
    const saved = keychain()
    await saved.api.write("", "", JSON.stringify({ ...credentials, expiresAt: expired ? "2000-01-01T00:00:00Z" : credentials.expiresAt }))
    let probes = 0
    const auth = await createCloudAuth({ api: "https://cloud.test", keychain: saved.api,
      fetchImpl: async () => { probes++; return new Response("insufficient token scope", { status: 403 }) } })
    cleanup.push(() => auth.stop())
    expect(auth.session().state).toBe(expired ? "signed-out" : "signed-in"); expect(probes).toBe(expired ? 0 : 1)
    if (expired) { expect(saved.value()).toBeNull(); expect(await auth.start()).toHaveProperty("url") }
    else expect(auth.session().scopes).toBe("degraded")
  }
})

test("concurrent successful agent edits both survive on disk", async () => {
  const stateDir = await directory(); const store = createAgentStore({ stateDir })
  const input = { label: "Reviewer", purpose: "Review tests", harness: "codex" as const, model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT" } }
  expect((await Promise.all([store.put("review-one", input), store.put("review-two", input)])).map((row) => row.status)).toEqual(["created", "created"])
  expect((await createAgentStore({ stateDir }).list()).filter((row) => row.id.startsWith("review-")).map((row) => row.id)).toEqual(["review-one", "review-two"])
})

test("starting a new run first retains the previous launch's history", async () => {
  const repo = await directory()
  const run = (runId: string) => ({ runId, repoId: "review-repo", repo, workspace: ".", label: "//:test", labels: ["//:test"], startedAt: Date.now(), status: "pending" as const, exitCode: null })
  const old = createTargetRunHistory(); await old.start(run("old")); old.event(run("old"), { type: "exit", code: 0 }); await old.list("review-repo", repo)
  const current = createTargetRunHistory(); await current.start(run("new"))
  expect((await current.list("review-repo", repo)).map((row) => row.runId).sort()).toEqual(["new", "old"]); expect(await current.replay("old")).toBeDefined()
})

test("run events arriving during journal initialization are retained", async () => {
  const repo = await directory()
  const run = { runId: "early-event", repoId: "review-repo", repo, workspace: ".", label: "//:test", labels: ["//:test"], startedAt: Date.now(), status: "pending" as const, exitCode: null }
  const history = createTargetRunHistory()
  const started = history.start(run)
  history.event(run, { type: "exit", code: 0 })
  await started
  const replay = await history.replay(run.runId)
  expect(replay?.run.status).toBe("done")
  expect(replay?.events).toContainEqual({ type: "exit", code: 0 })
  expect((await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: repo }]))?.run.status).toBe("done")
})

test("native quit waits for cleanup once then allows Electrobun's final quit", async () => {
  let beforeQuit!: (event: { response?: { allow: boolean } }) => void; let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve }); const quits: Array<number> = []; let stops = 0
  const shutdown = createNativeShutdown({ onBeforeQuit: (handler) => { beforeQuit = handler }, stop: async () => { stops++; await gate }, quit: (code) => { quits.push(code) }, log: () => {} })
  const event: { response?: { allow: boolean } } = {}; beforeQuit(event); beforeQuit({})
  expect(event.response).toEqual({ allow: false }); expect(stops).toBe(1); expect(quits).toEqual([])
  release(); await shutdown()
  const final: { response?: { allow: boolean } } = {}; beforeQuit(final)
  expect(final.response).toBeUndefined(); expect(quits).toEqual([0])
})

test("the Cerebras credential detected by the harness table reaches its child", () => {
  expect(childEnv({ CEREBRAS_API_KEY: "test-key", PATH: "" }, "/fake", []).CEREBRAS_API_KEY).toBe("test-key")
})

test("native LSP ignores old diagnostics after syncing version two", async () => {
  const dir = await directory(); const script = join(dir, "lsp.mjs")
  await writeFile(script, `let b=Buffer.alloc(0);function send(m){const p=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));process.stdout.write('Content-Length: '+p.length+'\\r\\n\\r\\n');process.stdout.write(p)}
process.stdin.on('data',chunk=>{b=Buffer.concat([b,chunk]);for(;;){const h=b.indexOf('\\r\\n\\r\\n');if(h<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(b.subarray(0,h).toString())[1]);if(b.length<h+4+n)return;const m=JSON.parse(b.subarray(h+4,h+4+n));b=b.subarray(h+4+n);if(m.method==='initialize')send({id:m.id,result:{capabilities:{}}});if(m.method==='textDocument/hover')send({id:m.id,result:{contents:'number'}});if(m.method==='textDocument/didChange'){const publish=(version,message)=>send({method:'textDocument/publishDiagnostics',params:{uri:m.params.textDocument.uri,version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:1}},message,severity:1}]}});setTimeout(()=>publish(1,'old'),10);setTimeout(()=>publish(2,'current'),30)}if(m.method==='shutdown')send({id:m.id,result:null});if(m.method==='exit')process.exit(0)}})`)
  await writeFile(join(dir, "a.ts"), 'const a: number = "old"')
  const session = createLspSession({ repoId: "review-repo", repoRoot: dir, spec: TYPESCRIPT_SERVER, argv: [process.execPath, script], env: {}, publish: () => {}, log: () => {}, requestTimeoutMs: 2000, killGraceMs: 100 })
  cleanup.push(() => session.shutdown()); await session.hover("a.ts", { line: 1, character: 1 })
  const current = "const a: number = 1"; await writeFile(join(dir, "a.ts"), current)
  const response = await session.diagnostics("a.ts", 1000)
  expect(response.version).toBe(2); expect(response.items?.map((item) => item.message)).toEqual(["current"])
  expect(response.digest).toBe(createHash("sha256").update(current).digest("hex"))
})
