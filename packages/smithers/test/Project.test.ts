/**
 * Where an invocation decides it is running, and whether Smithers 0.x state is
 * beside it.
 *
 * The 0.x requirement carried forward (`apps/cli/tests/resolve-root.test.js`
 * and `cli-root-consistency.e2e.test.js`): two commands run from different
 * directories of one project must resolve the same root, or they write to two
 * different databases and disagree about what exists.
 */
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as Project from "../src/Project.ts"

const staged: Array<string> = []

const project = (...markers: ReadonlyArray<string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-project-"))
  staged.push(directory)
  mkdirSync(join(directory, ".git"), { recursive: true })
  for (const marker of markers) {
    if (marker.endsWith("/")) mkdirSync(join(directory, marker), { recursive: true })
    else writeFileSync(join(directory, marker), "")
  }
  return directory
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

it("distinguishes current build definitions from legacy run state without hiding unknown files", () => {
  const root = project(".smithers/", ".smithers/WORKSPACE.ts", ".smithers/FACTORY.ts", ".smithers/home.json")
  expect(Project.legacyState(root)).toEqual([])
  writeFileSync(join(root, ".smithers", "runs.sqlite"), "")
  expect(Project.legacyState(root)).toEqual([join(root, ".smithers")])
  rmSync(join(root, ".smithers", "runs.sqlite"))
  // The opencode server's own files are 1.0 state, beside build definitions or
  // alone: its database, the sidecars an open one has, and the record naming
  // the server that holds the directory, which a killed server leaves behind.
  for (const file of ["opencode.sqlite", "opencode.sqlite-wal", "opencode.sqlite-shm", "opencode.server.json"]) {
    writeFileSync(join(root, ".smithers", file), "")
  }
  expect(Project.legacyState(root)).toEqual([])
  const served = project(".smithers/", ".smithers/opencode.sqlite")
  expect(Project.legacyState(served)).toEqual([])
  writeFileSync(join(served, ".smithers", "runs.db"), "")
  expect(Project.legacyState(served)).toEqual([join(served, ".smithers")])
  const empty = project(".smithers/")
  expect(Project.legacyState(empty)).toEqual([join(empty, ".smithers")])
  mkdirSync(join(root, ".smithers", "unknown-state"))
  expect(Project.legacyState(root)).toEqual([join(root, ".smithers")])
  rmSync(join(root, ".smithers"), { recursive: true })
  writeFileSync(join(root, ".smithers"), "unreadable as a directory")
  const exists = (path: string) =>
    path === join(root, ".smithers") ||
    path === join(root, ".smithers", "WORKSPACE.ts") || path === join(root, ".smithers", "FACTORY.ts") ||
    path === join(root, ".git")
  expect(Project.legacyState(root, exists)).toEqual([join(root, ".smithers")])
})

it("reads the alert policy as 1.0 state, alone or beside current files", () => {
  // `smthrs alerts` reads `.smithers/alerts.json`; a project that only
  // configures alerts must not print the 0.x notice on every command.
  const alerting = project(".smithers/", ".smithers/alerts.json")
  expect(Project.legacyState(alerting)).toEqual([])
  const served = project(".smithers/flows/", ".smithers/opencode.sqlite", ".smithers/alerts.json")
  expect(Project.legacyState(served)).toEqual([])
  writeFileSync(join(alerting, ".smithers", "smithers.db"), "")
  expect(Project.legacyState(alerting)).toEqual([join(alerting, ".smithers")])
})

it("reads a .smithers/flows/ directory as 1.0 state, alone or beside current files", () => {
  const flowsOnly = project(".smithers/flows/review/")
  writeFileSync(join(flowsOnly, ".smithers", "flows", "review", "flow.ts"), "")
  expect(Project.legacyState(flowsOnly)).toEqual([])
  const configured = project(
    ".smithers/flows/",
    ".smithers/WORKSPACE.ts",
    ".smithers/FACTORY.ts",
    ".smithers/home.json"
  )
  expect(Project.legacyState(configured)).toEqual([])
  const served = project(".smithers/flows/", ".smithers/opencode.sqlite")
  expect(Project.legacyState(served)).toEqual([])
  // Another subdirectory, 0.x's workflows/ among them, still reads as 0.x.
  mkdirSync(join(configured, ".smithers", "workflows"))
  expect(Project.legacyState(configured)).toEqual([join(configured, ".smithers")])
  // So does an unknown file beside flows/ with no build definitions.
  writeFileSync(join(flowsOnly, ".smithers", "smithers.db"), "")
  expect(Project.legacyState(flowsOnly)).toEqual([join(flowsOnly, ".smithers")])
})

it("reads the wiki's decisions pages under .smithers/wiki/ as 1.0 state", () => {
  // Agent memory writes `.smithers/wiki/decisions/<item>.md` (decisionsDirectory).
  const wikiOnly = project(".smithers/wiki/decisions/")
  writeFileSync(join(wikiOnly, ".smithers", "wiki", "decisions", "1.md"), "")
  expect(Project.legacyState(wikiOnly)).toEqual([])
  const both = project(".smithers/flows/", ".smithers/wiki/", ".smithers/WORKSPACE.ts", ".smithers/FACTORY.ts")
  expect(Project.legacyState(both)).toEqual([])
  mkdirSync(join(both, ".smithers", "prompts"))
  expect(Project.legacyState(both)).toEqual([join(both, ".smithers")])
})

describe("the project root", () => {
  it("resolves an explicit --root against the invocation directory", () => {
    expect(Project.root("sub/dir", "/a/b")).toBe(resolve("/a/b", "sub/dir"))
    expect(Project.root("/abs/root", "/a/b")).toBe("/abs/root")
    expect(Project.root("", "/a/b")).toBe(resolve("/a/b"))
  })

  it("anchors on the nearest ancestor holding .flows/ or .smithers/flows/", () => {
    const root = project(".smithers/flows/")
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })

    // The parity `up`, `ls`, and `ps` all depend on: one project, one root,
    // whichever directory the operator happened to be in.
    expect(Project.root(undefined, root)).toBe(root)
    expect(Project.root(undefined, nested)).toBe(root)
  })

  it("anchors on .flows/ as well, for a project that has run but has no sources yet", () => {
    const root = project(".flows/")
    expect(Project.root(undefined, join(root, "deep", "er"))).toBe(root)
  })

  it("does not mistake a package directory called flows for a project root", () => {
    // This repository is the case: `packages/smithers/flows` is the `@smthrs/flows`
    // package, and a bare-name rule made every invocation under `packages/`
    // write a second `packages/.flows` database.
    const root = project("package.json")
    const packages = join(root, "packages")
    mkdirSync(join(packages, "flows"), { recursive: true })
    const nested = join(packages, "cli", "scratch")
    mkdirSync(nested, { recursive: true })

    expect(Project.root(undefined, nested)).toBe(nested)
  })

  it("anchors on a .smithers/flows/ directory that sits beside a package manifest", () => {
    const root = project(".smithers/flows/", "package.json")
    rmSync(join(root, ".git"), { recursive: true, force: true })
    const nested = join(root, "src", "deep")
    mkdirSync(nested, { recursive: true })

    expect(Project.root(undefined, nested)).toBe(root)
  })

  it("does not anchor on a retired root flows/ directory", () => {
    const root = project("flows/", "package.json")
    rmSync(join(root, ".git"), { recursive: true, force: true })
    const nested = join(root, "src", "deep")
    mkdirSync(nested, { recursive: true })

    expect(Project.root(undefined, nested)).toBe(nested)
  })

  it("does not anchor on .smithers/flows/ without a project marker beside it", () => {
    const outer = project()
    const inner = join(outer, "tools")
    mkdirSync(join(inner, ".smithers", "flows"), { recursive: true })
    const nested = join(inner, "src")
    mkdirSync(nested, { recursive: true })

    expect(Project.root(undefined, nested)).toBe(nested)
    writeFileSync(join(inner, "package.json"), "{}")
    expect(Project.root(undefined, nested)).toBe(inner)
  })

  it("falls back to the invocation directory when nothing anchors", () => {
    const root = project()
    expect(Project.root(undefined, root)).toBe(root)
  })

  it("stops at the repository root rather than climbing into the home directory", () => {
    const outer = mkdtempSync(join(tmpdir(), "smithers-outer-"))
    staged.push(outer)
    mkdirSync(join(outer, ".smithers", "flows"), { recursive: true })
    const inner = join(outer, "checkout")
    mkdirSync(join(inner, ".git"), { recursive: true })

    // `outer` has a `.smithers/flows/` directory, but a checkout is its own project: a
    // root resolved past the repository boundary would put one repository's
    // run state inside another's.
    expect(Project.root(undefined, inner)).toBe(inner)
  })

  it("resolves the migration root from the 0.x state, never from an rc.0 ancestor", () => {
    // The shape that made `migrate --apply` rewrite the wrong tree: an rc.0
    // project with a 0.x project inside it, and no VCS marker in between.
    const ancestor = mkdtempSync(join(tmpdir(), "smithers-ancestor-"))
    staged.push(ancestor)
    mkdirSync(join(ancestor, ".flows"), { recursive: true })
    const legacy = join(ancestor, "legacy-project")
    mkdirSync(join(legacy, ".smithers"), { recursive: true })
    const nested = join(legacy, "src")
    mkdirSync(nested, { recursive: true })

    expect(Project.root(undefined, legacy)).toBe(ancestor)
    expect(Project.legacyRoot(undefined, legacy)).toBe(legacy)
    // From inside the 0.x project, the same answer: one project, one root.
    expect(Project.legacyRoot(undefined, nested)).toBe(legacy)
  })

  it("honors an explicit --root, and otherwise falls back to the invocation directory", () => {
    expect(Project.legacyRoot("sub/dir", "/a/b")).toBe(resolve("/a/b", "sub/dir"))
    expect(Project.legacyRoot("/abs/root", "/a/b")).toBe("/abs/root")
    const bare = project()
    expect(Project.legacyRoot("", bare)).toBe(bare)
    expect(Project.legacyRoot(undefined, bare)).toBe(bare)
  })

  it("names the state, log, and flow-source paths off one root", () => {
    expect(Project.stateDirectory("/work")).toBe(join("/work", ".flows"))
    expect(Project.logDirectory("/work")).toBe(join("/work", ".flows", "logs"))
    expect(Project.logFile("/work", "run-1")).toBe(join("/work", ".flows", "logs", "run-1.log"))
    expect(Project.flowsDirectory("/work")).toBe(join("/work", ".smithers", "flows"))
  })

  it("supplies ambient defaults when no project layer is installed", () => {
    expect(Effect.runSync(Project.ProjectRoot)).toBe(process.cwd())
    expect(Effect.runSync(Project.MigrationRoot)).toBe(Project.legacyRoot(undefined, process.cwd()))
  })
})

