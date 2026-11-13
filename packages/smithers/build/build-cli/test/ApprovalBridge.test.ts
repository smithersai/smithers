/**
 * The approval bridge a parent CLI serves its store through: a child's
 * `granted` reaches the parent's store for the exact request, and every
 * failure (no store, wrong token, a store error, a closed bridge, a malformed
 * answer) refuses rather than approving.
 */
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as ApprovalBridge from "../src/internal/ApprovalBridge.ts"
import type * as PackageExec from "../src/PackageExec.ts"

const request: PackageExec.TargetApprovalRequest = { root: "/work", label: "//:push", digest: "a".repeat(64) }

const recording = (answer: (request: PackageExec.TargetApprovalRequest) => Promise<boolean>) => {
  const asked: Array<PackageExec.TargetApprovalRequest> = []
  const store: PackageExec.TargetApprovals = {
    granted: (request) => {
      asked.push(request)
      return answer(request)
    }
  }
  return { store, asked }
}

const address = (environment: Readonly<Record<string, string>>) => {
  const value = environment[ApprovalBridge.environmentName]!
  return { token: value.slice(0, value.indexOf("@")), path: value.slice(value.indexOf("@") + 1) }
}

/** Sends one raw line to the bridge and returns its raw answer. */
const raw = (path: string, line: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = Net.createConnection(path, () => socket.write(line))
    let text = ""
    socket.on("data", (chunk) => text += chunk.toString("utf8"))
    socket.on("end", () => resolve(text))
    socket.on("error", reject)
  })

