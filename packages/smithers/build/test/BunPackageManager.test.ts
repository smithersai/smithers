import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as ExecutableFixture from "./ExecutableFixture.ts"
import { writeExecutable } from "./ExecutableFixture.ts"

const runtimeLayer = Runtime.layerNoop("bun", {
  requirement: ">=1.4.1",
  version: "1.4.2",
  platform: { os: "linux", arch: "x64", libc: null }
})

const patch = "patches/dep@1.0.0.patch"

/**
 * A store path as the manager spells it in arguments, the child's environment and messages: joined with `/` on
 * every host, as the pnpm manager's are. A real directory the test reads is still `NodePath.join`ed; on Windows the
 * two differ in their separators.
 */
const spelled = (...parts: ReadonlyArray<string>): string => parts.join("/")

/** A Bun text lockfile with one workspace member and one patch, as Bun writes it. */
const lockfile = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "fixture", },
    "packages/a": { "name": "a", },
  },
  "patchedDependencies": {
    "dep@1.0.0": "${patch}",
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "dep": ["dep@1.0.0", "", {}, "sha512-x"],
  },
}
`

interface Call {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * A project and a stand-in `bun` that reports a version and records each
 * install it is asked for. The real spawner still owns argv, cwd, and the
 * environment, which are what these suites assert.
 */
const withProject = async <A>(
  use: (project: {
    readonly root: string
    readonly executable: string
    readonly calls: () => Promise<ReadonlyArray<Call>>
    readonly write: (path: string, text: string) => Promise<void>
  }) => Promise<A>,
  version = "1.4.2"
): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bun-manager-")))
  const tools = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bun-tool-")))
  const write = async (path: string, text: string) => {
    await Fs.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
    await Fs.writeFile(NodePath.join(root, path), text, "utf8")
  }
  try {
    const executable = NodePath.join(tools, "bun.mjs")
    const record = NodePath.join(tools, "calls")
    await writeExecutable(
      executable,
      `import { appendFileSync } from "node:fs"\n` +
        `if (process.argv[2] === "--version") { process.stdout.write(${
          JSON.stringify(version)
        } + "\\n"); process.exit(0) }\n` +
        `appendFileSync(${
          JSON.stringify(record)
        }, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n")`
    )
    await write("package.json", `{ "name": "fixture", "workspaces": ["packages/*"] }\n`)
    await write("bun.lock", lockfile)
    await write("packages/a/package.json", `{ "name": "a" }\n`)
    await write(patch, "--- a/index.js\n+++ b/index.js\n")
    return await use({
      root,
      executable,
      write,
      calls: async () =>
        (await Fs.readFile(record, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Call)
    })
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
    await Fs.rm(tools, { recursive: true, force: true })
  }
}

const makeBun = (
  projectRoot: string,
  executable: string,
  options: {
    readonly requirement?: string
    readonly environment?: Readonly<Record<string, string | undefined>>
    readonly storeDirectory?: string
    readonly fileSystem?: (real: FileSystem.FileSystem) => FileSystem.FileSystem
  } = {}
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const real = yield* FileSystem.FileSystem
      return yield* PackageManager.makeBun({
        requirement: options.requirement ?? "1.4.2",
        projectRoot,
        executable,
        environment: options.environment ?? process.env,
        storeDirectory: options.storeDirectory,
        credentialHosts: ["registry.example"]
      }).pipe(Effect.provideService(FileSystem.FileSystem, options.fileSystem?.(real) ?? real))
    }).pipe(Effect.provide(ExecutableFixture.layer), Effect.provide(runtimeLayer))
  )

const refused = (operation: Effect.Effect<unknown, PackageManager.PackageManagerError>) =>
  Effect.runPromise(Effect.flip(operation))

/** Every file below a directory, as sorted relative paths. */
const filesBelow = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await Fs.readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => NodePath.relative(directory, NodePath.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()

const denied = (method: string, path: string) =>
  Effect.fail(PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path
  }))

/** A file system whose named operation is denied for the paths the predicate selects. */
const failing =
  (method: "exists" | "makeDirectory" | "stat", selects: (path: string) => boolean) =>
  (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...real,
    exists: (path) => method === "exists" && selects(path) ? denied(method, path) : real.exists(path),
    makeDirectory: (path, options) =>
      method === "makeDirectory" && selects(path) ? denied(method, path) : real.makeDirectory(path, options),
    stat: (path) => method === "stat" && selects(path) ? denied(method, path) : real.stat(path)
  })

