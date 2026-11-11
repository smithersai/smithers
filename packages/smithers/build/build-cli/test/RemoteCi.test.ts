/**
 * The `ci --remote` coordinator's pieces: merging results, packing the tree a
 * machine unpacks with its own `tar`, quoting, and a part's run against a
 * real machine (this host), with faults injected through its provider.
 */
import type * as Sandbox from "@smthrs/sandbox/Sandbox"
import { Effect } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { layerNonInteractiveNodeServices } from "../src/engine.ts"
import * as RemoteCi from "../src/internal/RemoteCi.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-remote-ci-")))
  temporaryDirectories.push(directory)
  return directory
}

const row = (
  label: string,
  status: RemoteCi.Row["status"],
  durationMs: number,
  key = `key-${label}`
): RemoteCi.Row => ({
  label,
  status,
  key,
  durationMs
})

describe("merge", () => {
  const order = [{ label: "//:shared", target: "Shell.Test" }, { label: "//:a", target: "Shell.Test" }]
  const run = { pattern: "//...", jobs: 4, durationMs: 50 }

  it.each(
    [
      ["hit", "ran", "ran"],
      ["ran", "skipped", "skipped"],
      ["skipped", "cancelled", "cancelled"],
      ["cancelled", "failed", "failed"],
      ["failed", "hit", "failed"]
    ] as const
  )("keeps the worse of %s and %s: %s", (first, second, worst) => {
    const summary = RemoteCi.merge(
      order,
      [[row("//:shared", first, 10, "one")], [row("//:shared", second, 30, "two")]],
      run
    )
    expect(summary.results).toEqual([
      expect.objectContaining({ label: "//:shared", status: worst, durationMs: 30, target: "Shell.Test" })
    ])
  })

  it("keeps the longest duration even when the worse status was faster", () => {
    const summary = RemoteCi.merge(order, [[row("//:shared", "failed", 5)], [row("//:shared", "ran", 40)]], run)
    expect(summary.results[0]).toMatchObject({ status: "failed", durationMs: 40 })
  })

  it("orders rows by the local plan, then appends labels the plan lacks, and recounts", () => {
    const summary = RemoteCi.merge(
      order,
      [[row("//:a", "ran", 1), row("//:extra", "cancelled", 2)], [row("//:shared", "hit", 3)]],
      run
    )
    expect(summary).toEqual({
      verb: "ci",
      pattern: "//...",
      jobs: 4,
      durationMs: 50,
      counts: { hit: 1, ran: 1, failed: 0, skipped: 0, cancelled: 1 },
      ok: true,
      results: [
        { ...row("//:shared", "hit", 3), target: "Shell.Test" },
        { ...row("//:a", "ran", 1), target: "Shell.Test" },
        { ...row("//:extra", "cancelled", 2), target: "" }
      ]
    })
  })

  it("is red when any merged row failed, and omits cancelled from the counts when none was", () => {
    const summary = RemoteCi.merge(order, [RemoteCi.failedRoots(["//:a"], "machine 1 was lost: gone")], run)
    expect(summary.ok).toBe(false)
    expect(summary.counts).toEqual({ hit: 0, ran: 0, failed: 1, skipped: 0 })
    expect(summary.results).toEqual([
      {
        label: "//:a",
        status: "failed",
        key: "",
        durationMs: 0,
        error: "machine 1 was lost: gone",
        target: "Shell.Test"
      }
    ])
  })
})

describe("parseResults", () => {
  it("reads the rows a results file holds, advisory fields included", () => {
    const content = JSON.stringify({
      ok: false,
      counts: {},
      results: [{ ...row("//:a", "failed", 2), blocking: false, failureDigest: "sha256:x" }],
      version: 1
    })
    expect(RemoteCi.parseResults(content)).toEqual([{
      ...row("//:a", "failed", 2),
      blocking: false,
      failureDigest: "sha256:x"
    }])
  })

  it.each([
    "not json",
    JSON.stringify({ version: 1 }),
    JSON.stringify({ results: [{ label: "//:a", status: "odd" }] })
  ])(
    "refuses %s",
    (content) => {
      expect(() => RemoteCi.parseResults(content)).toThrow()
    }
  )
})

describe("quote", () => {
  it.each(["//:a", "--results-file", "/tmp/x y", "it's", "", "$(false)"])(
    "delivers %j to a shell unchanged",
    (word) => {
      const echoed = NodeChildProcess.execFileSync("/bin/sh", ["-c", `printf %s ${RemoteCi.quote(word)}`], {
        encoding: "utf8"
      })
      expect(echoed).toBe(word)
    }
  )

  it("leaves a safe word bare", () => {
    expect(RemoteCi.quote("//packages/a:lint")).toBe("//packages/a:lint")
  })
})

