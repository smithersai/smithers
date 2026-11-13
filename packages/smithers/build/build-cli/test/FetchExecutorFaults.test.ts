import { Effect, Layer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as FetchExecutor from "../src/internal/rules/FetchExecutor.ts"

const url = "https://releases.example/tool.tar.gz"
const payload = Buffer.from("payload")
const digest = createHash("sha256").update(payload).digest("hex")
let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-fetch-faults-")))
  await Fs.mkdir(Path.join(root, "out"))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const transportOf = (client: HttpClient.HttpClient): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(client)

/** A transport that refuses every request with a TransportError built from `props`. */
const refusing = (props: { readonly cause?: unknown }) =>
  transportOf(HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, ...props }) })
    )
  ))

/** A transport that answers every request with the payload. */
const answering = transportOf(
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(payload))))
)

const download = (options: Partial<Parameters<typeof FetchExecutor.download>[0]>) =>
  FetchExecutor.download({ root, url, sha256: digest, outFile: "out/file.bin", ...options })

describe("Fetch transport failures without a readable reason", () => {
  const proxy = new Proxy({ message: "hidden behind a proxy" }, {})
  it.each<[string, { readonly cause?: unknown }]>([
    ["no cause at all", {}],
    ["an undefined cause", { cause: undefined }],
    ["a null cause", { cause: null }],
    ["a Proxy cause", { cause: proxy }],
    ["a cause behind an accessor", {
      cause: Object.defineProperty({}, "cause", { get: () => new Error("accessor reason") })
    }],
    ["a chain deeper than the walk", { cause: { cause: { cause: { cause: new Error("too deep") } } } }]
  ])("reports the generic transport reason for %s", async (_, props) => {
    await expect(download({ transport: refusing(props) })).rejects.toMatchObject({
      _tag: "smithers-build/FetchError",
      code: "request_failed",
      message: "Fetch request failed for https://releases.example/tool.tar.gz: HTTP transport failed"
    })
    expect(await Fs.readdir(Path.join(root, "out"))).toEqual([])
  })

  it("reports the native reason a cause chain carries", async () => {
    await expect(download({ transport: refusing({ cause: new Error("connect ECONNREFUSED") }) })).rejects
      .toMatchObject({
        code: "request_failed",
        message: "Fetch request failed for https://releases.example/tool.tar.gz: connect ECONNREFUSED"
      })
  })
})

describe("Fetch deadline", () => {
  it("fails a request that never answers once the deadline passes, publishing nothing", async () => {
    await expect(download({ transport: transportOf(HttpClient.make(() => Effect.never)), deadlineMs: 20 })).rejects
      .toMatchObject({
        _tag: "smithers-build/FetchError",
        code: "request_failed",
        message: "Fetch request for https://releases.example/tool.tar.gz did not finish in time"
      })
    expect(await Fs.readdir(Path.join(root, "out"))).toEqual([])
  })
})

describe("Fetch temporary file faults", () => {
  /** Opens the real temporary file, then lets `fault` replace methods on that one handle. */
  const faultyOpen = (fault: (handle: Fs.FileHandle) => void) => {
    const opened: Array<Fs.FileHandle> = []
    return {
      opened,
      open: async (path: string) => {
        const handle = await Fs.open(path, "wx", 0o644)
        fault(handle)
        opened.push(handle)
        return handle
      }
    }
  }

  it("downloads through the real file when the seam opens it unchanged", async () => {
    await expect(download({ transport: answering })).resolves.toEqual({ bytes: payload.length, sha256: digest })
    expect(await Fs.readFile(Path.join(root, "out", "file.bin"))).toEqual(payload)
  })

  it("fails a write the temporary file accepts zero bytes of, rather than retrying forever", async () => {
    let closes = 0
    const files = faultyOpen((handle) => {
      const close = handle.close.bind(handle)
      handle.write = (async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer })) as typeof handle.write
      handle.close = async () => {
        closes += 1
        await close()
      }
    })
    await expect(download({ transport: answering, openTemporary: files.open })).rejects.toMatchObject({
      _tag: "smithers-build/FetchError",
      code: "write_failed",
      message: expect.stringMatching(/: the temporary fetch file accepted a zero-byte write$/)
    })
    expect(files.opened).toHaveLength(1)
    expect(closes).toBe(1)
    expect(await Fs.readdir(Path.join(root, "out"))).toEqual([])
  })

  it("keeps the write failure when closing the abandoned temporary file also fails", async () => {
    const files = faultyOpen((handle) => {
      const close = handle.close.bind(handle)
      handle.write = (async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer })) as typeof handle.write
      handle.close = async () => {
        await close()
        throw new Error("close failed")
      }
    })
    await expect(download({ transport: answering, openTemporary: files.open })).rejects.toMatchObject({
      code: "write_failed",
      message: expect.stringMatching(/: the temporary fetch file accepted a zero-byte write$/)
    })
    expect(await Fs.readdir(Path.join(root, "out"))).toEqual([])
  })
})
