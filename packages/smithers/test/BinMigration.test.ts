/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { Version } from "../src/index.ts"
import {
  inProject,
  keyless,
  keylessMigration,
  processBudget,
  refusal,
  run,
  stageLegacyProject,
  temporaryDirectoryPrefix
} from "./support/bin.ts"

/**
 * The release policy detection, at the process boundary.
 *
 * The rule is "0.x markers and no `.flows/` beside them", and the CLI creates
 * `<root>/.flows` as soon as it opens the control database. Sampling the
 * markers from a handler therefore looked at a directory the same invocation
 * had just written, and the notice never printed on the projects it exists
 * for. Only a real process can catch that, because in-process assertions on
 * `Project.legacyState` pass either way.
 */
describe("Smithers 0.x detection", processBudget, () => {
  const stage = (): string => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true })
    writeFileSync(join(cwd, ".smithers", "workflows", "ship.tsx"), "export default null\n")
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "legacy" }))
    // The real 0.x table and column names, because the point of the check is
    // that it reads a database the old CLI wrote. The columns are the ones
    // `@smthrs/migrate`'s run-state scan selects, and every one of them is in
    // the original 16 that `packages/smithers/migrate/test/fixtures/persisted-db/old-schema.sql`
    // records verbatim from a live 0.x database. A narrower stand-in made the
    // scan report every project as one it could not read, which reads as a
    // defect in the project rather than in the fixture.
    const database = new DatabaseSync(join(cwd, "smithers.db"))
    database.exec(
      `CREATE TABLE _smithers_runs (
         run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
         heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
         pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
       )`
    )
    database.exec(
      "INSERT INTO _smithers_runs (run_id, workflow_name, status) " +
        "VALUES ('run-old-1','ship','running'),('run-old-2','ship','finished')"
    )
    database.close()
    return cwd
  }

  it("prints the 0.x-project notice on a first command in a 0.x project", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["ls", "--json"])

      // Informational: it names the state and does not change the exit code.
      expect(result.status).toBe(0)
      expect(result.stderr).toContain("Found Smithers 0.x state at")
      expect(result.stderr).toContain("does not load, resume, or migrate 0.x run databases")
      expect(result.stderr).toContain("https://smithers.sh/migration/1.0#run-data")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("prints the notice whichever command runs first, not only `ls` and `up`", () => {
    // The 0.x-project guard says "when a command runs in a directory", and an operator
    // arriving at a 0.x project types `ps` or `status` at least as often as
    // `ls`. Wiring the notice into two handlers meant the notice depended on
    // which verb happened to be typed first, and the second command never
    // printed it because the first had written `.flows/`.
    for (const argv of [["ps", "--json"], ["status"], ["doctor", "--json"]]) {
      const cwd = stage()
      try {
        const result = inProject(cwd, argv)

        expect(result.stderr).toContain("Found Smithers 0.x state at")
        expect(result.stderr).toContain("https://smithers.sh/migration/1.0#run-data")
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  })

  it("prints the notice once per invocation", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["ls", "--json"])
      const notices = result.stderr.split("Found Smithers 0.x state at").length - 1

      expect(notices).toBe(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("refuses to migrate a project that still holds non-terminal 0.x runs", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["migrate", "--json"])

      // The 0.x-project guard has to win over every later check: the
      // operator's next step is the 0.x CLI, not installing a flow.
      expect(result.status).toBe(1)
      const error = JSON.parse(result.stdout)
      expect(error.message).toContain("Refusing to migrate")
      expect(error.message).toContain("run-old-1 running (ship)")
      expect(error.message).not.toContain("run-old-2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("still refuses once the project has an rc.0 state directory", () => {
    const cwd = stage()
    try {
      // The realistic order: the operator runs something in the project
      // first, which writes `.flows/`, and only then reaches for `migrate`.
      // The 0.x-project guard gates the informational notice on `.flows/` being absent;
      // it does not gate the refusal, and gating it there would retire the
      // guard for every project that ever ran an rc.0 command.
      expect(inProject(cwd, ["ls", "--json"]).status).toBe(0)
      expect(existsSync(join(cwd, ".flows"))).toBe(true)

      const result = inProject(cwd, ["migrate", "--json"])

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).message).toContain("Refusing to migrate")
      expect(JSON.parse(result.stdout).message).toContain("run-old-1 running (ship)")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reaches the migration tool shipped in @smthrs/migrate, not a project-local flow file", () => {
    // A 0.x project has no `flows/` directory by definition, so demanding one
    // made the verb unreachable for every project it exists for. The flow
    // ships inside `@smthrs/migrate` (the release policy, the release scope);
    // the verb runs that, and what it answers is the migration tool's own
    // report or the migration tool's own refusal.
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true })
      writeFileSync(join(cwd, ".smithers", "workflows", "ship.tsx"), "export default null\n")
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "legacy" }))
      const database = new DatabaseSync(join(cwd, "smithers.db"))
      database.exec(
        `CREATE TABLE _smithers_runs (
           run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
           heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
           pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
         )`
      )
      // Terminal only: the 0.x-project guard has nothing to hold, so the verb
      // gets as far as the tool.
      database.exec("INSERT INTO _smithers_runs (run_id, workflow_name, status) VALUES ('run-old-1','ship','finished')")
      database.close()

      const result = inProject(cwd, ["migrate", "--json"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("is not installed in this project")
      expect(output).not.toContain("Add it under flows/")
      expect(JSON.parse(result.stdout)).toMatchObject({ tool: { name: "@smthrs/migrate" }, mode: "plan" })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("keeps reporting the old database in doctor after the state directory exists", () => {
    const cwd = stage()
    try {
      expect(inProject(cwd, ["ls", "--json"]).status).toBe(0)

      const report = JSON.parse(inProject(cwd, ["doctor", "--json"]).stdout) as {
        readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }>
      }
      const legacy = report.checks.filter((check) => check.name === "smithers 0.x")

      expect(legacy.some((check) => check.detail.includes("1 non-terminal runs"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reports the 0.x paths and the runs the old database still holds", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["doctor", "--json"])
      const report = JSON.parse(result.stdout) as {
        readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }>
      }
      const legacy = report.checks.filter((check) => check.name === "smithers 0.x")

      expect(legacy.map((check) => check.detail).join("\n")).toContain(".smithers")
      // `running` is non-terminal and `finished` is not, and the count is
      // what tells an operator whether the 0.x CLI still has work to finish.
      expect(legacy.some((check) => check.detail.includes("1 non-terminal runs"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The `migrate` command's process-level shape.
 *
 * The verb runs the flow that ships inside `@smthrs/migrate`, which is the
 * same entry `smithers-migrate` runs. A verb that reached that entry with
 * `apply: false` hardcoded could plan and nothing else, so the transformation
 * the contract row promises was unreachable however the operator typed it.
 * Only a real process can prove the flag set, because the parser is what
 * rejects an undeclared flag.
 */
describe("the migrate verb's option surface", processBudget, () => {
  /** A 0.x project whose runs are all terminal, so the 0.x-project guard has nothing to hold. */
  const stageTerminal = (): string => stageLegacyProject(mkdtempSync(temporaryDirectoryPrefix))

  it("declares the migration tool's own flags", () => {
    const help = run(["migrate", "--help"])
    const text = `${help.stdout}${help.stderr}`

    // The set `packages/smithers/migrate/src/flow/bin.ts` declares, minus `--json`,
    // which is a shared global here.
    for (
      const flag of [
        "--scan",
        "--apply",
        "--seat",
        "--allow-unsafe",
        "--acknowledge-run-state",
        "--allow-no-vcs",
        "--keep-old-sources",
        "--unit",
        "--max-repair-rounds",
        "--report-dir",
        "--flows-dir",
        "--verify-install",
        "--verify-format",
        "--verify-typecheck",
        "--verify-test",
        "--verify-read",
        "--verify-unconfined"
      ]
    ) {
      expect(text, flag).toContain(flag)
    }
  })

  it("runs the tool in scan mode when --scan is given", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--scan", "--json"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("Unrecognized flag")
      // The tool's own heading names the mode it ran in, so this is the mode
      // reaching the flow rather than the flag being parsed and dropped.
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: "scan", tool: { name: "@smthrs/migrate" } })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reaches apply mode with --apply, where plan mode never writes", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--apply", "--json"], keylessMigration)
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("Unrecognized flag")
      // Plan mode renders its own heading and exits 0; apply mode is the only
      // one the run-state gate parks. Reaching that park is the proof the mode
      // arrived, and 3 is the status `smithers-migrate` gives a park.
      expect(output).not.toContain("smthrs migrate plan:")
      expect(result.status).toBe(3)
      expect(output).toContain("--acknowledge-run-state")
      expect(JSON.parse(result.stdout).code).toBe("run-state-blocked")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("parks a keyless apply at the run-state gate", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--apply", "--json"], keylessMigration)
      const output = `${result.stdout}${result.stderr}`

      expect(result.status).toBe(3)
      expect(JSON.parse(result.stdout).code).toBe("run-state-blocked")
      expect(output).toContain("--acknowledge-run-state")
      expect(output).not.toContain("AI_GATEWAY_API_KEY")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * Which project `smthrs migrate` converts.
 *
 * The verb's default target used to be the rc.0 project root, whose walk
 * anchors on `.flows/`. A 0.x project has none, which is what makes it a 0.x
 * project, so a project without a `.git`/`.jj` marker of its own resolved to
 * whatever rc.0 project sat above it, and `--apply` rewrote the ancestor's
 * tree. Only a real process shows it: the resolution happens while the layers
 * are built, before any handler runs.
 */
describe("the migrate verb's target", processBudget, () => {
  /** An rc.0 project with a 0.x project inside it and no VCS marker between them. */
  const stageNested = (): { readonly ancestor: string; readonly project: string } => {
    const ancestor = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    // The `.flows/` the root walk anchors on, and nothing else.
    mkdirSync(join(ancestor, ".flows"), { recursive: true })
    return { ancestor, project: stageLegacyProject(join(ancestor, "legacy-project")) }
  }

  it("converts the project the operator is standing in, not an rc.0 ancestor", () => {
    const { ancestor, project } = stageNested()
    try {
      const result = inProject(project, ["migrate", "--scan", "--json"])
      const report = JSON.parse(result.stdout) as {
        readonly root: string
        readonly units: ReadonlyArray<{ readonly id: string }>
      }

      expect(report.root).toBe(project)
      // The fixture's own units, and only those: its `package.json`, the one
      // workflow under `.smithers/workflows`, and the project itself. The scan
      // walks down, so these three appear from the ancestor too. `root` is
      // what separates the two answers, and `root` is what `--apply` writes
      // against.
      expect(report.units.map((unit) => unit.id)).toEqual(["dependencies", "workflow:ship", "project"])
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })

  it("names the tree it would rewrite when apply stops at the version-control gate", () => {
    const { ancestor, project } = stageNested()
    try {
      // The gate refuses before anything is written, and the refusal quotes the
      // directory the migration would have rewritten, so it reports the target
      // without producing one.
      const result = inProject(
        project,
        ["migrate", "--apply", "--acknowledge-run-state", "--json"],
        keylessMigration
      )

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).message).toContain(`"${project}" is under no version control`)
      expect(JSON.parse(result.stdout).message).not.toContain(`"${ancestor}" is under no version control`)
      // The read-only VCS preflight precedes even lock metadata creation.
      expect(existsSync(join(ancestor, ".smithers-migrate"))).toBe(false)
      expect(existsSync(join(project, ".smithers-migrate"))).toBe(false)
      expect(readFileSync(join(project, ".smithers/workflows/ship.tsx"), "utf8")).toBe("export default null\n")
      expect(readFileSync(join(project, "package.json"), "utf8")).toBe(JSON.stringify({ name: "legacy" }))
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })

  it("refuses a keyless apply without version control or rewriting either nested project", () => {
    const { ancestor, project } = stageNested()
    try {
      // Version-control safety is checked before any model is needed.
      const result = inProject(
        project,
        ["migrate", "--apply", "--acknowledge-run-state", "--json"],
        keylessMigration
      )

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).message).toContain(`"${project}" is under no version control`)
      expect(result.stdout).not.toContain("AI_GATEWAY_API_KEY")
      // Safety checks precede even lock metadata creation.
      expect(existsSync(join(ancestor, ".smithers-migrate"))).toBe(false)
      expect(existsSync(join(project, ".smithers-migrate"))).toBe(false)
      expect(readFileSync(join(project, ".smithers/workflows/ship.tsx"), "utf8")).toBe("export default null\n")
      expect(readFileSync(join(project, "package.json"), "utf8")).toBe(JSON.stringify({ name: "legacy" }))
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })
})
