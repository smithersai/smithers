/**
 * Resolving a declared Nix environment and asserting its tool versions.
 *
 * Resolver cases drive a fixture `nix` on PATH without a Nix store, checking
 * typed refusals, memoization, and declared versions. Version probe cases
 * run real executables to check failure recovery, caller cancellation, and
 * successful probe sharing.
 */
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import { getEventListeners } from "node:events"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as NixExec from "../src/NixExec.ts"

/** A 32-character store hash from the Nix base-32 alphabet. */
const hash = "0123456789abcdfghijklmnpqrsvwxyz"

let root: string
let store: string
let fakeBin: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const script = (body: string): string => `#!/bin/sh\n${body}\n`

/**
 * Installs a fake `nix` plus a fake closure holding `node` and `pnpm`.
 *
 * `nix build` prints the closure's store path, `print-dev-env` exports its
 * `bin` on PATH and one carried variable, `path-info --recursive` lists two
 * paths. Every `build` appends to a counter so a test can prove each resolution
 * evaluates even when the environment is memoized.
 */
const installFakeNix = async (options: { readonly node?: string; readonly pnpm?: string } = {}): Promise<void> => {
  store = NodePath.join(root, "store")
  const closure = NodePath.join(store, `${hash}-fake-env`)
  const dependency = NodePath.join(store, `${hash.split("").reverse().join("")}-fake-dep`)
  await Fs.mkdir(NodePath.join(closure, "bin"), { recursive: true })
  await Fs.mkdir(dependency, { recursive: true })
  await Fs.writeFile(
    NodePath.join(closure, "bin", "node"),
    script(`echo "${options.node ?? "v22.19.0"}"`),
    { mode: 0o755 }
  )
  await Fs.writeFile(
    NodePath.join(closure, "bin", "pnpm"),
    script(`echo "${options.pnpm ?? "11.21.0"}"`),
    { mode: 0o755 }
  )
  fakeBin = NodePath.join(root, "fake-bin")
  await Fs.mkdir(fakeBin, { recursive: true })
  const counter = NodePath.join(root, "nix-build-count")
  await Fs.writeFile(
    NodePath.join(fakeBin, "nix"),
    script(
      [
        `case "$1" in --version) echo "nix (Nix) 2.99.0"; exit 0;; esac`,
        `sub=""`,
        `for a in "$@"; do case "$a" in build|print-dev-env|path-info) sub="$a"; break;; esac; done`,
        `case "$sub" in`,
        `  build) echo x >> ${JSON.stringify(counter)}; echo ${JSON.stringify(closure)};;`,
        `  print-dev-env) printf '%s' '{"variables":{"PATH":{"type":"exported","value":"${closure}/bin"},` +
        `"SSL_CERT_FILE":{"type":"exported","value":"/etc/ssl/cert.pem"},` +
        `"NIX_BUILD_CORES":{"type":"exported","value":"4"}}}';;`,
        `  path-info) printf '%s\\n%s\\n' ${JSON.stringify(dependency)} ${JSON.stringify(closure)};;`,
        `  *) echo "fake nix: unknown command $*" >&2; exit 2;;`,
        `esac`
      ].join("\n")
    ),
    { mode: 0o755 }
  )
}

const buildCount = async (): Promise<number> => {
  try {
    return (await Fs.readFile(NodePath.join(root, "nix-build-count"), "utf8")).split("x").length - 1
  } catch {
    return 0
  }
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-nix-"))
  root = await Fs.realpath(root)
  await write("flake.nix", "{ outputs = { self }: { }; }\n")
  await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Fs.rm(root, { recursive: true, force: true })
})

const declaration = (): Nix.Environment => Nix.Environment({ flake: Input.file("//flake.nix") })