/** The repository root, two levels above this package's `test/` directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const trackedSourceFile = process.env.SMITHERS_TEST_TRACKED_SOURCE_FILE

/**
 * Every path the checkout tracks under `.smithers/`. A jj checkout is read from
 * its last snapshot without snapshotting edits; a plain Git checkout (CI) from
 * its index.
 */
const trackedUnderDotSmithers = (): ReadonlyArray<string> => {
  if (trackedSourceFile !== undefined) {
    return readFileSync(trackedSourceFile, "utf8").split("\n").filter((path) => path.startsWith(".smithers/"))
  }
  const jj = existsSync(join(repositoryRoot, ".jj"))
  const result = spawnSync(
    jj ? "jj" : "git",
    jj ? ["file", "list", "--ignore-working-copy", ".smithers"] : ["ls-files", "--", ".smithers"],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 }
  )
  expect(result.status, `inventory failed: ${result.error?.message ?? result.stderr}`).toBe(0)
  return result.stdout.split("\n").filter((path) => path.startsWith(".smithers/"))
}

// Excluded metadata can survive an earlier user's slot; it is not this source's inventory.
describe.skipIf(
  trackedSourceFile === undefined &&
    (process.env.SMITHERS_TEST_SOURCE_MIRROR === "1" ||
      (!existsSync(join(repositoryRoot, ".jj")) && !existsSync(join(repositoryRoot, ".git"))))
)(
  "a fresh clone of this repository (needs tracked-source inventory from jj/Git or SMITHERS_TEST_TRACKED_SOURCE_FILE)",
  () => {
    it("has tracked source under .smithers/, so the check below has files to cover", () => {
      expect(trackedUnderDotSmithers()).toContain(".smithers/WORKSPACE.ts")
    })

    it("prints no Smithers 0.x notice for the .smithers/ files it tracks", () => {
      // The clone holds exactly the tracked entries. Directories inside them
      // (a workflows/ tree) are created too, because a subdirectory reads as 0.x.
      const clone = project()
      for (const tracked of trackedUnderDotSmithers()) {
        const target = join(clone, tracked)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, "")
      }

      expect(Project.legacyState(clone)).toEqual([])
    })
  }
)

