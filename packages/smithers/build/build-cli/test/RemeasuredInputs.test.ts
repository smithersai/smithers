/**
 * A result is stored and reused under the key of what its run could read.
 *
 * Every case plans and executes real targets with real processes in a
 * temporary workspace. A target's key is planned before anything runs, so a
 * target that waits for one that writes to the tree is measured again when it
 * starts, and a green result is stored only when its inputs still measure the
 * same after the run. A run that cannot measure again is supplied through the
 * execution services.
 */
import { Smithers as S } from "@smthrs/targets"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Effect from "effect/Effect"
import * as ChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Replanner } from "../src/internal/PackagePlanner.ts"
import { executeEffect, ExecutionServices, executionServicesLive, movedInput } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    await Fs.chmod(Path.join(root, "guarded"), 0o755).catch(() => undefined)
    await Fs.rm(root, { recursive: true, force: true })
  }
})

const posixIt = it.skipIf(process.platform === "win32")
/** True when this host can hold a run to the files it declares: bubblewrap on Linux, seatbelt on macOS. */
const confines = process.platform === "darwin" ||
  (process.platform === "linux" && ChildProcess.spawnSync("bwrap", ["--version"]).status === 0)
const confinedIt = it.skipIf(!confines)

type Targets = Parameters<typeof S.Package>[0]["targets"]

interface RunSettings {
  readonly services?: ExecutionServices
  /** Variables the run has beside its search path. */
  readonly environment?: Readonly<Record<string, string>>
  /** Digests the plan and the run share, as one invocation of the CLI shares them. */
  readonly digests?: SafeFs.DigestIndex
}

const fixture = async (targets: Targets, files: Readonly<Record<string, string>>) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-remeasured-")))
  temporary.push(root)
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
    await Fs.writeFile(Path.join(root, name), text, { mode })
  }
  for (const [name, text] of Object.entries(files)) await write(name, text)
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("remeasured", {
      repository: "git+https://example.invalid/remeasured.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets }) }]
  })
  const logs: Array<string> = []
  const options = (names: ReadonlyArray<string>, settings: RunSettings) => ({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: names.map((name) => `//:${name}`),
    environment: { PATH: "/usr/bin:/bin", ...settings.environment },
    // One target at a time, in plan order, so a case can say which measurement each target shares.
    jobs: 1,
    ...(settings.digests === undefined ? {} : { digests: settings.digests }),
    log: (line: string) => {
      logs.push(line)
    }
  })
  /** Plans and executes the named targets; answers each one's report by name. */
  const run = async (names: ReadonlyArray<string>, settings: RunSettings = {}) => {
    const summary = await Effect.runPromise(
      executeEffect(await plan(options(names, settings)), options(names, settings)).pipe(
        Effect.provideService(ExecutionServices, settings.services ?? executionServicesLive)
      )
    )
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result]))
  }
  const statuses = async (names: ReadonlyArray<string>, settings: RunSettings = {}): Promise<Record<string, string>> =>
    Object.fromEntries(Object.entries(await run(names, settings)).map(([name, result]) => [name, result.status]))
  /** The key a plan made now gives a target. */
  const key = async (name: string): Promise<string> =>
    (await plan(options([name], {}))).nodes.get(`//:${name}`)!.keyPreview
  return { root, write, run, statuses, key, logs }
}

/** A build that always runs, as an install or a formatter does, and writes nothing it declares. */
const always = (shell: string) =>
  S.Shell.Build({
    shell: `mkdir -p .flows/ci && : > .flows/ci/setup && ${shell}`,
    outFiles: ["//.flows/ci/setup"],
    cache: false,
    sandbox: "none",
    data: []
  })

/** Copies `config.txt` over a file the test declares. */
const rewrite = always("/bin/cat config.txt > src/a.txt")

const reads = (shell: string, data: ReadonlyArray<unknown>) =>
  S.Shell.Test({ shell, sandbox: "none", data: data as never })

/** Execution services whose replanner reports each call and can be made to fail. */
const counting = (fail: (call: number) => boolean = () => false) => {
  const calls: Array<string> = []
  const services: ExecutionServices = {
    ...executionServicesLive,
    replanner: (options, nodes, trees): Replanner => {
      const live = executionServicesLive.replanner(options, nodes, trees)
      return {
        plan: (node, settled, when, place) => {
          calls.push(`${node.label} ${when}`)
          return fail(calls.length)
            ? Promise.reject(new Error("the tree is gone"))
            : live.plan(node, settled, when, place)
        },
        close: () => live.close().then(() => Promise.reject(new Error("already closed")))
      }
    }
  }
  return { calls, services }
}

