import { Effect, Fiber } from "effect"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Net from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"

const payload = (source: string): Exec.Payload => ({
  argv: [process.execPath, "-e", source],
  cwd: ".",
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 30_000
})

describe.runIf(process.platform === "linux")("destination confinement", () => {
  it("admits brokered HTTP while denying direct TCP, DNS and undeclared hosts", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "exec-destination-")))
    let requests = 0
    const upstream = Http.createServer((_req, res) => {
      requests++
      res.end("allowed")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const port = (upstream.address() as Net.AddressInfo).port
    const source = `
      const http = require("node:http")
      const net = require("node:net")
      const get = host => new Promise((resolve, reject) => {
        const proxy = new URL(process.env.HTTP_PROXY)
        http.get({ hostname: proxy.hostname, port: proxy.port,
          headers: { "proxy-authorization": "Basic " + Buffer.from(
            decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") },
          path: "http://" + host + ":${port}/" }, res => {
          let body = ""; res.on("data", d => body += d)
          res.on("end", () => resolve({ code: res.statusCode, body }))
        }).on("error", reject)
      })
      ;(async () => {
        const ok = await get("127.0.0.1")
        if (ok.code !== 200 || ok.body !== "allowed") throw new Error(JSON.stringify(ok))
        if ((await get("undeclared.test")).code !== 403) throw new Error("undeclared host admitted")
        await new Promise((resolve, reject) => {
          const c = net.connect(${port}, "127.0.0.1")
          c.on("connect", () => { c.destroy(); reject(new Error("direct TCP admitted")) })
          c.on("error", resolve)
        })
        await new Promise((resolve, reject) => {
          const dns = require("node:dgram").createSocket("udp4")
          dns.send(Buffer.from([0, 1]), 53, "1.1.1.1", error => {
            dns.close()
            if (error) resolve()
            else reject(new Error("direct DNS admitted"))
          })
        })
        console.log("broker-only")
      })().catch(error => { console.error(error); process.exit(1) })
    `
    try {
      const result = await Effect.runPromise(Exec.run({
        workspaceRoot: root,
        sandbox: { policy: {}, reads: [], writes: [".flows"], destinations: ["127.0.0.1"] }
      }, payload(source)))
      expect(result.stdout).toContain("broker-only")
      expect(requests).toBe(1)
      expect(await Fs.readdir(Path.join(root, ".flows/sandbox"))).toEqual([])
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(["none", { network: true }] as const)(
    "refuses an allowlist combined with an open network (%j)",
    async (policy) => {
      const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "exec-destination-")))
      try {
        const result = await Effect.runPromise(
          Exec.run({
            workspaceRoot: root,
            sandbox: { policy, reads: [], writes: [], destinations: ["example.com"] }
          }, payload("throw new Error('must not execute')")).pipe(Effect.result)
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("sandbox_unenforceable")
          expect(result.failure.stderr).toContain("closed network")
        }
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe.runIf(process.platform === "linux")("concurrent destination isolation", () => {
  it("cannot borrow another live run's broker through a broad read grant or ambient temp directory", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "exec-peer-")))
    const shared = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "shared-runtime-")))
    const previousTmp = process.env["TMPDIR"]
    process.env["TMPDIR"] = shared
    let ready!: (path: string) => void
    const announced = new Promise<string>((resolve) => {
      ready = resolve
    })
    let stdout = ""
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const owner = yield* Exec.run(
          {
            workspaceRoot: root,
            sandbox: { policy: {}, reads: [], writes: [".flows"], destinations: ["example.com"] },
            onStdout: (chunk) => {
              stdout += Buffer.from(chunk).toString()
              const match = /SOCKET:(.+)\n/.exec(stdout)
              if (match) ready(match[1]!)
            }
          },
          payload(`
          const fs = require("node:fs")
          const argv = fs.readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").split(String.fromCharCode(0))
          console.log("SOCKET:" + argv[argv.indexOf("--") + 1])
          setInterval(() => {}, 1000)
        `)
        ).pipe(Effect.forkChild)
        const socket = yield* Effect.promise(() =>
          Promise.race([
            announced,
            Effect.runPromise(Fiber.await(owner)).then((exit) => {
              throw new Error(JSON.stringify(exit))
            })
          ])
        )
        const consumer = yield* Exec.run(
          {
            workspaceRoot: root,
            sandbox: {
              policy: {},
              reads: [],
              writes: [".flows"],
              destinations: [],
              externalReads: [shared, "/tmp/.smthrs-egress"]
            }
          },
          payload(`
          const net = require("node:net")
          const client = net.connect(${JSON.stringify(socket)})
          client.on("connect", () => { console.error("borrowed another broker"); process.exit(2) })
          client.on("error", () => { console.log("peer broker hidden") })
        `)
        )
        expect(consumer.stdout).toContain("peer broker hidden")
        for (const [index, target] of ["/tmp/.smthrs-egress", "/tmp"].entries()) {
          const alias = "broker-alias-" + index
          yield* Effect.promise(() => Fs.symlink(target, Path.join(root, alias), "dir"))
          const refused = yield* Exec.run({
            workspaceRoot: root,
            sandbox: { policy: {}, reads: [alias], writes: [".flows"], externalReads: [target], destinations: [] }
          }, payload("throw new Error('aliased broker must not execute')")).pipe(Effect.result)
          expect(refused._tag).toBe("Failure")
          if (refused._tag === "Failure") {
            expect(refused.failure.stderr).toContain("aliases the private destination broker tree")
          }
        }
        yield* Fiber.interrupt(owner)
        expect(yield* Effect.promise(() => Fs.stat(socket).catch(() => undefined))).toBeUndefined()
      })))
    } finally {
      if (previousTmp === undefined) delete process.env["TMPDIR"]
      else process.env["TMPDIR"] = previousTmp
      await Fs.rm(shared, { recursive: true, force: true })
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
