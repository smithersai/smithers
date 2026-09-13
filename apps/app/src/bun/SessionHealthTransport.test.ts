import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as Health from "@smthrs/control/Health"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { startLocalServer } from "./server"
import { createPtyManager } from "./Pty"
import { openLocalHealthJournal } from "./LocalHealthJournal"

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test("real PTY lifecycle and durable Effect health reach authenticated list and topic transports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-health-transport-"))
  const stateDir = join(directory, "state")
  await writeFile(join(directory, "index.html"), "<html><head></head><body>health fixture</body></html>")
  const server = await startLocalServer({
    port: 0, distDir: directory, stateDir, home: directory, chatStub: true, node: null,
    harnesses: async () => [], log: () => {},
    health: {
      checkers: [{ id: "fixture.semantic", probe: () => Effect.succeed({ activity: "working", reason: "ok" }) }],
      bindings: { terminal: { checkerId: "fixture.semantic", policy: { intervalMs: 100, timeoutMs: 50, ttlMs: 1000 } } }
    },
    pty: (deps) => createPtyManager({ ...deps, env: {}, shell: "/bin/sh" })
  })
  let socket: WebSocket | undefined
  try {
    expect((await fetch(server.origin + "/api/pty")).status).toBe(401)
    const request = (path: string, init?: RequestInit) => fetch(server.origin + path, {
      ...init, headers: { [LOCAL_SESSION_HEADER]: server.sessionToken, "content-type": "application/json", ...init?.headers }
    })
    const created = await request("/api/pty", { method: "POST", body: JSON.stringify({ kind: "terminal", cols: 80, rows: 24 }) })
    expect(created.status).toBe(201)
    const { sessionId } = await created.json() as { sessionId: string }
    const statuses: Health.StatusRollup[] = []
    let acknowledged = false
    socket = new WebSocket(server.origin.replace("http:", "ws:") + "/ws", [server.websocketProtocol])
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === "pty.status") statuses.push(Schema.decodeUnknownSync(Health.StatusRollup)(message.status))
      if (message.type === "subscribed") acknowledged = true
    }
    await until(() => socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "subscribe", topic: `pty:${sessionId}`, cursor: 0 }))
    await until(() => acknowledged && statuses.some((status) => status.activity === "working"))
    const row = (await (await request("/api/pty")).json() as { sessions: Array<{ status: unknown }> }).sessions[0]!
    const snapshot = Schema.decodeUnknownSync(Health.StatusRollup)(row.status)
    expect(snapshot.subjectId).toBe(`session:${sessionId}`)
    expect(snapshot.activity).toBe("working")
    expect(snapshot.provenance?.checkerId).toBe("fixture.semantic")

    // The frame's sequence names already-committed evidence in the production
    // journal, readable through a separate SQLite connection.
    const ledger = await openLocalHealthJournal(stateDir)
    try {
      const committed = await ledger.entries(`session:${sessionId}`)
      expect(committed.entries.some((entry) => entry.seq === snapshot.provenance?.version)).toBe(true)
    } finally { await ledger.close() }

    socket.send(JSON.stringify({ type: "pty.input", sessionId, data: "exit 7\n" }))
    await until(() => statuses.some((status) => status.state === "exited"))
    expect(statuses.findLast((status) => status.state === "exited")).toMatchObject({ activity: "unknown", health: "failing" })
    expect((await request(`/api/pty/${sessionId}`, { method: "DELETE" })).status).toBe(200)
  } finally {
    socket?.close()
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
