import { it as effectIt } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Net from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DestinationProxy from "../src/DestinationProxy.ts"
import { createBrokerDirectory } from "../src/internal/DestinationBrokerRoot.ts"

const testToken = "fixture-broker-token"
const authorization = "Basic " + Buffer.from("broker:" + testToken).toString("base64")
const roots: Array<string> = []
afterAll(async () => {
  for (const root of roots) await Fs.rm(root, { recursive: true, force: true })
})
const socketPath = async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "destination-"))
  roots.push(root)
  return Path.join(root, "p.sock")
}
const request = (socketPath: string, path: string, headers = {}, authentication: string | null = authorization) =>
  new Promise<{ code: number; body: string }>((resolve, reject) => {
    Http.get({
      socketPath,
      path,
      headers: { ...(authentication === null ? {} : { "proxy-authorization": authentication }), ...headers }
    }, (response) => {
      let body = ""
      response.on("data", (data) => {
        body += data
      })
      response.on("end", () => resolve({ code: response.statusCode!, body }))
    }).on("error", reject)
  })
const tunnel = (socket: string, authority: string, body = "", authentication: string | null = authorization) =>
  new Promise<string>((resolve, reject) => {
    const client = Net.connect(socket)
    let output = ""
    client.on("error", reject)
    client.on("close", () => resolve(output))
    client.on("data", (data) => {
      output += data
      if (output.includes("\r\n\r\n")) {
        if (output.startsWith("HTTP/1.1 200") && !output.includes("echo:")) {
          client.write(body)
        } else {
          client.destroy()
          resolve(output)
        }
      }
    })
    client.on(
      "connect",
      () =>
        client.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ignored.test\r\n${
            authentication === null ? "" : "Proxy-Authorization: " + authentication + "\r\n"
          }\r\n`
        )
    )
  })

describe.runIf(process.platform !== "win32")("destination broker", () => {
  it("forwards HTTP to an exact declared host and replaces the Host header", async () => {
    const socket = await socketPath()
    const origins: Array<string | undefined> = []
    const proxyHeaders: Array<string | undefined> = []
    const upstream = Http.createServer((req, res) => {
      origins.push(req.headers.host)
      proxyHeaders.push(req.headers["proxy-authorization"])
      res.end("real upstream")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const port = (upstream.address() as Net.AddressInfo).port
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        yield* DestinationProxy.open(socket, ["127.0.0.1"], testToken)
        const result = yield* Effect.promise(() =>
          request(socket, `http://127.0.0.1:${port}/module`, { host: "evil.test" })
        )
        expect(result).toEqual({ code: 200, body: "real upstream" })
        expect(origins).toEqual([`127.0.0.1:${port}`])
        expect(proxyHeaders).toEqual([undefined])
        for (
          const url of [
            `http://localhost:${port}/`,
            "http://undeclared.test/",
            "http://127.0.0.1.evil.test/",
            "http://user:secret@127.0.0.1/",
            "http://:password@127.0.0.1/",
            "https://127.0.0.1/",
            "file:///etc/passwd"
          ]
        ) {
          const denied = yield* Effect.promise(() => request(socket, url))
          expect(denied.code, url).toBe(403)
        }
        expect((yield* Effect.promise(() => request(socket, "/relative"))).code).toBe(400)
        expect(origins).toHaveLength(1)
      })))
      expect(await Fs.stat(socket).catch(() => undefined)).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("brokers CONNECT and rejects aliases, credentials and malformed authorities before connecting", async () => {
    const socket = await socketPath()
    let connections = 0
    const upstream = Net.createServer((client) => {
      connections++
      client.once("data", (data) => client.end("echo:" + data))
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const port = (upstream.address() as Net.AddressInfo).port
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        yield* DestinationProxy.open(socket, ["127.0.0.1"], testToken)
        expect(yield* Effect.promise(() => tunnel(socket, `127.0.0.1:${port}`, "hello")))
          .toContain("echo:hello")
        for (
          const authority of [
            "undeclared.test:443",
            "127.0.0.1.evil.test:443",
            "user@127.0.0.1:443",
            "127.0.0.1:443/path",
            "127.0.0.1:443?x",
            "127.0.0.1:443#x"
          ]
        ) {
          expect(yield* Effect.promise(() => tunnel(socket, authority)), authority)
            .toMatch(/^HTTP\/1\.1 40[03] /)
        }
        expect(yield* Effect.promise(() => tunnel(socket, "[bad"))).toContain("400 Bad Request")
        // Bytes that arrive in the same packet as the CONNECT head reach the upstream first.
        const early = yield* Effect.promise(() =>
          new Promise<string>((resolve, reject) => {
            const client = Net.connect(socket)
            let output = ""
            client.on("error", reject)
            client.on("data", (data) => {
              output += data
            })
            client.on("close", () => resolve(output))
            client.on("connect", () =>
              client.write(
                `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nProxy-Authorization: ${authorization}\r\n\r\nearly`
              ))
          })
        )
        expect(early).toContain("echo:early")
        expect(connections).toBe(2)
      })))
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("closes live tunnels when the scope ends and reports a bind failure", async () => {
    const socket = await socketPath()
    const upstream = Net.createServer()
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const port = (upstream.address() as Net.AddressInfo).port
    const peerClosed = new Promise<void>((resolve) =>
      upstream.once("connection", (peer) => peer.on("close", () => resolve()))
    )
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* DestinationProxy.open(socket, ["127.0.0.1"], testToken)
      const client = Net.connect(socket)
      yield* Effect.promise(() =>
        new Promise<void>((resolve) => {
          client.on("data", () => resolve())
          client.on("connect", () =>
            client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nProxy-Authorization: ${authorization}\r\n\r\n`))
        })
      )
      const failure = yield* DestinationProxy.open(socket, [], testToken).pipe(Effect.result)
      expect(failure._tag).toBe("Failure")
    })))
    await peerClosed
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })
})

describe.runIf(process.platform !== "win32")("broker failure boundaries", () => {
  effectIt.effect.prop(
    "denies generated authority mutations without making an upstream connection",
    [Schema.Int],
    ([seed]) =>
      Effect.scoped(Effect.gen(function*() {
        const socket = yield* Effect.promise(socketPath)
        yield* DestinationProxy.open(socket, ["allowed.test"], testToken)
        // Attr.Destinations: "open exactly these hosts". Prefixes and suffixes
        // name different authorities, regardless of port or generated label.
        const token = "p" + Math.abs(seed).toString(36)
        for (const host of [token + ".allowed.test", "allowed.test." + token]) {
          expect(
            (yield* Effect.promise(() => request(socket, "http://" + host + ":" + (1024 + Math.abs(seed) % 50000))))
              .code
          )
            .toBe(403)
          expect(yield* Effect.promise(() => tunnel(socket, host + ":443"))).toContain("403 Forbidden")
        }
      })),
    { arbitrary: { runs: 64, seed: 0x51a110 }, timeout: 30_000 }
  )

  it("terminates failed HTTP and CONNECT upstreams without opening a different destination", async () => {
    const socket = await socketPath()
    const portServer = Net.createServer()
    await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve))
    const port = (portServer.address() as Net.AddressInfo).port
    await new Promise<void>((resolve) => portServer.close(() => resolve()))
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* DestinationProxy.open(socket, ["127.0.0.1"], testToken)
      const outcome = yield* Effect.promise(() => request(socket, "http://127.0.0.1:" + port).catch(() => "refused"))
      expect(outcome).toBe("refused")
      expect(yield* Effect.promise(() => tunnel(socket, "127.0.0.1:" + port))).toBe("")
      expect(yield* Effect.promise(() => tunnel(socket, "127.0.0.1"))).toBe("")
    })))
  })

  it("runs the relay command and preserves exit status and spawn errors", async () => {
    const socket = await socketPath()
    const execute = (argv: ReadonlyArray<string>) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const [file, ...args] = DestinationProxy.wrap(argv, socket)
        ChildProcess.execFile(
          file,
          args,
          { env: { ...process.env, SMTHRS_DESTINATION_TOKEN: testToken } },
          (error, stdout) =>
            resolve({
              code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
              out: stdout
            })
        )
      })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* DestinationProxy.open(socket, [], testToken)
      expect(
        yield* Effect.promise(() =>
          execute([
            process.execPath,
            "-e",
            "if (!process.env.HTTPS_PROXY.startsWith('http://broker:')) process.exit(3); console.log('relay'); process.exit(7)"
          ])
        )
      ).toEqual({ code: 7, out: "relay\n" })
      expect((yield* Effect.promise(() => execute(["/nonexistent/destination-test"]))).code).toBe(1)
    })))
  })
})

describe.runIf(process.platform === "linux")("isolated destination brokers", () => {
  it("uses a private directory outside workspace grants and removes it at scope exit", async () => {
    const workspace = Path.dirname(await socketPath())
    let socket = ""
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const broker = yield* DestinationProxy.isolated([], workspace)
      socket = broker.socket
      expect(Path.relative(workspace, socket).startsWith(".." + Path.sep)).toBe(true)
      expect((yield* Effect.promise(() => Fs.stat(Path.dirname(socket)))).mode & 0o777).toBe(0o700)
      expect(
        (yield* Effect.promise(() =>
          request(socket, "http://undeclared.test", {
            "proxy-authorization": "Basic " + Buffer.from("broker:" + broker.token).toString("base64")
          })
        )).code
      ).toBe(403)
    })))
    expect(await Fs.stat(Path.dirname(socket)).catch(() => undefined)).toBeUndefined()
  })

  it("refuses a workspace covering the private broker location", async () => {
    const result = await Effect.runPromise(Effect.scoped(
      DestinationProxy.isolated([], Path.parse(Os.tmpdir()).root).pipe(Effect.result)
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toContain("outside the workspace")
  })
})

describe.runIf(process.platform === "linux")("broker authentication", () => {
  it("requires the owning run's token before HTTP or CONNECT can reach an upstream", async () => {
    const workspace = Path.dirname(await socketPath())
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const owner = yield* DestinationProxy.isolated(["127.0.0.1"], workspace)
      const peer = yield* DestinationProxy.isolated(["127.0.0.1"], workspace)
      expect(owner.token).not.toBe(peer.token)
      expect(Buffer.from(owner.token, "base64url")).toHaveLength(32)
      const peerAuthorization = "Basic " + Buffer.from("broker:" + peer.token).toString("base64")
      for (const invalid of [null, "", "Basic malformed", peerAuthorization]) {
        expect((yield* Effect.promise(() => request(owner.socket, "/relative", {}, invalid))).code).toBe(407)
        expect(yield* Effect.promise(() => tunnel(owner.socket, "127.0.0.1:443", "", invalid)))
          .toContain("407 Proxy Authentication Required")
      }
    })))
  })
})

describe.runIf(process.platform === "linux")("broker directory identities", () => {
  it("refuses symbolic links, permissive modes, foreign and unknown owners, noncanonical parents and non-directories", async () => {
    const fixture = Path.dirname(await socketPath())
    const privateRoot = Path.join(fixture, "private")
    await Fs.mkdir(privateRoot, { mode: 0o700 })
    const link = Path.join(fixture, "link")
    await Fs.symlink(privateRoot, link, "dir")
    const permissive = Path.join(fixture, "permissive")
    await Fs.mkdir(permissive, { mode: 0o755 })
    await Fs.chmod(permissive, 0o755)
    const aliasedParent = Path.join(fixture, "parent-link")
    await Fs.symlink(fixture, aliasedParent, "dir")
    const file = Path.join(fixture, "file")
    await Fs.writeFile(file, "not a directory")
    // Linux, where this suite runs, always has an operating-system user id.
    const uid = process.getuid!()
    for (
      const [root, owner] of [
        [link, uid],
        [permissive, uid],
        [privateRoot, uid + 1],
        [privateRoot, undefined],
        [Path.join(aliasedParent, "private"), uid],
        [file, uid]
      ] as const
    ) {
      const refused = await Effect.runPromise(createBrokerDirectory(root, owner).pipe(Effect.result))
      expect(refused._tag, root).toBe("Failure")
      if (refused._tag === "Failure") {
        expect(refused.failure._tag).toBe("DestinationBrokerError")
        expect(refused.failure.message).toContain("could not be created")
      }
    }
    expect(await Fs.readdir(privateRoot)).toEqual([])
    const made = await Effect.runPromise(createBrokerDirectory(privateRoot, uid))
    expect((await Fs.stat(made)).mode & 0o777).toBe(0o700)
  })
})
