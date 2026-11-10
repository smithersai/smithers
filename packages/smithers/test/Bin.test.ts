/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.vibe"
import { Version } from "../src/index.ts"
import * as Unsupported from "../src/Unsupported.ts"
import {
  executable,
  inEmptyDirectory,
  processBudget,
  run,
  runIn,
  scriptedHost,
  temporaryDirectoryPrefix
} from "./support/bin.ts"
import { spawnNodeSync } from "./support/node-child.ts"

describe("smithers executable", processBudget, () => {
  it("reports the package version", () => {
    const result = run(["--version"])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(Version.packageVersion)
  })

  /**
   * `--version` and `--help` are documents, not work. They resolved a project
   * root, scanned its `.smithers/flows/` tree, and opened both SQLite databases before
   * `effect/cli` decided the invocation only wanted a document. In
   * the release validation that cost more than ten minutes: the invocation
   * directory held no project marker, the walk climbed to `$HOME`, and
   * discovery scanned the whole home tree.
   *
   * The staged tree below is that shape in miniature: an ancestor holding
   * `.flows/` (so the walk anchors there) and a `.smithers/flows/` directory with
   * enough entries that a scan is unmistakably slower than the budget.
   */
  const stageHomeProject = (entries: number): string => {
    const home = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    mkdirSync(join(home, ".flows"), { recursive: true })
    for (let index = 0; index < entries; index++) {
      const directory = join(home, ".smithers", "flows", `pkg${index}`, "sub")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "README.md"), "x")
    }
    mkdirSync(join(home, "deep", "nested"), { recursive: true })
    return home
  }

  it("answers --version without discovery or a database, from a directory with no project marker", () => {
    const home = stageHomeProject(24)
    try {
      const result = spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, "--version"], {
        cwd: join(home, "deep", "nested"),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      expect(existsSync(join(home, ".flows", "control.db"))).toBe(false)
      expect(existsSync(join(home, ".flows", "engine.db"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("answers --help without discovery or a database, from a directory with no project marker", () => {
    const home = stageHomeProject(24)
    try {
      const result = spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, "--help"], {
        cwd: join(home, "deep", "nested"),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("plan")
      expect(existsSync(join(home, ".flows", "control.db"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  /**
   * The docs generator imports `src/Cli.ts` in-process under Node's type
   * stripping, a second source-checkout entry beside `src/bin.ts`. A sibling
   * import spelled `./Diagnosis.js` for a `Diagnosis.ts` file broke both.
   * `--check` writes nothing; reaching the drift comparison proves the whole
   * CLI graph loaded and every help page rendered, whether or not the
   * committed pages are current.
   */
  it("loads the CLI the docs generator imports from the source checkout", () => {
    const generator = fileURLToPath(new URL("../../../apps/site/scripts/gen-cli-data.mjs", import.meta.url))
    const result = spawnNodeSync(["--no-warnings", generator, "--check"], {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_OPTIONS: "" }
    })
    expect(result.error).toBeUndefined()
    const reasons = result.stderr.split("\n").filter((line) => line !== "")
    expect(reasons.filter((line) => !line.startsWith("drift: "))).toEqual([])
    expect(result.status).toBe(reasons.length === 0 ? 0 : 1)
    if (reasons.length === 0) expect(result.stdout).toBe("up to date\n")
  })

  it("exits with usage status for malformed JSON input", () => {
    const result = run(["plan", "system/test", "--data", "{"])

    expect(result.status).toBe(2)
  })

  it("reports a missing project root as a usage error", () => {
    inEmptyDirectory((cwd) => {
      const path = join(cwd, "absent")
      const result = runIn(cwd, ["--root", path, "ls"], { SMITHERS_AUDIENCE: "human" })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("--root")
      expect(result.stderr).toContain(path)
      expect(result.stderr).not.toMatch(/ENOENT|realpath|stat '/)
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it.each([
    ["memory", ["list", "get", "set", "rm"]],
    ["claude", ["tick", "node-wait", "monitor", "subscribe", "unsubscribe"]],
    ["mcp", ["add"]]
  ])("shows the available subcommands for bare %s", (verb, subcommands) => {
    const result = run([verb as string])
    expect(result.status).toBe(verb === "claude" ? 2 : 0)
    for (const subcommand of subcommands) expect(result.stdout + result.stderr).toContain(subcommand)
  })

  it("reports invalid pre-parse configuration as flag-specific usage errors", () => {
    inEmptyDirectory((cwd) => {
      const missing = join(cwd, "missing.json")
      const malformed = join(cwd, "malformed.json")
      writeFileSync(malformed, "{")

      const remoteResult = runIn(cwd, ["runs", "list", "--remote", "nota", "--json"])
      const missingResult = runIn(cwd, ["runs", "list", "--mcp-config", missing, "--json"])
      const malformedResult = runIn(cwd, ["runs", "list", "--mcp-config", malformed, "--json"])

      expect(remoteResult.status).toBe(2)
      expect(JSON.parse(remoteResult.stdout).message).toContain(
        "--remote must be an http:// or https:// URL; got \"nota\""
      )
      expect(missingResult.status).toBe(2)
      expect(JSON.parse(missingResult.stdout).message).toContain(`--mcp-config ${missing}: file not found`)
      expect(malformedResult.status).toBe(2)
      // The path, never the parser's own text.
      const malformedMessage = JSON.parse(malformedResult.stdout).message as string
      expect(malformedMessage).toContain(`--mcp-config ${malformed} is not valid JSON`)
      expect(malformedMessage).not.toMatch(/JSON input|Expected property|position/)
      for (
        const output of [
          remoteResult.stdout,
          missingResult.stdout,
          malformedResult.stdout
        ]
      ) {
        expect(output).not.toContain("TypeError")
        expect(output).not.toContain("ENOENT")
        expect(output).not.toContain("SyntaxError")
      }
    })
  })

  it("exits with usage status for a flag no command declares", () => {
    const result = run(["ls", "--filter", "review"])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--filter")
  })
})

describe("the help surface", processBudget, () => {
  const help = run(["--help"])

  it("lists canonical target and durable command groups", () => {
    expect(help.status).toBe(0)
    for (
      const name of ["flow", "runs", "todo", "host", "api"]
    ) {
      expect(help.stdout).toMatch(new RegExp(`^\\s+${name}\\s{2,}`, "m"))
    }
    // Appendix B.6: callable library groups are absent from install discovery.
    for (
      const name of ["build", "test", "targets", "approvals", "eval", "memory", "credentials", "triggers"]
    ) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${name}\\s{2,}`, "m"))
    }
  })

  it("advertises no removed verb", () => {
    const manifest = run(["--llms-full", "--format", "json"])
    expect(manifest.status).toBe(0)
    const commands = new Set((JSON.parse(manifest.stdout) as { commands: { name: string }[] }).commands
      .map((command) => command.name))
    // Matched on the help layout's own leading indentation so a word that
    // merely appears inside a description is not read as a listed command.
    for (const verb of Unsupported.removedVerbs) {
      if (verb.subcommands === undefined) {
        expect(help.stdout).not.toMatch(new RegExp(`^\\s+${verb.name}\\s{2,}`, "m"))
        expect(commands.has(verb.name)).toBe(false)
      } else {
        // Catalog parents can return while their old child verbs remain removed.
        for (const child of verb.subcommands) expect(commands.has(`${verb.name} ${child}`)).toBe(false)
      }
    }
  })

  it("advertises no alias, which is what keeps the list the contract's list", () => {
    for (const alias of ["resume", "inspect", "why", "events", "gateway"]) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${alias}\\s{2,}`, "m"))
    }
  })
})