describe("PackageManager.makeBun", () => {
  it("describes the Bun manager without touching the host", async () => {
    const manager = await makeBun("/workspace", "bun")
    expect(manager).toMatchObject({
      name: "bun",
      projectRoot: "/workspace",
      storeDirectory: ".flows/store/bun",
      lockfileName: "bun.lock",
      platformSensitive: true,
      requirement: "1.4.2"
    })
    expect(PackageManager.minimumBunVersion).toBe("1.4.1")
  })

  it("fetches with a frozen, script-free install in a staging copy inside the store", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      await write("bunfig.toml", `[install]\nlinker = "isolated"\n`)
      await write(".npmrc", "registry=https://registry.example/\n")
      // Files the lockfile does not name are not the fetch's to read.
      await write("src/index.ts", "export {}\n")
      await write(".env", "DATABASE_URL=postgres://localhost/app\n")
      await write("packages/unlisted/package.json", `{ "name": "unlisted" }\n`)
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)

      const store = NodePath.join(root, ".flows/store/bun")
      const [call] = await calls()
      expect(call?.args).toEqual([
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-progress",
        "--cache-dir",
        spelled(root, ".flows/store/bun/cache")
      ])
      expect(call?.cwd).toBe(NodePath.join(store, "fetch"))
      expect(await filesBelow(NodePath.join(store, "fetch"))).toEqual([
        ".npmrc",
        "bun.lock",
        "bunfig.toml",
        "package.json",
        "packages/a/package.json",
        patch
      ])
      for (const file of ["bun.lock", "bunfig.toml", "packages/a/package.json", patch]) {
        expect(await Fs.readFile(NodePath.join(store, "fetch", file), "utf8"), file)
          .toBe(await Fs.readFile(NodePath.join(root, file), "utf8"))
      }
      // The project's own tree is the link's to write.
      await expect(Fs.access(NodePath.join(root, "node_modules"))).rejects.toThrow()
    })
  })

  it("links offline from the same cache in the project root", async () => {
    await withProject(async ({ calls, executable, root }) => {
      const manager = await makeBun(root, executable)
      // The link installs from the store the fetch made, and from nothing else.
      const unfetched = await refused(manager.link)
      expect(unfetched.code).toBe("command_failed")
      expect(unfetched.message).toContain(`could not resolve ${root}/.flows/store/bun/cache`)
      await Effect.runPromise(manager.fetch)
      await Effect.runPromise(manager.link)
      const [, call] = await calls()
      expect(call?.args).toEqual([
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-progress",
        "--cache-dir",
        spelled(root, ".flows/store/bun/cache")
      ])
      expect(call?.cwd).toBe(root)
    })
  })

  it("pins the cache and an empty home in the child environment, and forwards nothing else", async () => {
    await withProject(async ({ calls, executable, root }) => {
      const manager = await makeBun(root, executable, {
        environment: {
          PATH: process.env.PATH,
          HOME: "/home/operator",
          BUN_INSTALL_CACHE_DIR: "/home/operator/.bun/install/cache",
          BUN_CONFIG_REGISTRY: "https://elsewhere.example/",
          GITHUB_TOKEN: "ghp_not_forwarded"
        }
      })
      await Effect.runPromise(manager.fetch)
      await Effect.runPromise(manager.link)
      const store = spelled(root, ".flows/store/bun")
      for (const { env } of await calls()) {
        expect(env).toMatchObject({
          BUN_INSTALL_CACHE_DIR: spelled(store, "cache"),
          BUN_INSTALL: spelled(store, "home/.bun"),
          HOME: spelled(store, "home"),
          USERPROFILE: spelled(store, "home"),
          XDG_CACHE_HOME: spelled(store, "home/.cache"),
          XDG_CONFIG_HOME: spelled(store, "home/.config"),
          XDG_DATA_HOME: spelled(store, "home/.local/share"),
          CI: "true"
        })
        expect(env.BUN_CONFIG_REGISTRY).toBeUndefined()
        expect(env.GITHUB_TOKEN).toBeUndefined()
      }
      expect((await Fs.stat(NodePath.join(store, "home"))).isDirectory()).toBe(true)
    })
  })

  it("empties the pinned home before a fetch and refuses to link past one that is not empty", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      const home = NodePath.join(root, ".flows/store/bun/home")
      // A checkout can carry files at the home's path. Bun would read this
      // one as user-level configuration, past every check on the project's own.
      await write(".flows/store/bun/home/.bunfig.toml", `[install]\nregistry = "https://elsewhere.example/"\n`)
      await write(".flows/store/bun/home/.config/.bunfig.toml", `[install]\ndryRun = true\n`)
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      expect(await Fs.readdir(home)).toEqual([])
      await Effect.runPromise(manager.link)
      expect(await calls()).toHaveLength(2)

      await write(".flows/store/bun/home/.npmrc", "registry=https://elsewhere.example/\n")
      const error = await refused(manager.link)
      expect(error.code).toBe("unsafe_configuration")
      expect(error.message).toContain(`${spelled(root, ".flows/store/bun/home")} is not empty`)
      expect(await calls()).toHaveLength(2)
    })
  })

  it("refuses to link from a store directory that became a link out of the store", async () => {
    await withProject(async ({ calls, executable, root }) => {
      const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bun-outside-")))
      try {
        const manager = await makeBun(root, executable)
        await Effect.runPromise(manager.fetch)
        const cache = NodePath.join(root, ".flows/store/bun/cache")
        await Fs.rm(cache, { recursive: true })
        await Fs.symlink(outside, cache)
        const error = await refused(manager.link)
        expect(error.code).toBe("unsafe_configuration")
        expect(error.message).toBe(`${spelled(root, ".flows/store/bun/cache")} resolves outside the install store`)
        expect(await calls()).toHaveLength(1)
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  it("rebuilds the staging copy from nothing when it fetches", async () => {
    await withProject(async ({ executable, root, write }) => {
      const stage = NodePath.join(root, ".flows/store/bun/fetch")
      // A workspace the lockfile named last time, and the tree Bun staged. A
      // kept tree would tell Bun every package is installed, so a cache that
      // lost one would never be refilled.
      await write(".flows/store/bun/fetch/packages/removed/package.json", `{ "name": "removed" }\n`)
      await write(".flows/store/bun/fetch/stale.txt", "stale\n")
      await write(".flows/store/bun/fetch/node_modules/dep/package.json", `{ "name": "dep" }\n`)
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      expect(await filesBelow(stage)).toEqual(["bun.lock", "package.json", "packages/a/package.json", patch])
    })
  })

  it("does nothing on a fetch whose inputs the last completed fetch staged", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      await write("bunfig.toml", `[install]\nlinker = "isolated"\n`)
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      // The completion lives in the cache, so a deleted cache takes it along.
      expect(await Fs.readFile(NodePath.join(root, ".flows/store/bun/cache/.smithers-fetch"), "utf8"))
        .toBe("smithers-build/bun-fetch/v1\n1.4.2\nlinux-x64-null\n")
      const staged = ".flows/store/bun/fetch/node_modules/dep/package.json"
      await write(staged, `{ "name": "dep" }\n`)
      await Effect.runPromise(manager.fetch)
      expect(await calls()).toHaveLength(1)
      expect(await Fs.readFile(NodePath.join(root, staged), "utf8")).toBe(`{ "name": "dep" }\n`)
    })
  })

  it.each<
    [
      string,
      (
        project: { readonly root: string; readonly write: (path: string, text: string) => Promise<void> }
      ) => Promise<void>
    ]
  >([
    [
      "the lockfile changes",
      ({ write }) => write("bun.lock", lockfile.replace(`"name": "fixture"`, `"name": "renamed"`))
    ],
    // The same length, so only the bytes tell the two apart.
    ["a workspace manifest changes", ({ write }) => write("packages/a/package.json", `{ "name": "b" }\n`)],
    ["a patch file changes", ({ write }) => write(patch, "--- a/other.js\n+++ b/other.js\n")],
    ["bunfig.toml appears", ({ write }) => write("bunfig.toml", `[install]\nlinker = "hoisted"\n`)],
    ["the cache is deleted", ({ root }) => Fs.rm(NodePath.join(root, ".flows/store/bun/cache"), { recursive: true })],
    ["a staged file is gone", ({ root }) => Fs.rm(NodePath.join(root, ".flows/store/bun/fetch/package.json"))],
    ["a staged file is not a file", async ({ root }) => {
      await Fs.rm(NodePath.join(root, ".flows/store/bun/fetch/package.json"))
      await Fs.mkdir(NodePath.join(root, ".flows/store/bun/fetch/package.json"))
    }],
    [
      "another Bun completed the cache",
      ({ write }) =>
        write(".flows/store/bun/cache/.smithers-fetch", "smithers-build/bun-fetch/v1\n1.5.0\nlinux-x64-null\n")
    ]
  ])("fetches again, from an empty staging copy, when %s", async (_name, change) => {
    await withProject(async ({ calls, executable, root, write }) => {
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      await write(".flows/store/bun/fetch/node_modules/dep/package.json", `{ "name": "dep" }\n`)
      await change({ root, write })
      await Effect.runPromise(manager.fetch)
      expect(await calls()).toHaveLength(2)
      await expect(Fs.access(NodePath.join(root, ".flows/store/bun/fetch/node_modules"))).rejects.toThrow()
    })
  })

  it("fetches again when a configuration file the staged install ran under is removed", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      await write("bunfig.toml", `[install]\nlinker = "isolated"\n`)
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      await Fs.rm(NodePath.join(root, "bunfig.toml"))
      await Effect.runPromise(await makeBun(root, executable).then((service) => service.fetch))
      expect(await calls()).toHaveLength(2)
      await expect(Fs.access(NodePath.join(root, ".flows/store/bun/fetch/bunfig.toml"))).rejects.toThrow()
    })
  })

  it("refuses an input before it deletes anything in the store", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      const staged = await filesBelow(NodePath.join(root, ".flows/store/bun"))
      // A root manifest that is a link is refused like every staged file.
      await write(".env", "TOKEN=secret-value\n")
      await Fs.rm(NodePath.join(root, "package.json"))
      await Fs.symlink(NodePath.join(root, ".env"), NodePath.join(root, "package.json"))
      const error = await refused(manager.fetch)
      expect(error.code).toBe("manifest_unreadable")
      expect(error.message).toContain("not a symbolic link")
      expect(await filesBelow(NodePath.join(root, ".flows/store/bun"))).toEqual(staged)
      expect(await calls()).toHaveLength(1)
    })
  })

  it.each(["a directory outside the store", "nothing"])(
    "replaces a staged node_modules that is a link to %s",
    async (target) => {
      await withProject(async ({ executable, root }) => {
        const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bun-outside-")))
        try {
          await Fs.writeFile(NodePath.join(outside, "kept"), "kept\n")
          const stage = NodePath.join(root, ".flows/store/bun/fetch")
          await Fs.mkdir(stage, { recursive: true })
          await Fs.symlink(
            target === "nothing" ? NodePath.join(outside, "absent") : outside,
            NodePath.join(stage, "node_modules")
          )
          const manager = await makeBun(root, executable)
          await Effect.runPromise(manager.fetch)
          await expect(Fs.lstat(NodePath.join(stage, "node_modules"))).rejects.toThrow()
          expect(await Fs.readFile(NodePath.join(outside, "kept"), "utf8")).toBe("kept\n")
        } finally {
          await Fs.rm(outside, { recursive: true, force: true })
        }
      })
    }
  )

  it.each([
    ".flows",
    ".flows/store",
    ".flows/store/bun",
    ".flows/store/bun/cache",
    ".flows/store/bun/fetch",
    ".flows/store/bun/home"
  ])(
    "refuses a store whose %s is a link out of the store, and creates or deletes nothing through it",
    async (path) => {
      await withProject(async ({ calls, executable, root }) => {
        const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bun-outside-")))
        try {
          await Fs.writeFile(NodePath.join(outside, "kept"), "kept\n")
          await Fs.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
          await Fs.symlink(outside, NodePath.join(root, path))
          const manager = await makeBun(root, executable)
          const error = await refused(manager.fetch)
          expect(error.code).toBe("unsafe_configuration")
          expect(error.message).toBe(`${spelled(root, path)} resolves outside the install store`)
          expect(await Fs.readdir(outside)).toEqual(["kept"])
          expect(await calls()).toEqual([])
        } finally {
          await Fs.rm(outside, { recursive: true, force: true })
        }
      })
    }
  )

  it.each([".flows", ".flows/store", ".flows/store/bun"])(
    "refuses a package.json at %s, which Bun would install from instead of the staging copy",
    async (directory) => {
      await withProject(async ({ calls, executable, root, write }) => {
        // Bun installs from the nearest parent whose manifest names its
        // working directory as a workspace: this one would bring its own
        // lockfile and configuration, checked by nothing.
        await write(`${directory}/package.json`, `{ "workspaces": ["fetch", "bun/fetch", "store/bun/fetch"] }\n`)
        const error = await refused((await makeBun(root, executable)).fetch)
        expect(error.code).toBe("unsafe_configuration")
        expect(error.message).toBe(
          `${spelled(root, directory, "package.json")} is above the staging copy; Bun would install from it instead`
        )
        expect(await calls()).toEqual([])
      })
    }
  )

  it.each([
    ["a patch file", patch],
    ["a workspace manifest", "packages/a/package.json"],
    ["bunfig.toml", "bunfig.toml"]
  ])("refuses %s that is a link to another file of the project", async (_name, file) => {
    await withProject(async ({ calls, executable, root, write }) => {
      // The link's target is inside the project, so the bounded read alone
      // would copy it into the store and digest it.
      await write(".git/config", "[remote]\n\turl = https://user:secret-value@example.com/repo.git\n")
      await Fs.rm(NodePath.join(root, file), { force: true })
      await Fs.symlink(NodePath.join(root, ".git/config"), NodePath.join(root, file))
      const error = await refused((await makeBun(root, executable)).fetch)
      expect(error.code).toBe("manifest_unreadable")
      expect(error.message).toContain("expected a regular file at its own path, not a symbolic link")
      expect(error.message).not.toContain("secret-value")
      expect(await calls()).toEqual([])
      const staged = NodePath.join(root, ".flows/store/bun/fetch", file)
      expect(await Fs.readFile(staged, "utf8").catch(() => "")).not.toContain("secret-value")
    })
  })

  it("stages and links against a host store when one is named", async () => {
    await withProject(async ({ calls, executable, root }) => {
      const store = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bun-store-")))
      try {
        const manager = await makeBun(root, executable, { storeDirectory: store })
        expect(manager.storeDirectory).toBe(store)
        await Effect.runPromise(manager.fetch)
        await Effect.runPromise(manager.link)
        const [fetch, link] = await calls()
        expect(fetch?.cwd).toBe(NodePath.join(store, "fetch"))
        expect(fetch?.args.at(-1)).toBe(spelled(store, "cache"))
        expect(link?.cwd).toBe(root)
        expect(link?.args.at(-1)).toBe(spelled(store, "cache"))
        await expect(Fs.access(NodePath.join(root, ".flows"))).rejects.toThrow()
      } finally {
        await Fs.rm(store, { recursive: true, force: true })
      }
    })
  })

  it("holds the host to the declared version and to the first Bun with an offline install", async () => {
    await withProject(async ({ calls, executable, root }) => {
      const declared = await refused((await makeBun(root, executable, { requirement: "1.4.3" })).verify)
      expect(declared.code).toBe("environment_mismatch")
      expect(declared.message).toBe("this host runs bun 1.4.2, and the workspace declares 1.4.3")
      expect(await Effect.runPromise((await makeBun(root, executable, { requirement: ">=1.4.0" })).verify)).toBe(
        "1.4.2"
      )
      expect(await calls()).toEqual([])
    })
    // Bun 1.4.0 satisfies `>=1.4.0` and would ignore `--offline`.
    await withProject(async ({ calls, executable, root }) => {
      const manager = await makeBun(root, executable, { requirement: ">=1.4.0" })
      for (const operation of [manager.verify, manager.fetch, manager.link]) {
        const error = await refused(operation)
        expect(error.code).toBe("environment_mismatch")
        expect(error.message).toBe(
          "this host runs bun 1.4.0; the install needs bun 1.4.1 or newer, the first release with bun install --offline"
        )
      }
      expect(await calls()).toEqual([])
      await expect(Fs.access(NodePath.join(root, ".flows"))).rejects.toThrow()
    }, "1.4.0")
  })

  it("refuses a missing, binary, undecodable, or unstageable lockfile before staging anything", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      const manager = await makeBun(root, executable)
      await write("bun.lock", lockfile.replace(`["dep@1.0.0", "", {}, "sha512-x"]`, `["dep@file:../dep", {}]`))
      expect(await refused(manager.fetch)).toMatchObject({ code: "unsupported" })
      await Fs.writeFile(NodePath.join(root, "bun.lock"), new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))
      const undecodable = await refused(manager.fetch)
      expect(undecodable.code).toBe("lockfile_unreadable")
      await Fs.rm(NodePath.join(root, "bun.lock"))
      const missing = await refused(manager.fetch)
      expect(missing.code).toBe("lockfile_unreadable")
      expect(missing.message).toBe(`${root}/bun.lock is missing; a Bun install needs a committed bun.lock`)
      await write("bun.lockb", "binary")
      const binary = await refused(manager.fetch)
      expect(binary.code).toBe("lockfile_unreadable")
      expect(binary.message).toContain("bun install --save-text-lockfile --frozen-lockfile --lockfile-only")
      expect(await calls()).toEqual([])
      await expect(Fs.access(NodePath.join(root, ".flows"))).rejects.toThrow()
    })
  })

  it("refuses a workspace manifest or patch file the lockfile names and the project lacks", async () => {
    await withProject(async ({ calls, executable, root }) => {
      const manager = await makeBun(root, executable)
      await Fs.rm(NodePath.join(root, patch))
      const error = await refused(manager.fetch)
      expect(error.code).toBe("manifest_unreadable")
      expect(error.message).toContain(patch)
      expect(await calls()).toEqual([])
    })
  })

  it("holds bunfig.toml to the known settings before any child starts", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      await write("bunfig.toml", `[install.security]\nscanner = "@acme/scanner"\n`)
      const manager = await makeBun(root, executable)
      for (const operation of [manager.version, manager.verify, manager.fetch, manager.link]) {
        const error = await refused(operation)
        expect(error.code).toBe("unsafe_configuration")
        expect(error.message).toBe("bunfig.toml setting install.security runs a scanner package during the install")
      }
      expect(await calls()).toEqual([])
    })
  })

  it("forwards an .npmrc credential and holds bunfig.toml transport to the host while it does", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      await write(".npmrc", "//registry.example/:_authToken=${NPM_TOKEN}\n")
      await write("bunfig.toml", `[install]\nregistry = "https://registry.example/"\n`)
      const environment = { PATH: process.env.PATH, NPM_TOKEN: "npm_forwarded" }
      const manager = await makeBun(root, executable, { environment })
      await Effect.runPromise(manager.fetch)
      await Effect.runPromise(manager.link)
      const [, call] = await calls()
      expect(call?.env.NPM_TOKEN).toBe("npm_forwarded")
      // pnpm's transport flags are not Bun's; Bun's settings are refused in the files instead.
      expect(call?.args).not.toContain("--config.strict-ssl=true")

      await write("bunfig.toml", `[install]\nregistry = "http://registry.example/"\n`)
      const error = await refused((await makeBun(root, executable, { environment })).link)
      expect(error.code).toBe("unsafe_configuration")
      expect(error.message).toContain("install.registry changes how a forwarded credential travels")
      expect(await calls()).toHaveLength(2)
    })
  })

  it("installs beside an environment file that sets only the application's variables", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      const manager = await makeBun(root, executable)
      // A directory of the name, such as a Python environment, is not a file Bun loads.
      await Fs.mkdir(NodePath.join(root, ".env"))
      await write(".env.local", "DATABASE_URL=postgres://localhost/app\n")
      await Effect.runPromise(manager.fetch)
      await Effect.runPromise(manager.link)
      expect(await calls()).toHaveLength(2)
    })
  })

  it.each([
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local"
  ])("refuses to fetch or link past a %s that configures the installer", async (name) => {
    await withProject(async ({ calls, executable, root, write }) => {
      const manager = await makeBun(root, executable)
      await Effect.runPromise(manager.fetch)
      await write(name, "API=1\nBUN_CONFIG_SKIP_INSTALL_PACKAGES=secret-value\n")
      // Bun loads the file at link, in the project root. The fetch runs in the
      // staging copy, and refuses too: a root manifest that names the staging
      // copy as a workspace would move it to the project root.
      for (const operation of [manager.link, manager.fetch]) {
        const error = await refused(operation)
        expect(error.code).toBe("unsafe_configuration")
        expect(error.message).toBe(
          `${root}/${name} sets BUN_CONFIG_SKIP_INSTALL_PACKAGES; bun install loads this file and cannot be ` +
            "told not to, so it may not set a BUN_ or NPM_CONFIG_ variable"
        )
        expect(error.message).not.toContain("secret-value")
      }
      expect(await calls()).toHaveLength(1)
    })
  })

  it("turns each host failure into a typed refusal", async () => {
    await withProject(async ({ calls, executable, root, write }) => {
      await write(".env", "A=1\n")
      const cases = [
        [
          failing("exists", (path) => path.endsWith("/bun/package.json")),
          "fetch",
          "manifest_unreadable",
          "could not read"
        ],
        [failing("exists", (path) => path.endsWith("/bun.lock")), "fetch", "lockfile_unreadable", "could not read"],
        [
          failing("exists", (path) => path.endsWith("/bunfig.toml")),
          "version",
          "manifest_unreadable",
          "could not read"
        ],
        [failing("makeDirectory", (path) => path.endsWith("/cache")), "fetch", "command_failed", "could not create"],
        [failing("exists", (path) => path.endsWith("/.env.test")), "link", "manifest_unreadable", "could not read"],
        [failing("stat", (path) => path.endsWith("/.env")), "link", "manifest_unreadable", "could not read"]
      ] as const
      for (const [fileSystem, operation, code, message] of cases) {
        const manager = await makeBun(root, executable, { fileSystem })
        const error = await refused(manager[operation])
        expect(error.code, operation).toBe(code)
        expect(error.message, operation).toContain(message)
      }
      expect(await calls()).toEqual([])
    })
  })

  it("reports each install's nonzero exit without reporting a successful install", async () => {
    await withProject(async ({ root }) => {
      const failingBun = NodePath.join(root, "failing-bun.mjs")
      await writeExecutable(
        failingBun,
        `if (process.argv[2] === "--version") { process.stdout.write("1.4.2\\n"); process.exit(0) }\nprocess.exit(1)`
      )
      const manager = await makeBun(root, failingBun)
      expect(await refused(manager.fetch)).toMatchObject({
        code: "command_failed",
        message: "bun install exited with status 1"
      })
      expect(await refused(manager.link)).toMatchObject({
        code: "command_failed",
        message: "bun install --offline exited with status 1"
      })
      // A fetch that failed completed nothing, so the next one runs Bun again.
      await expect(Fs.access(NodePath.join(root, ".flows/store/bun/cache/.smithers-fetch"))).rejects.toThrow()
    })
  })

  it("digests the package directories the link left, and reports a tree that is not there", async () => {
    await withProject(async ({ executable, root, write }) => {
      const manager = await makeBun(root, executable)
      const evidence = () =>
        Effect.runPromise(
          manager.linkManifest.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))
        )
      const absent = await Effect.runPromise(
        Effect.flip(manager.linkManifest).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))
      )
      expect(absent.code).toBe("manifest_unreadable")
      expect(absent.message).toContain(`${root}/node_modules`)

      await write("node_modules/dep/package.json", "{}\n")
      await write("node_modules/@scope/pkg/package.json", "{}\n")
      await write("node_modules/.bun/dep@1.0.0/node_modules/dep/package.json", "{}\n")
      const linked = await evidence()
      expect(linked).toMatch(/^[0-9a-f]{64}$/)
      expect(await evidence()).toBe(linked)
      // The evidence is names, so a file inside a package does not move it and a package does.
      await write("node_modules/dep/index.js", "\n")
      expect(await evidence()).toBe(linked)
      await write("node_modules/.bun/other@2.0.0/node_modules/other/package.json", "{}\n")
      expect(await evidence()).not.toBe(linked)
    })
  })
})

