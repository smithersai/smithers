/**
 * The memory backend's failure surfaces: an empty bank list, the default
 * PATH locator, the subprocess runner's own refusals and captured output,
 * and the git ref resolver's readable failures. Every subprocess is real.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as MemoryBackend from "../src/MemoryBackend.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})
const temporaryRoot = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-memory-failures-")))
  temporaryDirectories.push(root)
  return root
}

const target = () => S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["commit"] })
const memory = S.Memory.SmithersCloud({ bank: ["repo"] })
const sha = "1234567890abcdef1234567890abcdef12345678"
const resolveSource = async (): Promise<string> => sha

const recordingCli = () => {
  const binaries: Array<string> = []
  const cli: MemoryBackend.MemoryCli = {
    run: async (binary) => {
      binaries.push(binary)
      return { exitCode: 0, stdout: "", stderr: "" }
    }
  }
  return { binaries, cli }
}

/** An environment whose every entry throws `thrown` when read. */
const unreadableEnvironment = (thrown: unknown): Record<string, string> =>
  Object.defineProperty({}, "PATH", {
    enumerable: true,
    get: () => {
      throw thrown
    }
  })

describe("retain refusals before any subprocess", () => {
  it("refuses a SmithersCloud declaration that names no bank", async () => {
    const { binaries, cli } = recordingCli()
    await expect(MemoryBackend.retain({
      root: Os.tmpdir(),
      target: target(),
      memory: S.Memory.SmithersCloud({ bank: [] }),
      locator: { find: async () => "/opt/fake/smithers" },
      resolveSource,
      cli
    })).rejects.toMatchObject({
      _tag: "smithers-build/MemoryBackendUnavailable",
      code: "no_backend_declared",
      message: expect.stringContaining("names no bank to retain into")
    })
    expect(binaries).toEqual([])
  })

  it("names the argv and says (no output) when a failing backend printed nothing", async () => {
    const attempt = MemoryBackend.retain({
      root: Os.tmpdir(),
      target: target(),
      memory,
      locator: { find: async () => "/opt/fake/smithers" },
      resolveSource,
      cli: { run: async () => ({ exitCode: 3, stdout: " \n", stderr: "\n" }) }
    })
    const error = await attempt.catch((cause: unknown) => cause)
    expect(MemoryBackend.isMemoryCommandFailed(error)).toBe(true)
    expect((error as Error).message).toBe(
      `smithers memory set repo commit:${sha} ${
        JSON.stringify({ source: "HEAD", commit: sha, tags: ["commit"] })
      } exited 3: (no output)`
    )
  })
})

describe("default locator", () => {
  it("skips a directory named smithers on PATH and finds the executable file after it", async () => {
    const root = await temporaryRoot()
    const shadow = NodePath.join(root, "shadow")
    const bin = NodePath.join(root, "bin")
    await Fs.mkdir(NodePath.join(shadow, "smithers"), { recursive: true, mode: 0o755 })
    await Fs.mkdir(bin)
    await Fs.writeFile(NodePath.join(bin, "smithers"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const locator = MemoryBackend.pathLocator({ PATH: [shadow, bin].join(NodePath.delimiter) })
    expect(await locator.find()).toBe(NodePath.join(bin, "smithers"))
    expect(await MemoryBackend.pathLocator({ PATH: shadow }).find()).toBeUndefined()
  })

  it("searches the given environment's PATH when retain receives no locator", async () => {
    const root = await temporaryRoot()
    const binary = NodePath.join(root, "smithers")
    await Fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const { binaries, cli } = recordingCli()
    const result = await MemoryBackend.retain({
      root,
      target: target(),
      memory,
      environment: { PATH: root },
      resolveSource,
      cli
    })
    expect(result.binary).toBe(binary)
    expect(binaries).toEqual([binary])
  })

  it("searches the process PATH when retain receives neither a locator nor an environment", async () => {
    const expected = await MemoryBackend.pathLocator(process.env).find()
    const outcome = await MemoryBackend.retain({
      root: Os.tmpdir(),
      target: target(),
      memory,
      resolveSource,
      cli: recordingCli().cli
    }).then((result) => result.binary, (error: { readonly code?: unknown }) => error.code)
    expect(outcome).toBe(expected ?? "cli_not_found")
  })
})

describe("spawnCli", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses timeoutMs %s before spawning", async (timeoutMs) => {
    await expect(MemoryBackend.spawnCli({ timeoutMs }).run(process.execPath, ["-e", ""], Os.tmpdir())).rejects
      .toThrow(new RangeError("Memory timeoutMs must be positive and finite"))
  })

  it("returns a nonzero exit with the stderr the backend wrote", async () => {
    const output = await MemoryBackend.spawnCli().run(process.execPath, [
      "-e",
      "process.stdout.write('partial'); process.stderr.write('bank refused'); process.exitCode = 4"
    ], Os.tmpdir())
    expect(output).toEqual({ exitCode: 4, stdout: "partial", stderr: "bank refused" })
  })

  it("answers a binary that cannot be spawned as exit 1 with the failure message", async () => {
    const root = await temporaryRoot()
    const output = await MemoryBackend.spawnCli().run(NodePath.join(root, "missing-smithers"), ["memory"], root)
    expect(output.exitCode).toBe(1)
    expect(output.stdout).toBe("")
    expect(output.stderr).toBe("process execution failed")
  })

  it("keeps the stderr captured before an output overflow instead of the generic message", async () => {
    const output = await MemoryBackend.spawnCli().run(process.execPath, [
      "-e",
      "process.stderr.write('x'.repeat(9 * 1024 * 1024))"
    ], Os.tmpdir())
    expect(output.exitCode).toBe(1)
    expect(output.stderr.length).toBeGreaterThan(0)
    expect(output.stderr.length).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(output.stderr).toMatch(/^x+$/)
  })

  it("rethrows a host failure that is not a process failure instead of reporting an exit", async () => {
    const unreadable = new Error("environment is unreadable")
    await expect(
      MemoryBackend.spawnCli({ environment: unreadableEnvironment(unreadable) }).run(
        process.execPath,
        ["-e", ""],
        Os.tmpdir()
      )
    ).rejects.toBe(unreadable)
  })
})

describe("default git source resolution", () => {
  it("names git's exit status when git fails without writing stderr", async () => {
    const root = await temporaryRoot()
    await Fs.writeFile(NodePath.join(root, "git"), "#!/bin/sh\nexit 3\n", { mode: 0o755 })
    await expect(MemoryBackend.retain({
      root,
      target: target(),
      memory,
      environment: { PATH: root },
      locator: { find: async () => "/opt/fake/smithers" },
      cli: recordingCli().cli
    })).rejects.toThrow(new Error(`cannot resolve HEAD to a commit in ${root}: git exited 3`))
  })

  it("keeps a thrown non-Error as the cause while naming the ref", async () => {
    const root = await temporaryRoot()
    const error = await MemoryBackend.retain({
      root,
      target: target(),
      memory,
      environment: unreadableEnvironment("environment is unreadable"),
      locator: { find: async () => "/opt/fake/smithers" },
      cli: recordingCli().cli
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(`cannot resolve HEAD to a commit in ${root}: `)
    expect((error as Error).cause).toBe("environment is unreadable")
  })
})
