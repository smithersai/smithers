/**
 * A repository whose CI runs tools that are kept under the home directory,
 * replayed by the real program with a temporary home and a `PATH` that names
 * them.
 *
 * A version manager of an invented name keeps its shims in `~/.vm/shims` and
 * its versions in `~/.vm/versions`; another keeps its versions in a directory
 * no known manager uses. Each shim runs its version through `HOME`, which is
 * the step's own home in a replay, in the baseline and in normal mode, with a
 * jail and without one. A wrapper that starts a tool kept in another
 * directory of the home is not given that directory: its step fails, and the
 * failure says which directory to put on `PATH`.
 */
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, remove, start, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const program = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** A machine that can jail a step: Linux with a bubblewrap that starts. */
const jails = !("refusal" in probe())

/** The system directories, with the jail's own program when `jailed`, wherever this machine keeps it. */
const systemPath = (jailed: boolean): string => {
  const entries = ["/usr/bin", "/bin"]
  if (!jailed) {
    // No bubblewrap on `PATH`: a directory of every program of the system directories but that one.
    return entries.map((entry) => {
      const without = keep(temporary("no-jail"))
      for (const name of execFileSync("ls", [entry], { encoding: "utf8" }).split("\n")) {
        if (name !== "" && name !== "bwrap") symlinkSync(join(entry, name), join(without, name))
      }
      return without
    }).join(":")
  }
  const bwrap = execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim()
  if (bwrap.startsWith("/usr/") || bwrap.startsWith("/bin/")) return entries.join(":")
  const directory = keep(temporary("jail"))
  symlinkSync(bwrap, join(directory, "bwrap"))
  return [...entries, directory].join(":")
}

const workflow = (...commands: ReadonlyArray<string>): string =>
  [
    "name: CI",
    "on: [push, pull_request]",
    "jobs:",
    ...commands.flatMap((command, index) => [
      `  job${index}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - run: ${JSON.stringify(command)}`
    ]),
    ""
  ].join("\n")

const repository = (...commands: ReadonlyArray<string>): string => {
  const root = keep(temporary("home-managers"))
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", { ".github/workflows/ci.yml": workflow(...commands), "docs/readme.md": "# Fixture\n" })
  commit(root, "docs only", { "docs/readme.md": "# Fixture\n\nMore words.\n" })
  return root
}

const ways = [
  { where: "in the jail", jailed: true, runs: jails },
  { where: "with no jail", jailed: false, runs: true }
]

describe.each(ways)("tools kept under the home directory, $where", ({ jailed, runs }) => {
  it.skipIf(!runs)(
    "a version manager's shim finds its versions under the step's own home, in the baseline and in normal mode",
    async () => {
      const home = keep(temporary("home"))
      // The manager of an invented name, with the directory of versions a manager is known by.
      program(join(home, ".vm", "shims", "tool"), "exec \"$HOME/.vm/versions/1/bin/tool\" \"$@\"")
      program(join(home, ".vm", "versions", "1", "bin", "tool"), "test \"$1\" = check")
      // Another, whose directory is known for a tool's own only by what its shim runs.
      program(join(home, ".vt", "shims", "other"), "exec \"$HOME/.vt/kept/2/other\" \"$@\"")
      program(join(home, ".vt", "kept", "2", "other"), "test \"$1\" = check")
      const root = repository("tool check", "other check")
      const outcome = await start(bin, ["--commits", "2", "--no-apply-check", "--json"], root, {
        HOME: home,
        PATH: `${join(home, ".vm", "shims")}:${join(home, ".vt", "shims")}:${dirname(process.execPath)}:${
          systemPath(jailed)
        }`
      }).done
      expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
      const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
      expect(outcome.stderr.includes("steps run without a file-system jail")).toBe(!jailed)
      expect(report.notReplayed).toBeUndefined()
      expect(report.mismatches).toBe(0)
      expect(report.commits).toHaveLength(2)
      for (const replayed of report.commits) {
        expect([replayed.baseline.failures ?? [], replayed.normal.failures ?? []]).toEqual([[], []])
        expect(replayed.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
        expect(replayed.normal.counts.hit + replayed.normal.counts.ran).toBe(2)
      }
    },
    900_000
  )

  it.skipIf(!runs)(
    "a wrapper that starts a tool kept in another directory of the home fails, and says which directory to put on PATH",
    async () => {
      const home = keep(temporary("home"))
      program(join(home, "a", "bin", "wrap"), "exec \"$HOME/b/tool\" \"$@\"")
      program(join(home, "b", "tool"), "true")
      const root = repository("wrap")
      const outcome = await start(bin, ["--commits", "1", "--no-apply-check"], root, {
        HOME: home,
        PATH: `${join(home, "a", "bin")}:${dirname(process.execPath)}:${systemPath(jailed)}`
      }).done
      expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
      expect(outcome.stdout).toBe("")
      const lines = outcome.stderr.trim().split("\n")
      expect(lines.at(-3)).toBe("  exit     127")
      expect(lines.at(-2)).toMatch(/^ {2}error {4}.*\/home\/b\/tool/)
      expect(lines.at(-1)).toBe(
        "  fix      put ~/b on PATH: ~/b/tool is in your home directory and not in the step's, "
          + "and a step gets a tool whose own directory is on PATH"
      )
    },
    900_000
  )
})
