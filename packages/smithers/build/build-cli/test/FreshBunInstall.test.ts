import * as ChildProcess from "node:child_process"
import * as Crypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const execFile = promisify(ChildProcess.execFile)

interface Published {
  readonly manifest: Record<string, unknown>
  readonly file: string
  readonly bytes: Uint8Array
}

/**
 * An npm registry on loopback, holding the packages a suite publishes to it.
 *
 * It is a real registry as far as Bun can tell: Bun resolves manifests from
 * it, downloads the tarballs `bun pm pack` built, and checks their integrity.
 * Every request is recorded, which is how a suite proves a run fetched
 * nothing, and `broken` makes it refuse tarballs, which is a failed fetch.
 */
const registry = {
  packages: new Map<string, Map<string, Published>>(),
  requests: [] as Array<string>,
  broken: false,
  url: "",
  server: undefined as Http.Server | undefined
}

const scratch: Array<string> = []
const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), prefix)))
  scratch.push(directory)
  return directory
}

/** The environment a fixture's own `bun` commands run in: nothing of the operator's Bun setup. */
const bunEnvironment = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  BUN_INSTALL_CACHE_DIR: Path.join(home, "cache")
})

/** Packs a package with Bun and publishes the tarball to the loopback registry. */
const publish = async (manifest: Record<string, unknown>): Promise<void> => {
  const directory = await temporary("smthrs-bun-package-")
  await write(directory, "package.json", `${JSON.stringify(manifest)}\n`)
  await write(directory, "index.js", `module.exports = ${JSON.stringify(`${manifest.name}@${manifest.version}`)}\n`)
  // What a lifecycle script would leave behind if the install ran one.
  await write(
    directory,
    "postinstall.js",
    `require("node:fs").writeFileSync(require("node:path").join(__dirname, "SCRIPT_RAN"), "yes")\n`
  )
  await execFile("bun", ["pm", "pack", "--destination", directory, "--quiet"], {
    cwd: directory,
    env: bunEnvironment(directory)
  })
  const file = (await Fs.readdir(directory)).find((name) => name.endsWith(".tgz"))!
  const versions = registry.packages.get(String(manifest.name)) ?? new Map<string, Published>()
  versions.set(String(manifest.version), { manifest, file, bytes: await Fs.readFile(Path.join(directory, file)) })
  registry.packages.set(String(manifest.name), versions)
}

let bunVersion = ""

beforeAll(async () => {
  bunVersion = (await execFile("bun", ["--version"])).stdout.trim()
  await publish({ name: "alpha", version: "1.0.0" })
  await publish({ name: "alpha", version: "1.1.0" })
  await publish({ name: "beta", version: "1.0.0", dependencies: { alpha: "1.0.0" } })
  await publish({ name: "scripty", version: "1.0.0", scripts: { postinstall: "node postinstall.js" } })
  const server = Http.createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]!)
    registry.requests.push(`${request.method} ${path}`)
    const tarball = /^\/([^/]+)\/-\/(.+\.tgz)$/.exec(path)
    if (tarball !== null) {
      const found = [...(registry.packages.get(tarball[1]!)?.values() ?? [])].find(({ file }) => file === tarball[2])
      if (found === undefined || registry.broken) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(found.bytes)
      return
    }
    const versions = registry.packages.get(path.slice(1))
    if (versions === undefined) {
      response.writeHead(404, { "content-type": "application/json" }).end("{}")
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: path.slice(1),
      "dist-tags": { latest: [...versions.keys()].at(-1) },
      versions: Object.fromEntries([...versions].map(([version, { bytes, file, manifest }]) => [version, {
        ...manifest,
        dist: {
          tarball: `${registry.url}${path.slice(1)}/-/${file}`,
          integrity: `sha512-${Crypto.createHash("sha512").update(bytes).digest("base64")}`,
          shasum: Crypto.createHash("sha1").update(bytes).digest("hex")
        }
      }]))
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  registry.server = server
  registry.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}, 120_000)

afterEach(() => {
  registry.broken = false
})

