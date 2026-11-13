import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as FetchExecutor from "../src/internal/rules/FetchExecutor.ts"

let origin: string
let root: string

/**
 * Replaces the output's parent directory after the request arrives and before
 * any body byte is sent, so the download finds its parent changed when it
 * first opens the temporary file.
 */
const server = createServer((request, response) => {
  const parent = Path.join(root, "out")
  void Fs.rename(parent, `${parent}-moved`)
    .then(() => Fs.mkdir(parent))
    .then(() => {
      if (request.url === "/empty") response.end()
      else response.end(Buffer.from("payload"))
    })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-fetch-parent-swap-")))
  await Fs.mkdir(Path.join(root, "out"))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("Fetch redirect location", () => {
  it("refuses a location that does not parse, naming only the redacted origin", () => {
    let refusal: unknown
    try {
      FetchExecutor.redirectTarget("https://user:token@releases.example/a?sig=secret", "http://[")
    } catch (cause) {
      refusal = cause
    }
    expect(refusal).toMatchObject({
      _tag: "smithers-build/FetchError",
      code: "insecure_redirect",
      message: "Fetch redirect from https://<redacted>@releases.example/a?<redacted> names an unparsable location",
      cause: expect.objectContaining({ code: "ERR_INVALID_URL" })
    })
  })
})

describe("Fetch output path", () => {
  it("reports an output that escapes the workspace as a write failure without contacting the server", async () => {
    let requests = 0
    const counting = createServer((_, response) => {
      requests += 1
      response.end()
    })
    await new Promise<void>((resolve) => counting.listen(0, "127.0.0.1", resolve))
    try {
      const port = (counting.address() as AddressInfo).port
      await expect(FetchExecutor.download({
        root,
        url: `http://127.0.0.1:${port}/payload`,
        sha256: "0".repeat(64),
        outFile: "../escape.bin"
      })).rejects.toMatchObject({
        _tag: "smithers-build/FetchError",
        code: "write_failed",
        message: expect.stringContaining("native output must name a file inside the workspace: ../escape.bin")
      })
      expect(requests).toBe(0)
      await expect(Fs.access(Path.join(Path.dirname(root), "escape.bin"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await new Promise<void>((resolve) => counting.close(() => resolve()))
    }
  })
})

describe("Fetch output parent replaced during the download", () => {
  it.each([
    ["a body chunk", "/payload"],
    ["an empty body", "/empty"]
  ])("refuses to write %s into a replaced parent and publishes nothing", async (_, path) => {
    const failure = FetchExecutor.download({
      root,
      url: `${origin}${path}`,
      sha256: "0".repeat(64),
      outFile: "out/file.bin"
    })
    await expect(failure).rejects.toMatchObject({
      _tag: "smithers-build/FetchError",
      code: "write_failed",
      message: expect.stringMatching(
        new RegExp(`^Fetch could not publish ${root}/out/file\\.bin: native output parent changed`)
      )
    })
    expect(await Fs.readdir(Path.join(root, "out"))).toEqual([])
    expect(await Fs.readdir(Path.join(root, "out-moved"))).toEqual([])
  })
})