describe("PackageManager Bun inputs", () => {
  const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)

  it("digests bunfig.toml, reports none, and refuses one the install cannot run under", async () => {
    await withProject(async ({ root, write }) => {
      const digest = () => Effect.runPromise(PackageManager.bunfigDigest(root).pipe(Effect.provide(services)))
      expect(await digest()).toBeNull()
      await write("bunfig.toml", `[install]\nlinker = "hoisted"\n`)
      const hoisted = await digest()
      expect(hoisted).toMatch(/^[0-9a-f]{64}$/)
      await write("bunfig.toml", `[install]\nlinker = "isolated"\n`)
      expect(await digest()).not.toBe(hoisted)
      await write("bunfig.toml", `[install]\nregistry = { url = "https://registry.example/", token = "literal" }\n`)
      const error = await Effect.runPromise(
        Effect.flip(PackageManager.bunfigDigest(root)).pipe(Effect.provide(services))
      )
      expect(error.code).toBe("unsafe_configuration")
      expect(error.message).not.toContain("literal")
      await Fs.writeFile(NodePath.join(root, "bunfig.toml"), new Uint8Array([0x5b, 0xff, 0xfe, 0x5d]))
      const undecodable = await Effect.runPromise(
        Effect.flip(PackageManager.bunfigDigest(root)).pipe(Effect.provide(services))
      )
      expect(undecodable.code).toBe("manifest_unreadable")
    })
  })

  it("digests each patch file the lockfile names, in path order", async () => {
    await withProject(async ({ root, write }) => {
      const digests = () => Effect.runPromise(PackageManager.bunPatchDigests(root).pipe(Effect.provide(services)))
      const [first] = await digests()
      expect(first?.path).toBe(patch)
      await write(patch, "--- a/other.js\n+++ b/other.js\n")
      expect((await digests())[0]?.digest).not.toBe(first?.digest)
      await write("bun.lock", lockfile.replace(/ {2}"patchedDependencies": \{\n.*\n {2}\},\n/, ""))
      expect(await digests()).toEqual([])
    })
  })

  it("refuses to digest a patch file or a bunfig.toml that is a link to another file", async () => {
    await withProject(async ({ root, write }) => {
      await write(".env", "TOKEN=secret-value\n")
      const digests = [[patch, PackageManager.bunPatchDigests], ["bunfig.toml", PackageManager.bunfigDigest]] as const
      for (const [file, digest] of digests) {
        await Fs.rm(NodePath.join(root, file), { force: true })
        await Fs.symlink(NodePath.join(root, ".env"), NodePath.join(root, file))
        const error = await Effect.runPromise(
          Effect.flip(digest(root) as Effect.Effect<unknown, PackageManager.PackageManagerError, FileSystem.FileSystem>)
            .pipe(Effect.provide(services))
        )
        expect(error.code, file).toBe("manifest_unreadable")
        expect(error.message, file).toContain("not a symbolic link")
      }
    })
  })
})

