/**
 * `scripts/box-replay.mjs`, the replay of a repository we do not trust in a Cloudflare box, without a box: its dry
 * run prints the cfbox command, it refuses what would carry this machine into the box, and of what a box returns it
 * takes only the named plain files.
 */
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const script = join(import.meta.dirname, "..", "scripts", "box-replay.mjs")

interface Taken {
  readonly path: string
  readonly name: string
  readonly bytes: number
}

const box: {
  readonly main: (argv: ReadonlyArray<string>) => Promise<number>
  readonly collect: (out: string, cpu: string, code: number) => number
  readonly sift: (listing: string) => {
    readonly keep: ReadonlyArray<Taken>
    readonly drop: ReadonlyArray<{ readonly path: string; readonly why: string }>
  }
  readonly unpack: (artifact: string, out: string) => ReadonlyArray<Taken>
  readonly parse: (argv: ReadonlyArray<string>) => unknown
  readonly pool: <A>(tasks: ReadonlyArray<() => Promise<A>>, limit: number) => Promise<ReadonlyArray<A>>
  readonly table: (
    rows: ReadonlyArray<{ readonly job: string; readonly exit: number; readonly report?: unknown }>,
    cpu: string
  ) => ReadonlyArray<string>
  readonly reportIn: (out: string) => unknown
} = await import(script)

const made: Array<string> = []
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "box-replay-test-"))
  made.push(directory)
  return directory
}
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env["CFBOX"]
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A directory of release tarballs as pack-release.mjs writes it: a manifest and the files it lists. */
const packs = (files: ReadonlyArray<string> = ["smithers-ci-1.0.0.tgz", "smthrs-build-cli-1.0.0.tgz"]): string => {
  const directory = temporary()
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(files.map((filename) => ({ name: filename.replace(/-1\.0\.0\.tgz$/, ""), filename })))
  )
  for (const file of files) writeFileSync(join(directory, file), "tarball")
  return directory
}

/** Runs the script in this process; its exit code and what it printed. */
const run = async (args: ReadonlyArray<string>) => {
  const printed: Array<string> = []
  const said: Array<string> = []
  vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line))
  vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line))
  const code = await box.main(args)
  vi.restoreAllMocks()
  return { code, stdout: printed.join("\n"), stderr: said.join("\n") }
}

/** An artifact as cfbox collects it: `out/` and the files in it. */
const artifact = (files: Record<string, string>, into: string): string => {
  const root = temporary()
  mkdirSync(join(root, "out"))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "out", name), text)
  const file = join(into, "result.tgz")
  expect(spawnSync("tar", ["-czf", file, "-C", root, "out"]).status).toBe(0)
  return file
}

const url = "https://github.com/tj/commander.js"

