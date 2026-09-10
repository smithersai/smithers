/** The shipped CLI executor must contain descendants after an MCP server exits. */
import { Control } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const ownedProcess = (pid: number, token: string): boolean => {
  try {
    return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
    }).includes(token)
  } catch {
    return false
  }
}

describe.skipIf(process.platform === "win32")("NodeControl executor process groups", () => {
  it.each(["SIGTERM", "natural"] as const)(
    "closes a real MCP server's stubborn descendant after %s exit",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "smithers-cli-mcp-containment-"))
      const token = randomUUID()
      const ready = join(root, "child.json")
      const leader = join(root, "leader.pid")
      const heartbeat = join(root, "heartbeat")
      const spawnChild = join(root, "spawn-child")
      const child = [
        "const fs = require('node:fs')",
        `const token = ${JSON.stringify(token)}`,
        "process.on('SIGTERM', () => {})",
        `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ token, pid: process.pid }))`,
        `const beat = () => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.')`,
        "beat(); setInterval(beat, 20)"
      ].join("\n")
      const server = [
        "const fs = require('node:fs')",
        `fs.writeFileSync(${JSON.stringify(leader)}, String(process.pid))`,
        "let started = false",
        "setInterval(() => {",
        `  if (!started && fs.existsSync(${JSON.stringify(spawnChild)})) {`,
        "    started = true",
        `    require('node:child_process').spawn(process.execPath, ['-e', ${
          JSON.stringify(child)
        }], { stdio: 'ignore' }).unref()`,
        "  }",
        `  if (${mode === "natural"} && started && fs.existsSync(${JSON.stringify(heartbeat)})) process.exit(0)`,
        "}, 5)",
        "process.on('SIGTERM', () => process.exit(0))",
        "setInterval(() => {}, 1000)",
        "process.stdin.setEncoding('utf8')",
        "let buffer = ''",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk",
        "  let newline",
        "  while ((newline = buffer.indexOf('\\n')) !== -1) {",
        "    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)",
        "    if (!line.trim()) continue",
        "    const message = JSON.parse(line)",
        "    if (message.id === undefined) continue",
        "    const result = message.method === 'initialize'",
        "      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'containment', version: '1' } }",
        "      : { tools: [] }",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')",
        "  }",
        "})"
      ].join("\n")
      let childPid: number | undefined
      try {
        const registry = NodeControl.layerRegistry(root)
        const engine = NodeControl.engineDurable(root, registry)
        const executor = NodeControl.layerExecutor(registry, engine, root, {
          environment: {},
          mcpServers: [{ server: "containment", command: process.execPath, args: ["-e", server] }]
        })
        await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control.Control
            expect((yield* control.plan({ flowId: "system/test", input: {} })).flowId).toBe("system/test")
            // The executor and its initial identity capture are ready before the
            // server may fork. A natural exit then leaves only its new descendant.
            writeFileSync(spawnChild, "go")
            for (let attempt = 0; attempt < 500; attempt++) {
              try {
                if (statSync(heartbeat).size > 0) {
                  const record = JSON.parse(readFileSync(ready, "utf8")) as { token: string; pid: number }
                  expect(record.token).toBe(token)
                  childPid = record.pid
                  break
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
              }
              yield* Effect.sleep(10)
            }
            if (childPid === undefined) throw new Error("MCP descendant never became ready")
            if (mode === "natural") {
              const leaderPid = Number(readFileSync(leader, "utf8"))
              for (let attempt = 0; attempt < 100 && ownedProcess(leaderPid, token); attempt++) {
                yield* Effect.sleep(10)
              }
              expect(ownedProcess(leaderPid, token)).toBe(false)
            }
          }).pipe(
            Effect.provide(Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>),
            Effect.scoped
          )
        )
        expect(childPid).toBeDefined()
        const stoppedAt = statSync(heartbeat).size
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(statSync(heartbeat).size, "the descendant must stop writing after executor scope closure").toBe(
          stoppedAt
        )
        expect(ownedProcess(childPid!, token)).toBe(false)
      } finally {
        // Only this fixture's UUID-bearing processes may be signalled, including
        // when the regression fails before normal scope cleanup can contain them.
        for (const file of [ready, leader]) {
          try {
            const text = readFileSync(file, "utf8")
            const pid = file === ready ? (JSON.parse(text) as { pid: number }).pid : Number(text)
            if (ownedProcess(pid, token)) process.kill(pid, "SIGKILL")
          } catch {
            // The owned process or its readiness file is already gone.
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    20_000
  )
})
