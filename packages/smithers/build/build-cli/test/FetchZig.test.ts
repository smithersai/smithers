/**
 * Where zig 0.17.1 is not installed, the build of `smthrs-observe` fetches
 * zig's own archive and runs nothing in it before its sha256 matches the sum
 * zig publishes.
 *
 * Each case serves a real archive from a real HTTP server on this machine,
 * made with the system `tar`: a directory named as zig's own, holding a `zig`
 * that answers `version` as the pinned release does. The fetch runs as a build
 * runs it, in its own Node process.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findZig, zigCache } from "../scripts/build-observe.mjs"

const name = "zig-x86_64-linux-0.17.1"
const scratch: Array<string> = []
const servers: Array<ChildProcess> = []

afterEach(() => {
  for (const child of servers.splice(0)) child.kill()
  for (const directory of scratch.splice(0)) NodeFs.rmSync(directory, { recursive: true, force: true })
})

const temporary = (): string => {
  const directory = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "fetch-zig-"))
  scratch.push(directory)
  return directory
}

/** A `.tar.xz` laid out as zig's: one directory named as the archive, its `zig` answering `version` with `answer`. */
const archive = (answer: string): Buffer => {
  const root = temporary()
  NodeFs.mkdirSync(Path.join(root, name))
  NodeFs.writeFileSync(Path.join(root, name, "zig"), `#!/bin/sh\necho ${answer}\n`, { mode: 0o755 })
  const made = spawnSync("tar", ["-cJf", Path.join(root, "zig.tar.xz"), "-C", root, name])
  expect(made.status).toBe(0)
  return NodeFs.readFileSync(Path.join(root, "zig.tar.xz"))
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

// The server runs in a process of its own: `findZig` waits for the fetch as a build does, and blocks this one.
const server = `
const fs = require("node:fs")
const [file, status, log] = process.argv.slice(1)
const bytes = fs.readFileSync(file)
require("node:http").createServer((request, response) => {
  fs.appendFileSync(log, request.url + "\\n")
  if (request.url !== "/0.17.1/${name}.tar.xz" || status !== "200") {
    response.writeHead(status === "200" ? 404 : Number(status)).end()
    return
  }
  response.writeHead(200, { "content-length": bytes.length }).end(bytes)
}).listen(0, "127.0.0.1", function() { console.log(this.address().port) })
`

/** Serves `bytes` at zig's path for the archive, or `status`; counts the requests. */
const serve = async (
  bytes: Buffer,
  status = 200
): Promise<{ readonly url: string; readonly requests: () => number }> => {
  const directory = temporary()
  const file = Path.join(directory, "archive")
  const log = Path.join(directory, "requests")
  NodeFs.writeFileSync(file, bytes)
  NodeFs.writeFileSync(log, "")
  const child = spawn(process.execPath, ["-e", server, file, String(status), log], {
    stdio: ["ignore", "pipe", "inherit"]
  })
  servers.push(child)
  const port = await new Promise<string>((resolve) =>
    child.stdout.once("data", (chunk) => resolve(String(chunk).trim()))
  )
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => NodeFs.readFileSync(log, "utf8").split("\n").filter((line) => line !== "").length
  }
}

const missing = (): string => Path.join(temporary(), "no-zig")

