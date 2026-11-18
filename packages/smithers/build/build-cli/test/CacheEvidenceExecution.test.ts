/**
 * Reusable test, type-check and lint results, end to end.
 *
 * Every case plans and executes real targets through the PACKAGE.ts surface.
 * The package manager, the runtime and the tools are small real programs in
 * the fixture: the tool runs the declared test file, and that file decides
 * the verdict from what it reads, so an undeclared read, an undeclared write
 * and a failure are things the tool really does. Confinement is the host's
 * own bubblewrap, so the cases that need it run on Linux hosts that have it.
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  dependencyOutputPaths,
  executeEffect,
  ExecutionServices,
  executionServicesLive,
  sandboxRequest
} from "../src/internal/PackageRunner.ts"
import { execute, plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/** Whether this host can confine a run under a scratch layer: Linux with bubblewrap. */
const provable = ExecSandbox.enforceable(
  { policy: undefined, reads: [], writes: [], scratch: true },
  ExecSandbox.host()
)
const confinedIt = it.skipIf(!provable)
const posixIt = it.skipIf(process.platform === "win32")

/** The directory holding the host's bubblewrap, when it has one. */
const mechanismDirectory = (process.env["PATH"] ?? "").split(Path.delimiter)
  .find((directory) => Path.isAbsolute(directory) && NodeFs.existsSync(Path.join(directory, "bwrap")))

/**
 * Runs `body` with the process search path set to `path`. A target body
 * resolves its package manager from the process, and the sandbox mechanism is
 * found there too, so an execution sees exactly the programs its plan keyed.
 */
const withPath = async <A>(path: string, body: () => Promise<A>): Promise<A> => {
  const previous = process.env["PATH"]
  process.env["PATH"] = path
  try {
    return await body()
  } finally {
    process.env["PATH"] = previous
  }
}

const rules = ["test", "node", "check", "lint"] as const
type Rule = typeof rules[number]

/** The installed program each rule's tool run starts. */
/** The start of every test file: the verdict comes from the declared source, and a source without a value fails. */
const verdict = "set -e\ncase \"$(/bin/cat source.ts)\" in *value*) ;; *) exit 1 ;; esac\n"

const toolOf: Record<Rule, string> = { test: "vitest", node: "runner/lib.txt", check: "vibelang", lint: "eslint" }

interface FixtureOptions {
  /** `off` declares `S.Sandbox.None()`; `default` declares nothing, so the platform's mechanism confines. */
  readonly confinement?: "off" | "default"
  /** Lines the test file runs after its own check. */
  readonly behaviour?: string
  /** Extra declared inputs of every target, relative to the package. */
  readonly data?: ReadonlyArray<string>
  /** Whether the package depends on a build whose output differs on every run. */
  readonly unstableDependency?: boolean
  /** Whether that build also patches an installed package, after the plan measured it. */
  readonly patchesInstalledTree?: boolean
  /** Where the tools start; the root package when `.`. */
  readonly cwd?: string
}

