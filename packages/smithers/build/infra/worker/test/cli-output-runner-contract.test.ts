import { openCache } from "@smthrs/build-cli/Cache"
import * as PackageDiscovery from "@smthrs/build-cli/PackageDiscovery"
import * as PackageExec from "@smthrs/build-cli/PackageExec"
import { PackageIndex } from "@smthrs/build-cli/PackageIndex"
import * as PackageLoader from "@smthrs/build-cli/PackageLoader"
import type { RemoteCacheAccess } from "@smthrs/build-cli/Workspace"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import { createHandler } from "../protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"

// Windows keeps no POSIX mode bits: every writable file stats as 0o666, the one written as much as the one
// restored, so there the restored mode is that.
const hostMode = (mode: number) => process.platform === "win32" ? 0o666 : mode

const roots: Array<string> = []
const servers: Array<Http.Server> = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  )
  await Promise.all(roots.splice(0).map(root => Fs.rm(root, { recursive: true, force: true })))
})

const writeFile = async (root: string, relative: string, content: string) => {
  const target = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(target), { recursive: true })
  await Fs.writeFile(target, content)
}

const runnerFixture = async (
  source: string,
  files: Readonly<Record<string, string>> = {},
  workspaceExtra = ""
) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-runner-boundary-")))
  roots.push(root)
  await writeFile(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("host-boundary", {
  repository: "git+https://example.invalid/host-boundary.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["sh"] }),
  ${workspaceExtra}
})`
  )
  await writeFile(root, "package.json", "{\"name\":\"host-boundary\",\"private\":true}\n")
  await writeFile(root, "yarn.lock", "# yarn lockfile v1\n")
  await writeFile(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\n${source}`)
  for (const [relative, value] of Object.entries(files)) await writeFile(root, relative, value)
  execFileSync("jj", ["git", "init", "--colocate", root], { stdio: "ignore" })
  execFileSync("jj", ["describe", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  execFileSync("jj", ["new", "-m", ""], { cwd: root, stdio: "ignore" })
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:command"] }
  return { root, options, plan: await PackageExec.plan(options) }
}

const startHandlerServer = async (handler: (request: Request) => Promise<Response>) => {
  const server = Http.createServer(async (req, res) => {
    try {
      const address = server.address() as AddressInfo
      const url = `http://127.0.0.1:${address.port}${req.url ?? "/"}`
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item)
        } else if (value !== undefined) {
          headers.set(name, value)
        }
      }
      const chunks: Array<Buffer> = []
      if (req.method !== "GET" && req.method !== "HEAD") {
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        }
      }
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
      const response = await handler(
        new Request(url, {
          method: req.method ?? "GET",
          headers,
          ...(body === undefined ? {} : { body })
        })
      )
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      const responseBytes = Buffer.from(await response.arrayBuffer())
      res.end(responseBytes)
    } catch (error) {
      res.statusCode = 500
      res.end(String(error))
    }
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

it.each([1, 520])("reports a real target hit and restores %i outputs after all local cache files are removed", async count => {
  const f = await runnerFixture(`
const command = S.ToolBuild({
  tool: "sh", command: "sh",
  args: ["-c", "mkdir -p out && printf artifact > out/program && chmod 755 out/program && i=1; while [ $i -lt ${count} ]; do printf artifact-%s $i > out/file-$i; i=$((i+1)); done; printf run >> calls.log"],
  inputs: [], outputs: ["out"], deps: [], env: {}, cache: true
})
export const Package = S.Package({ targets: { command } })
`, { ".gitignore": "calls.log\n.flows\n" }, "sandboxes: S.Sandboxes({ default: S.Sandbox.None() }),")
  const first = await PackageExec.execute(f.plan, f.options)
  expect(first.ok, JSON.stringify(first.results)).toBe(true)
  expect(first.results).toMatchObject([{ label: "//:command", status: "ran" }])
  const key = f.plan.nodes.get("//:command")!.keyPreview
  const local = await openCache({ workspaceRoot: f.root })
  const result = await local.get(key)
  expect(result).not.toBeNull()
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const batches: Array<number> = []
  class SlowContentStore extends MemoryContentStore {
    override async presentDigests(digests: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
      batches.push(digests.length)
      // One 520-digest probe would exceed the metadata read budget.
      await new Promise(resolve => setTimeout(resolve, digests.length * 8))
      return super.presentDigests(digests)
    }
  }
  const actionCache = new MemoryActionCache()
  const handler = createHandler({
    actionCache,
    contentStore: new SlowContentStore(),
    readTokenHash: hash("reader-credential-for-runner-test"),
    writeTokenHash: hash("writer-credential-for-runner-test")
  })
  const endpoint = await startHandlerServer(handler)
  const readToken = () => "reader-credential-for-runner-test"
  const writeToken = () => "writer-credential-for-runner-test"
  const options = {
    workspaceRoot: f.root,
    endpoint,
    readToken,
    writeToken,
    warn: (line: string) => { throw new Error(line) }
  }
  // The unconfined fixture produces a local result. The real client seeds
  // the trusted service explicitly; the runner's publication guard is unchanged.
  const publisher = await openCache(options)
  await publisher.put(key, result!)
  expect(actionCache.entries.has(key)).toBe(true)
  expect(batches).toEqual(count === 520 ? [128, 128, 128, 128, 8] : [1])
  await Fs.rm(Path.join(f.root, ".flows"), { recursive: true, force: true })
  await Fs.rm(Path.join(f.root, "out"), { recursive: true })
  const remoteCache: RemoteCacheAccess = {
    endpoint,
    credentials: {
      _tag: "split",
      readTokenEnv: "SMITHERS_CACHE_READ_TOKEN",
      writeTokenEnv: "SMITHERS_CACHE_WRITE_TOKEN"
    },
    readToken,
    writeToken,
    publishNamespace: undefined
  }
  const second = await PackageExec.execute(f.plan, { ...f.options, remoteCache })
  expect(second.ok, JSON.stringify(second.results)).toBe(true)
  expect(second.results).toMatchObject([{ label: "//:command", status: "hit" }])
  expect(await Fs.readFile(Path.join(f.root, "out/program"), "utf8")).toBe("artifact")
  expect((await Fs.stat(Path.join(f.root, "out/program"))).mode & 0o777).toBe(hostMode(0o755))
  expect(await Fs.readFile(Path.join(f.root, "calls.log"), "utf8")).toBe("run")
  expect(await Fs.readdir(Path.join(f.root, "out"))).toHaveLength(count)
  for (let i = 1; i < count; i++) {
    expect(await Fs.readFile(Path.join(f.root, "out/file-" + i), "utf8")).toBe("artifact-" + i)
  }
})
