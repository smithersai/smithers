/**
 * A machine, made from real workspaces: real git checkouts, real files, real
 * links. A git that fails is supplied as a function.
 */
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const posixIt = it.skipIf(process.platform === "win32")

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Machine.remove(root)))
})

const directory = async (name: string): Promise<string> => {
  const made = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), `smithers-machine-${name}-`)))
  temporary.push(made)
  return made
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Machine", "-c", "user.email=machine@example.invalid", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

const write = async (root: string, name: string, text: string, mode = 0o644): Promise<void> => {
  const file = Path.join(root, name)
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  await Fs.writeFile(file, text, { mode })
  await Fs.chmod(file, mode)
}

/**
 * A checkout with one commit: two tracked files, a tracked link, an ignored
 * directory and the cache directory. `origin` is its remote.
 */
const checkout = async (): Promise<string> => {
  const root = Path.join(await directory("checkout"), "repo")
  await Fs.mkdir(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  await write(root, ".gitignore", "node_modules\nout\n.flows\n")
  await write(root, "src/a.txt", "a\n")
  await write(root, "tool.sh", "#!/bin/sh\nexit 0\n", 0o755)
  await Fs.symlink("src/a.txt", Path.join(root, "link"))
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "one")
  git(root, "remote", "add", "origin", "https://example.invalid/repo.git")
  await write(root, "node_modules/dep/index.js", "module.exports = 1\n")
  await write(root, "out/built", "built\n")
  await write(root, ".flows/cache/entry", "cached\n")
  return root
}

const sorted = (names: Iterable<string>): ReadonlyArray<string> => [...names].sort()

describe("where machines are kept", () => {
  it("is the directory the variable names, else the user's cache directory, by the workspace's path", () => {
    const named = Machine.holding("/work/repo", { [Machine.holdingVariable]: "/kept" })
    expect(Path.dirname(named)).toBe("/kept")
    expect(Path.basename(named)).toMatch(/^[0-9a-f]{16}$/)
    expect(Machine.holding("/work/other", { [Machine.holdingVariable]: "/kept" })).not.toBe(named)
    expect(Path.dirname(Machine.holding("/work/repo", { XDG_CACHE_HOME: "/cache", HOME: "/home/me" })))
      .toBe("/cache/smthrs/machines")
    expect(Path.dirname(Machine.holding("/work/repo", { HOME: "/home/me" }))).toBe("/home/me/.cache/smthrs/machines")
  })

  it("gives each machine a directory of its own with its tree under the workspace's name", () => {
    const one = Machine.named("/kept", "/work/repo", "ci.yml:lint (node 22)")
    expect(one).toEqual({
      name: "ci.yml:lint (node 22)",
      directory: one.directory,
      tree: Path.join(one.directory, "w", "repo"),
      home: Path.join(one.directory, "home"),
      tmp: Path.join(one.directory, "tmp")
    })
    expect(Path.basename(one.directory)).toMatch(/^ci\.yml-lint-node-22--[0-9a-f]{8}$/)
    // Two names that read alike once their marks are replaced are still two machines.
    expect(Machine.named("/kept", "/work/repo", "ci.yml/lint (node 22)").directory).not.toBe(one.directory)
  })

  posixIt("is made empty before a build: what an earlier build left is removed", async () => {
    const base = await directory("kept")
    const environment = { [Machine.holdingVariable]: Path.join(base, "machines") }
    const kept = await Machine.prepare("/work/repo", environment)
    expect(kept).toBe(Machine.holding("/work/repo", environment))
    await write(kept, "old/home/left", "left\n")
    expect(await Machine.prepare("/work/repo", environment)).toBe(kept)
    expect(await Fs.readdir(kept)).toEqual([])
  })

  posixIt("is set aside when a build ends, and removed by a command the build does not wait for", async () => {
    const base = await directory("kept")
    const environment = { [Machine.holdingVariable]: Path.join(base, "machines") }
    const kept = await Machine.prepare("/work/repo", environment)
    await write(kept, "job/home/go/pkg/mod/x/file", "locked\n")
    // A directory nothing can be removed from, as Go leaves its module cache.
    await Fs.chmod(Path.join(kept, "job/home/go/pkg/mod/x"), 0o555)
    const started: Array<ReadonlyArray<string>> = []
    await Machine.discard(kept, (argv) => {
      started.push(argv)
    })
    // It is gone at once for whatever looks next; what removes it has its new name.
    expect(NodeFs.existsSync(kept)).toBe(false)
    const [aside] = await Fs.readdir(Path.dirname(kept))
    expect(aside).toMatch(new RegExp(`^${Path.basename(kept)}\\.gone-${process.pid}-[0-9a-f]{8}$`))
    expect(started).toEqual([Machine.remover(Path.join(Path.dirname(kept), aside!))])
    // The command removes it, locked directory and all, with nobody waiting.
    Machine.startApart(started[0] as [string, ...Array<string>], () => undefined)
    await expect.poll(() => Fs.readdir(Path.dirname(kept)), { timeout: 30_000 }).toEqual([])
  })

  posixIt("is removed by the next build where the command that removes it was stopped", async () => {
    const base = await directory("kept")
    const environment = { [Machine.holdingVariable]: Path.join(base, "machines") }
    const kept = await Machine.prepare("/work/repo", environment)
    await write(kept, "job/home/left", "left\n")
    // The command never runs, as in a jail that ends with the build.
    await Machine.discard(kept, () => undefined)
    // Another workspace's machines, and its leftovers, are not this build's to remove.
    const other = await Machine.prepare("/work/other", environment)
    await write(`${other}.gone-1-00000000`, "job/home/left", "left\n")
    expect(await Fs.readdir(Path.dirname(kept))).toHaveLength(3)
    expect(await Machine.prepare("/work/repo", environment)).toBe(kept)
    expect((await Fs.readdir(Path.dirname(kept))).sort()).toEqual(
      [Path.basename(kept), Path.basename(other), `${Path.basename(other)}.gone-1-00000000`].sort()
    )
  })

  posixIt("is removed here and now where no command can remove it apart", async () => {
    const base = await directory("kept")
    const environment = { [Machine.holdingVariable]: Path.join(base, "machines") }
    // Windows has no such command.
    const kept = await Machine.prepare("/work/repo", environment)
    await write(kept, "job/home/left", "left\n")
    const never = (): void => {
      throw new Error("no command is started")
    }
    await Machine.discard(kept, never, "win32")
    expect(await Fs.readdir(Path.dirname(kept))).toEqual([])
    // A directory that is not there cannot be renamed, and there is nothing to remove.
    await Machine.discard(kept, never)
    expect(await Fs.readdir(Path.dirname(kept))).toEqual([])
    // A command that cannot be started says so, and the directory is removed here.
    await write(kept, "job/home/left", "left\n")
    await Machine.discard(
      kept,
      (argv, failed) => Machine.startApart(["/nonexistent-smithers-remover", ...argv], failed)
    )
    await expect.poll(() => Fs.readdir(Path.dirname(kept)), { timeout: 30_000 }).toEqual([])
  })
})