const fixture = async (options: FixtureOptions = {}) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-cache-evidence-run-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const tools = Path.join(base, "tools", "bin")
  const cwd = options.cwd ?? "pkg"
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    const file = Path.isAbsolute(name) ? name : Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text, { mode })
    await Fs.chmod(file, mode)
  }
  const inPackage = (name: string): string => Path.posix.join(cwd, name)
  // The manager resolves a tool from the directory it starts in, as `pnpm exec` does.
  await write(
    Path.join(tools, "pnpm"),
    "#!/bin/sh\nif [ \"$1\" = exec ]; then shift; tool=\"$1\"; shift; exec \"./node_modules/.bin/$tool\" \"$@\"; fi\n" +
      "printf '11.21.0\\n'\n",
    0o755
  )
  // The runtime's own test runner runs the files it is handed.
  await write(
    Path.join(tools, "node"),
    "#!/bin/sh\nif [ \"$1\" = --test ]; then shift; exec /bin/sh \"$@\"; fi\nprintf '26.4.0\\n'\n",
    0o755
  )
  await write("package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  if (cwd !== ".") await write(inPackage("package.json"), "{\"name\":\"pkg\"}\n")
  await write(inPackage("source.ts"), "export const value = 1\n")
  await write(inPackage("config.json"), "{}\n")
  await write(inPackage("data.txt"), "data\n")
  await write(inPackage("README.md"), "unrelated\n")
  await write(inPackage("case.test.ts"), `${verdict}${options.behaviour ?? ""}\n`)
  for (const tool of ["vitest", "vibelang", "eslint"]) {
    await write(inPackage(`node_modules/.bin/${tool}`), "#!/bin/sh\nset -e\n. ./case.test.ts\n", 0o755)
  }
  await write(inPackage("node_modules/runner/lib.txt"), "installed\n")
  const data = (options.data ?? []).map((name) => S.file(name))
  const unstable = S.Shell.Build({
    // A shell form starts in the workspace root; its outputs are declared from the package.
    shell: `/bin/mkdir -p ${cwd}/dist && /bin/date +%s%N > ${cwd}/dist/stamp.txt` +
      (options.patchesInstalledTree === true ? ` && echo patched >> ${cwd}/node_modules/runner/lib.txt` : ""),
    outDirs: ["dist"],
    cache: false,
    sandbox: "none"
  })
  const deps = options.unstableDependency === true ? [unstable] : []
  const sources = [S.file("source.ts"), ...data]
  const targets = {
    ...(options.unstableDependency === true ? { unstable } : {}),
    test: S.Vitest({
      tests: [S.file("case.test.ts")],
      sources,
      deps,
      config: S.file("config.json"),
      environment: "node",
      passWithNoTests: false,
      cwd
    }),
    node: S.NodeTest({ runner: S.testRunner([S.file("case.test.ts")]), srcs: sources, deps: [], cwd }),
    asserted: S.NodeTest({ runner: S.testRunner([S.file("case.test.ts")]), srcs: sources, deps: [], cwd, cache: true }),
    check: S.Typecheck({
      srcs: [S.file("case.test.ts"), ...sources],
      deps: [],
      tsconfig: S.file("config.json"),
      buildMode: false,
      incremental: false,
      cwd
    }),
    lint: S.EsLint({
      sources: [S.file("case.test.ts"), ...sources],
      deps: [],
      configs: [S.file("config.json")],
      maxWarnings: 0,
      fix: false,
      cwd
    })
  }
  const packagePath = cwd === "." ? "" : cwd
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("evidence", {
      repository: "git+https://example.invalid/evidence.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=26.4.0", executable: Path.join(tools, "node") }),
      packageManager: S.PackageManager.Pnpm({
        manifest: S.file("//package.json"),
        lockfile: S.file("//pnpm-lock.yaml"),
        version: "11.21.0"
      }),
      nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
      ...(options.confinement === "default" ? {} : { sandboxes: S.Sandboxes({ default: S.Sandbox.None() }) })
    }),
    factory: undefined,
    packages: [{
      file: Path.posix.join(packagePath, "PACKAGE.ts"),
      packagePath,
      value: S.Package({ targets })
    }]
  })
  const environment = {
    PATH: [tools, ...(mechanismDirectory === undefined ? [] : [mechanismDirectory])].join(Path.delimiter)
  }
  const label = (name: string): string => `//${packagePath}:${name}`
  const planned = (names: ReadonlyArray<string>) =>
    plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: names.map(label), environment })
  const logs: Array<string> = []
  /** Plans and executes the named targets; answers each one's status by name. */
  const run = async (...names: ReadonlyArray<string>): Promise<Record<string, string>> => {
    const summary = await withPath(environment.PATH, async () =>
      execute(await planned(names), {
        index,
        cacheDirectory: ".flows",
        verb: "auto",
        patterns: names.map(label),
        environment,
        log: (line) => logs.push(line)
      }))
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  const node = async (name: string) => (await planned([name])).nodes.get(label(name))!
  const attempts = async (): Promise<ReadonlyArray<{ readonly label: string; readonly at: number }>> => {
    const directory = Path.join(root, ".flows", "evidence")
    const names = await Fs.readdir(directory).catch(() => [])
    return Promise.all(names.map(async (name) => JSON.parse(await Fs.readFile(Path.join(directory, name), "utf8"))))
  }
  return { root, tools, write, inPackage, run, node, planned, logs, attempts, label, index, environment }
}