describe("Smithers 0.x detection", () => {
  it.each([".smithers/checks/", ".smithers/front-door.json"])(
    "recognizes current tracked %s beside the build definitions",
    (marker) => {
      const root = project(".smithers/", ".smithers/WORKSPACE.ts", ".smithers/FACTORY.ts", marker)
      expect(Project.legacyState(root)).toEqual([])
    }
  )

  it("reports every 0.x marker beside a project", () => {
    const root = project(".smithers/", "smithers.db", "smithers.db-wal")

    expect(Project.legacyState(root)).toEqual([
      join(root, ".smithers"),
      join(root, "smithers.db"),
      join(root, "smithers.db-wal")
    ])
    expect(Project.legacyMarkers).toEqual([".smithers", "smithers.db", "smithers.db-wal", "smithers.db-shm"])
  })

  it("says nothing about a directory that already has .flows/", () => {
    // A repository mid-migration would otherwise print the notice on every
    // command forever.
    const root = project(".smithers/", "smithers.db", ".flows/")

    expect(Project.legacyState(root)).toEqual([])
  })

  it("finds 0.x state in an ancestor, up to the repository root", () => {
    const root = project("smithers.db")
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })

    expect(Project.legacyState(nested)).toEqual([join(root, "smithers.db")])
  })

  it("writes the notice the release policy specifies", () => {
    const notice = Project.legacyNotice("/work/smithers.db")

    expect(notice).toContain("Found Smithers 0.x state at /work/smithers.db")
    expect(notice).toContain("does not load, resume, or migrate 0.x run databases")
    expect(notice).toContain("bunx smthrs@0.35.0 ps")
    expect(notice).toContain("https://smithers.sh/migration/1.0#run-data")
  })

  it("names the version that is running, read from the package", () => {
    // The notice said 1.0.0-rc.0 from every release through rc.5 (#3845): a
    // literal no cut rewrote. The manifest is what `smthrs --version` prints.
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly version: string
    }
    const notice = Project.legacyNotice("/work/smithers.db")

    expect(notice).toContain(`Smithers ${version} does not load, resume, or migrate 0.x run databases.`)
    expect(notice.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g)).toEqual([version, "0.35.0"])
  })

  it("sends the reader to the command that ships on their PATH", () => {
    // `smithers-migrate` is @smthrs/migrate's own bin. A project that ran
    // `npx smthrs` has `smthrs`, and the docs and the notice thrown by the
    // `smthrs` package both say `smthrs migrate`.
    const notice = Project.legacyNotice("/work/smithers.db")

    expect(notice).toContain("then run \"smthrs migrate\" to convert the project source.")
    expect(notice).not.toContain("smithers-migrate")
  })
})