describe.skipIf(process.platform === "win32")("NixExec.resolveEnvironment", () => {
  it("refuses a host without nix", async () => {
    vi.stubEnv("PATH", NodePath.join(root, "empty"))
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration() })).rejects.toMatchObject({
      _tag: "smithers-build/NixEnvironmentError",
      code: "nix_absent"
    })
  })

  it("refuses a flake without its lock and names the fix", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    await Fs.rm(NodePath.join(root, "flake.lock"))
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration() })).rejects.toMatchObject({
      code: "nix_input_missing",
      message: expect.stringContaining("nix flake lock")
    })
  })

  it("resolves the closure, its PATH, the carried variables, and the transitive closure", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(resolved.storePath).toBe(NodePath.join(store, `${hash}-fake-env`))
    expect(resolved.hash).toBe(hash)
    expect(resolved.path).toEqual([NodePath.join(store, `${hash}-fake-env`, "bin")])
    expect(resolved.variables).toEqual({ SSL_CERT_FILE: "/etc/ssl/cert.pem" })
    expect(resolved.closure).toHaveLength(2)
    expect(resolved.closure).toContain(resolved.storePath)
    expect(resolved.nix.version).toBe("nix (Nix) 2.99.0")
    expect(resolved.inputs.map((input) => input.path)).toEqual(["flake.nix", "flake.lock"])
    expect(NixExec.layer(resolved)).toBe(`nix:${hash}`)
    expect(NixExec.toolEnvironment(resolved)).toEqual({
      path: NodePath.join(store, `${hash}-fake-env`, "bin"),
      variables: { SSL_CERT_FILE: "/etc/ssl/cert.pem" }
    })
    expect(NixExec.hostEnvironmentWith(resolved, { PATH: "/usr/bin", HOME: "/home/x" })).toEqual({
      PATH: NodePath.join(store, `${hash}-fake-env`, "bin"),
      HOME: "/home/x",
      SSL_CERT_FILE: "/etc/ssl/cert.pem"
    })
  })

  it("memoizes a resolution under the cache directory and reuses it while the store path exists", async () => {
    await installFakeNix()
    vi.stubEnv("PATH", fakeBin)
    const first = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(await buildCount()).toBe(1)
    const second = await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(second).toEqual(first)
    expect(await buildCount()).toBe(2)
    const memos = await Fs.readdir(NodePath.join(root, ".flows", "nix"))
    expect(memos).toHaveLength(1)
    // Even a changed lock that builds the same closure is evaluated again.
    await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 8 }\n")
    await NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" })
    expect(await buildCount()).toBe(3)
    // A store path that vanished invalidates the memo rather than answering for it.
    await Fs.rm(first.storePath, { recursive: true, force: true })
    await write("flake.lock", "{ \"nodes\": {}, \"root\": \"root\", \"version\": 7 }\n")
    await expect(NixExec.resolveEnvironment({ root, declaration: declaration(), cacheDirectory: ".flows" }))
      .resolves.toMatchObject({ hash })
    expect(await buildCount()).toBe(4)
  })

  it("asserts declared tool versions against the closure alone", async () => {
    await installFakeNix({ node: "v22.20.1" })
    vi.stubEnv("PATH", fakeBin)
    const resolved = await NixExec.resolveEnvironment({ root, declaration: declaration() })
    await expect(NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=22.19.0" }, { root }))
      .resolves.toBe("22.20.1")
    await expect(NixExec.assertToolVersion(resolved, { name: "pnpm", requirement: "11.21.0" }, { root }))
      .resolves.toBe("11.21.0")
    await expect(NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=24.0.0" }, { root }))
      .rejects.toMatchObject({
        code: "nix_version_mismatch",
        message: expect.stringContaining("declares node >=24.0.0 but the Nix environment provides node 22.20.1")
      })
    await expect(NixExec.assertToolVersion(resolved, { name: "bun", requirement: ">=1.4.0" }, { root }))
      .rejects.toMatchObject({ code: "nix_tool_absent" })
  })
})

/** A real executable whose version probe can fail or wait on a release receipt. */
const versionEnvironment = async (body: string): Promise<NixExec.ResolvedEnvironment> => {
  const bin = NodePath.join(root, "bin")
  await Fs.mkdir(bin)
  await Fs.writeFile(
    NodePath.join(bin, "probe"),
    `#!${process.execPath}
const Fs = require("node:fs")
Fs.appendFileSync(${JSON.stringify(NodePath.join(root, "probe-count"))}, "x")
${body}
`,
    { mode: 0o755 }
  )
  return {
    storePath: root,
    hash,
    path: [bin],
    variables: {},
    closure: [root],
    nix: { executable: "nix", version: "2.99.0" },
    system: NixExec.hostSystem(),
    inputs: []
  }
}