describe("a plan", () => {
  posixIt.each(rules)("keys %s on the installed tree and the manifest its tool starts from", async (name) => {
    const { write, inPackage, node } = await fixture()
    const original = await node(name)
    expect(original.refusal).toBeUndefined()
    expect(original.installedTrees).toEqual(["pkg/node_modules"])
    expect(original.readSet).toContain("pkg/package.json")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    const moves = async (file: string, changed: string, restored: string): Promise<void> => {
      const mode = file.includes("/.bin/") ? 0o755 : 0o644
      await write(file, changed, mode)
      expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
      await write(file, restored, mode)
      expect((await node(name)).keyPreview).toBe(original.keyPreview)
    }
    // The tool's own bytes, a package it can import, and the manifest it resolves from.
    await moves(inPackage("node_modules/.bin/vitest"), "#!/bin/sh\nexit 0\n", "#!/bin/sh\nset -e\n. ./case.test.ts\n")
    await moves(inPackage("node_modules/runner/lib.txt"), "patched\n", "installed\n")
    await moves(inPackage("package.json"), "{\"name\":\"pkg\",\"type\":\"module\"}\n", "{\"name\":\"pkg\"}\n")
    // A tool's scratch state inside the tree is not key material.
    await write(inPackage("node_modules/.vite/results.json"), "{}")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
  })

  posixIt("plans evidence for a complete contract and says why another is never reused", async () => {
    const { node, index, root, environment } = await fixture()
    for (const name of rules) {
      const planned = await node(name)
      expect(planned.cacheable).toBe(true)
      expect(planned.evidence).toEqual({ mode: "attempt" })
      expect(planned.uncachedBecause).toBeUndefined()
    }
    const confined = await fixture({ confinement: "default" })
    expect((await confined.node("test")).evidence).toEqual({ mode: "declared" })

    const variants = {
      unconfined: S.Vitest({
        tests: [S.file("case.test.ts")],
        sources: [],
        deps: [],
        config: null,
        environment: "node",
        passWithNoTests: false,
        sandbox: "none",
        cwd: "pkg"
      }),
      incremental: S.Typecheck({
        srcs: [],
        deps: [],
        tsconfig: S.file("config.json"),
        buildMode: false,
        incremental: true,
        cwd: "pkg"
      }),
      fixing: S.EsLint({ sources: [], deps: [], configs: [], maxWarnings: 0, fix: true, cwd: "pkg" }),
      asserted: S.NodeTest({
        runner: S.testRunner([S.file("case.test.ts")]),
        srcs: [],
        deps: [],
        cwd: "pkg",
        cache: true
      }),
      refused: S.NodeTest({
        runner: S.testRunner([S.file("case.test.ts")]),
        srcs: [],
        deps: [],
        cwd: "pkg",
        cache: false
      })
    }
    const other = PackageIndex.make({
      root,
      workspace: index.workspace,
      factory: undefined,
      packages: [{ file: "pkg/PACKAGE.ts", packagePath: "pkg", value: S.Package({ targets: variants }) }]
    })
    const nodes = (await plan({
      index: other,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: Object.keys(variants).map((name) => `//pkg:${name}`),
      environment
    })).nodes
    expect(nodes.get("//pkg:unconfined")).toMatchObject({ cacheable: false })
    expect(nodes.get("//pkg:unconfined")!.uncachedBecause).toContain("sandbox: \"none\"")
    expect(nodes.get("//pkg:incremental")!.uncachedBecause).toContain("build info")
    expect(nodes.get("//pkg:incremental")!.cacheable).toBe(false)
    expect(nodes.get("//pkg:fixing")!.uncachedBecause).toContain("fix mode")
    // A declaration that asserts its own completeness keeps that promise and gathers no evidence.
    expect(nodes.get("//pkg:asserted")).toMatchObject({ cacheable: true })
    expect(nodes.get("//pkg:asserted")!.evidence).toBeUndefined()
    expect(nodes.get("//pkg:asserted")!.uncachedBecause).toBeUndefined()
    // A declaration that refuses caching runs as the workspace declares: no confined attempt, nothing stored.
    expect(nodes.get("//pkg:refused")!.cacheable).toBe(false)
    expect(nodes.get("//pkg:refused")!.evidence).toBeUndefined()
    expect(nodes.get("//pkg:refused")!.uncachedBecause).toBe("the target declares cache: false")
  })

  posixIt("never reuses a result over a tree it could not measure, and skips a tree that is not there", async () => {
    const { root, inPackage, node, write } = await fixture()
    // Deeper than any installed tree: measuring fails, so the contract is incomplete.
    await write(inPackage(`node_modules/deep/${Array.from({ length: 140 }, () => "d").join("/")}/leaf.txt`), "x")
    const unmeasured = await node("test")
    expect(unmeasured.cacheable).toBe(false)
    expect(unmeasured.evidence).toBeUndefined()
    expect(unmeasured.uncachedBecause).toContain("the installed tree pkg/node_modules could not be identified")
    expect(unmeasured.installedTrees).toBeUndefined()
    // A declaration's own assertion does not cover a tree the key could not include.
    expect((await node("asserted")).cacheable).toBe(false)
    await Fs.rm(Path.join(root, inPackage("node_modules/deep")), { recursive: true })
    expect((await node("asserted")).cacheable).toBe(true)
    // A link to nowhere where a tree could be: nothing is installed there.
    await Fs.symlink("missing-install", Path.join(root, "node_modules"))
    const measured = await node("test")
    expect(measured.cacheable).toBe(true)
    expect(measured.installedTrees).toEqual(["pkg/node_modules"])
  })

  posixIt("keys a tool that starts in the workspace root, with or without a manifest there", async () => {
    const { node } = await fixture({ cwd: "." })
    const original = await node("test")
    expect(original.installedTrees).toEqual(["node_modules"])
    expect(original.readSet).toContain("package.json")
    const nested = await fixture()
    await Fs.rm(Path.join(nested.root, "pkg/package.json"))
    expect((await nested.node("test")).readSet).not.toContain("pkg/package.json")
  })

  posixIt("reports a remembered-tree file it cannot save and plans all the same", async () => {
    const { root, index, environment } = await fixture()
    await Fs.mkdir(Path.join(root, ".flows", "plan", "installed-trees.json"), { recursive: true })
    // A unit is remembered only once its last change is two seconds old.
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const logs: Array<string> = []
    const planned = await plan({
      index,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//pkg:test"],
      environment,
      log: (line) => logs.push(line)
    })
    expect(planned.nodes.get("//pkg:test")!.cacheable).toBe(true)
    expect(logs.join("\n")).toContain("could not remember installed trees")
  })
})