describe("box-replay dry run", () => {
  it("prints the cfbox command that uploads only the tarballs and the box's script", () => {
    const out = join(temporary(), "result")
    const result = spawnSync(
      process.execPath,
      [script, url, "A5A7DC0", "--packs", packs(), "--out", out, "--job-id", "t-1", "--dry-run", "--", "--jobs", "2"],
      { encoding: "utf8" }
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(
      `cfbox run --cpu 4 --image node --job-id t-1 --artifact out --output ${out}/result.tgz ${out}/upload -- ` +
        `bash box-replay.sh ${url} a5a7dc0 4 --jobs 2`
    )
    expect(existsSync(out)).toBe(false)
  })

  it("names the program CFBOX names, the box size and the commits asked for", async () => {
    process.env["CFBOX"] = "/opt/cf box"
    const result = await run([url, "a5a7dc0", "--packs", packs(), "--cpu", "2", "--commits", "6", "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^'\/opt\/cf box' run --cpu 2 --image node --job-id box-replay-a5a7dc0-\d+ /)
    expect(result.stdout).toMatch(/ a5a7dc0 6$/)
  })
})

describe("box-replay refuses", () => {
  const refused = async (args: ReadonlyArray<string>, words: RegExp) => {
    const result = await run([...args, "--dry-run"])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(words)
  }

  it("a variable of this machine, passed or set", async () => {
    await refused([url, "a5a7dc0", "--packs", packs(), "--env-pass", "GH_TOKEN"], /--env-pass is refused: .*credential/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--env", "A=b"], /--env is refused/)
  })

  it("a cache another job shares", async () => {
    await refused([url, "a5a7dc0", "--packs", packs(), "--cache-key", "smithers-1"], /--cache-key is refused: .*shared/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--cache"], /--cache is refused/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--", "--cache=https://cache.example"], /replay flag --cache/)
  })

  it("files of this machine in the upload", async () => {
    await refused([url, "a5a7dc0", "--packs", packs(), "--add", "x"], /--add is refused/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--with-deps"], /--with-deps is refused/)
    const crowded = packs()
    mkdirSync(join(crowded, "repo"))
    await refused([url, "a5a7dc0", "--packs", crowded], /holds repo, which its manifest does not list/)
    await refused([url, "a5a7dc0", "--packs", packs(["smthrs-cli-1.0.0.tgz"])], /holds no smithers-ci/)
    const short = packs()
    rmSync(join(short, "smthrs-build-cli-1.0.0.tgz"))
    await refused([url, "a5a7dc0", "--packs", short], /lacks smthrs-build-cli-1.0.0.tgz/)
  })

  it("a local path as the repository", async () => {
    const checkout = temporary()
    await refused([checkout, "a5a7dc0", "--packs", packs()], /is a path on this machine/)
    await refused(["./repo", "a5a7dc0", "--packs", packs()], /is a path on this machine/)
    await refused(["~/repo", "a5a7dc0", "--packs", packs()], /is a path on this machine/)
    await refused([`file://${checkout}`, "a5a7dc0", "--packs", packs()], /is a path on this machine/)
    await refused(["package.json", "a5a7dc0", "--packs", packs()], /is a path on this machine/)
  })

  it("a repository that is not a public https URL", async () => {
    await refused(["git@github.com:tj/commander.js", "a5a7dc0", "--packs", packs()], /is not a URL/)
    await refused(["ssh://git@github.com/tj/commander.js", "a5a7dc0", "--packs", packs()], /not an https URL/)
    await refused(["https://me:secret@github.com/x/y", "a5a7dc0", "--packs", packs()], /names a user or a password/)
  })

  it("a command line it cannot read", async () => {
    await refused([url, "main", "--packs", packs()], /main is not a commit id/)
    await refused([url, "--packs", packs()], /give a repository URL and a commit/)
    await refused([url, "a5a7dc0"], /--packs names the directory/)
    await refused([url, "a5a7dc0", "--packs"], /--packs needs a value/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--cpu", "3"], /--cpu is 1, 2 or 4/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--commits", "0"], /--commits is a whole number/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--job-id", "a b"], /--job-id is letters/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--frobnicate"], /unknown flag --frobnicate/)
    await refused([url, "a5a7dc0", "--packs", packs(), "--", "--json"], /replay flag --json/)
    await refused([url, "a5a7dc0", "--packs", temporary()], /has no manifest.json/)
  })

  it("only its own refusals: another fault is thrown", async () => {
    const unreadable = temporary()
    writeFileSync(join(unreadable, "manifest.json"), "not json")
    await expect(box.main([url, "a5a7dc0", "--packs", unreadable])).rejects.toThrow(SyntaxError)
  })
})

describe("box-replay runs", () => {
  it("leaves nothing behind when the box cannot start", async () => {
    const out = join(temporary(), "result")
    process.env["CFBOX"] = join(temporary(), "no-cfbox")
    const result = await run([url, "a5a7dc0", "--packs", packs(), "--out", out, "--job-id", "t-2"])
    expect(result.code).toBe(125)
    expect(result.stderr).toMatch(/the box returned no results \(cfbox exit 125\)/)
    expect(readdirSync(out)).toEqual(["box.log"])
  })

  it("will not write over the results of another run", async () => {
    const out = temporary()
    writeFileSync(join(out, "replay.json"), "{}")
    const result = await run([url, "a5a7dc0", "--packs", packs(), "--out", out])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/is not empty/)
  })
})

describe("box-replay with a box for each job", () => {
  it("prints one cfbox command for each job, each with its own job id and results folder", async () => {
    const out = join(temporary(), "result")
    const result = await run([
      url,
      "a5a7dc0",
      "--packs",
      packs(),
      "--out",
      out,
      "--job-id",
      "t",
      "--job",
      "tests.yml:test",
      "--job",
      "ci.yml:a b",
      "--dry-run"
    ])
    expect(result.code).toBe(0)
    expect(result.stdout.split("\n")).toEqual([
      `cfbox run --cpu 4 --image node --job-id t-1 --artifact out --output ${out}/1/result.tgz ${out}/upload -- ` +
      `bash box-replay.sh ${url} a5a7dc0 4 --job tests.yml:test`,
      `cfbox run --cpu 4 --image node --job-id t-2 --artifact out --output ${out}/2/result.tgz ${out}/upload -- ` +
      `bash box-replay.sh ${url} a5a7dc0 4 --job 'ci.yml:a b'`
    ])
  })

  it("refuses --job with no id, and the replay's own --job", async () => {
    for (
      const [args, words] of [
        [["--job"], /--job needs a CI job's id/],
        [["--job", "--dry-run"], /--job needs a CI job's id/],
        [["--", "--job", "x"], /replay flag --job is refused: give it as this script's --job/]
      ] as const
    ) {
      const result = await run([url, "a5a7dc0", "--packs", packs(), ...args])
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(words)
    }
  })

  it("brings each box's results back to its own folder and lists every job, those with no report too", async () => {
    const out = join(temporary(), "result")
    process.env["CFBOX"] = join(temporary(), "no-cfbox")
    const result = await run([url, "a5a7dc0", "--packs", packs(), "--out", out, "--job", "a", "--job", "b"])
    expect(result.code).toBe(125)
    expect(readdirSync(out).sort()).toEqual(["1", "2", "jobs.txt"])
    expect(readdirSync(join(out, "1"))).toEqual(["box.log"])
    expect(readFileSync(join(out, "jobs.txt"), "utf8")).toBe(
      "job  exit  baseline  normal  reused  mismatches\n" +
        "a    125   -         -       -       -\n" +
        "b    125   -         -       -       -\n" +
        "job seconds, each job alone in a 4 vCPU box: baseline 0 s, normal 0 s\n"
    )
  })

  it("adds the jobs' seconds up beside the table, as job seconds and never as a speedup", () => {
    const report = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "replay-report.example.json"), "utf8"))
    const lines = box.table([{ job: "ci.yml:test", exit: 1, report }, { job: "ci.yml:lint", exit: 3 }], "4")
    expect(lines).toHaveLength(4)
    expect(lines[1]).toMatch(/^ci\.yml:test  1     \d+ s\s+\d+ s\s+\d+ of \d+\s+1$/)
    expect(lines[2]).toMatch(/^ci\.yml:lint  3\s+-\s+-\s+-\s+-$/)
    expect(lines[3]).toBe(
      `job seconds, each job alone in a 4 vCPU box: baseline ${Math.round(report.baselineWallMs / 1000)} s, normal ${
        Math.round(report.normalWallMs / 1000)
      } s`
    )
    expect(lines.join("\n")).not.toMatch(/speedup|faster/)
  })

  it("runs four boxes at once at most, and gives their results in order", async () => {
    let running = 0
    let most = 0
    const task = (value: number) => async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((done) => setTimeout(done, 5))
      running -= 1
      return value
    }
    expect(await box.pool([1, 2, 3, 4, 5, 6, 7].map(task), 4)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(most).toBe(4)
    expect(await box.pool([], 4)).toEqual([])
  })

  it("reads a box's report, and nothing where it brought none", () => {
    const out = temporary()
    expect(box.reportIn(out)).toBeUndefined()
    writeFileSync(join(out, "replay.json"), `{"version":1}`)
    expect(box.reportIn(out)).toEqual({ version: 1 })
  })
})

describe("box-replay results", () => {
  it("takes only named plain files from what a box returns", () => {
    const root = temporary()
    mkdirSync(join(root, "out"))
    writeFileSync(join(root, "out", "replay.json"), "{}")
    writeFileSync(join(root, "out", "exit"), "0\n")
    writeFileSync(join(root, "out", "node_modules.tgz"), "built program")
    symlinkSync("/etc/passwd", join(root, "out", "report.html"))
    const file = join(temporary(), "result.tgz")
    expect(spawnSync("tar", ["-czf", file, "-C", root, "out"]).status).toBe(0)
    const { drop, keep } = box.sift(spawnSync("tar", ["-tvzf", file], { encoding: "utf8" }).stdout)
    expect(keep.map((entry) => [entry.name, entry.bytes]).sort()).toEqual([["exit", 2], ["replay.json", 2]])
    expect(drop.map((entry) => [entry.path.split(" ")[0], entry.why]).sort()).toEqual([
      ["out/node_modules.tgz", "not a named result"],
      ["out/report.html", "not a plain file"]
    ])
  })

  it("unpacks the named files beside the run, sums the replay up and gives its exit code", () => {
    const out = temporary()
    const report = readFileSync(join(import.meta.dirname, "fixtures", "replay-report.example.json"), "utf8")
    artifact({ "replay.json": report, "exit": "1\n", "checkout.tgz": "the repository" }, out)
    const printed: Array<string> = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(box.collect(out, "4", 0)).toBe(1)
    expect(readdirSync(out).sort()).toEqual(["exit", "replay.json"])
    const parsed = JSON.parse(report)
    expect(printed[0]).toBe("box: 4 vCPU")
    expect(printed).toContain(`mismatches: ${parsed.mismatches}`)
    expect(printed.filter((line) => / reused \d+ of \d+, \d+ mismatches$/.test(line))).toHaveLength(
      parsed.commits.length
    )
  })

  it("names the recorder, why it was chosen, and why the replay stopped", () => {
    const out = temporary()
    const report = {
      ...JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "replay-report.example.json"), "utf8")),
      jobs: undefined,
      recorder: { name: "strace", why: "smthrs-observe cannot run here" },
      stopped: "the replay stopped before the disk filled"
    }
    artifact({ "replay.json": JSON.stringify(report) }, out)
    const printed: Array<string> = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(box.collect(out, "2", 0)).toBe(0)
    expect(printed).toContain("jobs replayed: -")
    expect(printed).toContain("recorder: strace (smthrs-observe cannot run here)")
    expect(printed).toContain("stopped: the replay stopped before the disk filled")
  })

  it("gives the replay's own reason when it printed no report", () => {
    const out = temporary()
    const refusal = "smithers-ci: replay: 0 of 49 CI jobs can be reproduced on this machine"
    artifact({ "replay.json": "", "exit": "3\n", "replay.log": `smithers-ci: fetching 3 objects\n${refusal}\n` }, out)
    const said: Array<string> = []
    vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line))
    expect(box.collect(out, "4", 0)).toBe(3)
    expect(said).toContain(`box-replay: the replay printed no report; it said: ${refusal}`)
  })

  it("says so when the replay printed no report and no reason", () => {
    const out = temporary()
    artifact({ "exit": "4\n" }, out)
    const said: Array<string> = []
    vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line))
    expect(box.collect(out, "4", 0)).toBe(4)
    expect(said).toContain("box-replay: the replay printed no report")
  })

  it("says so when replay.json is not a report", () => {
    const out = temporary()
    artifact({ "replay.json": "{ cut", "exit": "4\n" }, out)
    const said: Array<string> = []
    vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line))
    expect(box.collect(out, "4", 0)).toBe(4)
    expect(said.join("\n")).toMatch(/replay.json is not a report/)
  })

  it("gives cfbox's code, or 4, when the box wrote no exit code or no results", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const out = temporary()
    artifact({ "box.txt": "cpus 4" }, out)
    expect(box.collect(out, "4", 255)).toBe(255)
    expect(box.collect(temporary(), "4", 0)).toBe(4)
  })

  it("unpacks nothing from an artifact that holds no named file", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const root = temporary()
    writeFileSync(join(root, "binary"), "a built program")
    const out = temporary()
    expect(spawnSync("tar", ["-czf", join(out, "result.tgz"), "-C", root, "binary"]).status).toBe(0)
    expect(box.unpack(join(out, "result.tgz"), out)).toEqual([])
    expect(readdirSync(out)).toEqual([])
  })

  it("says so when an artifact cannot be read", () => {
    const out = temporary()
    writeFileSync(join(out, "result.tgz"), "not gzip")
    expect(() => box.unpack(join(out, "result.tgz"), out)).toThrow(/could not list/)
  })
})
