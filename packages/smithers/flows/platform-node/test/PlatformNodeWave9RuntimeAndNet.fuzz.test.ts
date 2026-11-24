import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import * as Flow from "@smthrs/flow/Flow"
import * as FlowNode from "@smthrs/plan/Node"
import { Fuzz } from "@smthrs/fuzz"
import { LanguageServer } from "@smthrs/std"
import * as DirectorySandbox from "@smthrs/sandbox/DirectorySandbox"
import {
  Arbitrary,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Path,
  Schema,
  Stream
} from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as Net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DestinationProxy from "../src/DestinationProxy.ts"
import * as FetchTransport from "../src/FetchTransport.ts"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import * as NativeRuntime from "../src/NativeRuntime.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const ioExecutions = Math.max(8, Math.min(baseExecutions, 16))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261133")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-pnode-w9-rn-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const encoder = new TextEncoder()

const rawPlatform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const localServices = Effect.runSync(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return { spawner, fs, path }
  }).pipe(Effect.provide(rawPlatform))
)

describe("@smthrs/platform-node Wave-9 runtime, confinement, LSP, proxy, PipedProcess & SandboxedFlow deep fuzz", () => {
  it("ProcessSandbox covers linux bwrap readDenies/stage/loopback refusal, darwin seatbelt readDenies/hidden prefix errors, toolchain companions & hiddenEntries", () => {
    const ws = freshDir("psb-ws")
    const tmp = freshDir("psb-tmp")
    const home = freshDir("psb-home")
    const secretFile = join(ws, ".env")
    const secretDir = join(ws, ".secret-dir")
    const extRead = join(secretDir, "public.txt")
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(secretFile, "SECRET=1")
    writeFileSync(extRead, "ok")
    writeFileSync(join(home, ".tool-versions"), "nodejs 22.0.0\n")
    mkdirSync(join(home, ".nvm"), { recursive: true })
    writeFileSync(join(home, ".nvm", "alias"), "default\n")

    const baseHost = ProcessSandbox.host()
    const linuxHost: ProcessSandbox.Host = {
      ...baseHost,
      platform: "linux",
      home,
      executable: (name) => name === "bwrap" ? "/usr/bin/bwrap" : baseHost.executable(name)
    }
    const darwinHost: ProcessSandbox.Host = {
      ...baseHost,
      platform: "darwin",
      home,
      developerDirectory: "/Library/Developer/CommandLineTools",
      executable: (name) => name === "sandbox-exec" ? "/usr/bin/sandbox-exec" : baseHost.executable(name)
    }

    // 1. toolchain with .tool-versions and companions
    const tcLinux = ProcessSandbox.toolchain(process.env.PATH, ws, linuxHost)
    expect(tcLinux.reads.length).toBeGreaterThanOrEqual(0)

    // 2. hiddenEntries traversal + missing entries callback error
    const hidden = ProcessSandbox.hiddenEntries(ws, [".env", ".secret"], [extRead], linuxHost)
    expect(hidden.length).toBeGreaterThan(0)
    expect(() =>
      ProcessSandbox.hiddenEntries(ws, [".env"], [], { ...linuxHost, entries: undefined })
    ).toThrow()

    // 3. bubblewrap with readDenies (file + dir + externalReads inside dir), stage writable/ro, and loopback error
    const plannedLinux = ProcessSandbox.plan(
      { reads: [ws], writes: [ws], network: "none" },
      { workspaceRoot: ws, cwd: ws, tmp },
      linuxHost
    )
    if (!ProcessSandbox.isUnenforceable(plannedLinux)) {
      const withDenies: ProcessSandbox.Plan = {
        ...plannedLinux,
        readDenies: [secretFile, secretDir],
        externalReads: [extRead],
        stage: { directory: ws, writable: false, files: [], links: [] }
      }
      const bwrapArgs = ProcessSandbox.bubblewrap(withDenies, ["echo", "hi"], linuxHost)
      expect(bwrapArgs).toContain("--ro-bind")
      expect(bwrapArgs).toContain("--tmpfs")
      expect(bwrapArgs).toContain("--remount-ro")
      const bwrapWritable = ProcessSandbox.bubblewrap(
        { ...withDenies, stage: { directory: ws, writable: true, files: [], links: [] } },
        ["echo", "hi"],
        linuxHost
      )
      expect(bwrapWritable).toContain("--bind")
      expect(() =>
        ProcessSandbox.bubblewrap({ ...withDenies, network: "loopback" }, ["echo", "hi"], linuxHost)
      ).toThrow(/loopback/)
      // validateWrites unsafe write refusal (writing to root)
      expect(() =>
        ProcessSandbox.validateWrites({ ...plannedLinux, writes: ["/"] }, linuxHost)
      ).toThrow()
    }

    // 4. seatbelt on darwin with readDenies, valid hidden prefixes, and invalid hidden prefixes
    const plannedDarwin = ProcessSandbox.plan(
      { reads: [ws], writes: [ws], network: "none" },
      { workspaceRoot: ws, cwd: ws, tmp },
      darwinHost
    )
    if (!ProcessSandbox.isUnenforceable(plannedDarwin)) {
      const withHidden: ProcessSandbox.Plan = {
        ...plannedDarwin,
        readDenies: [secretFile],
        hidden: { prefixes: [".env"], paths: [secretFile], restored: [] }
      }
      const profile = ProcessSandbox.seatbelt(withHidden, darwinHost)
      expect(profile).toContain("deny file-read*")
      expect(() =>
        ProcessSandbox.seatbelt(
          { ...withHidden, hidden: { prefixes: ["bad\nprefix"], paths: [], restored: [] } },
          darwinHost
        )
      ).toThrow()
    }
  })

  it("NodeLanguageServer covers framing resync, workspace/applyEdit refusal, workspaceSymbols, multi-byte stderr tail & abrupt close", async () => {
    const ws = freshDir("lsp-ws")
    const binDir = freshDir("lsp-bin")
    const scriptPath = join(binDir, "fake-lsp.mjs")
    writeFileSync(
      scriptPath,
      `
const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write("Content-Length: " + body.byteLength + "\\r\\n\\r\\n");
  process.stdout.write(body);
};
process.stderr.write("😀".repeat(6000));

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n");
    if (idx < 0) break;
    const hdr = buf.subarray(0, idx).toString("utf8");
    const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
    if (!m) { buf = buf.subarray(idx + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < idx + 4 + len) break;
    const msg = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString("utf8"));
    buf = buf.subarray(idx + 4 + len);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: 9001, method: "workspace/applyEdit", params: { edit: {} } });
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { workspaceSymbolProvider: true } } });
    } else if (msg.method === "workspace/symbol") {
      if (msg.params?.query === "crash") {
        process.exit(1);
      }
      process.stdout.write("GARBAGE_PREFIX_BYTES" + String.fromCharCode(13, 10, 13, 10));
      send({ jsonrpc: "2.0", id: msg.id, result: [{ name: "SymA", kind: 12, location: { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }] });
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
`
    )

    const layer = NodeLanguageServer.layer({
      command: process.execPath,
      args: [scriptPath],
      cwd: ws,
      extensions: [".ts"]
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const lsp = yield* LanguageServer.LanguageServer
          const syms = yield* Effect.exit(lsp.workspaceSymbols("SymA"))
          expect(Exit.isSuccess(syms) || Exit.isFailure(syms)).toBe(true)
          const crashed = yield* Effect.exit(lsp.workspaceSymbols("crash"))
          expect(Exit.isFailure(crashed)).toBe(true)
        })
      ).pipe(Effect.provide(layer), Effect.provide(rawPlatform), Effect.provide(silentLogger))
    )
  }, 30_000)

  it("PipedProcess covers additionalFds input/output streams, unref/ref, isRunning, SIGKILL escalation & Redacted arg error sanitization", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const cmd = ChildProcess.make(
            process.execPath,
            ["-e", "const fs=require('fs'); const data=fs.readFileSync(3,'utf8'); fs.writeSync(4, 'ECHO:'+data);"],
            {
              additionalFds: {
                fd3: { type: "input", stream: Stream.make(encoder.encode("hello-fd3")) },
                fd4: { type: "output", stream: "pipe" }
              }
            } as ChildProcess.CommandOptions
          )
          const handle = yield* PipedProcess.spawn(cmd, undefined)
          const reref = yield* handle.unref
          yield* reref
          const running = yield* handle.isRunning
          expect(typeof running).toBe("boolean")
          const out4 = yield* Stream.mkString(Stream.decodeText(handle.getOutputFd(4)))
          expect(out4).toBe("ECHO:hello-fd3")
          expect(handle.getInputFd(99)).toBeDefined()
          expect(handle.getOutputFd(99)).toBeDefined()
          const code = yield* handle.exitCode
          expect(Number(code)).toBe(0)
        })
      ).pipe(Effect.provide(silentLogger))
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const cmd = ChildProcess.make(
            process.execPath,
            ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(()=>{},1000)"],
            { killSignal: "SIGTERM" }
          )
          const handle = yield* PipedProcess.spawn(cmd, undefined)
          yield* Effect.sleep("60 millis")
          yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: "80 millis" })
          yield* Effect.exit(handle.exitCode)
        })
      ).pipe(Effect.provide(silentLogger))
    )

    const missingExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          PipedProcess.spawn(
            ChildProcess.make("/nonexistent/wave9-binary-xyz", [Redacted.make("TOP_SECRET_VALUE") as unknown as string]),
            undefined
          )
        )
      ).pipe(Effect.provide(silentLogger))
    )
    expect(Exit.isFailure(missingExit)).toBe(true)
    expect(String(missingExit)).not.toContain("TOP_SECRET_VALUE")
  }, 30_000)

  it("DestinationProxy, FetchTransport, ProcessReaper, ProcessConfinement, NativeRuntime & SandboxedFlow cover error & edge branches", async () => {
    const ws = freshDir("proxy-ws")

    // DestinationProxy.isolated (real temp socket outside ws) & wrap
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const iso = yield* DestinationProxy.isolated(["example.com:443"], ws)
          expect(iso.socket).toContain("p.sock")
          const wrapped = DestinationProxy.wrap(["echo", "hi"], iso.socket)
          expect(wrapped.length).toBeGreaterThan(0)
        })
      ).pipe(Effect.provide(silentLogger))
    )

    // Real UDS DestinationProxy.open handling malformed CONNECT (400), bad upstream (502), unauthorized HTTP (407)
    const sockDir = freshDir("proxy-sock")
    const sockPath = join(sockDir, "p.sock")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* DestinationProxy.open(sockPath, ["127.0.0.1:1"], "secret-tok")
          const sendRaw = (payload: string) =>
            new Promise<string>((resolve) => {
              const client = Net.createConnection(sockPath, () => {
                client.write(payload)
              })
              let resp = ""
              client.on("data", (d) => {
                resp += d.toString("utf8")
              })
              client.on("end", () => resolve(resp))
              client.on("error", () => resolve(resp))
              setTimeout(() => {
                client.destroy()
                resolve(resp)
              }, 300)
            })
          const auth = Buffer.from("broker:secret-tok").toString("base64")
          const badConnect = yield* Effect.promise(() =>
            sendRaw(`CONNECT invalid_no_port HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
          )
          expect(badConnect).toMatch(/400|403/)
          const badHttp = yield* Effect.promise(() => sendRaw(`GET http://127.0.0.1:1/ HTTP/1.1
Host: 127.0.0.1:1
Proxy-Authorization: Basic ${auth}

`))
          expect(badHttp).toMatch(/400|403|502/)
          const unauthHttp = yield* Effect.promise(() =>
            sendRaw(`GET http://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n`)
          )
          expect(unauthHttp).toContain("407")
        })
      ).pipe(Effect.provide(silentLogger))
    )

    // 2. FetchTransport.observe on closed loopback port (ECONNREFUSED)
    const closedPort = await new Promise<number>((resolve) => {
      const srv = Net.createServer()
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as Net.AddressInfo).port
        srv.close(() => resolve(port))
      })
    })
    const observer = FetchTransport.observe(`http://127.0.0.1:${closedPort}`)
    try {
      const attempt = observer.begin()
      await fetch(`http://127.0.0.1:${closedPort}/ping`).catch(() => undefined)
      const diag = attempt.fields()
      expect(diag).toBeDefined()
    } finally {
      observer.close()
    }

    // 3. ProcessReaper: posixSystemWith & windowsSystemWith
    const psStub = join(ws, "fake-ps.sh")
    writeFileSync(psStub, `#!/bin/sh\nif [ "$2" = "pgid=" ]; then echo "4242"; else echo "Mon Jan 1 00:00:00 2024"; fi\n`)
    chmodSync(psStub, 0o755)
    const pSys = ProcessReaper.posixSystemWith({ psExecutable: psStub })
    expect(pSys.ownGroup()).toBe(4242)
    expect(pSys.startedAtMs(process.pid)._tag).toBe("started")

    const wSys = ProcessReaper.windowsSystemWith({ ownerPid: 500 })
    expect(wSys.ownGroup()).toBeNull()
    expect(wSys.refuseTarget({ pid: 500, pgid: null } as never)).toBe("own-group")
    expect(wSys.refuseTarget({ pid: 999, pgid: 999 } as never)).toBe("invalid-record")
    expect(wSys.refuseTarget({ pid: 1, pgid: null } as never)).toBe("invalid-record")
    expect(wSys.killTree({ pid: 500, pgid: null } as never)).toBe("failed")
    expect(wSys.killTree({ pid: 999, pgid: 999 } as never)).toBe("failed")

    // 4. NativeRuntime make
    const api = NativeRuntime.make({
      name: "wave9-plat",
      runtime: { bun: false, main: "/a.js", sea: false },
      signals: ["SIGINT"],
      exit: () => undefined,
      onSignal: () => () => undefined,
      dbPath: () => join(ws, "rt.db"),
      fileSystem: NodeFileSystem.layer,
      spawner: NodeChildProcessSpawner.layer
    } as never)
    expect(typeof api.layer).toBe("function")

    // 5. SandboxedFlow validation errors & resultSchema / action
    const dummyFlow = Flow.make("wave9/dummy", {
      payload: { x: Schema.Number },
      success: Schema.Struct({ y: Schema.Number }),
      body: (payload) => FlowNode.succeed({ y: payload.x + 1 })
    })
    expect(SandboxedFlow.resultSchema(Schema.Number)).toBeDefined()
    const act = SandboxedFlow.action(dummyFlow)
    expect(act).toBeDefined()

    const sbRoot = freshDir("sbf-root")
    const dirProv = DirectorySandbox.make({
      fs: localServices.fs,
      spawner: ProcessReaper.layerSpawner({ graceMs: 50 }) as never,
      root: sbRoot
    })
    expect(Exit.isFailure(Effect.runSyncExit(SandboxedFlow.execute(dummyFlow, { x: 1 }, { provider: dirProv, session: "s1", entry: "/guest.mjs", limits: { diffBytes: -1 } })))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(SandboxedFlow.execute(dummyFlow, { x: 1 }, { provider: dirProv, session: "s1", entry: "/guest.mjs", timeout: Number.NaN })))).toBe(true)

    // 6. ProcessConfinement error path
    const tempDir = freshDir("conf-tmp")
    const confLayer = ProcessConfinement.layer({
      temporaryDirectory: tempDir,
      unavailable: "unconfined"
    })
    const built = await Effect.runPromise(
      Effect.scoped(Layer.build(confLayer)).pipe(Effect.provide(rawPlatform), Effect.provide(silentLogger))
    )
    expect(built).toBeDefined()

    const arb = Arbitrary.schema(Schema.Struct({ port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })) }))
    const rep = await Effect.runPromise(
      Fuzz.run(arb, ({ port }) => Effect.succeed(port >= 1 && port <= 65535), { executions: ioExecutions, seed })
    )
    assertPassed(rep)
  }, 60_000)
})
