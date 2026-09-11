import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TYPESCRIPT_SERVER } from "./LanguageServers"
import { createLspSession } from "./LspSession"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })

const delayedSession = async (initializeDelay: number, startupTimeoutMs: number) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-startup-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const script = join(root, "server.mjs")
  await writeFile(join(root, "a.ts"), "const a = 1\n")
  await writeFile(script, `let b=Buffer.alloc(0),queries=0;function send(m){const p=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));process.stdout.write('Content-Length: '+p.length+'\\r\\n\\r\\n');process.stdout.write(p)}
process.stdin.on('data',chunk=>{b=Buffer.concat([b,chunk]);for(;;){const h=b.indexOf('\\r\\n\\r\\n');if(h<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(b.subarray(0,h).toString())[1]);if(b.length<h+4+n)return;const m=JSON.parse(b.subarray(h+4,h+4+n));b=b.subarray(h+4+n);if(m.method==='initialize')setTimeout(()=>send({id:m.id,result:{capabilities:{}}}),${initializeDelay});if(m.method==='textDocument/hover'||m.method==='textDocument/definition'){queries++;setTimeout(()=>send({id:m.id,result:m.method==='textDocument/hover'?{contents:'number'}:[]}),queries<=2?300:150)}if(m.method==='shutdown')send({id:m.id,result:null});if(m.method==='exit')process.exit(0)}})`)
  const session = createLspSession({ repoId: "repo", repoRoot: root, spec: TYPESCRIPT_SERVER,
    argv: [process.execPath, script], env: {}, publish: () => {}, log: () => {},
    requestTimeoutMs: 75, startupTimeoutMs, killGraceMs: 100
  })
  cleanup.push(() => session.shutdown())
  return session
}

test("cold initialization and concurrent project queries have a separate budget; warm queries keep their limit", async () => {
  const session = await delayedSession(150, 1500)
  const [hover, definition] = await Promise.all([
    session.hover("a.ts", { line: 1, character: 1 }),
    session.definition("a.ts", { line: 1, character: 1 })
  ])
  expect(hover.hover?.contents).toBe("number")
  expect(definition.locations).toEqual([])
  await expect(session.hover("a.ts", { line: 1, character: 1 })).rejects.toMatchObject({ code: "language_server_timeout", http: 504, message: "The language server did not answer textDocument/hover within 75 ms." })
}, 5000)

test("the initialization allowance remains bounded", async () => {
  const session = await delayedSession(1500, 300)
  await expect(session.hover("a.ts", { line: 1, character: 1 })).rejects.toMatchObject({ code: "language_server_timeout", http: 504, message: "The language server did not answer initialize within 300 ms." })
}, 5000)