describe("a test after a build that rewrites one of its declared inputs", () => {
  posixIt("runs on the rewritten file and is never answered by a result for the file as planned", async () => {
    const test = reads("/usr/bin/grep -q one src/a.txt", [S.glob("//src/**"), rewrite])
    const { statuses, run, write } = await fixture({ rewrite, test }, { "config.txt": "one\n", "src/a.txt": "one\n" })
    expect(await statuses(["test"])).toEqual({ rewrite: "ran", test: "ran" })
    expect(await statuses(["test"])).toEqual({ rewrite: "ran", test: "hit" })
    // The plan measures src/a.txt holding "one"; the build then writes "two" into it.
    await write("config.txt", "two\n")
    expect((await run(["test"]))["test"]).toMatchObject({ status: "failed" })
    // Nothing was stored for the failure, and the file now holds "two" at plan time as well.
    expect(await statuses(["test"])).toEqual({ rewrite: "ran", test: "failed" })
  })

  posixIt("is stored under the key the next plan gives it, and says which file changed", async () => {
    const test = reads("/usr/bin/grep -q one src/a.txt", [S.glob("//src/**"), rewrite])
    const { key, logs, run, statuses, write } = await fixture({ rewrite, test }, {
      "config.txt": "one\n",
      "src/a.txt": "one\n"
    })
    expect(await statuses(["test"])).toEqual({ rewrite: "ran", test: "ran" })
    const planned = await key("test")
    await write("config.txt", "one more\n")
    const again = await run(["test"])
    expect(again["test"]).toMatchObject({ status: "ran" })
    expect(again["test"]!.notStored).toBeUndefined()
    expect(again["test"]!.key).not.toBe(planned)
    expect(logs).toContain(
      "//:test  planned again: src/a.txt changed since the plan"
    )
    // The run stored its result under the key of the file it read, which is what a plan now measures.
    expect(again["test"]!.key).toBe(await key("test"))
    expect(await statuses(["test"])).toEqual({ rewrite: "ran", test: "hit" })
  })

  posixIt("measures with the digests its invocation shares, settled or not", async () => {
    const test = reads("/usr/bin/grep -q one src/a.txt", [S.glob("//src/**"), rewrite])
    const { run, write } = await fixture({ rewrite, test }, { "config.txt": "one\n", "src/a.txt": "one\n" })
    // A clock ten seconds ahead: every file this index reads has settled.
    const settled = SafeFs.makeDigestIndex([], () => BigInt(Date.now() + 10_000) * 1_000_000n)
    expect((await run(["test"], { digests: settled }))["test"]).toMatchObject({ status: "ran" })
    await write("config.txt", "two\n")
    // The settled row for src/a.txt names the file before the build wrote it: its status changed, so it is read again.
    expect((await run(["test"], { digests: settled }))["test"]).toMatchObject({ status: "failed" })
    // The plan measures "two"; the build writes "one" back, and the first run's result answers for those bytes.
    await write("config.txt", "one\n")
    expect((await run(["test"], { digests: SafeFs.makeDigestIndex() }))["test"]).toMatchObject({ status: "hit" })
  })
})

describe("a target that asks to be observed, on a host that cannot observe", () => {
  posixIt("is keyed by its declared files, so it is measured again like any other", async () => {
    const test = S.Shell.Test({
      shell: "/usr/bin/grep -q one src/a.txt",
      sandbox: "none",
      observe: true,
      data: [S.glob("//src/**"), rewrite] as never
    })
    const { statuses, write } = await fixture({ rewrite, test }, { "config.txt": "one\n", "src/a.txt": "one\n" })
    const services: ExecutionServices = {
      ...executionServicesLive,
      observer: () => ({ reason: "no tracer on this host" })
    }
    expect(await statuses(["test"], { services })).toEqual({ rewrite: "ran", test: "ran" })
    expect(await statuses(["test"], { services })).toEqual({ rewrite: "ran", test: "hit" })
    await write("config.txt", "two\n")
    expect(await statuses(["test"], { services })).toEqual({ rewrite: "ran", test: "failed" })
  })
})