describe("findZig", () => {
  it("fetches zig's archive once where zig 0.17.1 is not installed, and builds with it", async () => {
    const bytes = archive("0.17.1")
    const server = await serve(bytes)
    const cache = temporary()
    const options = {
      named: undefined,
      onPath: missing(),
      host: "linux-x64",
      cache,
      downloads: server.url,
      archives: { "linux-x64": [name, sha256(bytes)] as const }
    }
    expect(findZig(options)).toEqual({ zig: Path.join(cache, name, "zig") })
    expect(server.requests()).toBe(1)
    // The next build finds it in the cache and fetches nothing.
    expect(findZig(options)).toEqual({ zig: Path.join(cache, name, "zig") })
    expect(server.requests()).toBe(1)
    expect(NodeFs.readdirSync(cache)).toEqual([name])
  })

  it("runs nothing from an archive whose sum is not zig's, and keeps nothing of it", async () => {
    const bytes = archive("0.17.1")
    const server = await serve(bytes)
    const cache = temporary()
    const published = "0".repeat(64)
    const found = findZig({
      named: undefined,
      onPath: missing(),
      host: "linux-x64",
      cache,
      downloads: server.url,
      archives: { "linux-x64": [name, published] as const }
    })
    expect(found).toEqual({
      problem: `zig 0.17.1 is not installed, and fetching it failed: ${server.url}/0.17.1/${name}.tar.xz has sha256 ${
        sha256(bytes)
      }, not the ${published} zig publishes for it`
    })
    expect(NodeFs.readdirSync(cache)).toEqual([])
  })

  it("says what the server answered when the archive cannot be fetched", async () => {
    const server = await serve(Buffer.alloc(0), 503)
    const found = findZig({
      named: undefined,
      onPath: missing(),
      host: "linux-x64",
      cache: temporary(),
      downloads: server.url,
      archives: { "linux-x64": [name, "0".repeat(64)] as const }
    })
    expect(found).toEqual({
      problem: `zig 0.17.1 is not installed, and fetching it failed: ${server.url}/0.17.1/${name}.tar.xz answered 503`
    })
  })

  it("says so when nothing listens where the archive is fetched from", () => {
    const found = findZig({
      named: undefined,
      onPath: missing(),
      host: "linux-x64",
      cache: temporary(),
      downloads: "http://127.0.0.1:9",
      archives: { "linux-x64": [name, "0".repeat(64)] as const }
    })
    expect(found.problem).toMatch(
      /^zig 0\.17\.1 is not installed, and fetching it failed: http:\/\/127\.0\.0\.1:9\/0\.17\.1\/zig-x86_64-linux-0\.17\.1\.tar\.xz: .+/
    )
  })

  it("refuses an archive that unpacks to another zig", async () => {
    const bytes = archive("0.16.0")
    const server = await serve(bytes)
    const cache = temporary()
    const found = findZig({
      named: undefined,
      onPath: missing(),
      host: "linux-x64",
      cache,
      downloads: server.url,
      archives: { "linux-x64": [name, sha256(bytes)] as const }
    })
    expect(found).toEqual({
      problem: `${Path.join(cache, name, "zig")} is zig 0.16.0, and smthrs-observe is built with zig 0.17.1`
    })
  })

  it("names the machines it fetches zig for, elsewhere", async () => {
    const server = await serve(Buffer.alloc(0))
    expect(
      findZig({ named: undefined, onPath: missing(), host: "freebsd-x64", cache: temporary(), downloads: server.url })
    )
      .toEqual({
        problem: "zig 0.17.1 is not installed, and a build fetches it only on x86_64 or aarch64 Linux or macOS"
      })
    expect(server.requests()).toBe(0)
  })

  it("uses the zig on PATH when it is the pinned release, and only the named zig when one is named", async () => {
    const server = await serve(Buffer.alloc(0))
    const directory = temporary()
    const pinned = Path.join(directory, "zig")
    NodeFs.writeFileSync(pinned, "#!/bin/sh\necho 0.17.1\n", { mode: 0o755 })
    const common = { host: "linux-x64", cache: temporary(), downloads: server.url }
    expect(findZig({ ...common, named: undefined, onPath: pinned })).toEqual({ zig: pinned })
    expect(findZig({ ...common, named: pinned, onPath: missing() })).toEqual({ zig: pinned })
    const named = missing()
    expect(findZig({ ...common, named, onPath: pinned })).toEqual({ problem: `zig 0.17.1 is not installed (${named})` })
    expect(server.requests()).toBe(0)
  })
})

describe("zigCache", () => {
  it("is SMITHERS_ZIG_CACHE, else smithers/zig in the user's cache directory", () => {
    expect(zigCache({ SMITHERS_ZIG_CACHE: "/c" })).toBe("/c")
    expect(zigCache({ XDG_CACHE_HOME: "/x" })).toBe(Path.join("/x", "smithers", "zig"))
    expect(zigCache({})).toBe(Path.join(Os.homedir(), ".cache", "smithers", "zig"))
  })
})

describe("fetch-zig.mjs", () => {
  it("says how it is called", () => {
    const script = Path.join(import.meta.dirname, "..", "scripts", "fetch-zig.mjs")
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" })
    expect(run.status).toBe(2)
    expect(run.stderr).toBe("usage: node fetch-zig.mjs <url> <sha256> <directory>\n")
  })
})