afterAll(async () => {
  await new Promise((resolve) => registry.server?.close(resolve))
  await Promise.all(scratch.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

/** Resolves the fixture's dependencies into `bun.lock` with Bun itself, installing nothing. */
const lock = async (root: string): Promise<void> => {
  const home = await temporary("smthrs-bun-home-")
  await execFile("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root, env: bunEnvironment(home) })
}

/**
 * A Bun workspace with a member, a transitive dependency, a trusted
 * dependency that has a lifecycle script, and a `bunfig.toml` that names the
 * loopback registry and a cache directory of its own.
 */
const workspace = async (
  options: { readonly declaredBun?: string; readonly alpha?: string } = {}
): Promise<string> => {
  const root = await temporary("smthrs-bun-install-")
  const manifest = (alpha: string) =>
    `${
      JSON.stringify(
        {
          name: "bun-fixture",
          private: true,
          packageManager: `bun@${bunVersion}`,
          workspaces: ["packages/*"],
          dependencies: { beta: "1.0.0", scripty: "1.0.0" },
          devDependencies: { alpha },
          trustedDependencies: ["scripty"],
          scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('ROOT_SCRIPT_RAN', 'yes')\"" }
        },
        undefined,
        2
      )
    }\n`
  await write(root, "package.json", manifest(options.alpha ?? "1.0.0"))
  await write(
    root,
    "packages/a/package.json",
    `${JSON.stringify({ name: "a", version: "1.0.0", dependencies: { alpha: "1.0.0" } })}\n`
  )
  await write(
    root,
    "bunfig.toml",
    `[install]\nregistry = "${registry.url}"\n\n[install.cache]\ndir = "${Path.join(root, "bunfig-cache")}"\n`
  )
  await lock(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
const runtime = S.Runtime.Bun({ version: ${JSON.stringify(options.declaredBun ?? bunVersion)} })
export const Workspace = S.Workspace("bun-fixture", {
  repository: "git+https://example.invalid/bun-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.BunPackages({ runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { install: S.Install({ lockfilePath: "bun.lock" }) } })
`
  )
  registry.requests.length = 0
  return root
}

const exists = (path: string): Promise<boolean> => Fs.access(path).then(() => true, () => false)
const installed = async (root: string, name: string): Promise<string> =>
  (JSON.parse(await Fs.readFile(Path.join(root, "node_modules", name, "package.json"), "utf8")) as { version: string })
    .version
const tarballs = (): ReadonlyArray<string> => registry.requests.filter((request) => request.endsWith(".tgz"))

describe("fresh Bun installations", () => {
  it("installs a Bun workspace from the registry, and a second run fetches nothing", async () => {
    const root = await workspace()
    const first = await serve(root, ["install"])
    expect(first.exitCode, `${first.output}${first.logs}`).toBe(0)
    expect(first.output).toContain("ok: true")
    expect(await installed(root, "alpha")).toBe("1.0.0")
    expect(await installed(root, "beta")).toBe("1.0.0")
    expect(await exists(Path.join(root, "packages/a/node_modules/alpha/package.json"))).toBe(true)
    expect([...tarballs()].sort()).toEqual([
      "GET /alpha/-/alpha-1.0.0.tgz",
      "GET /beta/-/beta-1.0.0.tgz",
      "GET /scripty/-/scripty-1.0.0.tgz"
    ])

    // The store holds the cache, the staging copy, and the pinned home; the
    // cache directory bunfig.toml names is never used.
    expect((await Fs.readdir(Path.join(root, ".flows/store/bun"))).sort()).toEqual(["cache", "fetch", "home"])
    expect(await exists(Path.join(root, "bunfig-cache"))).toBe(false)
    expect(await exists(Path.join(root, ".flows/store/bun/fetch/packages/a/package.json"))).toBe(true)
    // No lifecycle script ran: not the root's, and not the trusted dependency's.
    expect(await exists(Path.join(root, "ROOT_SCRIPT_RAN"))).toBe(false)
    expect(await exists(Path.join(root, "node_modules/scripty/postinstall.js"))).toBe(true)
    expect(await exists(Path.join(root, "node_modules/scripty/SCRIPT_RAN"))).toBe(false)

    // An unchanged fetch does nothing: no request, and the staged tree is
    // the one the first run left, not one deleted and installed again.
    const stagedTree = Path.join(root, ".flows/store/bun/fetch/node_modules")
    const staged = (await Fs.stat(stagedTree)).ino
    registry.requests.length = 0
    const second = await serve(root, ["install"])
    expect(second.exitCode, `${second.output}${second.logs}`).toBe(0)
    expect(registry.requests).toEqual([])
    expect((await Fs.stat(stagedTree)).ino).toBe(staged)

    // The link is offline: with the tree gone and the registry refusing
    // tarballs, the store alone rebuilds it.
    await Fs.rm(Path.join(root, "node_modules"), { recursive: true })
    registry.broken = true
    const relinked = await serve(root, ["install"])
    expect(relinked.exitCode, `${relinked.output}${relinked.logs}`).toBe(0)
    expect(await installed(root, "beta")).toBe("1.0.0")
    expect(tarballs()).toEqual([])
  }, 120_000)

  it("fetches and links what a changed lockfile names", async () => {
    const root = await workspace()
    expect((await serve(root, ["install"])).exitCode).toBe(0)
    expect(await installed(root, "alpha")).toBe("1.0.0")

    const manifest = await Fs.readFile(Path.join(root, "package.json"), "utf8")
    await write(root, "package.json", manifest.replace(`"alpha": "1.0.0"`, `"alpha": "1.1.0"`))
    // The manifest moved and the lockfile did not: the frozen install refuses,
    // and the linked tree stays what the lockfile names. Bun downloads what
    // the new manifest asks for before it refuses, so the tarball is fetched here.
    registry.requests.length = 0
    const stale = await serve(root, ["install"])
    expect(stale.exitCode).toBe(1)
    expect(`${stale.output}${stale.logs}`).toContain("bun install exited with status 1")
    expect(await installed(root, "alpha")).toBe("1.0.0")

    await lock(root)
    const changed = await serve(root, ["install"])
    expect(changed.exitCode, `${changed.output}${changed.logs}`).toBe(0)
    expect(await installed(root, "alpha")).toBe("1.1.0")
    expect(tarballs()).toEqual(["GET /alpha/-/alpha-1.1.0.tgz"])
  }, 120_000)

  it("fails closed when the root manifest names the staging copy as a workspace", async () => {
    const root = await workspace()
    // Bun installs from a parent whose manifest names its working directory,
    // which would move the fetch out of the staging copy and into the project.
    // The lockfile cannot name a workspace inside `.flows`, so the frozen
    // install stops before it writes a tree anywhere.
    const manifest = await Fs.readFile(Path.join(root, "package.json"), "utf8")
    await write(root, "package.json", manifest.replace(`"packages/*"`, `"packages/*",\n    ".flows/store/bun/*"`))
    registry.requests.length = 0
    const { exitCode, logs, output } = await serve(root, ["install"])
    expect(exitCode).toBe(1)
    expect(`${output}${logs}`).toContain("bun install exited with status 1")
    expect(await exists(Path.join(root, "node_modules"))).toBe(false)
    expect(await exists(Path.join(root, ".flows/store/bun/fetch/node_modules"))).toBe(false)
  }, 120_000)

  it("fails the link when the cache lost a package, and recovers once the store is deleted", async () => {
    const root = await workspace()
    expect((await serve(root, ["install"])).exitCode).toBe(0)
    const cache = Path.join(root, ".flows/store/bun/cache")
    const lost = (await Fs.readdir(cache)).filter((entry) => entry.startsWith("beta@1.0.0"))
    expect(lost.length).toBeGreaterThan(0)
    await Promise.all(lost.map((entry) => Fs.rm(Path.join(cache, entry), { recursive: true })))
    await Fs.rm(Path.join(root, "node_modules"), { recursive: true })
    registry.requests.length = 0
    // The fetch completed for these inputs, so it does not run again; the
    // offline link is what notices, and it does not reach the registry.
    const damaged = await serve(root, ["install"])
    expect(damaged.exitCode).toBe(1)
    expect(`${damaged.output}${damaged.logs}`).toContain("bun install --offline exited with status 1")
    expect(tarballs()).toEqual([])

    await Fs.rm(Path.join(root, ".flows/store/bun"), { recursive: true })
    const recovered = await serve(root, ["install"])
    expect(recovered.exitCode, `${recovered.output}${recovered.logs}`).toBe(0)
    expect(await installed(root, "beta")).toBe("1.0.0")
  }, 120_000)

  it("refuses a workspace with no lockfile before Bun starts", async () => {
    const root = await workspace()
    await Fs.rm(Path.join(root, "bun.lock"))
    registry.requests.length = 0
    const { exitCode, logs, output } = await serve(root, ["install"])
    expect(exitCode).toBe(1)
    expect(`${output}${logs}`).toContain("a Bun install needs a committed bun.lock")
    expect(registry.requests).toEqual([])
    expect(await exists(Path.join(root, ".flows/store"))).toBe(false)
    expect(await exists(Path.join(root, "node_modules"))).toBe(false)
  }, 120_000)

  it("refuses a host whose Bun is not the declared version before anything is written", async () => {
    const root = await workspace({ declaredBun: "9.9.9" })
    const { exitCode, logs, output } = await serve(root, ["install"])
    expect(exitCode).toBe(1)
    expect(`${output}${logs}`).toContain(`this host runs bun ${bunVersion}, and the workspace declares 9.9.9`)
    expect(registry.requests).toEqual([])
    expect(await exists(Path.join(root, ".flows/store"))).toBe(false)
    expect(await exists(Path.join(root, "node_modules"))).toBe(false)
  }, 120_000)

  it("reports a failed fetch, links nothing, and recovers when the registry does", async () => {
    const root = await workspace()
    registry.broken = true
    const failed = await serve(root, ["install"])
    expect(failed.exitCode).toBe(1)
    expect(`${failed.output}${failed.logs}`).toContain("bun install exited with status 1")
    expect(tarballs().length).toBeGreaterThan(0)
    // The fetch failed in its staging copy; the project was never linked.
    expect(await exists(Path.join(root, "node_modules"))).toBe(false)

    registry.broken = false
    const recovered = await serve(root, ["install"])
    expect(recovered.exitCode, `${recovered.output}${recovered.logs}`).toBe(0)
    expect(await installed(root, "beta")).toBe("1.0.0")
  }, 120_000)
})