describe("a confined run", () => {
  confinedIt.each(rules)(
    "stores %s once it ran confined, and answers until something it reads changes",
    async (name) => {
      const { write, inPackage, run, root } = await fixture()
      expect(await run(name)).toEqual({ [name]: "ran" })
      expect(await run(name)).toEqual({ [name]: "hit" })
      const misses = async (file: string, text: string): Promise<void> => {
        await write(file, text, file.includes("/.bin/") ? 0o755 : 0o644)
        expect(await run(name)).toEqual({ [name]: "ran" })
        expect(await run(name)).toEqual({ [name]: "hit" })
      }
      await misses(inPackage("source.ts"), "export const value = 2\n")
      await misses(inPackage("case.test.ts"), `${verdict}# another case\n`)
      if (name !== "node") await misses(inPackage("config.json"), "{\"changed\":true}\n")
      await misses("pnpm-lock.yaml", "lockfileVersion: '9.0'\n# relocked\n")
      // The tool's own bytes under an unchanged lockfile.
      await misses(
        inPackage(`node_modules/${name === "node" ? toolOf.node : `.bin/${toolOf[name]}`}`),
        name === "node" ? "patched\n" : "#!/bin/sh\nset -e\n. ./case.test.ts\n# patched\n"
      )
      // A file no declaration names changes nothing.
      await write(inPackage("README.md"), "still unrelated\n")
      expect(await run(name)).toEqual({ [name]: "hit" })
      expect(NodeFs.existsSync(Path.join(root, ".flows", "evidence"))).toBe(false)
    }
  )

  confinedIt("never reuses a failed run, and reuses the green one again once the failure is gone", async () => {
    const { write, inPackage, run, attempts } = await fixture()
    await write(inPackage("source.ts"), "export const broken = 1\n")
    expect(await run("test")).toEqual({ test: "failed" })
    expect(await run("test")).toEqual({ test: "failed" })
    // Red confined and red unconfined is a failure, not a suite that cannot be confined.
    expect(await attempts()).toEqual([])
    await write(inPackage("source.ts"), "export const value = 1\n")
    expect(await run("test")).toEqual({ test: "ran" })
    await write(inPackage("source.ts"), "export const broken = 1\n")
    expect(await run("test")).toEqual({ test: "failed" })
    await write(inPackage("source.ts"), "export const value = 1\n")
    expect(await run("test")).toEqual({ test: "hit" })
  })

  confinedIt("never reuses a run that read a file its declaration does not name", async () => {
    const { write, inPackage, run, logs, attempts } = await fixture({ behaviour: "/bin/cat data.txt > /dev/null" })
    // Confined, the file is not there; as the workspace declares, it is. The verdict stands and nothing is stored.
    expect(await run("test")).toEqual({ test: "ran" })
    expect(logs.join("\n")).toContain(
      "//pkg:test  not cached: it passed, but failed when confined to its declared inputs"
    )
    expect(logs.join("\n")).toContain("pkg/data.txt is outside the declared read set")
    const [first] = await attempts()
    expect(first).toMatchObject({ label: "//pkg:test", denied: ["pkg/data.txt is outside the declared read set"] })
    expect(await run("test")).toEqual({ test: "ran" })
    // The declaration did not change, so the second run did not attempt again, and said why it stored nothing.
    expect(await attempts()).toEqual([first])
    const reasons = logs.filter((line) => line.includes("not cached"))
    expect(reasons.length).toBe(2)
    expect(reasons[1]).toContain(
      "//pkg:test  not cached: it passed, but failed when confined to its declared inputs, on an earlier run"
    )
    expect(reasons[1]).toContain("The confined run's output is in .flows/evidence/")
    // The undeclared file moves and the key does not: a stored result here would be stale.
    await write(inPackage("data.txt"), "other data\n")
    expect(await run("test")).toEqual({ test: "ran" })
    // An edit to a declared source is a new key and the same declaration: still no second attempt.
    await write(inPackage("source.ts"), "export const value = 3\n")
    expect(await run("test")).toEqual({ test: "ran" })
    expect(await attempts()).toEqual([first])
    // Declared, the same read is keyed, the run passes confined, and the result is reused.
    const declared = await fixture({ behaviour: "/bin/cat data.txt > /dev/null", data: ["data.txt"] })
    expect(await declared.run("test")).toEqual({ test: "ran" })
    expect(await declared.run("test")).toEqual({ test: "hit" })
    await declared.write(declared.inPackage("data.txt"), "other data\n")
    expect(await declared.run("test")).toEqual({ test: "ran" })
  })

  confinedIt("fails a run that reads an undeclared file where the workspace confines its build", async () => {
    const { run, attempts } = await fixture({ confinement: "default", behaviour: "/bin/cat data.txt > /dev/null" })
    expect(await run("test")).toEqual({ test: "failed" })
    expect(await run("test")).toEqual({ test: "failed" })
    expect(await attempts()).toEqual([])
    const declared = await fixture({ confinement: "default" })
    expect(await declared.run("test")).toEqual({ test: "ran" })
    expect(await declared.run("test")).toEqual({ test: "hit" })
  })

  confinedIt("never reuses a run whose tool is missing", async () => {
    const { root, inPackage, run, write } = await fixture()
    await Fs.rm(Path.join(root, inPackage("node_modules/.bin/vitest")))
    expect(await run("test")).toEqual({ test: "failed" })
    expect(await run("test")).toEqual({ test: "failed" })
    expect(NodeFs.existsSync(Path.join(root, ".flows", "evidence"))).toBe(false)
    await write(inPackage("node_modules/.bin/vitest"), "#!/bin/sh\nset -e\n. ./case.test.ts\n", 0o755)
    expect(await run("test")).toEqual({ test: "ran" })
  })

  confinedIt("lets a tool write beside its inputs into a layer the host never sees", async () => {
    for (const confinement of ["off", "default"] as const) {
      const { root, inPackage, run } = await fixture({
        confinement,
        behaviour:
          "echo sidecar > source.d.ts\n/bin/cat source.d.ts > /dev/null\n/bin/mkdir -p node_modules/.vite-temp\n" +
          "echo config > node_modules/.vite-temp/config.mjs"
      })
      expect(await run("test")).toEqual({ test: "ran" })
      expect(await run("test")).toEqual({ test: "hit" })
      expect(NodeFs.existsSync(Path.join(root, inPackage("source.d.ts")))).toBe(false)
      expect(NodeFs.existsSync(Path.join(root, inPackage("node_modules/.vite-temp")))).toBe(false)
    }
  })

  confinedIt("hides a tool's own state inside an installed tree from the run", async () => {
    const { write, inPackage, run } = await fixture({ behaviour: "test ! -e node_modules/.vite/results.json" })
    await write(inPackage("node_modules/.vite/results.json"), "{}")
    expect(await run("test")).toEqual({ test: "ran" })
    expect(await run("test")).toEqual({ test: "hit" })
  })

  confinedIt("shows a run's output once, whether its confined attempt passed or failed", async () => {
    const passed = await fixture({ behaviour: "echo run-output" })
    expect(await passed.run("test")).toEqual({ test: "ran" })
    expect(passed.logs.filter((line) => line.includes("run-output"))).toEqual(["//pkg:test: run-output"])
    // The failed attempt printed the line too; only the run that gave the verdict is shown.
    const failed = await fixture({ behaviour: "echo run-output\n/bin/cat data.txt > /dev/null" })
    expect(await failed.run("test")).toEqual({ test: "ran" })
    expect(failed.logs.filter((line) => line.includes("run-output"))).toEqual(["//pkg:test: run-output"])
  })

  confinedIt("tells a test runner to stop at its first failure only on an attempt it would discard", async () => {
    const reports = "case \" $* \" in *\" --bail=1 \"*) echo stops-early ;; *) echo runs-all ;; esac"
    const lines = (logs: ReadonlyArray<string>): ReadonlyArray<string> =>
      logs.filter((line) => line.includes("stops-early") || line.includes("runs-all"))
    // The attempt passes: it is the verdict, and it ran with the flag.
    const passed = await fixture({ behaviour: reports })
    expect(await passed.run("test")).toEqual({ test: "ran" })
    expect(lines(passed.logs)).toEqual(["//pkg:test: stops-early"])
    // The attempt fails: the verdict is the workspace's own run, which runs every case.
    const failed = await fixture({ behaviour: `${reports}\n/bin/cat data.txt > /dev/null` })
    expect(await failed.run("test")).toEqual({ test: "ran" })
    expect(lines(failed.logs)).toEqual(["//pkg:test: runs-all"])
    // A workspace that confines its build has no attempt to discard.
    const declared = await fixture({ confinement: "default", behaviour: reports })
    expect(await declared.run("test")).toEqual({ test: "ran" })
    expect(lines(declared.logs)).toEqual(["//pkg:test: runs-all"])
    // Another rule's tool is started as declared.
    const lint = await fixture({ behaviour: reports })
    expect(await lint.run("lint")).toEqual({ lint: "ran" })
    expect(lines(lint.logs)).toEqual(["//pkg:lint: runs-all"])
  })

  confinedIt("says nothing was denied when a confined run fails for another reason", async () => {
    // The confined run gets a private home; the workspace's own run does not.
    const { run, logs, attempts } = await fixture({ behaviour: "test \"$HOME\" != /tmp/home" })
    expect(await run("test")).toEqual({ test: "ran" })
    const line = logs.find((entry) => entry.includes("not cached"))!
    expect(line).toContain(
      "failed when confined to its declared inputs; the confined run's output is in .flows/evidence/"
    )
    expect((await attempts())[0]).toMatchObject({ label: "//pkg:test", denied: [] })
  })

  confinedIt("still reports the verdict when the failed attempt cannot be remembered", async () => {
    const { root, run, write } = await fixture({ behaviour: "/bin/cat data.txt > /dev/null" })
    // A file where the records belong.
    await write(".flows/evidence", "not a directory\n")
    expect(await run("test")).toEqual({ test: "ran" })
    expect((await Fs.stat(Path.join(root, ".flows", "evidence"))).isFile()).toBe(true)
    // Nothing was remembered, so the next run attempts again and still stores nothing.
    expect(await run("test")).toEqual({ test: "ran" })
  })

  confinedIt("answers only while a dependency's output still measures as the run saw it", async () => {
    const { root, run } = await fixture({ unstableDependency: true })
    expect(await run("test")).toEqual({ unstable: "ran", test: "ran" })
    // The dependency's key is unchanged and its output is not: the stored result read other bytes.
    expect(await run("test")).toEqual({ unstable: "ran", test: "ran" })
    const stored = NodeFs.readdirSync(Path.join(root, ".flows", "cache"), { recursive: true })
      .filter((name) => String(name).endsWith(".json"))
    expect(stored.length).toBe(1)
    const entry = JSON.parse(await Fs.readFile(Path.join(root, ".flows", "cache", String(stored[0])), "utf8"))
    expect(entry.output.kind).toBe("evidence")
    expect(entry.output.reads).toEqual([["pkg/dist", expect.stringMatching(/^[0-9a-f]{64}$/)]])
  })

  confinedIt("treats a stored entry without evidence, or with a result it cannot decode, as a miss", async () => {
    const { root, run } = await fixture()
    expect(await run("test")).toEqual({ test: "ran" })
    const [name] = NodeFs.readdirSync(Path.join(root, ".flows", "cache"), { recursive: true })
      .filter((entry) => String(entry).endsWith(".json"))
    const file = Path.join(root, ".flows", "cache", String(name))
    const entry = JSON.parse(await Fs.readFile(file, "utf8"))
    await Fs.writeFile(file, JSON.stringify({ ...entry, output: entry.output.result }))
    expect(await run("test")).toEqual({ test: "ran" })
    expect(await run("test")).toEqual({ test: "hit" })
    await Fs.writeFile(file, JSON.stringify({ ...entry, output: { ...entry.output, result: { not: "a result" } } }))
    expect(await run("test")).toEqual({ test: "ran" })
  })

  confinedIt("stores nothing over an installed tree that holds a link out of the workspace or is one", async () => {
    const outward = await fixture()
    await Fs.symlink("/usr", Path.join(outward.root, "pkg/node_modules/outward"))
    const request = sandboxRequest(
      await outward.node("test"),
      new Map(),
      outward.index.workspace,
      ".flows",
      [],
      outward.root
    )
    expect(request.reads).toContain("pkg/node_modules")
    expect(request.scratch).toBe(true)
    expect(request.mechanism).toBeUndefined()
    // Granted whole, the tree shows a tool's own state too, which no key covers.
    expect(await outward.run("test")).toEqual({ test: "ran" })
    expect(await outward.run("test")).toEqual({ test: "ran" })
    const whyNot = "//pkg:test  not cached: an installed tree is a link or links out of the workspace: " +
      "pkg/node_modules; a run cannot be shown only the entries its key measures"
    expect(outward.logs.filter((line) => line.includes("not cached"))).toEqual([whyNot, whyNot])

    const linked = await fixture()
    const shared = Path.join(Path.dirname(linked.root), "shared", "node_modules")
    await Fs.mkdir(Path.dirname(shared), { recursive: true })
    await Fs.rename(Path.join(linked.root, "pkg/node_modules"), shared)
    await Fs.symlink(shared, Path.join(linked.root, "pkg/node_modules"))
    const whole = sandboxRequest(
      await linked.node("test"),
      new Map(),
      linked.index.workspace,
      ".flows",
      [],
      linked.root
    )
    expect(whole.reads).toContain("pkg/node_modules")
    expect(whole.links ?? []).toEqual([])
    expect(await linked.run("test")).toEqual({ test: "ran" })
    expect(await linked.run("test")).toEqual({ test: "ran" })
    expect(linked.logs.filter((line) => line.includes("not cached: an installed tree is a link")).length).toBe(2)
    // The end of each run counts the result it did not store.
    expect(linked.logs).toContain("1 result not stored: 1 an installed tree is a link or links out of the workspace")
  })

  confinedIt("hides a tree installed after the plan, which no key measured", async () => {
    const { root, node, index, write } = await fixture()
    const planned = await node("test")
    await write("node_modules/late/index.js", "export {}\n")
    const scratch = sandboxRequest(planned, new Map(), index.workspace, ".flows", [], root)
    expect(scratch.reads.filter((read) => read.startsWith("node_modules"))).toEqual([])
    // A run without the layer is granted every tree above its directory, as before.
    expect(sandboxRequest(planned, new Map(), index.workspace, ".flows").reads).toContain("node_modules")
    // A keyed tree that is gone by the time the run is confined cannot be shown entry by entry.
    await Fs.rename(Path.join(root, "pkg/node_modules"), Path.join(root, "pkg/removed"))
    expect(sandboxRequest(planned, new Map(), index.workspace, ".flows", [], root).reads).toContain("pkg/node_modules")
  })

  confinedIt("confines a program that has no installed tree above it", async () => {
    const { root, run, node } = await fixture()
    await Fs.rm(Path.join(root, "pkg/node_modules"), { recursive: true })
    expect((await node("node")).installedTrees).toBeUndefined()
    expect(await run("node")).toEqual({ node: "ran" })
    expect(await run("node")).toEqual({ node: "hit" })
  })

  posixIt("keeps a declaration's own assertion: its result is stored without a confined run", async () => {
    const { run, logs, attempts } = await fixture({ behaviour: "/bin/cat data.txt > /dev/null" })
    // The program reads a file its declaration does not name, and `cache: true` asserts it does not.
    expect(await run("asserted")).toEqual({ asserted: "ran" })
    expect(await run("asserted")).toEqual({ asserted: "hit" })
    expect(logs.filter((line) => line.includes("not cached"))).toEqual([])
    expect(await attempts()).toEqual([])
  })

  confinedIt("keys a run on the installed tree a dependency left, not on the one the plan measured", async () => {
    // The dependency runs after the plan and patches a package the test can read.
    const { root, run, logs, node, environment } = await fixture({
      unstableDependency: true,
      patchesInstalledTree: true
    })
    // Planned under the search path the run plans under.
    const key = () => withPath(environment.PATH, async () => (await node("test")).keyPreview)
    const planned = await key()
    expect(await run("test")).toEqual({ unstable: "ran", test: "ran" })
    // The test started after the patch: it was measured again and ran on the patched tree.
    expect(logs).toContain(
      "//pkg:test  planned again: what the workspace pins or installs changed since the plan"
    )
    expect(logs.filter((line) => line.includes("not cached"))).toEqual([])
    // Its one result is stored under the key of the patched tree, which is what a plan measures now.
    const stored = NodeFs.readdirSync(Path.join(root, ".flows", "cache"), { recursive: true })
      .filter((name) => String(name).endsWith(".json"))
    expect(stored.length).toBe(1)
    const entry = JSON.parse(await Fs.readFile(Path.join(root, ".flows", "cache", String(stored[0])), "utf8"))
    expect(entry.key).not.toBe(planned)
    expect(entry.key).toBe(await key())
  })

  confinedIt("grants a tree entry by entry, placing each link as a link", async () => {
    const { root, node, index } = await fixture()
    await Fs.mkdir(Path.join(root, "pkg/node_modules/.pnpm/runner@1/node_modules"), { recursive: true })
    await Fs.rename(
      Path.join(root, "pkg/node_modules/runner"),
      Path.join(root, "pkg/node_modules/.pnpm/runner@1/node_modules/runner")
    )
    await Fs.symlink(".pnpm/runner@1/node_modules/runner", Path.join(root, "pkg/node_modules/runner"))
    await Fs.mkdir(Path.join(root, "pkg/node_modules/.vite"))
    const planned = await node("test")
    const scratch = sandboxRequest(planned, new Map(), index.workspace, ".flows", [], root)
    expect(scratch.reads).toEqual(expect.arrayContaining(["pkg/node_modules/.bin", "pkg/node_modules/.pnpm"]))
    expect(scratch.reads).not.toContain("pkg/node_modules")
    expect(scratch.reads).not.toContain("pkg/node_modules/.vite")
    expect(scratch.links).toEqual([{ path: "pkg/node_modules/runner", target: ".pnpm/runner@1/node_modules/runner" }])
    // Without the layer the tree is granted whole, under the workspace's own mechanism.
    const plain = sandboxRequest(planned, new Map(), index.workspace, ".flows")
    expect(plain.reads).toContain("pkg/node_modules")
    expect(plain.scratch).toBeUndefined()
    expect(plain.mechanism).toEqual(S.Sandbox.None())
  })
})