describe("pack", () => {
  it("packs bytes, permission bits and long paths that the system tar extracts exactly", async () => {
    const directory = await temporary()
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index)
    // A 990-byte path makes its extended-header record cross from three length digits to four.
    const deep = Array.from({ length: 4 }, (_, index) => `${index}`.repeat(200)).join("/") + `/${"f".repeat(186)}`
    const files: ReadonlyArray<RemoteCi.TreeFile> = [
      {
        path: "bin/run.sh",
        mode: 0o100755,
        mtimeMs: 1_700_000_000_000,
        content: new TextEncoder().encode("echo hi\n")
      },
      { path: "data/bytes.bin", mode: 0o100644, mtimeMs: 0, content: binary },
      { path: `${"long/".repeat(30)}file.txt`, mode: 0o100600, mtimeMs: 0, content: new TextEncoder().encode("long") },
      { path: deep, mode: 0o100644, mtimeMs: 0, content: new Uint8Array() }
    ]
    expect(deep.length).toBe(990)
    await Fs.writeFile(NodePath.join(directory, "tree.tar"), RemoteCi.pack(files))
    await Fs.mkdir(NodePath.join(directory, "tree"))
    NodeChildProcess.execFileSync("tar", ["-xf", "tree.tar", "-C", "tree"], { cwd: directory })
    for (const file of files) {
      const extracted = NodePath.join(directory, "tree", file.path)
      expect(new Uint8Array(await Fs.readFile(extracted))).toEqual(file.content)
      expect((await Fs.stat(extracted)).mode & 0o777).toBe(file.mode & 0o777)
    }
    expect(Math.round((await Fs.stat(NodePath.join(directory, "tree", "bin/run.sh"))).mtimeMs)).toBe(1_700_000_000_000)
  })

  it("packs an empty tree as an empty archive", () => {
    expect(RemoteCi.pack([])).toEqual(new Uint8Array(1024))
  })
})

describe("run", () => {
  const remote = (cli: ReadonlyArray<string>, workdir: string) => ({
    _tag: "RemoteCommand" as const,
    machines: [[]],
    workdir,
    setup: [],
    cli
  })
  const tree = RemoteCi.pack([{
    path: "README.md",
    mode: 0o100644,
    mtimeMs: 0,
    content: new TextEncoder().encode("hi")
  }])

  const runWith = (
    options: Pick<RemoteCi.RunOptions<never>, "remote"> & {
      readonly parts?: ReadonlyArray<RemoteCi.Part>
      readonly fault?: (session: Sandbox.Session) => Sandbox.Session
    }
  ) => {
    const lines: Array<string> = []
    let acquired = 0
    const outcome = Effect.runPromise(
      RemoteCi.run({
        remote: options.remote,
        runId: "run",
        tree,
        parts: options.parts ?? [{ machine: 1, roots: ["//:a"] }],
        flags: [],
        output: (line) => lines.push(line),
        provider: (machine, workdir) =>
          Effect.map(RemoteCi.providerOf(options.remote, machine, workdir), (provider) => ({
            acquire: (session: string) =>
              Effect.map(provider.acquire(session), (held) => {
                acquired += 1
                return options.fault === undefined ? held : options.fault(held)
              })
          }))
      }).pipe(Effect.provide(layerNonInteractiveNodeServices))
    )
    return { outcome, lines, acquired: () => acquired }
  }

  it("runs no part that has no roots", async () => {
    const workdir = await temporary()
    const ran = runWith({ remote: remote(["true"], workdir), parts: [{ machine: 1, roots: [] }] })
    expect(await ran.outcome).toEqual([])
    expect(ran.acquired()).toBe(0)
  })

  it("loses a machine that wrote no results file, twice, on two fresh sessions", async () => {
    const workdir = await temporary()
    const ran = runWith({ remote: remote(["echo", "no results from"], workdir) })
    expect(await ran.outcome).toEqual([
      RemoteCi.failedRoots(["//:a"], "machine 1 was lost: `ci` exited 0 and wrote no results file")
    ])
    expect(ran.acquired()).toBe(2)
    expect(ran.lines).toContain(
      "machine 1: no results from ci //:a --results-file " + `${workdir}/run/machine-1-2/results.json`
    )
    expect(await Fs.readdir(workdir)).toEqual([])
  })

  it("loses a machine whose results file is not one", async () => {
    const workdir = await temporary()
    const ran = runWith({
      remote: remote(["true"], workdir),
      fault: (session) => ({ ...session, readFile: () => Effect.succeed(new TextEncoder().encode("{}")) })
    })
    expect(await ran.outcome).toEqual([
      RemoteCi.failedRoots(["//:a"], "machine 1 was lost: `ci` exited 0 and its results file is not readable")
    ])
  })

  it("loses a machine whose results file leaves out a root it was given", async () => {
    const workdir = await temporary()
    const ran = runWith({
      remote: remote(["true"], workdir),
      parts: [{ machine: 1, roots: ["//:a", "//:b"] }],
      fault: (session) => ({
        ...session,
        readFile: () => Effect.succeed(new TextEncoder().encode(JSON.stringify({ results: [row("//:a", "ran", 1)] })))
      })
    })
    expect(await ran.outcome).toEqual([
      RemoteCi.failedRoots(
        ["//:a", "//:b"],
        "machine 1 was lost: `ci` exited 0 and its results file does not report //:b"
      )
    ])
  })

  it("loses a machine that cannot unpack the tree", async () => {
    const workdir = await temporary()
    const ran = runWith({
      remote: remote(["true"], workdir),
      fault: (session) => ({
        ...session,
        spawn: (command, options) => session.spawn(command.includes("tar -xf") ? "exit 3" : command, options)
      })
    })
    expect(await ran.outcome).toEqual([
      RemoteCi.failedRoots(["//:a"], "machine 1 was lost: the tree could not be unpacked (tar exited 3)")
    ])
  })
})