describe("a fresh checkout", () => {
  posixIt("holds what git tracks and what it does not ignore, as the working tree has it now", async () => {
    const root = await checkout()
    await write(root, "new.txt", "untracked\n")
    await write(root, "src/b.txt", "untracked beside a tracked file\n")
    await Fs.rm(Path.join(root, "tool.sh"))
    const held = await Machine.fresh(root, ".flows")
    expect(sorted(held!.files)).toEqual([".gitignore", "link", "new.txt", "src/a.txt", "src/b.txt"])
    expect(sorted(held!.directories)).toEqual(["src"])
  })

  posixIt("holds a submodule as an empty directory, and every directory on the way to a file", async () => {
    const root = await checkout()
    const inner = Path.join(root, "vendor", "lib")
    await Fs.mkdir(inner, { recursive: true })
    git(inner, "init", "--quiet", "--initial-branch=main")
    await write(inner, "x", "x\n")
    git(inner, "add", "-A")
    git(inner, "commit", "--quiet", "-m", "inner")
    git(root, "add", "vendor/lib")
    await write(root, "deep/er/still/file", "f\n")
    const held = await Machine.fresh(root, ".flows")
    expect(sorted(held!.directories)).toEqual(["deep", "deep/er", "deep/er/still", "src", "vendor", "vendor/lib"])
    expect(held!.files.has("vendor/lib/x")).toBe(false)
  })

  posixIt("is not known for a workspace that is no git checkout, and fails when git does", async () => {
    const plain = await directory("plain")
    expect(await Machine.fresh(plain, ".flows")).toBeUndefined()
    const root = await checkout()
    await expect(Machine.fresh(root, ".flows", () => Promise.reject(new Error("git is broken")))).rejects.toThrow(
      "git is broken"
    )
  })
})