const probeTool = { name: "probe", requirement: ">=22.19.0" }

describe.skipIf(process.platform === "win32")("NixExec.assertToolVersion recovery", () => {
  it("keeps prerelease and build identity in a real version probe", async () => {
    const resolved = await versionEnvironment("console.log(\"22.20.1-canary.2+build.7\")")
    await expect(
      NixExec.assertToolVersion(resolved, { name: "probe", requirement: "22.20.1-canary.2+build.7" }, { root })
    ).resolves.toBe("22.20.1-canary.2+build.7")
    await expect(
      NixExec.assertToolVersion(resolved, { name: "probe", requirement: "22.20.1" }, { root })
    ).rejects.toMatchObject({ code: "nix_version_mismatch" })
  })

  it.each([
    ["nonzero exit", "console.error(\"unavailable\"); process.exit(1)"],
    ["invalid output", "console.log(\"unavailable\")"]
  ])("retries after a probe reports %s", async (_name, failure) => {
    const resolved = await versionEnvironment(`
if (Fs.readFileSync(${JSON.stringify(NodePath.join(root, "probe-count"))}, "utf8") === "x") {
  ${failure}
} else {
  console.log("22.20.1")
}
`)
    const signal = new AbortController().signal
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root, signal })).rejects.toMatchObject({
      code: "nix_tool_absent"
    })
    expect(getEventListeners(signal, "abort")).toHaveLength(0)
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root, signal })).resolves.toBe("22.20.1")
    expect(getEventListeners(signal, "abort")).toHaveLength(0)
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root })).resolves.toBe("22.20.1")
    expect(await Fs.readFile(NodePath.join(root, "probe-count"), "utf8")).toBe("xx")
  })

  it("retries after spawning a probe fails", async () => {
    const resolved = await versionEnvironment("console.log(\"22.20.1\")")
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root: NodePath.join(root, "missing") }))
      .rejects.toMatchObject({ code: "ENOENT" })
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root })).resolves.toBe("22.20.1")
    expect(await Fs.readFile(NodePath.join(root, "probe-count"), "utf8")).toBe("x")
  })

  it.each(["first", "second"])("cancels only the %s caller sharing a probe", async (cancelled) => {
    const started = NodePath.join(root, "probe-started")
    const release = NodePath.join(root, "probe-release")
    const resolved = await versionEnvironment(`
const release = ${JSON.stringify(release)}
const watcher = Fs.watch(${JSON.stringify(root)}, () => {
  if (Fs.existsSync(release)) {
    watcher.close()
    console.log("22.20.1")
  }
})
Fs.writeFileSync(${JSON.stringify(started)}, "started")
`)
    const controller = new AbortController()
    const reason = new Error("version check cancelled")
    const first = NixExec.assertToolVersion(resolved, probeTool, {
      root,
      ...(cancelled === "first" ? { signal: controller.signal } : {})
    })
    const firstResult = first.then(
      (version) => ({ version }),
      (error: unknown) => ({ error })
    )
    try {
      await expect.poll(() => Fs.readFile(started, "utf8").catch(() => "")).toBe("started")
      const second = NixExec.assertToolVersion(resolved, probeTool, {
        root,
        ...(cancelled === "second" ? { signal: controller.signal } : {})
      })
      const secondResult = second.then(
        (version) => ({ version }),
        (error: unknown) => ({ error })
      )
      controller.abort(reason)
      await expect(cancelled === "first" ? firstResult : secondResult).resolves.toEqual({ error: reason })
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      const retry = NixExec.assertToolVersion(resolved, probeTool, { root, signal: new AbortController().signal })
      await Fs.writeFile(release, "")
      await expect(cancelled === "first" ? secondResult : firstResult).resolves.toEqual({ version: "22.20.1" })
      await expect(retry).resolves.toBe("22.20.1")
      await expect(NixExec.assertToolVersion(resolved, probeTool, { root })).resolves.toBe("22.20.1")
      expect(await Fs.readFile(NodePath.join(root, "probe-count"), "utf8")).toBe("x")
    } finally {
      await Fs.writeFile(release, "")
      await firstResult
    }
  })

  it("refuses an already aborted caller without starting a probe or poisoning its cache", async () => {
    const resolved = await versionEnvironment("console.log(\"22.20.1\")")
    const reason = new Error("version check cancelled")
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root, signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason)
    await expect(Fs.access(NodePath.join(root, "probe-count"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root })).resolves.toBe("22.20.1")
    await expect(NixExec.assertToolVersion(resolved, probeTool, { root, signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason)
    expect(await Fs.readFile(NodePath.join(root, "probe-count"), "utf8")).toBe("x")
  })
})

