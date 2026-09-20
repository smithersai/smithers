import { expect, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = fileURLToPath(new URL("../", import.meta.url))
const port = Number(process.env.SMITHERS_FLOW_GRAPH_PORT ?? "47361")
const closed = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port })
  socket.once("connect", () => { socket.destroy(); resolve(false) })
  socket.once("error", () => { socket.destroy(); resolve(true) })
})

/** Save only this host's descendants before the failure path can orphan them. */
const descendants = (parent: number): number[] => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
  const owned = [parent]
  for (let index = 0; index < owned.length; index++) {
    owned.push(...rows.filter((row) => row[1] === owned[index]).map((row) => row[0]!))
  }
  return owned.reverse()
}

const deadline = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally { clearTimeout(timer) }
}

test("SIGTERM closes the host and relay ports and removes both database directories", async () => {
  expect(await closed(port)).toBe(true)
  const root = await mkdtemp(join(tmpdir(), "flow-graph-host-stop-"))
  const child = spawn(process.execPath, ["scripts/flow-graph-e2e-host.ts"], {
    cwd: APP_DIR, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, TMPDIR: root, SMITHERS_SKIP_SPA_BUILD: "1", SMITHERS_FLOW_GRAPH_PORT: String(port) }
  })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  let owned: number[] = []
  try {
    let output = ""
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (bytes) => {
        output += String(bytes)
        if (output.includes("[flow-graph] open")) resolve(output)
      })
      child.once("error", reject)
      child.once("exit", () => reject(new Error(`Host exited during startup: ${output}`)))
    })
    const stdout = await deadline(ready, 120_000, "Host never became ready")
    const relay = stdout.match(/\[flow-graph\] relay\s+http:\/\/127\.0\.0\.1:(\d+)/)
    expect(relay).not.toBeNull()
    const relayPort = Number(relay![1])
    owned = descendants(child.pid!)
    expect((await readdir(root)).filter((name) => /^smthrs-flow-graph-/.test(name))).toHaveLength(1)
    expect((await readdir(root)).filter((name) => /^smithers-flow-graph-host-/.test(name))).toHaveLength(1)
    expect(await closed(port)).toBe(false)
    expect(await closed(relayPort)).toBe(false)
    child.kill("SIGTERM")
    expect(await deadline(exited, 10_000, "Host did not finish its SIGTERM finalizers")).toBe(0)
    expect(await closed(port)).toBe(true)
    expect(await closed(relayPort)).toBe(true)
    expect((await readdir(root)).filter((name) => /^(smthrs|smithers)-flow-graph-/.test(name))).toEqual([])
  } finally {
    for (const pid of owned.length === 0 ? descendants(child.pid!) : owned) {
      try { process.kill(pid, "SIGKILL") } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    await exited
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)
