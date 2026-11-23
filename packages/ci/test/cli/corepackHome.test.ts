/**
 * A repository whose CI runs pnpm through corepack, replayed by the real
 * program with a corepack cache of the person's own and a registry on this
 * machine that counts what it is asked.
 *
 * A step's home gets each package manager the person's corepack keeps, read
 * where it is: a step that names a kept pnpm opens no network and is reused at
 * the next commit. A step that names a pnpm the cache does not keep fetches it
 * into its own home, as on a runner, and the person's cache is the same, byte
 * for byte, after the replay. Both hold with a jail and without one. The pnpm
 * is one this machine's corepack keeps: a machine that keeps none skips the
 * cases and says what to run.
 */
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, type TestContext } from "vitest"
import { exitCodes } from "../../src/contract/Command.vibe"
import { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { probe } from "../../src/replay/Jail.ts"
import { corepackRelease, type Release } from "./corepack.ts"
import { bin, commit, git, observes, remove, skipBecause, start, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

/** A machine that can jail a step: Linux with a bubblewrap that starts. */
const jails = !("refusal" in probe())

/**
 * The newest pnpm 10 this machine's corepack keeps, which each case copies into a corepack cache of its own. pnpm 11
 * writes the time it checked the install into `node_modules` before every script, which is not this test's subject.
 */
const kept = corepackRelease("pnpm", "pnpm@10", (release) => /^10\.\d+\.\d+$/.test(release))

/** That release; on a machine with none, the case is skipped and says what to run. */
const pnpm = (context: TestContext): Release => "missing" in kept ? skipBecause(context, kept.missing) : kept

/** Every path under a directory with its kind, mode and bytes, in order: equal digests are equal trees. */
const digest = (root: string): string => {
  const hash = createHash("sha256")
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = join(relative, name)
      const status = lstatSync(join(root, path))
      hash.update(`${path}\0${status.mode}\0`)
      if (status.isSymbolicLink()) hash.update(readlinkSync(join(root, path)))
      else if (status.isDirectory()) walk(path)
      else hash.update(readFileSync(join(root, path)))
      hash.update("\0")
    }
  }
  walk("")
  return hash.digest("hex")
}

/**
 * A registry on this machine that serves one pnpm, packed from the release this machine keeps, and counts every
 * request. corepack asks it for the release's record, then for the archive the record names.
 */
const registry = async (kept: { readonly version: string; readonly directory: string }) => {
  const archive = join(keep(temporary("registry")), "pnpm.tgz")
  execFileSync("tar", ["-czf", archive, "--exclude", ".corepack", "-C", dirname(kept.directory), kept.version])
  const asked: Array<string> = []
  const server = createServer((request, response) => {
    asked.push(request.url ?? "")
    const { port } = server.address() as AddressInfo
    if (request.url === `/pnpm/${kept.version}`) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        name: "pnpm",
        version: kept.version,
        dist: { tarball: `http://127.0.0.1:${port}/pnpm/-/pnpm-${kept.version}.tgz` }
      }))
    } else if (request.url === `/pnpm/-/pnpm-${kept.version}.tgz`) {
      response.end(readFileSync(archive))
    } else {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Where this machine finds a program. */
const which = (name: string): string => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim()

/**
 * The directories of corepack's `pnpm` shim, of `strace`, which records what a step reads, of `node` and of the
 * system's programs, as this machine has them. With `jailed` false each is a directory of links to its programs
 * but bubblewrap, so no step is jailed.
 */
const searchPath = (jailed: boolean, release: Release): string => {
  const entries = [
    ...new Set([dirname(release.program), dirname(which("strace")), dirname(process.execPath), "/usr/bin", "/bin"])
  ]
  if (jailed) return [...entries, dirname(which("bwrap"))].join(":")
  return entries.map((entry) => {
    const without = keep(temporary("no-jail"))
    for (const name of readdirSync(entry)) {
      if (name !== "bwrap") symlinkSync(join(entry, name), join(without, name))
    }
    return without
  }).join(":")
}

/** A repository that names `version` of pnpm, gets it from `url`, and runs one script; then a docs commit. */
const repository = (version: string, url: string): string => {
  const root = keep(temporary("corepack-home"))
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", {
    ".github/workflows/ci.yml": [
      "name: CI",
      "on: [push, pull_request]",
      "env:",
      `  COREPACK_NPM_REGISTRY: ${url}`,
      // The registry on this machine signs nothing.
      "  COREPACK_INTEGRITY_KEYS: \"0\"",
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: pnpm run check",
      ""
    ].join("\n"),
    "package.json": JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      private: true,
      packageManager: `pnpm@${version}`,
      scripts: { check: "node check.js" }
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "check.js": "if (require(\"./src/value.js\") !== \"ok\") process.exit(1)\n",
    "src/value.js": "module.exports = \"ok\"\n",
    "docs/readme.md": "# Fixture\n"
  })
  commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
  return root
}

const ways = [
  { where: "in the jail", jailed: true, runs: observes && jails },
  { where: "with no jail", jailed: false, runs: observes }
]

describe.each(ways)("pnpm run through corepack, $where", ({ jailed, runs }) => {
  /** Replays the repository's two commits with `cache` as the person's corepack cache and `kept`'s release. */
  const replay = async (cache: string, kept: Release) => {
    const served = await registry(kept)
    try {
      const root = repository(kept.version, served.url)
      const before = digest(cache)
      const outcome = await start(bin, ["--commits", "2", "--no-apply-check", "--no-trial", "--json"], root, {
        // The person's own corepack cache, in a home that is theirs.
        COREPACK_HOME: cache,
        PATH: searchPath(jailed, kept),
        ...(jailed ? {} : { SMITHERS_CI_ALLOW_UNCONFINED: "1" })
      }).done
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
      expect(report.mismatches).toBe(0)
      expect(report.commits.map((replayed) => [replayed.baseline.ok, replayed.normal.failures ?? []])).toEqual([
        [true, []],
        [true, []]
      ])
      // The person's cache is never written, whichever pnpm the steps ran.
      expect(digest(cache)).toBe(before)
      return { report, asked: served.asked }
    } finally {
      await served.close()
    }
  }

  it.skipIf(!runs)("a pnpm the person's corepack keeps opens no network, and the step is reused", async (context) => {
    const kept = pnpm(context)
    const cache = keep(temporary("person-corepack"))
    cpSync(kept.directory, join(cache, "v1", "pnpm", kept.version), { recursive: true })
    const { report, asked } = await replay(cache, kept)
    expect(asked).toEqual([])
    // The docs commit changes no file the step reads: it is answered from its record.
    expect(report.commits.at(-1)?.normal.counts).toEqual({ hit: 1, ran: 0, failed: 0, skipped: 0 })
  }, 900_000)

  it.skipIf(!runs)("a pnpm it does not keep is fetched into the step's own home", async (context) => {
    const kept = pnpm(context)
    const cache = keep(temporary("person-corepack"))
    mkdirSync(join(cache, "v1"))
    const { asked } = await replay(cache, kept)
    // Fetched at each commit, in the baseline and in normal mode.
    expect(asked.filter((url) => url === `/pnpm/-/pnpm-${kept.version}.tgz`).length).toBeGreaterThanOrEqual(2)
    expect(readdirSync(join(cache, "v1"))).toEqual([])
  }, 900_000)
})