describe("NixExec pure helpers", () => {
  it("compares versions the way declarations spell requirements", () => {
    expect(NixExec.satisfies("22.19.0", ">=22.19.0")).toBe(true)
    expect(NixExec.satisfies("22.18.9", ">=22.19.0")).toBe(false)
    expect(NixExec.satisfies("23.0.0", ">=22.19.0")).toBe(true)
    expect(NixExec.satisfies("11.21.0", "11.21.0")).toBe(true)
    expect(NixExec.satisfies("11.21.1", "11.21.0")).toBe(false)
    expect(NixExec.satisfies("0.0.1", ">=0.0.0")).toBe(true)
    expect(NixExec.satisfies("26.5.0", ">=22")).toBe(true)
    expect(NixExec.satisfies("26.5.0", "<27")).toBe(true)
    expect(NixExec.satisfies("27.0.0", "<27")).toBe(false)
    expect(NixExec.satisfies("26.5.0", "<=26.5.0")).toBe(true)
    expect(NixExec.satisfies("26.5.0", ">26.5.0")).toBe(false)
    expect(NixExec.satisfies("26.5.0", "=26.5.0")).toBe(true)
    expect(NixExec.satisfies("26.5.0", "")).toBe(true)
  })

  it("names the host system the way a flake does", () => {
    expect(NixExec.hostSystem("linux", "x64")).toBe("x86_64-linux")
    expect(NixExec.hostSystem("linux", "arm64")).toBe("aarch64-linux")
    expect(NixExec.hostSystem("darwin", "arm64")).toBe("aarch64-darwin")
  })
})

/**
 * A fake `nix` whose every step reads its behaviour from the environment the
 * resolver spawns it with, and records each subcommand it ran.
 */
const configurableNix = async (): Promise<
  { readonly bin: string; readonly closure: string; readonly calls: string }
> => {
  const closure = NodePath.join(root, "store", `${hash}-configurable-env`)
  await Fs.mkdir(NodePath.join(closure, "bin"), { recursive: true })
  const bin = NodePath.join(root, "configurable-bin")
  await Fs.mkdir(bin, { recursive: true })
  const calls = NodePath.join(root, "nix-calls")
  await Fs.writeFile(
    NodePath.join(bin, "nix"),
    script(
      [
        `case "$1" in --version)`,
        `  if [ "$VERSION" = fail ]; then echo "nix: broken install" >&2; exit 3; fi`,
        `  echo "nix (Nix) 2.99.0"; exit 0;;`,
        `esac`,
        `sub=""`,
        `for a in "$@"; do case "$a" in build|print-dev-env|path-info) sub="$a"; break;; esac; done`,
        `echo "$sub $*" >> ${JSON.stringify(calls)}`,
        `case "$sub" in`,
        `  build)`,
        `    case "$BUILD" in`,
        `      fail) i=0; while [ $i -lt 600 ]; do echo "error: line $i of a long evaluation trace" >&2; i=$((i+1)); done;` +
        ` echo "error: final cause" >&2; exit 1;;`,
        `      empty) exit 0;;`,
        `      slow) sleep 1;;`,
        `      hang) exec sleep 30;;`,
        `    esac`,
        `    echo ${JSON.stringify(closure)};;`,
        `  print-dev-env)`,
        `    case "$DEV" in`,
        `      fail) echo "error: no devShell" >&2; exit 4;;`,
        `      garbage) echo "not json";;`,
        `      novars) echo "{}";;`,
        `      *) printf '%s' '{"variables":{"PATH":{"type":"exported","value":"${closure}/bin"},` +
        `"TZDIR":{"type":"exported","value":""},"LOCALE_ARCHIVE":{"type":"array","value":["x"]}}}';;`,
        `    esac;;`,
        `  path-info)`,
        `    if [ "$PATHINFO" = fail ]; then echo "error: path is not valid" >&2; exit 5; fi`,
        `    echo ${JSON.stringify(closure)};;`,
        `esac`
      ].join("\n")
    ),
    { mode: 0o755 }
  )
  return { bin, closure, calls }
}