describe("approval bridge", () => {
  it("serves no store as an empty environment, and a child without one has no store", async () => {
    const bridge = await ApprovalBridge.serve(undefined)
    expect(bridge.environment).toEqual({})
    await bridge.close()
    for (const value of [undefined, "", "@/path", "no-separator"]) expect(ApprovalBridge.client(value)).toBeUndefined()
  })

  it("answers a child's question from the parent's store, for the exact request", async () => {
    const { store, asked } = recording(async (asking) => asking.digest === request.digest)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const client = ApprovalBridge.client(environment[ApprovalBridge.environmentName])!
      expect(await client.granted(request)).toBe(true)
      expect(await client.granted({ ...request, digest: "b".repeat(64) })).toBe(false)
      // Concurrent questions each get their own answer.
      expect(await Promise.all([client.granted(request), client.granted({ ...request, label: "//:x" })]))
        .toEqual([true, true])
    })
    expect(asked[0]).toEqual(request)
    expect(asked).toHaveLength(4)
  })

  it("keeps the socket in a private directory and removes it on close", async () => {
    const bridge = await ApprovalBridge.serve(recording(async () => true).store)
    const { path } = address(bridge.environment)
    if (process.platform !== "win32") {
      expect(path.length).toBeLessThan(100)
      expect((await Fs.stat(Path.dirname(path))).mode & 0o077).toBe(0)
    }
    await bridge.close()
    await expect(ApprovalBridge.client(bridge.environment[ApprovalBridge.environmentName])!.granted(request))
      .rejects.toThrow()
    if (process.platform !== "win32") await expect(Fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a wrong token and never asks the store", async () => {
    const { store, asked } = recording(async () => true)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const { path, token } = address(environment)
      const forged = ApprovalBridge.client(`${"0".repeat(token.length)}@${path}`)!
      await expect(forged.granted(request)).rejects.toThrow("unauthorized")
      await expect(ApprovalBridge.client(`short@${path}`)!.granted(request)).rejects.toThrow("unauthorized")
    })
    expect(asked).toEqual([])
  })

  it("fails closed when the parent's store fails", async () => {
    for (
      const answer of [
        () => Promise.reject(new Error("store unreadable")),
        () => Promise.reject("not an error")
      ]
    ) {
      await ApprovalBridge.withBridge(recording(answer).store, async (environment) => {
        const client = ApprovalBridge.client(environment[ApprovalBridge.environmentName])!
        await expect(client.granted(request)).rejects.toThrow("did not answer")
      })
    }
  })

  it("refuses malformed requests and answers only a boolean", async () => {
    const { store, asked } = recording(async () => "yes" as unknown as boolean)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const { path, token } = address(environment)
      expect(JSON.parse(await raw(path, `${JSON.stringify({ token, request: { label: 1 } })}\n`)))
        .toEqual({ error: "malformed request" })
      expect(JSON.parse(await raw(path, `${JSON.stringify({ token, request: null })}\n`)))
        .toEqual({ error: "malformed request" })
      expect(JSON.parse(await raw(path, "not json\n"))).toMatchObject({ error: expect.any(String) })
      expect(JSON.parse(await raw(path, `${"x".repeat(70 * 1024)}`))).toEqual({
        error: "approval bridge line is too long"
      })
      // A store answering anything but true is not an approval.
      expect(JSON.parse(await raw(path, `${JSON.stringify({ token, request })}\n`))).toEqual({ granted: false })
    })
    expect(asked).toHaveLength(1)
  })

  it("closes while a child holds an unfinished question", async () => {
    const { store, asked } = recording(async () => true)
    const bridge = await ApprovalBridge.serve(store)
    const { path } = address(bridge.environment)
    const socket = Net.createConnection(path).resume()
    // Destroying the server with unread question bytes can reset the peer.
    // Observe that expected transport refusal rather than leaving an unhandled
    // client error; any other transport error still fails this test.
    const errors: Array<NodeJS.ErrnoException> = []
    socket.on("error", (error) => errors.push(error))
    await new Promise((resolve) => socket.once("connect", resolve))
    const dropped = new Promise((resolve) => socket.once("close", resolve))
    socket.write("{\"token\":")
    await bridge.close()
    await dropped
    expect(errors.every((error) => error.code === "ECONNRESET")).toBe(true)
    expect(asked).toEqual([])
  })

  it("rejects an answer that is not a verdict", async () => {
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-bridge-test-"))
    const path = process.platform === "win32"
      ? `\\\\.\\pipe\\smthrs-bridge-${randomUUID()}`
      : Path.join(directory, "s")
    for (const reply of ["{}\n", "null\n", ""]) {
      const server = Net.createServer((socket) => {
        socket.resume()
        socket.end(reply)
      })
      await new Promise<void>((resolve) => server.listen(path, resolve))
      try {
        await expect(ApprovalBridge.client(`token@${path}`)!.granted(request)).rejects.toThrow("did not answer")
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
    await Fs.rm(directory, { recursive: true, force: true })
  })

  it("refuses a child that ends its connection before finishing a question", async () => {
    const { store, asked } = recording(async () => true)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const { path } = address(environment)
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = Net.createConnection(path, () => socket.end("{\"token\":"))
        let text = ""
        socket.on("data", (chunk) => text += chunk.toString("utf8"))
        socket.on("end", () => resolve(text))
        socket.on("error", reject)
      })
      expect(JSON.parse(answer)).toEqual({ error: "unauthorized" })
    })
    expect(asked).toEqual([])
  })

  it("survives a child that leaves before its answer is written", async () => {
    let release: () => void = () => {}
    const answered = new Promise<void>((resolve) => release = resolve)
    const { store, asked } = recording(async () => {
      await answered
      return true
    })
    await ApprovalBridge.withBridge(store, async (environment) => {
      const { path, token } = address(environment)
      const socket = Net.createConnection(path)
      await new Promise((resolve) => socket.once("connect", resolve))
      socket.write(`${JSON.stringify({ token, request })}\n`)
      while (asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
      socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 50))
      release()
      await new Promise((resolve) => setTimeout(resolve, 50))
      // The parent is still serving.
      expect(await ApprovalBridge.client(environment[ApprovalBridge.environmentName])!.granted(request)).toBe(true)
    })
    expect(asked).toHaveLength(2)
  })

  it.skipIf(process.platform === "win32")("rejects when the parent resets the connection mid-question", async () => {
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-bridge-test-"))
    const path = Path.join(directory, "s")
    // A parent that never reads the question and drops it resets the child's read.
    const server = Net.createServer((socket) => {
      socket.pause()
      setTimeout(() => socket.destroy(), 100)
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    try {
      // A question far larger than one read leaves bytes unread when the parent drops it.
      const large = { ...request, label: "x".repeat(4 * 1024 * 1024) }
      await expect(ApprovalBridge.client(`token@${path}`)!.granted(large)).rejects.toMatchObject({
        code: "ECONNRESET"
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")(
    "places the socket under /tmp when TMPDIR is too long for a socket path",
    async () => {
      const long = await Fs.mkdtemp(Path.join(Os.tmpdir(), `smthrs-bridge-${"t".repeat(64)}-`))
      const previous = process.env["TMPDIR"]
      process.env["TMPDIR"] = long
      let bridge: ApprovalBridge.Bridge
      try {
        expect(Os.tmpdir().length).toBeGreaterThan(60)
        bridge = await ApprovalBridge.serve(recording(async () => true).store)
      } finally {
        if (previous === undefined) delete process.env["TMPDIR"]
        else process.env["TMPDIR"] = previous
      }
      const { path } = address(bridge.environment)
      expect(Path.dirname(Path.dirname(path))).toBe("/tmp")
      expect(await ApprovalBridge.client(bridge.environment[ApprovalBridge.environmentName])!.granted(request)).toBe(
        true
      )
      await bridge.close()
      await expect(Fs.stat(Path.dirname(path))).rejects.toMatchObject({ code: "ENOENT" })
      await Fs.rm(long, { recursive: true, force: true })
    }
  )
})