describe("a host that cannot confine", () => {
  const linuxIt = it.skipIf(process.platform !== "linux")

  /** Executes under host facts that find no sandbox program, as a host without one answers. */
  const runWithoutMechanism = async (
    target: Awaited<ReturnType<typeof fixture>>,
    ...names: ReadonlyArray<string>
  ): Promise<Record<string, string>> => {
    const summary = await withPath(target.environment.PATH, async () =>
      Effect.runPromise(
        executeEffect(await target.planned(names), {
          index: target.index,
          cacheDirectory: ".flows",
          verb: "auto",
          patterns: names.map(target.label),
          environment: target.environment,
          log: (line) => target.logs.push(line)
        }).pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          sandboxHost: () => ({ ...ExecSandbox.host(), executable: () => undefined })
        }))
      ))
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }

  linuxIt("runs as the workspace declares, stores nothing, and says so once", async () => {
    const target = await fixture()
    const { logs, root } = target
    expect(await runWithoutMechanism(target, "test", "node")).toEqual({ test: "ran", node: "ran" })
    expect(await runWithoutMechanism(target, "test", "node")).toEqual({ test: "ran", node: "ran" })
    const notes = logs.filter((line) => line.includes("results are not cached on this host"))
    // One line for each execution, however many targets it ran.
    expect(notes.length).toBe(2)
    expect(notes[0]).toContain("bwrap")
    expect(NodeFs.existsSync(Path.join(root, ".flows", "evidence"))).toBe(false)
  })

  confinedIt("runs confined as declared and stores nothing where no mechanism has a scratch layer", async () => {
    // The workspace confines its build, and the evidence host facts offer no
    // layer: the run is confined as declared, so an undeclared write fails it.
    const strict = await fixture({ confinement: "default", behaviour: "echo sidecar > source.d.ts" })
    expect(await runWithoutMechanism(strict, "test")).toEqual({ test: "failed" })
    // A green run there read each installed tree whole, tool state included, so it is not evidence.
    const clean = await fixture({ confinement: "default" })
    expect(await runWithoutMechanism(clean, "test")).toEqual({ test: "ran" })
    expect(await runWithoutMechanism(clean, "test")).toEqual({ test: "ran" })
    expect(clean.logs.filter((line) => line.includes("results are not cached on this host")).length).toBe(2)
  })

  confinedIt("stores nothing when the run's search path is not the one its plan keyed", async () => {
    const { run, planned, index, environment, tools, logs } = await fixture()
    // The same programs under another directory: the plan fingerprinted the first.
    const other = Path.join(Path.dirname(tools), "other-bin")
    await Fs.cp(tools, other, { recursive: true })
    const elsewhere = [other, ...environment.PATH.split(Path.delimiter).slice(1)].join(Path.delimiter)
    const status = async (): Promise<string> => {
      const summary = await withPath(elsewhere, async () =>
        execute(await planned(["test"]), {
          index,
          cacheDirectory: ".flows",
          verb: "auto",
          patterns: ["//pkg:test"],
          environment,
          log: (line) => logs.push(line)
        }))
      return summary.results[0]!.status
    }
    expect(await status()).toBe("ran")
    expect(await status()).toBe("ran")
    // Under the path the plan keyed, the run gathers its evidence.
    expect(await run("test")).toEqual({ test: "ran" })
    expect(await run("test")).toEqual({ test: "hit" })
  })
})