describe("the host as a machine that is not made yet would find it", () => {
  posixIt("has of the workspace only what a fresh checkout holds, the cache and the repository's store", async () => {
    const root = await checkout()
    const kept = await directory("kept")
    const held = await Machine.fresh(root, ".flows")
    const { io, measured } = Machine.unmade({ root, cacheDirectory: ".flows", held, kept })
    expect(measured(Path.join(root, "src/a.txt"))).toBe(ObservedReads.measure(Path.join(root, "src/a.txt")))
    expect(measured(Path.join(root, "src"))).toBe("d")
    expect(measured(root)).toBe("d")
    // An installed tree and a build's output are in no fresh checkout.
    expect(measured(Path.join(root, "node_modules"))).toBe("-")
    expect(measured(Path.join(root, "node_modules/dep/index.js"))).toBe("-")
    expect(measured(Path.join(root, "out/built"))).toBe("-")
    // The cache and the repository's store are in every copy.
    expect(measured(Path.join(root, ".flows"))).toBe("d")
    expect(measured(Path.join(root, ".git"))).toBe("d")
    expect(measured(Path.join(root, ".git/HEAD"))).toMatch(/^f:/)
    // Anything else of the host is as it is.
    expect(measured("/")).toBe("d")
    expect(measured(kept)).toBe("d")
    expect(sorted(io.readdir(root))).toEqual([".flows", ".git", ".gitignore", "link", "src", "tool.sh"])
    expect(() => io.readdir(Path.join(root, "node_modules"))).toThrow("ENOENT")
    expect(() => io.lstat(Path.join(root, "out"))).toThrow("ENOENT")
    expect(io.lstat(Path.join(root, "src")).isDirectory()).toBe(true)
    expect(ObservedReads.listing(Path.join(root, "node_modules"), [], io)).toBeUndefined()
    expect(ObservedReads.listing(root, [], io)).toBe(
      ObservedReads.listing(root, ["node_modules", "out"], ObservedReads.defaultIo)
    )
  })

  posixIt("has every machine's three directories, with an empty home and an empty temporary directory", async () => {
    const root = await checkout()
    const kept = await directory("kept")
    // What an earlier build left where a machine goes is not what a new machine starts with.
    await write(kept, "job-1/home/.seen", "seen\n")
    const { io, measured } = Machine.unmade({ root, cacheDirectory: ".flows", held: undefined, kept })
    const machine = Machine.named(kept, root, "job")
    expect(measured(machine.directory)).toBe("d")
    expect(sorted(io.readdir(machine.directory))).toEqual(["home", "tmp", "w"])
    expect(measured(machine.home)).toBe("d")
    expect(io.readdir(machine.home)).toEqual([])
    expect(measured(Path.join(machine.home, ".seen"))).toBe("-")
    expect(measured(Path.join(kept, "job-1/home/.seen"))).toBe("-")
    expect(() => io.lstat(Path.join(machine.home, ".seen"))).toThrow("ENOENT")
    expect(io.lstat(machine.home).isDirectory()).toBe(true)
    expect(measured(machine.tmp)).toBe("d")
    expect(io.readdir(machine.tmp)).toEqual([])
    expect(measured(Path.join(machine.tmp, "left"))).toBe("-")
    expect(() => io.readdir(Path.join(machine.tmp, "left"))).toThrow("ENOENT")
    // The tree is where the workspace's copy goes, under the workspace's name.
    expect(measured(Path.dirname(machine.tree))).toBe("d")
    expect(io.readdir(Path.dirname(machine.tree))).toEqual(["repo"])
    expect(measured(machine.tree)).toBe("d")
    expect(measured(Path.join(Path.dirname(machine.tree), "other"))).toBe("-")
    expect(measured(Path.join(machine.tree, "src"))).toBe("-")
    expect(measured(Path.join(machine.directory, "elsewhere"))).toBe("-")
    // A workspace that is no git checkout is copied whole.
    expect(measured(Path.join(root, "node_modules/dep/index.js"))).toMatch(/^f:/)
  })

  posixIt("has in a machine's home the template and the links it will start with", async () => {
    const root = await checkout()
    const kept = await directory("kept")
    const template = await directory("template")
    await write(template, ".gitconfig", "[core]\n")
    await write(template, ".config/tool/settings", "s\n")
    const volta = await directory("volta")
    await write(volta, "bin/node", "node\n")
    const links = [{ path: ".volta", target: volta }, { path: ".local/share/mise", target: volta }, {
      path: ".gitconfig",
      target: volta
    }]
    const start = { root, cacheDirectory: ".flows", held: undefined, kept, homeTemplate: template, links }
    const { io, measured } = Machine.unmade(start)
    const home = Machine.named(kept, root, "job").home
    expect(sorted(io.readdir(home))).toEqual([".config", ".gitconfig", ".local", ".volta"])
    expect(measured(Path.join(home, ".gitconfig"))).toBe(ObservedReads.measure(Path.join(template, ".gitconfig")))
    expect(measured(Path.join(home, ".config/tool/settings"))).toMatch(/^f:/)
    expect(sorted(io.readdir(Path.join(home, ".config")))).toEqual(["tool"])
    expect(measured(Path.join(home, ".config/absent"))).toBe("-")
    expect(measured(Path.join(home, ".volta"))).toBe(`l:${volta}`)
    expect(measured(Path.join(home, ".volta/bin/node"))).toBe(ObservedReads.measure(Path.join(volta, "bin/node")))
    expect(io.readdir(Path.join(home, ".volta"))).toEqual(["bin"])
    expect(io.lstat(Path.join(home, ".volta")).isDirectory()).toBe(true)
    expect(measured(Path.join(home, ".local"))).toBe("d")
    expect(io.readdir(Path.join(home, ".local"))).toEqual(["share"])
    expect(io.readdir(Path.join(home, ".local/share"))).toEqual(["mise"])
    // What the made machine holds is what the one that is not made was taken to hold.
    const machine = await Machine.make({
      ...start,
      held: await Machine.fresh(root, ".flows"),
      machine: Machine.named(kept, root, "job")
    })
    for (
      const name of [
        "",
        ".gitconfig",
        ".config",
        ".config/tool/settings",
        ".volta",
        ".local",
        ".local/share/mise",
        ".absent"
      ]
    ) {
      expect([name, measured(Path.join(home, name))]).toEqual([
        name,
        ObservedReads.measure(Path.join(machine.home, name))
      ])
    }
    // With no template the home holds the links and the directories on the way to them.
    const bare = Machine.unmade({ ...start, homeTemplate: undefined })
    expect(sorted(bare.io.readdir(home))).toEqual([".gitconfig", ".local", ".volta"])
    expect(bare.measured(Path.join(home, ".config"))).toBe("-")
  })
})

