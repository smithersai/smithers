/**
 * A repository whose CI is `npm test`, replayed on a machine whose Node is
 * installed under the home directory, as nvm, Volta, fnm, asdf and mise
 * install it: `npm` is a link out of `bin` into the installation.
 *
 * The real program runs, with a real Node and a real npm copied under a
 * temporary home, and no other Node first on `PATH`.
 */
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { afterAll, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, head, remove, start, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const node = realpathSync(process.execPath)
/** Where a Node distribution keeps npm, beside its `bin`. */
const npmPackage = resolve(dirname(node), "../lib/node_modules/npm")

/** Installs this machine's Node under `home` the way a Node distribution unpacks: `bin/node`, and `bin/npm` as a link. */
const install = (home: string): string => {
  const prefix = join(home, ".local", "node")
  mkdirSync(join(prefix, "bin"), { recursive: true })
  // A copy, never a hard link: a link changes the status of the machine's own Node, and every observed step
  // running on the machine at that moment reads that as Node having changed while it ran, and is not stored.
  copyFileSync(node, join(prefix, "bin", "node"))
  cpSync(npmPackage, join(prefix, "lib", "node_modules", "npm"), { recursive: true })
  symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(prefix, "bin", "npm"))
  return join(prefix, "bin")
}

/**
 * The system directories, and a copy of the sandbox's own program when this machine keeps it elsewhere. A copy,
 * not a link: kept in another home than the temporary one, as `~/.local/bin` holds it, the program a link leads
 * to is out of a step's sight.
 */
const systemPath = (): string => {
  const entries = ["/usr/bin", "/bin"]
  if (process.platform !== "linux") return entries.join(":")
  const bwrap = execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim()
  if (bwrap.startsWith("/usr/") || bwrap.startsWith("/bin/")) return entries.join(":")
  const directory = keep(temporary("sandbox"))
  copyFileSync(realpathSync(bwrap), join(directory, "bwrap"))
  chmodSync(join(directory, "bwrap"), 0o755)
  return [...entries, directory].join(":")
}

it.skipIf(process.platform === "win32" || !existsSync(npmPackage))(
  "replays `npm test` with Node under the home directory: no mismatch, and a failure only at the commit that broke the test",
  async () => {
    const home = keep(temporary("home"))
    const tools = install(home)
    const root = keep(temporary("npm-workspace"))
    git(root, "init", "--quiet", "--initial-branch=main")
    // Each test also fails unless the Node that runs it is the one under the home directory.
    const test = (name: string): string =>
      [
        "const assert = require(\"node:assert\")",
        `assert.equal(process.execPath, ${JSON.stringify(join(tools, "node"))})`,
        `assert.equal(require("./value.js"), "ok", ${JSON.stringify(name)})`,
        ""
      ].join("\n")
    commit(root, "a passing workspace", {
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
        scripts: { test: "npm run test --workspaces" }
      }),
      "packages/a/package.json": JSON.stringify({
        name: "@fixture/a",
        version: "1.0.0",
        scripts: { test: "node test.js" }
      }),
      "packages/a/test.js": test("a"),
      "packages/a/value.js": "module.exports = \"ok\"\n",
      "packages/b/package.json": JSON.stringify({
        name: "@fixture/b",
        version: "1.0.0",
        scripts: { test: "node test.js" }
      }),
      "packages/b/test.js": test("b"),
      "packages/b/value.js": "module.exports = \"ok\"\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push, pull_request]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm test",
        ""
      ].join("\n")
    })
    const passing = head(root)
    commit(root, "a is broken", { "packages/a/value.js": "module.exports = \"broken\"\n" })
    const broken = head(root)
    commit(root, "a is fixed", { "packages/a/value.js": "module.exports = \"ok\"\n// fixed\n" })
    const fixed = head(root)

    const outcome = await start(bin, ["--commits", "3", "--no-apply-check", "--json"], root, {
      HOME: home,
      PATH: `${tools}:${systemPath()}`
    }).done
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const report = Schema.decodeUnknownSync(ReplayReport)(JSON.parse(outcome.stdout))
    expect(report.mismatches).toBe(0)
    expect(report.notReplayed).toBeUndefined()
    const at = (commit: string) => {
      const found = report.commits.find((entry) => entry.commit === commit)!
      return { baseline: found.baseline.ok, normal: found.normal.ok, failed: found.normal.counts.failed > 0 }
    }
    expect(report.commits).toHaveLength(3)
    expect(at(passing)).toEqual({ baseline: true, normal: true, failed: false })
    expect(at(broken)).toEqual({ baseline: false, normal: false, failed: true })
    expect(at(fixed)).toEqual({ baseline: true, normal: true, failed: false })
  },
  900_000
)