describe("the dependency outputs an evidence run can read", () => {
  posixIt("are the declared output of a planned dependency", async () => {
    const { planned } = await fixture({ unstableDependency: true })
    const nodes = (await planned(["test"])).nodes
    expect(dependencyOutputPaths(nodes.get("//pkg:test")!, nodes)).toEqual(["pkg/dist"])
    // A dependency the plan does not hold contributes nothing.
    expect(dependencyOutputPaths(nodes.get("//pkg:test")!, new Map())).toEqual([])
  })

  it("cover every transitive dependency once: directories, files and a cargo build's products", () => {
    type Node = Parameters<typeof dependencyOutputPaths>[0]
    const node = (
      dependencies: ReadonlyArray<string>,
      outDirs: ReadonlyArray<string> = [],
      outFiles: ReadonlyArray<string> = [],
      lane?: { readonly kind: string; readonly outFiles?: ReadonlyArray<string> }
    ): Node => ({ dependencies, outDirs, outFiles, lane }) as unknown as Node
    // A diamond: both sides reach the shared library, which is read once.
    const nodes = new Map<string, Node>([
      ["//a:left", node(["//a:shared"], ["a/left"])],
      ["//a:right", node(["//a:shared"], [], ["a/right.txt"])],
      ["//a:shared", node(["//a:crate"], ["a/shared"])],
      ["//a:crate", node([], [], [], { kind: "cargo", outFiles: ["target/release/tool"] })],
      ["//a:fetched", node([], [], ["a/archive.tgz"], { kind: "fetch" })]
    ])
    expect(dependencyOutputPaths(node(["//a:left", "//a:right", "//a:fetched"]), nodes)).toEqual([
      "a/archive.tgz",
      "a/left",
      "a/right.txt",
      "a/shared",
      "target/release/tool"
    ])
  })
})