describe("PackageManager store manifest under Bun", () => {
  const digest = "a".repeat(64)
  const other = "b".repeat(64)
  const base = {
    manager: "bun",
    managerVersion: "1.4.2",
    platform: null,
    lockfileDigest: digest,
    npmrcDigest: null
  } as const
  const tuple = (input: PackageManager.StoreManifestInput): unknown =>
    JSON.parse(PackageManager.storeManifestText(input))

  it("versions the canonical tuple when bunfig.toml or a patch file is present", () => {
    expect(tuple(base)).toEqual(["smithers-build/store-manifest/v1", "bun", "1.4.2", null, digest, null])
    expect(tuple({ ...base, bunfigDigest: null, patches: [] })).toEqual(tuple(base))
    expect(tuple({ ...base, bunfigDigest: other })).toEqual([
      "smithers-build/store-manifest/v3",
      "bun",
      "1.4.2",
      null,
      digest,
      null,
      null,
      null,
      other,
      []
    ])
    expect(tuple({ ...base, patches: [{ path: "patches/a.patch", digest: other }] })).toEqual([
      "smithers-build/store-manifest/v3",
      "bun",
      "1.4.2",
      null,
      digest,
      null,
      null,
      null,
      null,
      [["patches/a.patch", other]]
    ])
    // pnpm's tuple is unchanged by the Bun fields.
    expect(tuple({ ...base, manager: "pnpm", workspaceDigest: other })).toEqual([
      "smithers-build/store-manifest/v2",
      "pnpm",
      "1.4.2",
      null,
      digest,
      null,
      null,
      other
    ])
  })

  it("refuses Bun inputs that are not digests and paths with digests", () => {
    const invalid = [
      { bunfigDigest: "nope" },
      { patches: "patches/a.patch" },
      { patches: [7] },
      { patches: [{ path: "", digest }] },
      { patches: [{ path: 7, digest }] },
      { patches: [{ path: "patches/\ud800.patch", digest }] },
      { patches: [{ path: "patches/a.patch" }] },
      { patches: [{ path: "patches/a.patch", digest: "nope" }] },
      { patches: [{ path: "patches/a.patch", digest, extra: true }] }
    ]
    for (const fields of invalid) {
      expect(() => PackageManager.storeManifestText({ ...base, ...fields } as never), JSON.stringify(fields))
        .toThrow(TypeError)
    }
  })
})