describe("the steps of one machine, where a step rewrites a file the next one declares", () => {
  posixIt("measures the file in the machine's tree, which is the one the step reads", async () => {
    const generate = S.Shell.Build({
      shell: "/bin/cat config.txt > src/a.txt",
      cache: false,
      sandbox: "none",
      machine: "job",
      data: []
    })
    const test = S.Shell.Test({
      shell: "/usr/bin/grep -q one src/a.txt",
      sandbox: "none",
      machine: "job",
      data: [S.glob("//src/**"), generate] as never
    })
    // The same check on a machine of its own, where no step writes the file.
    const apart = S.Shell.Test({
      shell: "/usr/bin/grep -q one src/a.txt",
      sandbox: "none",
      machine: "other",
      data: [S.glob("//src/**")] as never
    })
    const { root, statuses, write } = await fixture({ generate, test, apart }, {
      ".gitignore": ".flows\n",
      "config.txt": "one\n",
      "src/a.txt": "one\n"
    })
    // A real checkout: each machine starts from what git tracks.
    for (const args of [["init", "-q", "."], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
      const identity = ["-c", "user.name=remeasured", "-c", "user.email=remeasured@example.invalid"]
      expect(ChildProcess.spawnSync("git", [...identity, ...args], { cwd: root, encoding: "utf8" }).stderr).toBe("")
    }
    const machines = `${root}-machines`
    temporary.push(machines)
    const settings = { environment: { SMTHRS_MACHINES: machines } }
    const both = ["test", "apart"]
    expect(await statuses(both, settings)).toEqual({ generate: "ran", test: "ran", apart: "ran" })
    expect(await statuses(both, settings)).toEqual({ generate: "ran", test: "hit", apart: "hit" })
    // The workspace's src/a.txt holds "one" in every run: the step writes "two" into its machine's copy only.
    await write("config.txt", "two\n")
    expect(await statuses(both, settings)).toEqual({ generate: "ran", test: "failed", apart: "hit" })
    expect(await Fs.readFile(Path.join(root, "src/a.txt"), "utf8")).toBe("one\n")
    // The copy holds "one" again: the first run's result answers for those bytes.
    await write("config.txt", "one\n")
    expect(await statuses(both, settings)).toEqual({ generate: "ran", test: "hit", apart: "hit" })
  })
})

describe("the other ways a declared input changes under a target", () => {
  posixIt("not a file the target itself declares that it writes, written by a target it waits for", async () => {
    const early = always(": > src/made.txt")
    const build = S.Shell.Build({
      shell: "/bin/cat src/a.txt > src/made.txt",
      outFiles: ["//src/made.txt"],
      sandbox: "none",
      data: [S.glob("//src/**"), early]
    })
    const { key, logs, run } = await fixture({ early, build }, { "src/a.txt": "one\n" })
    const planned = await key("build")
    const first = await run(["build"])
    // The only file that differs from the plan is one the build writes: it keeps the key it was planned under.
    expect(first["build"]).toMatchObject({ status: "ran", key: planned })
    expect(logs.filter((line) => line.includes("planned again"))).toEqual([])
  })

  posixIt("a file a target it waits for adds to a declared directory", async () => {
    const add = always(": > \"src/$(/bin/cat config.txt)\"")
    const test = reads("test ! -e src/b.txt", [S.glob("//src/**"), add])
    const { statuses, write } = await fixture({ add, test }, { "config.txt": "a.txt", "src/a.txt": "" })
    expect(await statuses(["test"])).toEqual({ add: "ran", test: "ran" })
    expect(await statuses(["test"])).toEqual({ add: "ran", test: "hit" })
    await write("config.txt", "b.txt")
    expect(await statuses(["test"])).toEqual({ add: "ran", test: "failed" })
  })

  posixIt("a file a target it waits for deletes", async () => {
    const remove = always("/bin/rm -f \"src/$(/bin/cat config.txt)\"")
    const test = reads("test -e src/a.txt", [S.glob("//src/**"), S.file("//src/a.txt"), remove])
    const { statuses, write } = await fixture({ remove, test }, {
      "config.txt": "none",
      "src/a.txt": "",
      "src/keep.txt": ""
    })
    expect(await statuses(["test"])).toEqual({ remove: "ran", test: "ran" })
    expect(await statuses(["test"])).toEqual({ remove: "ran", test: "hit" })
    await write("config.txt", "a.txt")
    expect(await statuses(["test"])).toEqual({ remove: "ran", test: "failed" })
  })

  posixIt("a symbolic link a target it waits for points somewhere else", async () => {
    const retarget = always(
      "/bin/ln -sfn \"$(/bin/cat config.txt)\" current && /bin/ln -sfn \"$(/bin/cat config.txt)/a.txt\" pointer.txt"
    )
    const versions = [S.glob("//v1/**"), S.glob("//v2/**")]
    // A link to a directory is declared as the link; a link to a file is read as that file.
    const directory = reads("/usr/bin/grep -q one current/a.txt", [S.link("//current"), ...versions, retarget])
    const file = reads("/usr/bin/grep -q one pointer.txt", [S.file("//pointer.txt"), ...versions, retarget])
    const { root, statuses, write } = await fixture({ retarget, directory, file }, {
      "config.txt": "v1",
      "v1/a.txt": "one\n",
      "v2/a.txt": "two\n"
    })
    await Fs.symlink("v1", Path.join(root, "current"))
    await Fs.symlink("v1/a.txt", Path.join(root, "pointer.txt"))
    const both = ["directory", "file"]
    expect(await statuses(both)).toEqual({ retarget: "ran", directory: "ran", file: "ran" })
    expect(await statuses(both)).toEqual({ retarget: "ran", directory: "hit", file: "hit" })
    await write("config.txt", "v2")
    expect(await statuses(both)).toEqual({ retarget: "ran", directory: "failed", file: "failed" })
  })

  posixIt("a file it reads through a group of files", async () => {
    const sources = S.Filegroup({ srcs: [S.glob("//src/**")] })
    const test = reads("/usr/bin/grep -q one src/a.txt", [sources, rewrite])
    const { logs, statuses, write } = await fixture({ rewrite, sources, test }, {
      "config.txt": "one\n",
      "src/a.txt": "one\n"
    })
    expect(await statuses(["test"])).toMatchObject({ rewrite: "ran", test: "ran" })
    expect(await statuses(["test"])).toMatchObject({ rewrite: "ran", test: "hit" })
    await write("config.txt", "two\n")
    expect(await statuses(["test"])).toMatchObject({ rewrite: "ran", test: "failed" })
    // The test declares no file itself: what changed is behind the group.
    expect(logs).toContain(
      "//:test  planned again: what it reads through a target it waits for changed since the plan"
    )
  })

  posixIt("a file its import closure reaches", async () => {
    const generate = always("/bin/cat config.txt > src/b.ts")
    const closure = S.ImportClosure({ entries: S.glob(["//src/a.ts"]) })
    const test = reads("/usr/bin/grep -q one src/b.ts", [closure, generate])
    // A second target measured after the closure's reader, so a later measurement closes what this one opened.
    const after = reads("true", [S.file("//config.txt"), generate])
    const { statuses, write } = await fixture({ generate, closure, test, after }, {
      "config.txt": "export const b = \"one\"\n",
      "src/a.ts": "import { b } from \"./b.ts\"\nexport const a = b\n",
      "src/b.ts": "export const b = \"one\"\n"
    })
    const both = ["test", "after"]
    expect(await statuses(both)).toMatchObject({ generate: "ran", test: "ran", after: "ran" })
    expect(await statuses(both)).toMatchObject({ generate: "ran", test: "hit", after: "hit" })
    await write("config.txt", "export const b = \"two\"\n")
    expect(await statuses(both)).toMatchObject({ generate: "ran", test: "failed", after: "ran" })
  })

  posixIt("an input a target it waits for makes unreadable fails the target by name", async () => {
    const lock = always("/bin/chmod 000 guarded")
    const test = reads("true", [S.file("//guarded/input.txt"), lock])
    const later = reads("true", [S.file("//config.txt"), lock])
    const { root, run } = await fixture({ lock, test, later }, { "config.txt": "", "guarded/input.txt": "input\n" })
    const results = await run(["test", "later"])
    expect(results["test"]).toMatchObject({ status: "failed" })
    expect(results["test"]!.error).toContain("its inputs could not be measured again before it ran: ")
    expect(results["test"]!.error).toContain(
      `EACCES: permission denied, lstat '${Path.join(root, "guarded/input.txt")}'`
    )
    // The measurement that failed does not stand in the way of the next target's.
    expect(results["later"]).toMatchObject({ status: "ran" })
  })
})

describe("a target that reads what a build it waits for left", () => {
  confinedIt("is answered in a fresh checkout, where the build's output is put back before it starts", async () => {
    // Held to what it declares, so a result answered from the cache leaves all that its run left.
    const build = S.Shell.Build({
      shell: "/bin/cat config.txt > src/made.txt",
      outFiles: ["//src/made.txt"],
      data: [S.file("//config.txt")]
    })
    const test = reads("/usr/bin/grep -q one src/made.txt", [S.glob("//src/**"), build])
    // A second test names one file the build does not write.
    const beside = reads("true", [S.file("//src/a.txt"), build])
    const { logs, root, run, statuses } = await fixture({ build, test, beside }, {
      "config.txt": "one\n",
      "src/a.txt": ""
    })
    const both = ["test", "beside"]
    expect(await statuses(both)).toEqual({ build: "ran", test: "ran", beside: "ran" })
    // A fresh checkout holds no output of the build: the plan measures src without it.
    await Fs.rm(Path.join(root, "src/made.txt"))
    const { calls, services } = counting()
    expect(await statuses(both, { services })).toEqual({ build: "hit", test: "hit", beside: "hit" })
    // Only the test that can read the output is measured again, and it is keyed on the file put back.
    expect(calls).toEqual(["//:test afresh"])
    expect(logs).toContain("//:test  planned again: src/made.txt changed since the plan")
    expect(await Fs.readFile(Path.join(root, "src/made.txt"), "utf8")).toBe("one\n")
  })
})

describe("which targets are measured again after a build's output is put back", () => {
  confinedIt("the ones whose inputs can name that output, whatever kind of input names it", async () => {
    const build = S.Shell.Build({
      shell: "/bin/cat config.txt > src/made.txt",
      outFiles: ["//src/made.txt"],
      data: [S.file("//config.txt")]
    })
    const after = (data: ReadonlyArray<unknown>) => reads("true", [...data, build])
    const targets = {
      build,
      // Can name src/made.txt: a glob over its directory, a glob over the workspace, a group of such files.
      directory: after([S.glob("//src/**")]),
      workspace: after([S.glob("//**")]),
      sources: S.Filegroup({ srcs: [S.glob("//src/**")] }),
      grouped: after([S.Filegroup({ srcs: [S.glob("//src/**")] })]),
      // Taken to name it: what an import closure reaches and what an installation pins are not read from a path.
      closure: S.ImportClosure({ entries: S.glob(["//src/a.ts"]) }),
      closed: after([S.ImportClosure({ entries: S.glob(["//src/a.ts"]) })]),
      installed: after([S.nodeModules("//")]),
      // Cannot name it: another file, a link, a glob over another directory, a group of other files.
      file: after([S.file("//src/a.ts")]),
      link: after([S.link("//current")]),
      elsewhere: after([S.glob("//docs/**")]),
      apart: after([S.Filegroup({ srcs: [S.file("//config.txt")] })])
    }
    const { root, statuses } = await fixture(targets, {
      "config.txt": "one\n",
      "docs/readme.md": "",
      "package.json": "{}\n",
      "package-lock.json": "{}\n",
      "src/a.ts": "export const a = 1\n"
    })
    await Fs.symlink("docs", Path.join(root, "current"))
    const names = ["directory", "workspace", "grouped", "closed", "installed", "file", "link", "elsewhere", "apart"]
    const all = (status: string) => Object.fromEntries(names.map((name) => [name, status]))
    expect(await statuses(names)).toMatchObject({ build: "ran", ...all("ran") })
    await Fs.rm(Path.join(root, "src/made.txt"))
    const { calls, services } = counting()
    expect(await statuses(names, { services })).toMatchObject({ build: "hit", ...all("hit") })
    // A group of files is a target too, and is measured after its own turn; the ones named here are its readers.
    const measured = calls.map((call) => call.split(" ")[0]!).filter((label) => !label.startsWith("//:__private_"))
    expect(measured.sort()).toEqual([
      "//:closed",
      "//:directory",
      "//:grouped",
      "//:installed",
      "//:workspace"
    ])
  })
})

describe("a target nothing confines or observes, while a target waits for it", () => {
  /** Writes the output it declares and, from config.txt, a file it does not. */
  const building = (sandbox: "none" | undefined) =>
    S.Shell.Build({
      shell: "mkdir -p out && : > out/built && /bin/cat config.txt > src/gen.txt",
      outFiles: ["//out/built"],
      ...(sandbox === undefined ? {} : { sandbox }),
      data: [S.file("//config.txt")]
    })
  const files = { "config.txt": "one\n", "src/a.txt": "" }
  /** What a fresh checkout does not hold: everything the build wrote. */
  const checkout = async (root: string): Promise<void> => {
    await Fs.rm(Path.join(root, "src/gen.txt"), { force: true })
    await Fs.rm(Path.join(root, "out"), { recursive: true, force: true })
  }

  posixIt("runs again, so the file it writes and does not declare is there for the target after it", async () => {
    const build = building("none")
    const test = reads("/usr/bin/grep -q one src/gen.txt", [S.glob("//src/**"), build])
    const { logs, root, run } = await fixture({ build, test }, files)
    expect((await run(["test"]))["test"]).toMatchObject({ status: "ran" })
    await checkout(root)
    // A result answered from the cache would put back out/built and never write src/gen.txt.
    const again = await run(["test"])
    expect(again["build"]).toMatchObject({
      status: "ran",
      notReused: "nothing confines or observes its run, and a target that waits for it is in this run"
    })
    expect(again["test"]).toMatchObject({ status: "hit" })
    expect(logs).toContain("//:build  runs again: nothing confines or observes its run, and //:test waits for it")
    expect(await Fs.readFile(Path.join(root, "src/gen.txt"), "utf8")).toBe("one\n")
  })

  posixIt("is answered when no target waits for it, or only a group of targets does", async () => {
    const build = building("none")
    const check = reads("true", [S.file("//config.txt")])
    const suite = S.Suite({ tests: [check] })
    const { statuses } = await fixture({ build, check, suite }, files)
    expect(await statuses(["build", "suite"])).toMatchObject({ build: "ran", check: "ran" })
    expect(await statuses(["build", "suite"])).toMatchObject({ build: "hit", check: "hit" })
  })

  posixIt("counts, for a target on a machine, only the targets of that machine", async () => {
    const on = (machine: string, data: ReadonlyArray<unknown>) =>
      S.Shell.Test({ shell: "true", sandbox: "none", machine, data: data as never })
    const config = S.file("//config.txt")
    // One machine: the second step reads the copy the first one wrote in.
    const first = on("one", [config])
    const second = on("one", [config, first])
    // Two machines: neither sees the other's copy.
    const alone = on("two", [config])
    const apart = on("three", [config, alone])
    // The workspace: every machine made after it copies what it left.
    const shared = reads("true", [config])
    const copied = on("four", [config, shared])
    const { root, statuses } = await fixture({ first, second, alone, apart, shared, copied }, files)
    const machines = `${root}-machines`
    temporary.push(machines)
    const settings = { environment: { SMTHRS_MACHINES: machines } }
    const all = ["second", "apart", "copied"]
    const every = (status: string) => ({ first: status, second: status, alone: status, apart: status })
    expect(await statuses(all, settings)).toEqual({ ...every("ran"), shared: "ran", copied: "ran" })
    expect(await statuses(all, settings)).toEqual({ ...every("hit"), first: "ran", shared: "ran", copied: "hit" })
  })

  confinedIt("is answered once its run is confined: what it does not declare, it cannot write", async () => {
    // The same build, held to what it declares: the write it does not declare fails it.
    const undeclared = building(undefined)
    const build = S.Shell.Build({
      shell: "mkdir -p out && /bin/cat config.txt > out/built",
      outFiles: ["//out/built"],
      data: [S.file("//config.txt")]
    })
    const test = reads("/usr/bin/grep -q one out/built", [S.glob("//src/**"), build])
    const { root, run, statuses } = await fixture({ undeclared, build, test }, files)
    expect((await run(["undeclared"]))["undeclared"]).toMatchObject({ status: "failed" })
    expect(NodeFs.existsSync(Path.join(root, "src/gen.txt"))).toBe(false)
    expect(await statuses(["test"])).toEqual({ build: "ran", test: "ran" })
    await checkout(root)
    expect(await statuses(["test"])).toEqual({ build: "hit", test: "hit" })
    expect(await Fs.readFile(Path.join(root, "out/built"), "utf8")).toBe("one\n")
  })
})

describe("a result whose inputs changed while its run was under way", () => {
  posixIt("is not stored, and says which file changed", async () => {
    const test = reads("echo more >> src/a.txt", [S.glob("//src/**")])
    const { logs, run } = await fixture({ test }, { "src/a.txt": "one\n" })
    const unstored = { status: "ran", notStored: "its inputs changed while it ran" }
    expect((await run(["test"]))["test"]).toMatchObject(unstored)
    // Nothing answers the next run: it runs again, and its inputs change again.
    expect((await run(["test"]))["test"]).toMatchObject(unstored)
    expect(logs).toContain("//:test  not cached: its inputs changed while it ran: src/a.txt changed")
  })

  posixIt("is not stored when the file is behind a group of files", async () => {
    const sources = S.Filegroup({ srcs: [S.glob("//src/**")] })
    const test = reads("echo more >> src/a.txt", [sources])
    const { logs, run } = await fixture({ sources, test }, { "src/a.txt": "one\n" })
    expect((await run(["test"]))["test"]).toMatchObject({ status: "ran", notStored: "its inputs changed while it ran" })
    expect(logs).toContain(
      "//:test  not cached: its inputs changed while it ran: what it reads through a target it waits for changed"
    )
  })

  posixIt("is stored when all that changed is what the target declares it writes", async () => {
    // The build declares a directory it also writes into: after its run its own outputs are in it.
    const build = S.Shell.Build({
      shell: "/bin/cat src/a.txt > src/made.txt && mkdir -p src/out && /bin/cat src/a.txt > src/out/b.txt",
      outFiles: ["//src/made.txt"],
      outDirs: ["//src/out"],
      sandbox: "none",
      data: [S.glob("//src/**")]
    })
    const { logs, root, run, statuses, write } = await fixture({ build }, { "src/a.txt": "one\n" })
    const first = await run(["build"])
    expect(first["build"]).toMatchObject({ status: "ran" })
    expect(first["build"]!.notStored).toBeUndefined()
    expect(logs.filter((line) => line.includes("not cached"))).toEqual([])
    // A checkout without the outputs plans the same key: it is answered, and the outputs are put back.
    await Fs.rm(Path.join(root, "src/made.txt"))
    await Fs.rm(Path.join(root, "src/out"), { recursive: true })
    expect(await statuses(["build"])).toEqual({ build: "hit" })
    expect(await Fs.readFile(Path.join(root, "src/out/b.txt"), "utf8")).toBe("one\n")
    // A file it reads still decides its key.
    await write("src/a.txt", "two\n")
    expect(await statuses(["build"])).toEqual({ build: "ran" })
    expect(await Fs.readFile(Path.join(root, "src/made.txt"), "utf8")).toBe("two\n")
  })

  posixIt("is not stored when a file it reads changed beside what it writes, and names that file", async () => {
    const build = S.Shell.Build({
      shell: "echo more >> src/z.txt && /bin/cat src/z.txt > src/made.txt",
      outFiles: ["//src/made.txt"],
      sandbox: "none",
      data: [S.glob("//src/**")]
    })
    const { logs, run } = await fixture({ build }, { "src/z.txt": "one\n" })
    expect((await run(["build"]))["build"]).toMatchObject({
      status: "ran",
      notStored: "its inputs changed while it ran"
    })
    // src/made.txt changed too and sorts first; the file the build does not write is the one named.
    expect(logs).toContain("//:build  not cached: its inputs changed while it ran: src/z.txt changed")
  })

  posixIt("keeps the result of every target that waits for it out of the cache", async () => {
    const build = S.Shell.Build({
      shell: "echo more >> src/a.txt && mkdir -p out && : > out/built",
      outFiles: ["//out/built"],
      sandbox: "none",
      data: [S.glob("//src/**")]
    })
    // Between them, a step whose results are never stored.
    const step = always("true")
    const test = reads("true", [S.file("//config.txt"), build, step])
    const { run } = await fixture({ build, step, test }, { "config.txt": "", "src/a.txt": "one\n" })
    const results = await run(["test"])
    expect(results["build"]).toMatchObject({ status: "ran", notStored: "its inputs changed while it ran" })
    expect(results["test"]).toMatchObject({
      status: "ran",
      notStored: "the inputs of a target it waits for changed while that one ran"
    })
  })

  posixIt("is not stored for any shard of a sharded test", async () => {
    const test = S.Shell.Test({ script: S.file("//check.sh"), shards: 2, sandbox: "none", data: [S.glob("//src/**")] })
    const { run, write } = await fixture({ test }, { "src/a.txt": "one\n" })
    await write("check.sh", "echo more >> src/a.txt\n", 0o755)
    expect((await run(["test"]))["test"]).toMatchObject({ status: "ran", notStored: "its inputs changed while it ran" })
    expect((await run(["test"]))["test"]).toMatchObject({ status: "ran" })
  })
})

describe("what measuring again costs", () => {
  /** A build held to what it declares, whose result is stored, and two tests that wait for it. */
  const graph = () => {
    const build = S.Shell.Build({
      shell: "mkdir -p out && /bin/cat config.txt > out/built",
      outFiles: ["//out/built"],
      data: [S.file("//config.txt")]
    })
    const first = reads("true", [S.file("//src/a.txt"), build])
    // Another command: two targets that declare the same thing share one key.
    const second = reads(":", [S.file("//src/a.txt"), build])
    const alone = reads("true", [S.file("//src/a.txt")])
    return { build, first, second, alone }
  }

  confinedIt("nothing in a run where every target is answered from the cache", async () => {
    const { statuses, write } = await fixture(graph(), { "config.txt": "one\n", "src/a.txt": "one\n" })
    const all = ["first", "second", "alone"]
    expect(await statuses(all)).toEqual({ build: "ran", first: "ran", second: "ran", alone: "ran" })
    const { calls, services } = counting()
    expect(await statuses(all, { services })).toEqual({ build: "hit", first: "hit", second: "hit", alone: "hit" })
    expect(calls).toEqual([])
    // A target that runs alone is measured once, after its run.
    await write("src/a.txt", "two\n")
    expect(await statuses(["alone"], { services })).toEqual({ alone: "ran" })
    expect(calls).toEqual(["//:alone after"])
  })

  confinedIt("one measurement for each target that runs, shared by the targets that start together", async () => {
    const { run, statuses, write } = await fixture(graph(), { "config.txt": "one\n", "src/a.txt": "one\n" })
    const { calls, services } = counting()
    const results = await run(["first", "second"], { services })
    expect(Object.values(results).map((result) => result.status)).toEqual(["ran", "ran", "ran"])
    // The two tests in the order the run started them.
    const [earlier, later] = Object.keys(results).filter((name) => name !== "build")
    expect(calls).toEqual([
      // After the build's run, before its result is stored.
      "//:build after",
      // One test starts after the build wrote, and is measured again after its own run.
      `//:${earlier} afresh`,
      `//:${earlier} after`,
      // No target the other test waits for has written since: its start shares that measurement.
      `//:${later} shared`,
      `//:${later} after`
    ])
    // A changed build runs again, and the tests keyed on it run after it.
    await write("config.txt", "two\n")
    expect(await statuses(["first", "second"], { services })).toEqual({ build: "ran", first: "ran", second: "ran" })
    calls.length = 0
    expect(await statuses(["first", "second"], { services })).toEqual({ build: "hit", first: "hit", second: "hit" })
    expect(calls).toEqual([])
  })
})

describe("a run that cannot measure again", () => {
  posixIt("fails a target it could not measure before its run", async () => {
    const test = reads("true", [S.glob("//src/**"), rewrite])
    const { run } = await fixture({ rewrite, test }, { "config.txt": "one\n", "src/a.txt": "one\n" })
    const { services } = counting(() => true)
    expect((await run(["test"], { services }))["test"]).toMatchObject({
      status: "failed",
      error: "its inputs could not be measured again before it ran: the tree is gone"
    })
  })

  posixIt("stores nothing for a target it could not measure after its run", async () => {
    const test = reads("true", [S.glob("//src/**"), rewrite])
    const { logs, run } = await fixture({ rewrite, test }, { "config.txt": "one\n", "src/a.txt": "one\n" })
    // The first call measures the test before its run; the second, after it.
    const { services } = counting((call) => call === 2)
    expect((await run(["test"], { services }))["test"]).toMatchObject({
      status: "ran",
      notStored: "its inputs could not be measured again after it ran"
    })
    expect(logs).toContain(
      "//:test  not cached: its inputs could not be measured again after it ran: the tree is gone"
    )
  })
})

describe("movedInput", () => {
  const planner = (root: string, targets: Targets) => {
    const index = PackageIndex.make({
      root,
      workspace: S.Workspace("remeasured", {
        repository: "git+https://example.invalid/remeasured.git",
        cache: S.Cache({ directory: ".flows" })
      }),
      factory: undefined,
      packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets }) }]
    })
    return async (name: string) =>
      (await plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: [`//:${name}`] })).nodes.get(`//:${name}`)!
  }

  posixIt("names the first declared file that differs, by path", async () => {
    const test = reads("true", [S.glob("//src/**")])
    const { root, write } = await fixture({ test }, { "src/b.txt": "one\n", "src/c.txt": "one\n" })
    const node = planner(root, { test })
    const before = await node("test")
    expect(movedInput(before, before)).toBeUndefined()
    await write("src/c.txt", "two\n")
    await write("src/a.txt", "new\n")
    await Fs.rm(Path.join(root, "src/b.txt"))
    expect(movedInput(before, await node("test"))).toBe("src/a.txt changed")
  })

  posixIt("leaves out what the target declares that it writes: a file, a directory, its write set", async () => {
    const build = S.Shell.Build({
      shell: "true",
      outFiles: ["//src/made.txt"],
      outDirs: ["//src/out"],
      sandbox: "none",
      data: [S.glob("//src/**")]
    })
    const { root, write } = await fixture({ build }, { "src/a.txt": "one\n" })
    const node = planner(root, { build })
    const before = await node("build")
    await write("src/made.txt", "made\n")
    await write("src/out/b.txt", "made\n")
    await write("src/state/c.txt", "made\n")
    const made = await node("build")
    // The key holds the files; what the build read does not.
    expect(made.keyPreview).not.toBe(before.keyPreview)
    expect(movedInput(before, made)).toBe("src/state/c.txt changed")
    expect(movedInput({ ...before, writeSet: ["src/state"] }, made)).toBeUndefined()
    // A rule that names its outputs from a directory of its own.
    const named = { ...before, declaredOutputs: { cwd: "src", paths: ["state"] } } as typeof before
    expect(movedInput(named, made)).toBeUndefined()
    await write("src/a.txt", "two\n")
    expect(movedInput({ ...before, writeSet: ["src/state"] }, await node("build"))).toBe("src/a.txt changed")
  })

  posixIt("sees a file behind a group of files, and what the workspace pins", async () => {
    const sources = S.Filegroup({ srcs: [S.glob("//src/**")] })
    const test = reads("true", [sources])
    const { root, write } = await fixture({ sources, test }, { "src/a.txt": "one\n" })
    const node = planner(root, { sources, test })
    const before = await node("test")
    await write("src/a.txt", "two\n")
    expect(movedInput(before, await node("test"))).toBe("what it reads through a target it waits for changed")
    const pinned = {
      ...before,
      keyMaterial: { ...before.keyMaterial, inputs: { ...before.keyMaterial.inputs as object, ambient: "other" } }
    }
    expect(movedInput(before, pinned)).toBe("what the workspace pins or installs changed")
    // A bundler graph settles while the run is under way: no file decides it.
    const settled = {
      ...before,
      keyMaterial: {
        ...before.keyMaterial,
        inputs: { ...before.keyMaterial.inputs as object, bundlerGraph: "settled" }
      }
    }
    expect(movedInput(before, settled)).toBeUndefined()
  })
})