/** The fake `nix` first, then the host tools its script runs. */
const hostPath = (bin: string): string => [bin, process.env["PATH"] ?? ""].join(NodePath.delimiter)

const calledSteps = async (calls: string): Promise<ReadonlyArray<string>> =>
  (await Fs.readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => line.split(" ")[0]!)

describe.skipIf(process.platform === "win32")("NixExec.resolveEnvironment refusals", () => {
  const resolveWith = async (
    behaviour: Readonly<Record<string, string>>,
    options: { readonly declaration?: Nix.Environment; readonly cacheDirectory?: string } = {}
  ) => {
    const fake = await configurableNix()
    const lines: Array<string> = []
    const result = NixExec.resolveEnvironment({
      root,
      declaration: options.declaration ?? declaration(),
      cacheDirectory: options.cacheDirectory,
      environment: { PATH: hostPath(fake.bin), ...behaviour },
      log: (line) => lines.push(line)
    })
    return { fake, lines, result }
  }

  it("names an unknown host platform and architecture as written", () => {
    expect(NixExec.hostSystem("freebsd", "riscv64")).toBe("riscv64-freebsd")
  })

  it("evaluates a flake in a subdirectory and an expression file at their declared paths", async () => {
    await write("nix/flake.nix", "{ outputs = { self }: { }; }\n")
    await write("nix/flake.lock", "{}\n")
    await write("env.nix", "{ }\n")
    const flake = await resolveWith({}, { declaration: Nix.Environment({ flake: Input.file("//nix/flake.nix") }) })
    await expect(flake.result).resolves.toMatchObject({ hash })
    const system = NixExec.hostSystem()
    expect(flake.lines).toEqual([`nix environment: evaluating ${root}/nix#devShells.${system}.default`])
    const file = await resolveWith({}, { declaration: Nix.Environment({ file: Input.file("//env.nix") }) })
    const resolved = await file.result
    expect(file.lines).toEqual([`nix environment: evaluating --file ${NodePath.join(root, "env.nix")}`])
    expect(resolved.inputs.map((input) => input.path)).toEqual(["env.nix"])
  })

  it("keeps only non-empty string variables from the dev shell", async () => {
    const { fake, result } = await resolveWith({})
    const resolved = await result
    expect(resolved.path).toEqual([NodePath.join(fake.closure, "bin")])
    expect(resolved.variables).toEqual({})
    expect(Object.isFrozen(resolved.variables)).toBe(true)
  })

  it("refuses a missing expression file without the flake lock hint", async () => {
    const { result } = await resolveWith({}, { declaration: Nix.Environment({ file: Input.file("//absent.nix") }) })
    const error = await result.catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: "nix_input_missing",
      message: "Nix environment input absent.nix does not exist"
    })
  })

  it("refuses a nix whose version probe fails", async () => {
    const { fake, result } = await resolveWith({ VERSION: "fail" })
    await expect(result).rejects.toMatchObject({
      code: "nix_evaluation_failed",
      message: "nix --version failed: nix: broken install"
    })
    expect(await calledSteps(fake.calls)).toEqual([])
  })

  it("reports a failed build with the bounded tail of its trace", async () => {
    const { result } = await resolveWith({ BUILD: "fail" })
    const error = (await result.catch((cause: unknown) => cause)) as NixExec.NixEnvironmentError
    expect(error.code).toBe("nix_evaluation_failed")
    const prefix = "nix build failed for the declared environment (exit 1): "
    expect(error.message.startsWith(prefix)).toBe(true)
    const trace = error.message.slice(prefix.length)
    expect(trace.length).toBe(4 * 1024)
    expect(trace.endsWith("error: final cause")).toBe(true)
    expect(trace).not.toContain("line 0 of")
  })

  it("refuses a build that prints no store path", async () => {
    const { fake, result } = await resolveWith({ BUILD: "empty" })
    await expect(result).rejects.toMatchObject({
      code: "nix_evaluation_failed",
      message: "nix build printed no store path for the declared environment: \"\""
    })
    expect(await calledSteps(fake.calls)).toEqual(["build"])
  })

  it.each([
    ["fails", { DEV: "fail" }, "nix_evaluation_failed", /^nix print-dev-env failed .*\(exit 4\): error: no devShell$/],
    [
      "prints no JSON",
      { DEV: "garbage" },
      "nix_environment_incomplete",
      /^nix print-dev-env printed no readable JSON$/
    ],
    ["exports no PATH", { DEV: "novars" }, "nix_environment_incomplete", /exports no PATH/]
  ])("refuses a dev shell that %s", async (_name, behaviour, code, message) => {
    const { fake, result } = await resolveWith(behaviour)
    await expect(result).rejects.toMatchObject({ code, message: expect.stringMatching(message) })
    expect(await calledSteps(fake.calls)).toEqual(["build", "print-dev-env"])
  })

  it("refuses a closure nix cannot list", async () => {
    const { fake, result } = await resolveWith({ PATHINFO: "fail" })
    await expect(result).rejects.toMatchObject({
      code: "nix_evaluation_failed",
      message: `nix path-info failed for ${fake.closure}: error: path is not valid`
    })
  })

  it.each([
    ["unparseable", "{"],
    ["not an object", "null"],
    ["missing its closure", JSON.stringify({ storePath: "", hash: undefined, path: [], variables: {} })]
  ])("re-evaluates past a memo that is %s and rewrites it", async (_name, text) => {
    const first = await resolveWith({}, { cacheDirectory: ".flows" })
    const resolved = await first.result
    const memos = NodePath.join(root, ".flows", "nix")
    const [memo] = await Fs.readdir(memos)
    await Fs.writeFile(NodePath.join(memos, memo!), text)
    const again = await resolveWith({}, { cacheDirectory: ".flows" })
    await expect(again.result).resolves.toEqual(resolved)
    expect(await calledSteps(first.fake.calls)).toEqual([
      "build",
      "print-dev-env",
      "path-info",
      "build",
      "print-dev-env",
      "path-info"
    ])
    expect(JSON.parse(await Fs.readFile(NodePath.join(memos, memo!), "utf8"))).toEqual(resolved)
  })

  it("resolves and logs when the memo cannot be written", async () => {
    await write(".flows/nix", "a file where the memo directory belongs")
    const { lines, result } = await resolveWith({}, { cacheDirectory: ".flows" })
    await expect(result).resolves.toMatchObject({ hash })
    expect(lines.at(-1)).toMatch(/^nix environment: could not memoize the resolution: Error: EEXIST/)
  })

  it("shares one evaluation between concurrent resolutions of one declaration", async () => {
    const fake = await configurableNix()
    const resolve = () =>
      NixExec.resolveEnvironment({
        root,
        declaration: declaration(),
        environment: { PATH: hostPath(fake.bin), BUILD: "slow" }
      })
    const [left, right] = await Promise.all([resolve(), resolve()])
    expect(right).toBe(left)
    expect(await calledSteps(fake.calls)).toEqual(["build", "print-dev-env", "path-info"])
    await resolve()
    expect((await calledSteps(fake.calls)).filter((step) => step === "build")).toHaveLength(2)
  })

  it("stops a running evaluation when the caller aborts", async () => {
    const fake = await configurableNix()
    const controller = new AbortController()
    const result = NixExec.resolveEnvironment({
      root,
      declaration: declaration(),
      environment: { PATH: hostPath(fake.bin), BUILD: "hang" },
      signal: controller.signal
    }).then(() => undefined, (cause: unknown) => cause)
    await expect.poll(() => calledSteps(fake.calls)).toEqual(["build"])
    const started = Date.now()
    controller.abort()
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
