// @vitest-environment node
// Stays .ts: it evaluates an instrumented bundle through a data: URL import and reads Istanbul's untyped
// globalThis.__coverage__, host code VibeLang rejects (EK4402, EK0107), like test/support/workerdCoverage.ts.
//
// workerd's counters must locate a statement where Vitest's V8 remap does, or the benchmark coverage merge drops real
// workerd execution of any file Node also loaded (0017).
import { expect, it } from "vitest"
import { build } from "esbuild"
import vibelang from "vibelang-unplugin/esbuild"
import { fileURLToPath } from "node:url"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { alchemyWorker } from "./support/alchemyBundle.vibe"
import { dumpWorkerdCoverage, instrumentModules, sourceCoverage } from "./support/workerdCoverage.ts"

const fixture = fileURLToPath(new URL("./support/coverageShape.vibe", import.meta.url))

/** Runs a measured bundle of the fixture, then checks where its counters put the arrow's namespace call. */
async function expectNamespaceCallAtSourceColumn(bundled: string) {
  const scope = globalThis as { __coverage__?: Record<string, unknown> }
  delete scope.__coverage__
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`) as { answer: (flag: boolean) => number }
  expect(module.answer(true)).toBe(1)
  const remapped = await sourceCoverage(scope.__coverage__!)
  delete scope.__coverage__
  // Only the selected module is instrumented, under the absolute path the merge gate filters on.
  expect(remapped.files()).toEqual([fixture])
  const source = remapped.fileCoverageFor(fixture).toJSON() as { statementMap: Record<string, { start: { line: number; column: number } }>; s: Record<string, number> }
  const line = "export const answer = (flag: boolean) => Effect.runSync(Effect.succeed(flag ? 1 : 2))"
  const body = Object.entries(source.statementMap).filter(([, loc]) => loc.start.line === 2)
  expect(body.map(([, loc]) => loc.start.column)).toContain(line.indexOf("Effect.runSync"))
  expect(body.every(([id]) => source.s[id]! > 0)).toBe(true)
}

it("workerd evidence locates a namespace call at its source column", async () => {
  const result = await build({
    entryPoints: [fixture], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    logLevel: "silent", plugins: [instrumentModules(vibelang(), (file) => file === fixture)],
  })
  await expectNamespaceCallAtSourceColumn(result.outputFiles[0]!.text)
}, 240_000)

// worker/Api.vibe is built by Alchemy's rolldown build (test/workerd/api.vibe), measured by the rolldown wrapper.
it("Alchemy's rolldown build of a measured module locates a namespace call at its source column", async () => {
  const modules = await alchemyWorker(fixture, (file) => file === fixture, { date: "2026-10-01", flags: ["nodejs_compat"] })
  expect(modules.map((module) => module.type)).toEqual(["esm"])
  await expectNamespaceCallAtSourceColumn(String(modules[0]!.contents))
}, 240_000)

it("a measured module that does not compile reports the compiler's diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workerd-coverage-"))
  const broken = join(directory, "broken.vibe")
  await writeFile(broken, 'export const answer: number = "text"\n')
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ include: ["*.vibe"], compilerOptions: { strict: true } }))
  try {
    const built = build({
      entryPoints: [broken], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
      logLevel: "silent", plugins: [instrumentModules(vibelang({ root: directory }), (file) => file === broken)],
    })
    await expect(built).rejects.toThrow(/TS2322/)
    await expect(built).rejects.not.toThrow(/without a source map/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)

/** A real inspector transport that can stop at either discovery or the HTTP upgrade. */
async function stalledInspector(stage: "listing" | "body" | "upgrade" | "close") {
  const sockets = new Set<import("node:net").Socket>()
  let upgraded = false
  const server = createServer((_request, response) => {
    if (stage === "listing") return
    if (stage === "body") {
      response.writeHead(200, { "content-type": "application/json" })
      response.write("[")
      return
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify([{ title: "core:user:coverage", webSocketDebuggerUrl: inspector.href.replace("http:", "ws:") }]))
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("upgrade", (request, socket) => {
    upgraded = true
    // An upgraded HTTP socket permits a half-close; finish the server side when the client aborts.
    socket.on("end", () => socket.end())
    if (stage === "close") {
      const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n" + "\u0088\u0000", "latin1")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as import("node:net").AddressInfo
  const inspector = new URL(`http://127.0.0.1:${address.port}`)
  return {
    worker: { async getInspectorURL() { return new URL(inspector) } },
    upgraded: () => upgraded,
    connections: () => sockets.size,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close((error) => error === undefined ? resolve() : reject(error))
    }),
  }
}

for (const stage of ["listing", "body", "upgrade", "close"] as const) {
  it(`bounds inspector ${stage} failure so worker disposal can finish`, async () => {
    const inspector = await stalledInspector(stage)
    const directory = await mkdtemp(join(tmpdir(), "workerd-inspector-"))
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // This is the measured worker's disposal ordering: a failed dump must reach its finalizer.
      const dump = dumpWorkerdCoverage(inspector.worker, "coverage", directory).finally(() => { disposed = true })
      const result = await Promise.race([
        dump.then(() => ({ error: undefined }), (error: unknown) => ({ error })),
        new Promise<{ error: undefined }>((resolve) => { timer = setTimeout(() => resolve({ error: undefined }), 18_000) }),
      ])
      expect(disposed).toBe(true)
      expect(result.error).toBeInstanceOf(Error)
      expect(String(result.error)).toMatch(stage === "close" ? /socket.*(closed|failed)/ : /timeout|timed out/i)
      expect(inspector.upgraded()).toBe(stage === "upgrade" || stage === "close")
      expect(await readdir(directory)).toEqual([])
      // A failed handshake must close its socket before fixture cleanup.
      if (stage === "upgrade") {
        await expect.poll(inspector.connections).toBe(0)
      }
    } finally {
      clearTimeout(timer)
      await inspector.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 25_000)
}
