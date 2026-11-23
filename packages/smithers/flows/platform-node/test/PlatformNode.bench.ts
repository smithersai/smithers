import * as Effect from "effect/Effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, test } from "vitest"
import { defaultLimits } from "../src/AtomicFileSystem.ts"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"
import * as HostLiveness from "../src/HostLiveness.ts"
import * as Protocol from "../src/internal/AtomicFileSystemProtocol.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const scratchBase = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-pnode-bench-")))
const workspaceRoot = NodePath.join(scratchBase, "workspace")
const tmpDir = NodePath.join(workspaceRoot, ".tmp")
NodeFs.mkdirSync(tmpDir, { recursive: true })
NodeFs.mkdirSync(NodePath.join(workspaceRoot, "dist"), { recursive: true })

afterAll(() => {
  NodeFs.rmSync(scratchBase, { recursive: true, force: true })
})

const linuxFacts: ProcessSandbox.Host = {
  ...ProcessSandbox.host(),
  platform: "linux",
  executable: (name) => `/usr/bin/${name}`
}

const darwinFacts: ProcessSandbox.Host = {
  ...ProcessSandbox.host(),
  platform: "darwin",
  executable: (name) => `/usr/bin/${name}`
}

const sampleStatPayload = {
  type: "File",
  mtime: 1_700_000_000_000,
  atime: 1_700_000_000_000,
  birthtime: 1_700_000_000_000,
  dev: 1,
  ino: 12345,
  mode: 0o644,
  nlink: 1,
  uid: 501,
  gid: 20,
  rdev: 0,
  size: 4096,
  blksize: 4096,
  blocks: 8
}

const sampleReadBody = Buffer.from("export const answer = 42\n".repeat(128)).toString("base64")
const framedStat = (() => {
  const body = JSON.stringify({ ok: true, value: sampleStatPayload })
  return Buffer.from(`flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`)
})()
const framedRead = (() => {
  const body = JSON.stringify({ ok: true, value: { base64: sampleReadBody } })
  return Buffer.from(`flows-atomic/1 ${Buffer.byteLength(body)}\n${body}`)
})()

const liveness = HostLiveness.isAlive({ hostId: "bench-node-host" })
const ownOwner = { hostId: "bench-node-host", pid: process.pid }
const deadOwner = { hostId: "bench-node-host", pid: 2_147_483_646 }
const foreignOwner = { hostId: "other-node", pid: 1234 }

const compiledDarwinPlan = ProcessSandbox.plan(
  { network: "none", reads: ["src", "package.json"], writes: ["dist"], writeFiles: [] },
  { workspaceRoot, cwd: workspaceRoot, tmp: tmpDir },
  darwinFacts
)

describe("@smthrs/platform-node", () => {
  test("HostLiveness.isAlive (live + dead ESRCH + foreign)", async ({ bench }) => {
    const program = Effect.gen(function*() {
      yield* liveness(ownOwner)
      yield* liveness(deadOwner)
      yield* liveness(foreignOwner)
    })
    await bench("HostLiveness.isAlive x3", async () => {
      await Effect.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("AtomicFileSystemProtocol decode + convert (stat + 3.2 KiB readFileString)", async ({ bench }) => {
    const statReq: Protocol.FramedRequest = { operation: "stat", path: "/workspace/src/index.ts" }
    const readReq: Protocol.FramedRequest = { operation: "readFileString", path: "/workspace/src/index.ts" }
    await bench("AtomicFileSystemProtocol decode+convert", async () => {
      const statDecoded = Protocol.decode(framedStat, defaultLimits)
      const readDecoded = Protocol.decode(framedRead, defaultLimits)
      if (statDecoded.ok) await Effect.runPromise(Protocol.convert(statReq, statDecoded.value, defaultLimits))
      if (readDecoded.ok) await Effect.runPromise(Protocol.convert(readReq, readDecoded.value, defaultLimits))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("ProcessSandbox.plan (workspace confinement & symlink checks)", async ({ bench }) => {
    await bench("ProcessSandbox.plan", () => {
      ProcessSandbox.plan(
        { network: "none", reads: ["src", "package.json"], writes: ["dist"], writeFiles: [] },
        { workspaceRoot, cwd: workspaceRoot, tmp: tmpDir },
        linuxFacts
      )
    }).run({ time: 120, warmupTime: 30 })
  })

  test("ProcessSandbox.seatbelt profile generation", async ({ bench }) => {
    if (ProcessSandbox.isUnenforceable(compiledDarwinPlan)) {
      throw new Error(`expected enforceable plan: ${compiledDarwinPlan.message}`)
    }
    await bench("ProcessSandbox.seatbelt", () => {
      ProcessSandbox.seatbelt(compiledDarwinPlan, darwinFacts)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("EgressHttpClient.dispatcher (direct + proxy config)", async ({ bench }) => {
    const program = Effect.scoped(
      Effect.gen(function*() {
        yield* EgressHttpClient.dispatcher({})
        yield* EgressHttpClient.dispatcher({ HTTPS_PROXY: "http://127.0.0.1:8080", NO_PROXY: "localhost,127.0.0.1" })
      })
    )
    await bench("EgressHttpClient.dispatcher", async () => {
      await Effect.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })
})