describe("making a machine", () => {
  const made = async (root: string, extra: Partial<Parameters<typeof Machine.make>[0]> = {}) => {
    const kept = await directory("kept")
    return Machine.make({
      machine: Machine.named(kept, root, "job"),
      root,
      cacheDirectory: ".flows",
      held: await Machine.fresh(root, ".flows"),
      kept,
      ...extra
    })
  }

  posixIt("copies a fresh checkout: files with their modes, links as links, nothing ignored, no cache", async () => {
    const root = await checkout()
    await write(root, "src/a.txt", "a, edited and not committed\n")
    await write(root, "new.txt", "untracked\n")
    const machine = await made(root)
    expect(Path.basename(machine.tree)).toBe("repo")
    expect(sorted(await Fs.readdir(machine.tree))).toEqual([".git", ".gitignore", "link", "new.txt", "src", "tool.sh"])
    expect(await Fs.readFile(Path.join(machine.tree, "src/a.txt"), "utf8")).toBe("a, edited and not committed\n")
    expect(await Fs.readlink(Path.join(machine.tree, "link"))).toBe("src/a.txt")
    expect((await Fs.stat(Path.join(machine.tree, "tool.sh"))).mode & 0o111).toBe(0o111)
    expect((await Fs.stat(Path.join(machine.tree, "src/a.txt"))).mode & 0o111).toBe(0)
    expect(await Fs.readdir(machine.home)).toEqual([])
    expect(await Fs.readdir(machine.tmp)).toEqual([])
  })

  posixIt(
    "gives the copy a repository of its own at the same commit, with the same branch, remote and changes",
    async () => {
      const root = await checkout()
      git(root, "tag", "v1")
      await write(root, "src/a.txt", "a, edited\n")
      const before = git(root, "status", "--porcelain")
      const machine = await made(root)
      expect(git(machine.tree, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"))
      expect(git(machine.tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
      expect(git(machine.tree, "status", "--porcelain")).toBe(before)
      expect(git(machine.tree, "remote", "get-url", "origin")).toBe("https://example.invalid/repo.git")
      expect(git(machine.tree, "tag", "--list")).toBe("v1")
      expect(git(machine.tree, "log", "--format=%s")).toBe("one")
      // What a target does with git in the copy stays in the copy.
      git(machine.tree, "commit", "--quiet", "-am", "on the machine")
      git(machine.tree, "config", "core.hooksPath", "/nowhere")
      expect(git(root, "log", "--format=%s")).toBe("one")
      expect(git(root, "status", "--porcelain")).toBe(before)
      expect(() => git(root, "config", "--get", "core.hooksPath")).toThrow()
    }
  )

  posixIt("gives a checkout with a detached commit and a submodule a copy that git reads", async () => {
    const root = await checkout()
    const inner = Path.join(root, "vendor", "lib")
    await Fs.mkdir(inner, { recursive: true })
    git(inner, "init", "--quiet", "--initial-branch=main")
    await write(inner, "x", "x\n")
    git(inner, "add", "-A")
    git(inner, "commit", "--quiet", "-m", "inner")
    git(root, "add", "vendor/lib")
    git(root, "commit", "--quiet", "-m", "two")
    git(root, "checkout", "--quiet", "--detach", "HEAD")
    const machine = await made(root)
    expect(git(machine.tree, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"))
    expect(git(machine.tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
    expect(await Fs.readdir(Path.join(machine.tree, "vendor/lib"))).toEqual([])
    // A submodule's own store is copied the same way, without the place of its working tree.
    const store = Path.join(await directory("store"), "lib")
    await Fs.mkdir(store)
    git(inner, "config", "core.worktree", inner)
    const copy = await Machine.make({
      machine: Machine.named(Path.dirname(store), inner, "inner"),
      root: inner,
      cacheDirectory: ".flows",
      held: await Machine.fresh(inner, ".flows"),
      kept: Path.dirname(store)
    })
    expect(git(copy.tree, "status", "--porcelain")).toBe("")
    expect(() => git(copy.tree, "config", "--get", "core.worktree")).toThrow()
  })

  posixIt("copies a workspace that is no git checkout whole, apart from the cache and a jj store", async () => {
    const plain = Path.join(await directory("plain"), "ws")
    await write(plain, "a.txt", "a\n")
    await write(plain, "node_modules/dep", "dep\n")
    await write(plain, ".flows/cache/entry", "cached\n")
    await write(plain, ".jj/repo/store", "store\n")
    const machine = await made(plain)
    expect(sorted(await Fs.readdir(machine.tree))).toEqual(["a.txt", "node_modules"])
  })

  posixIt("starts the home with the template and the links it is given", async () => {
    const root = await checkout()
    const template = await directory("template")
    await write(template, ".gitconfig", "[core]\n")
    await write(template, ".hooks/pre-push", "#!/bin/sh\nexit 1\n", 0o755)
    const volta = await directory("volta")
    const machine = await made(root, {
      homeTemplate: template,
      links: [{ path: ".volta", target: volta }, { path: ".local/share/mise", target: volta }, {
        path: ".gitconfig",
        target: volta
      }]
    })
    expect(sorted(await Fs.readdir(machine.home))).toEqual([".gitconfig", ".hooks", ".local", ".volta"])
    expect(await Fs.readlink(Path.join(machine.home, ".volta"))).toBe(volta)
    expect(await Fs.readlink(Path.join(machine.home, ".local/share/mise"))).toBe(volta)
    // A link never replaces what the template put there.
    expect(await Fs.readFile(Path.join(machine.home, ".gitconfig"), "utf8")).toBe("[core]\n")
    expect((await Fs.stat(Path.join(machine.home, ".hooks/pre-push"))).mode & 0o111).toBe(0o111)
  })

  posixIt(
    "replaces what an earlier build left where it goes, also a directory nothing can be removed from",
    async () => {
      const root = await checkout()
      const kept = await directory("kept")
      const machine = Machine.named(kept, root, "job")
      await write(machine.home, "go/pkg/mod/x/file", "locked\n")
      await Fs.chmod(Path.join(machine.home, "go/pkg/mod/x"), 0o555)
      await Fs.chmod(Path.join(machine.home, "go/pkg/mod"), 0o555)
      await write(machine.tree, "left-by-the-last-build", "left\n")
      await Machine.make({ machine, root, cacheDirectory: ".flows", held: await Machine.fresh(root, ".flows"), kept })
      expect(await Fs.readdir(machine.home)).toEqual([])
      expect(NodeFs.existsSync(Path.join(machine.tree, "left-by-the-last-build"))).toBe(false)
      await Machine.remove(Path.join(kept, "not-there"))
    }
  )

  // The fourth ship review's cobra replay: a build's machines are set aside and removed by a command nobody waits
  // for, and the next build, which removes what is left, met that command at work in Go's module cache. The
  // directory it was about to make writable was gone, and the build stopped with `ENOENT ... chmod`.
  posixIt("removes a directory another remover is taking away at the same time", async () => {
    const kept = await directory("kept")
    const locked = Path.join(kept, "home/go/pkg/mod")
    await write(kept, "home/go/pkg/mod/cache/download/sumdb/file", "locked\n")
    await write(kept, "home/go/pkg/mod/other/file", "locked\n")
    for (const name of ["cache/download/sumdb", "cache/download", "cache", "other", ""]) {
      await Fs.chmod(Path.join(locked, name), 0o555)
    }
    const taken: Array<string> = []
    /** The other remover: it takes a directory away just before this one makes it writable, or lists it. */
    const takenAway = async (path: string): Promise<void> => {
      if (!path.endsWith("/download") && !path.endsWith("/other")) return
      if (taken.includes(path)) return
      taken.push(path)
      execFileSync("sh", ["-c", "chmod -R u+rwx \"$1\" && rm -rf \"$1\"", "sh", path])
    }
    const racing: Machine.Removal = {
      lstat: Fs.lstat,
      rm: Fs.rm,
      // `download` is gone when it is to be made writable, and `other` when it is to be listed.
      chmod: async (path, mode) => {
        if (String(path).endsWith("/download")) await takenAway(String(path))
        return Fs.chmod(path, mode)
      },
      readdir: (async (path: string) => {
        if (path.endsWith("/other")) await takenAway(path)
        return Fs.readdir(path)
      }) as typeof Fs.readdir
    }
    await Machine.remove(kept, racing)
    expect(taken.map((path) => Path.relative(locked, path)).sort()).toEqual(["cache/download", "other"])
    expect(NodeFs.existsSync(kept)).toBe(false)
    // Any other failure is still a failure: a directory that cannot be made writable is not passed over.
    const denied = await directory("denied")
    await write(denied, "locked/file", "locked\n")
    await Fs.chmod(Path.join(denied, "locked"), 0o555)
    const refusing: Machine.Removal = {
      ...racing,
      chmod: (path, mode) =>
        String(path).endsWith("/locked")
          ? Promise.reject(Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" }))
          : Fs.chmod(path, mode),
      readdir: Fs.readdir
    }
    await expect(Machine.remove(denied, refusing)).rejects.toMatchObject({ code: "EPERM" })
    await Machine.remove(denied)
  })

  posixIt("fails when git cannot say where the repository is", async () => {
    const root = await checkout()
    const held = await Machine.fresh(root, ".flows")
    await expect(made(root, { held, git: () => Promise.reject(new Error("no repository here")) })).rejects.toThrow(
      "no repository here"
    )
  })
})

describe("the links of a machine's home", () => {
  it("are the ones a confined run is given under its private home", () => {
    expect(Machine.homeLinks([
      { path: "home/.volta", target: "/opt/volta" },
      { path: "data/mise", target: "/opt/mise" },
      { path: "home/.local/share/mise", target: "/opt/mise" }
    ])).toEqual([{ path: ".volta", target: "/opt/volta" }, { path: ".local/share/mise", target: "/opt/mise" }])
  })
})

describe("a target on a machine", () => {
  it("is told the machine's home, cache, temporary directory, and where git stops looking", () => {
    const machine = Machine.named("/kept", "/work/repo", "job")
    expect(Machine.environment(machine)).toEqual({
      HOME: machine.home,
      XDG_CACHE_HOME: Path.join(machine.home, ".cache"),
      XDG_CONFIG_HOME: Path.join(machine.home, ".config"),
      XDG_DATA_HOME: Path.join(machine.home, ".local", "share"),
      XDG_STATE_HOME: Path.join(machine.home, ".local", "state"),
      TMPDIR: machine.tmp,
      TMP: machine.tmp,
      TEMP: machine.tmp,
      SMTHRS_MACHINE_TMP: machine.tmp,
      GIT_CEILING_DIRECTORIES: Path.dirname(machine.tree)
    })
    expect(Machine.temporaryVariable).toBe("SMTHRS_MACHINE_TMP")
  })

  it("names the copy where its plan named the workspace, and the cache where it is", () => {
    const moved = (value: string): string => Machine.relocated(value, "/work/repo", "/m/w/repo", ".flows")
    expect(moved("/work/repo")).toBe("/m/w/repo")
    expect(moved("/work/repo/scripts/run.sh")).toBe("/m/w/repo/scripts/run.sh")
    expect(moved("/work/repo/node_modules/.bin:/usr/bin:/work/repo")).toBe(
      "/m/w/repo/node_modules/.bin:/usr/bin:/m/w/repo"
    )
    // The cache is the build's own, and another directory that starts alike is another directory.
    expect(moved("/work/repo/.flows/tmp/tools:/work/repo/bin")).toBe("/work/repo/.flows/tmp/tools:/m/w/repo/bin")
    expect(moved("/work/repo/.flows")).toBe("/work/repo/.flows")
    expect(moved("/work/repo/.flowsheet")).toBe("/m/w/repo/.flowsheet")
    expect(moved("/work/repository/x")).toBe("/work/repository/x")
    expect(moved("echo hello")).toBe("echo hello")
    // The text a declaration writes for the cache directory names the workspace's, where it is given.
    expect(moved("{cache}/store")).toBe("{cache}/store")
    expect(Machine.relocated("ls {cache}/store /work/repo/src", "/work/repo", "/m/w/repo", ".flows", "{cache}")).toBe(
      "ls /work/repo/.flows/store /m/w/repo/src"
    )
    expect(Machine.relocated("{cache}/store", "/work/repo", "/m/w/repo", "../kept", "{cache}")).toBe("/work/kept/store")
    // Also where the mark stands alone on a line of a script.
    expect(Machine.relocated("read kept <<E\n{cache}\nE", "/work/repo", "/m/w/repo", ".flows", "{cache}")).toBe(
      "read kept <<E\n/work/repo/.flows\nE"
    )
  })
})

describe("the temporary directory of a machine as /tmp", () => {
  const machine = Machine.named("/kept/abc", "/work/repo", "job")

  it("is put in place of /tmp for a command, and every other path is the host's", () => {
    expect(Machine.sharedTmp).toBe("/tmp")
    expect(Machine.withOwnTmp("/usr/bin/bwrap", machine, ["sh", "-c", "true"])).toEqual([
      "/usr/bin/bwrap",
      "--dev-bind",
      "/",
      "/",
      "--bind",
      machine.tmp,
      "/tmp",
      "--die-with-parent",
      "--",
      "sh",
      "-c",
      "true"
    ])
  })

  it("names the variable that forbids two machines one /tmp, and says why a target cannot run", () => {
    expect(Machine.ownTmpVariable).toBe("SMTHRS_MACHINE_OWN_TMP")
    expect(Machine.sharedRefusal("test", "lint", "bwrap is not on PATH")).toBe(
      "machine test needs a /tmp of its own, and this host gives none (bwrap is not on PATH); " +
        "machine lint has used the host's in this build, so it would see what that one left there"
    )
  })

  it("keeps in sight the entries of /tmp that hold what the build itself uses", () => {
    // A workspace, its machines and a tool under `/tmp`, each named by the entry of `/tmp` that holds it, once.
    const sight = Machine.inSight([
      "/tmp/work/home/.cache/smthrs/machines/abc/job",
      "/tmp/work/copy",
      "/tmp/bunx-1000/node_modules/.bin",
      "/usr/bin",
      "/tmp",
      "/tmp/",
      "/tmpfile/x",
      ""
    ], () => true)
    expect(sight).toEqual(["/tmp/bunx-1000", "/tmp/work"])
    expect(Machine.withOwnTmp("/usr/bin/bwrap", machine, ["true"], sight)).toEqual([
      "/usr/bin/bwrap",
      "--dev-bind",
      "/",
      "/",
      "--bind",
      machine.tmp,
      "/tmp",
      "--bind",
      "/tmp/bunx-1000",
      "/tmp/bunx-1000",
      "--bind",
      "/tmp/work",
      "/tmp/work",
      "--die-with-parent",
      "--",
      "true"
    ])
    // The recorder finds an entry in sight where it is, and anything else under `/tmp` on the machine.
    expect(Machine.mountsOf("/real/tmp", sight)).toEqual([
      ["/tmp/bunx-1000", "/tmp/bunx-1000"],
      ["/tmp/work", "/tmp/work"],
      ["/tmp", "/real/tmp"]
    ])
  })

  posixIt(
    "leaves out an entry of /tmp that is not there, as the node_modules/.bin npx names above where it starts",
    () => {
      const here = NodeFs.realpathSync(NodeFs.mkdtempSync("/tmp/smthrs-sight-"))
      try {
        // npx starts in `<here>/repository` and puts `<here>/node_modules/.bin`, `/tmp/node_modules/.bin` and
        // `/node_modules/.bin` on PATH; of the entries of /tmp they name, only `<here>` is there.
        const missing = `${here}-not-there`
        expect(Machine.inSight([
          `${here}/repository/node_modules/.bin`,
          `${here}/node_modules/.bin`,
          `${missing}/node_modules/.bin`,
          "/node_modules/.bin"
        ])).toEqual([here])
      } finally {
        NodeFs.rmSync(here, { recursive: true, force: true })
      }
    }
  )

  posixIt("is asked of the host: a bubblewrap on PATH that starts, or the reason there is none", async () => {
    const base = await directory("mounting")
    // A bubblewrap that starts, one that the host refuses, and a directory that holds none.
    const starts = Path.join(base, "starts")
    const refused = Path.join(base, "refused")
    const empty = Path.join(base, "empty")
    await write(base, "starts/bwrap", "#!/bin/sh\nexit 0\n")
    await write(base, "refused/bwrap", "#!/bin/sh\nexit 1\n")
    await write(base, "empty/readme", "nothing to run\n")
    await Fs.chmod(Path.join(starts, "bwrap"), 0o755)
    await Fs.chmod(Path.join(refused, "bwrap"), 0o755)
    // An empty entry of PATH and a directory with no bwrap are passed over.
    expect(await Machine.mounting({ PATH: `:${empty}:${starts}:${refused}` }, base, "linux")).toEqual({
      bwrap: Path.join(starts, "bwrap")
    })
    expect(await Machine.mounting({ PATH: `${refused}:${starts}` }, base, "linux")).toEqual({
      reason: `${Path.join(refused, "bwrap")} cannot give a process a mount of its own on this host`
    })
    expect(await Machine.mounting({ PATH: empty }, base, "linux")).toEqual({
      reason: "bwrap is not on PATH (install the bubblewrap package)"
    })
    expect(await Machine.mounting({}, base, "linux")).toEqual({
      reason: "bwrap is not on PATH (install the bubblewrap package)"
    })
    expect(await Machine.mounting({ PATH: starts }, base, "darwin")).toEqual({
      reason: "a private /tmp needs bubblewrap, which runs only on Linux"
    })
    // This host, as it is: an answer either way.
    const here = await Machine.mounting(process.env, base)
    expect("bwrap" in here || here.reason.length > 0).toBe(true)
  })
})

describe("a record of a run on a machine", () => {
  const machine = Machine.named("/kept/abc", "/work/repo", "job")

  it("names the machine's own paths from the machine, and finds them again on any host", () => {
    const name = Machine.neutral(machine)
    expect(name(Path.join(machine.home, ".npmrc"))).toBe("/smthrs-machine/home/.npmrc")
    expect(name(machine.tmp)).toBe("/smthrs-machine/tmp")
    expect(name(machine.directory)).toBe("/smthrs-machine")
    expect(name("/usr/lib/node")).toBe("/usr/lib/node")
    expect(name(`${machine.directory}-other/home`)).toBe(`${machine.directory}-other/home`)
    // The directory the machine is kept in holds the workspace's path in its name: it has a name of its own.
    expect(name("/kept/abc")).toBe("/smthrs-machines")
    expect(name("/kept")).toBe("/kept")
    const elsewhere = Machine.named("/other/kept/def", "/elsewhere/repo", "job")
    const found = Machine.actual(elsewhere)
    expect(found("/smthrs-machine/home/.npmrc")).toBe(Path.join(elsewhere.home, ".npmrc"))
    expect(found("/smthrs-machine")).toBe(elsewhere.directory)
    expect(found("/usr/lib/node")).toBe("/usr/lib/node")
    expect(found("/smthrs-machines")).toBe("/other/kept/def")
    expect(found("/smthrs-machines/x")).toBe("/smthrs-machines/x")
  })

  it("keeps for its later targets what is under its home or its temporary directory, and nothing else", () => {
    expect(Machine.own("/smthrs-machine/home/.npmrc")).toBe(true)
    expect(Machine.own("/smthrs-machine/tmp/state/outcome")).toBe(true)
    // The two directories themselves are every machine's, and the tree is kept from its root.
    expect(Machine.own("/smthrs-machine/home")).toBe(false)
    expect(Machine.own("/smthrs-machine/tmp")).toBe(false)
    expect(Machine.own("/smthrs-machine/w/repo/a.txt")).toBe(false)
    expect(Machine.own("/smthrs-machine/other/a")).toBe(false)
    expect(Machine.own("/tmp/a")).toBe(false)
    expect(Machine.own("home/a")).toBe(false)
    // A name that leaves the machine, or is no one path, is never put back.
    expect(Machine.own("/smthrs-machine/home/../../elsewhere")).toBe(false)
    expect(Machine.own("/smthrs-machine/home//a")).toBe(false)
    expect(Machine.own("/smthrs-machine/tmp/a/")).toBe(false)
    expect(Machine.own("/smthrs-machine/tmp/a\0b")).toBe(false)
  })

  posixIt("reads each path where it is placed", async () => {
    const real = await directory("placed")
    await write(real, "home/file", "content\n")
    await Fs.symlink("file", Path.join(real, "home/link"))
    const io = Machine.through(Machine.actual({ ...machine, directory: real }))
    expect(io.lstat("/smthrs-machine/home").isDirectory()).toBe(true)
    expect(io.readdir("/smthrs-machine/home").toSorted()).toEqual(["file", "link"])
    expect(io.readlink("/smthrs-machine/home/link")).toBe("file")
    expect(io.readFile("/smthrs-machine/home/file").toString()).toBe("content\n")
    expect(io.head("/smthrs-machine/home/file", 3).toString()).toBe("con")
    expect(ObservedReads.measure("/smthrs-machine/home/file", io)).toBe(
      ObservedReads.measure(Path.join(real, "home/file"))
    )
  })

  it("holds no path of the checkout it was made in", () => {
    const home = (name: string): string => Path.join(machine.home, name)
    const body = {
      reads: [["src/a.txt", "f:1"], [home(".npmrc"), "-"], ["/usr/bin/node", "f:2:x"], [home(".seen"), "f:3", "-"]],
      lists: [[machine.home, "digest", [".seen"]], ["src", "digest", []]],
      given: [[home("bin/tool"), "f:4:x", 0]],
      from: [["//:install", "id"]]
    } as const
    const observation: ObservedReads.Observation = {
      record: { ...body, id: ObservedReads.idOf(body) } as never,
      made: new Set([home(".seen")]),
      touched: new Set([home(".seen")]),
      left: { keep: ["deps/a"], gone: [], outside: [[home("bin/tool"), "f:4:x"]] }
    }
    const written = Machine.recorded(observation, machine)
    expect(written.record.reads).toEqual([
      ["/smthrs-machine/home/.npmrc", "-"],
      ["/smthrs-machine/home/.seen", "f:3", "-"],
      ["/usr/bin/node", "f:2:x"],
      ["src/a.txt", "f:1"]
    ])
    expect(written.record.lists).toEqual([["/smthrs-machine/home", "digest", [".seen"]], ["src", "digest", []]])
    expect(written.record.given).toEqual([["/smthrs-machine/home/bin/tool", "f:4:x", 0]])
    expect(written.record.from).toEqual(body.from)
    expect(written.left).toEqual({ keep: ["deps/a"], gone: [], outside: [["/smthrs-machine/home/bin/tool", "f:4:x"]] })
    // What the run left and removed in the machine's home and temporary directory is kept from the machine. A
    // path beside them, as the host's own temporary directory is, stays where it is.
    const kept = Machine.recorded(
      {
        ...observation,
        left: {
          keep: [
            "deps/a",
            home("bin"),
            home("bin/tool"),
            Path.join(machine.tmp, "state"),
            "/tmp/elsewhere",
            machine.home
          ],
          gone: [Path.join(machine.tmp, "old"), "deps/old", `${machine.directory}/other`],
          outside: []
        }
      },
      machine
    )
    expect(kept.left).toEqual({
      keep: [
        "deps/a",
        "/smthrs-machine/home/bin",
        "/smthrs-machine/home/bin/tool",
        "/smthrs-machine/tmp/state",
        "/tmp/elsewhere",
        machine.home
      ],
      gone: ["/smthrs-machine/tmp/old", "deps/old", `${machine.directory}/other`],
      outside: []
    })
    // The paths the run wrote stay the host's: the targets after it in this build read them there.
    expect(written.made).toBe(observation.made)
    const { id, ...rest } = written.record
    expect(id).toBe(ObservedReads.idOf(rest))
    expect(id).not.toBe(observation.record.id)
    // The same run on another host gives the same record.
    const elsewhere = Machine.named("/other/def", "/elsewhere/repo", "job")
    const moved = JSON.parse(JSON.stringify(observation.record).replaceAll(machine.directory, elsewhere.directory))
    expect(Machine.recorded({ ...observation, record: moved }, elsewhere).record).toEqual(written.record)
    // A run that read nothing a step before it wrote, and one whose files cannot be kept, keep what they have.
    const { given: _given, ...plain } = body
    const refused = Machine.recorded(
      { ...observation, record: { ...plain, id: "x" } as never, left: { refusal: "it left too much to keep" } },
      machine
    )
    expect(refused.record.given).toBeUndefined()
    expect(refused.left).toEqual({ refusal: "it left too much to keep" })
    const { left: _left, ...nothingLeft } = observation
    expect(Machine.recorded(nothingLeft, machine).left).toBeUndefined()
  })
})
