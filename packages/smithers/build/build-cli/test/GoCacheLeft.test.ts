/**
 * A workspace that leaves `go` its own cache, end to end.
 *
 * The case plans and executes real targets in a real git checkout with the
 * host's own `go`. Its Go test reads a file through a child process, which
 * `go`'s test cache cannot see: with a cache that outlives the job, `go test`
 * answers `ok (cached)` after the file changed. The cache directory is outside
 * the checkout, as `--cache-dir` names one: it is the same directory from the
 * workspace and from every machine, and it outlives them.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as CacheLocation from "../src/internal/CacheLocation.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import * as Machine from "../src/internal/Machine.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Machine.remove(root)))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Go", "-c", "user.email=go@example.invalid", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

const go = PackageTree.findOnPath("go")

const reader = `package x

import (
	"os/exec"
	"strings"
	"testing"
)

func TestValue(t *testing.T) {
	out, err := exec.Command("cat", "testdata/value.txt").Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(out)) != "ok" {
		t.Fatalf("value is %q", out)
	}
}
`

/** A Go module whose one test reads `testdata/value.txt` through `cat`, with one job that runs `go test ./...`. */
const fixture = async (cache: ReturnType<typeof S.Cache>) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-go-left-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const write = async (name: string, text: string): Promise<void> => {
    await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
    await Fs.writeFile(Path.join(root, name), text)
  }
  await Fs.mkdir(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  await write(".gitignore", ".flows\n")
  await write("go.mod", "module example.test/left\n\ngo 1.22\n")
  await write("x.go", "package x\n")
  await write("x_test.go", reader)
  await write("testdata/value.txt", "ok\n")
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "ok")
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("left", {
      repository: "git+https://example.invalid/left.git",
      cache,
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          test: S.Shell.Test({ shell: "go test ./...", machine: "job", sandbox: "none", data: [S.glob("**")] }),
          named: S.Shell.Test({ shell: "echo \"GOCACHE is ${GOCACHE-not set}\"", sandbox: "none" })
        }
      })
    }]
  })
  // The form `--cache-dir <base>/cache` resolves to.
  const cacheDirectory = CacheLocation.resolve(
    root,
    Path.join(base, "cache"),
    { directory: ".flows" },
    "left",
    CacheLocation.ambientHost({})
  )
  const environment: Record<string, string> = {
    PATH: [Path.dirname(go!), "/usr/bin", "/bin"].join(Path.delimiter),
    HOME: Path.join(base, "home"),
    [Machine.holdingVariable]: Path.join(base, "machines")
  }
  await Fs.mkdir(environment["HOME"]!, { recursive: true })
  const logs: Array<string> = []
  const options = (name: string) => ({
    index,
    cacheDirectory,
    verb: "auto" as const,
    patterns: [`//:${name}`],
    environment,
    jobs: 1,
    log: (line: string) => {
      logs.push(line)
    }
  })
  /** Plans and executes one target; answers its status and why it failed. */
  const run = async (name: string): Promise<{ readonly status: string; readonly error: string | undefined }> => {
    const previous = process.env["PATH"]
    process.env["PATH"] = environment["PATH"]
    try {
      const summary = await Effect.runPromise(
        executeEffect(await plan(options(name)), options(name)).pipe(
          Effect.provideService(ExecutionServices, executionServicesLive)
        )
      )
      const [result] = summary.results
      return { status: result!.status, error: result!.error }
    } finally {
      process.env["PATH"] = previous
    }
  }
  /** Every file under `directory`, from it. */
  const files = async (directory: string): Promise<ReadonlyArray<string>> =>
    (await Fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => Path.relative(directory, Path.join(entry.parentPath, entry.name)))
      .sort()
  return { base, root, write, run, logs, files, environment, cacheDirectory, cache: Path.join(base, "cache") }
}

describe.runIf(go !== undefined && process.platform !== "win32")("a workspace that leaves go its own cache", () => {
  it("fails a Go test that reads a file through a child process when the file changes", async () => {
    const work = await fixture(S.Cache({ directory: ".flows", goBuild: false }))
    expect(await work.run("test")).toEqual({ status: "ran", error: undefined })
    await work.write("testdata/value.txt", "bad\n")
    git(work.root, "commit", "--quiet", "-am", "bad")
    // The job's machine is a new one: `go` finds no result of the run before, and tests.
    const broken = await work.run("test")
    expect(broken.status).toBe("failed")
    expect(work.logs.join("\n")).toContain("value is \"bad")
    expect(work.logs.join("\n")).not.toContain("(cached)")
    // No tool is told where `go` keeps its cache.
    expect((await work.run("named")).status).toBe("ran")
    expect(work.logs.join("\n")).toContain("GOCACHE is not set")
    // Nothing of `go`'s is in the cache directory, and the machines are gone with the build.
    expect(await GoCache.status(work.root, work.cacheDirectory)).toMatchObject({ exists: false, entries: 0 })
    const kept = await work.files(work.cache)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.filter((name) => name.includes("go-build"))).toEqual([])
    expect(await work.files(work.environment[Machine.holdingVariable]!)).toEqual([])
    expect(await work.files(Path.join(work.environment["HOME"]!, ".cache", "go-build"))).toEqual([])
  }, 240_000)

  it("keeps the owned cache for a workspace that does not say so", async () => {
    const work = await fixture(S.Cache({ directory: ".flows" }))
    expect((await work.run("named")).status).toBe("ran")
    expect(work.logs.join("\n")).toContain(`GOCACHE is ${Path.join(work.cache, "go-build")}`)
  }, 240_000)
})
