import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLspHost } from "./lsp/LspHost"
import { createPtyManager } from "./Pty"
import type { PtyManager } from "./Pty"
import { startLocalServer } from "./server"

for (const failure of ["sync", "async"] as const) {
  test(`a ${failure} PTY shutdown failure still closes the listener and independent LSP owner`, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-server-lifetime-"))
    await writeFile(join(root, "index.html"), "fixture")
    let lspStopped = false
    const original = new Error("PTY fixture shutdown failed")
    const server = await startLocalServer({
      port: 0,
      distDir: root,
      home: root,
      stateDir: join(root, "state"),
      chatStub: true,
      node: null,
      harnesses: async () => [],
      log: () => {},
      pty: (deps) => {
        const owner = createPtyManager({ ...deps, env: {}, shell: "/bin/sh" })
        return {
          ...owner,
          dispose: failure === "sync"
            ? () => {
              throw original
            }
            : async () => {
              await owner.dispose()
              throw original
            }
        }
      },
      lsp: (deps) => {
        const owner = createLspHost(deps)
        return {
          ...owner,
          killAll: async () => {
            await owner.killAll()
            lspStopped = true
          }
        }
      }
    })
    try {
      const stopping = server.stop()
      expect(server.stop()).toBe(stopping)
      const error = await stopping.catch((error: unknown) => error)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toContain(original)
      expect(lspStopped).toBe(true)
      await expect(fetch(server.origin + "/api/health")).rejects.toThrow()
    } finally {
      // Preserve the red fixture's safety even when the original stop skipped its listener.
      server.server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("server shutdown cancels a route awaiting PTY setup and late completion cannot launch a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-server-lifetime-"))
  await writeFile(join(root, "index.html"), "fixture")
  const gate = Promise.withResolvers<ReadonlyArray<string>>()
  const entered = Promise.withResolvers<void>()
  let pty!: PtyManager
  const server = await startLocalServer({
    port: 0,
    distDir: root,
    home: root,
    stateDir: join(root, "state"),
    chatStub: true,
    node: null,
    harnesses: async () => [],
    log: () => {},
    pty: (deps) =>
      pty = createPtyManager({
        ...deps,
        env: {},
        shell: "/bin/sh",
        pathPrepend: () => {
          entered.resolve()
          return gate.promise
        }
      })
  })
  try {
    const request = fetch(server.origin + "/api/pty", {
      method: "POST",
      headers: { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json" },
      body: JSON.stringify({ kind: "terminal", cols: 80, rows: 24 })
    }).then((response) => response.status, () => "connection-closed")
    await entered.promise
    await server.stop()
    expect([503, "connection-closed"]).toContain(await request)
    gate.resolve([])
    await Bun.sleep(10)
    expect(pty.list()).toEqual([])
    expect(await pty.create({ kind: "terminal", cwd: root, cols: 80, rows: 24 })).toMatchObject({
      code: "manager_closed"
    })
  } finally {
    gate.resolve([])
    await server.stop()
    await rm(root, { recursive: true, force: true })
  }
})
