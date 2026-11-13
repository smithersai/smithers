/**
 * The suggestion checklist over in-memory repositories: the order, what each
 * check reads, and that the heavy suggestions are held back as follow-ups.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Discovery } from "@smthrs/registry"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Checklist from "../../src/suggest/Checklist.ts"

const collect = async (repository: Checklist.Repository): Promise<ReadonlyArray<Checklist.Suggestion>> => {
  const items: Array<Checklist.Suggestion> = []
  for await (const suggestion of Checklist.scan(repository)) items.push(suggestion)
  return items
}

const full = Checklist.memoryRepository("/repo", {
  "package.json": JSON.stringify({
    name: "acme",
    packageManager: "pnpm@10.0.0",
    workspaces: ["packages/*"],
    scripts: { test: "vitest run", lint: "eslint .", release: "changeset publish" }
  }),
  "pnpm-lock.yaml": "",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "vitest.config.ts": "export default {}",
  "eslint.config.js": "export default []",
  "tsconfig.json": "{}",
  ".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n",
  ".github/workflows/ci.yml": "name: ci",
  "CHANGELOG.md": "# Changelog",
  "packages/core/package.json": "{}"
})

describe("Checklist.evidence", () => {
  it("reads the package manager, scripts, runner, lint, CI, remote, layout, and changelog", () => {
    const facts = Checklist.evidence(full)

    expect(facts).toEqual({
      machine: {
        detectorVersion: "smithers.toolchain-detect/v4",
        tools: { node: { version: "", file: "package.json" }, pnpm: { version: "10.0.0", file: "package.json" } },
        packageManager: "pnpm",
        installs: [{
          command: ["pnpm", "install", "--frozen-lockfile"],
          offline: ["pnpm", "install", "--offline", "--frozen-lockfile"],
          files: ["package.json", "pnpm-lock.yaml"],
          destinations: ["registry.npmjs.org", "registry.yarnpkg.com"]
        }],
        checks: [{ id: "test", argv: ["pnpm", "test"] }, { id: "lint", argv: ["pnpm", "lint"] }]
      },
      checks: [{ id: "test", argv: ["pnpm", "test"] }, { id: "lint", argv: ["pnpm", "lint"] }],
      packageManager: "pnpm",
      scripts: { test: "vitest run", lint: "eslint .", release: "changeset publish" },
      testRunner: "vitest",
      lint: ["eslint.config.js"],
      ci: [".github/workflows/ci.yml"],
      flows: [],
      packageFile: false,
      github: true,
      git: true,
      monorepo: ["pnpm-workspace.yaml", "package.json#workspaces", "packages"],
      agentsFile: undefined,
      changelog: "CHANGELOG.md",
      language: ["javascript", "typescript"]
    })
  })

  it("falls back to the lockfile for the package manager and to config files for the runner", () => {
    const facts = Checklist.evidence(Checklist.memoryRepository("/repo", {
      "package.json": JSON.stringify({ name: "x" }),
      "bun.lock": "",
      "jest.config.js": "",
      "AGENTS.md": "# Agents"
    }))

    expect(facts.packageManager).toBe("bun")
    expect(facts.testRunner).toBe("jest")
    expect(facts.agentsFile).toBe("AGENTS.md")
    expect(facts.git).toBe(false)
  })

  it("survives an unreadable manifest", () => {
    const facts = Checklist.evidence(Checklist.memoryRepository("/repo", { "package.json": "{not json" }))

    expect(facts.scripts).toEqual({})
    expect(facts.packageManager).toBe("npm")
  })
})

describe("Checklist.scan", () => {
  it("streams every match in the documented order, cheap first and the heavy ones as follow-ups", async () => {
    const items = await collect(full)

    expect(items.map((item) => item.id)).toEqual([
      "test-target",
      "lint-target",
      "agents-md",
      "release-notes",
      "pr-review",
      "repeated-script",
      "changelog",
      "build-graph",
      "sandboxed-review"
    ])
    expect(items.map((item) => item.followUp)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true
    ])
    expect(items.map((item) => item.effort)).toEqual([
      "small",
      "small",
      "small",
      "small",
      "medium",
      "medium",
      "small",
      "large",
      "large"
    ])
  })

  it("cites the files each check read", async () => {
    const byId = new Map((await collect(full)).map((item) => [item.id, item]))

    // Only the runner file this repository actually carries is cited: the
    // check reads the tree, so `vitest.config.mts` and the rest of the
    // vitest spellings are absent here because they are absent on disk.
    expect(byId.get("test-target")!.why).toBe(
      "vitest is the test runner (package.json, vitest.config.ts), so a target keyed on its inputs skips the tests whose inputs did not change"
    )
    expect(byId.get("test-target")!.files).toEqual(["package.json", "vitest.config.ts"])
    expect(byId.get("lint-target")!.files).toEqual(["eslint.config.js"])
    expect(byId.get("pr-review")!.files).toEqual([".git/config", ".github/workflows/ci.yml"])
    expect(byId.get("repeated-script")!.title).toBe("A flow for the repeated task `release` reveals")
    expect(byId.get("build-graph")!.why).toContain("no PACKAGE.ts")
    expect(byId.get("test-target")!.followUps.map((followUp) => followUp.id)).toEqual(["ci", "incremental"])
    expect(byId.get("agents-md")!.followUps.map((followUp) => followUp.id)).toEqual(["ci"])
  })

  it("matches nothing on an empty directory", async () => {
    expect(await collect(Checklist.memoryRepository("/repo", {}))).toEqual([])
  })

  it("skips agents-md when one exists, build-graph when PACKAGE.ts exists, and changelog without git", async () => {
    const items = await collect(Checklist.memoryRepository("/repo", {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "CLAUDE.md": "# Claude",
      "PACKAGE.ts": "export const Package = {}",
      "pnpm-workspace.yaml": "",
      "CHANGELOG.md": "#"
    }))

    expect(items.map((item) => item.id)).toEqual(["test-target"])
    expect(items[0]!.why).toBe(
      "node --test is the test runner (package.json), so a target keyed on its inputs skips the tests whose inputs did not change"
    )
  })

  it("offers a review only for a GitHub remote, and release notes for any git repository", async () => {
    const items = await collect(Checklist.memoryRepository("/repo", {
      ".git/config": "[remote \"origin\"]\n\turl = https://gitlab.com/acme/acme.git\n"
    }))

    expect(items.map((item) => item.id)).toEqual(["release-notes"])
  })
})

describe("Checklist.repository", () => {
  let root: string | undefined

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it("inventories module flows, skills and nested entries with registry precedence", () => {
    const files = {
      ".smithers/flows/review/flow.ts": "throw new Error('discovery must not evaluate modules')",
      ".smithers/flows/review/flow.vibe": "",
      ".smithers/flows/review/flow.mdx": "",
      ".smithers/flows/review/SKILL.md": "",
      ".smithers/flows/review/nested/flow.mdx": "",
      ".smithers/flows/check/flow.vibe": "",
      ".smithers/flows/check/SKILL.md": "",
      ".smithers/flows/library/skill/SKILL.md": "",
      ".smithers/flows/markdown/flow.mdx": "",
      ".smithers/flows/markdown/SKILL.md": "",
      ".smithers/flows/.hidden/flow.ts": "",
      ".smithers/flows/node_modules/ignored/flow.ts": "",
      ".smithers/flows/channels/ignored/flow.ts": "",
      ".smithers/flows/connections/ignored/flow.ts": "",
      ".smithers/flows/flow.ts": "",
      "flows/retired/flow.ts": ""
    }
    root = mkdtempSync(join(tmpdir(), "smthrs-suggest-inventory-"))
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    const expected = [
      ".smithers/flows/check/flow.vibe",
      ".smithers/flows/library/skill/SKILL.md",
      ".smithers/flows/markdown/flow.mdx",
      ".smithers/flows/review/flow.ts",
      ".smithers/flows/review/nested/flow.mdx"
    ]
    expect(Checklist.evidence(Checklist.memoryRepository(root, files)).flows).toEqual(expected)
    expect(Checklist.evidence(Checklist.repository(root)).flows).toEqual(expected)
    if (process.platform !== "win32") {
      symlinkSync(join(root, ".smithers/flows"), join(root, ".smithers/flows/review/loop"))
      symlinkSync(join(root, ".smithers/flows/review"), join(root, ".smithers/flows/z-alias"))
      expect(Checklist.evidence(Checklist.repository(root)).flows).toEqual(expected)
    }
  })

  it.each(Array.from({ length: 15 }, (_, index) => index + 1))(
    "matches registry selection for entry combination %i without loading modules",
    async (mask) => {
      root = mkdtempSync(join(tmpdir(), "smthrs-suggest-precedence-"))
      const directory = ".smithers/flows/group/echo"
      mkdirSync(join(root, directory), { recursive: true })
      const files: Record<string, string> = {}
      for (const [index, name] of ["flow.ts", "flow.vibe", "flow.mdx", "SKILL.md"].entries()) {
        if (!(mask & (1 << index))) continue
        const file = `${directory}/${name}`
        files[file] = name.endsWith(".ts") || name.endsWith(".vibe")
          ? "throw new Error(\"must not execute\"); export default Flow.make(\"group/echo\", { description: \"Echo\", capabilities: [] })"
          : "---\nname: echo\ndescription: Echo\n---\nEcho"
        writeFileSync(join(root, file), files[file]!)
      }
      const scan = await Effect.runPromise(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan({ source: "project", root: join(root!, ".smithers/flows"), naming: "path" })
        }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))))
      )
      const expected = scan.entries.map((entry) => relative(root!, entry.path).split(sep).join("/"))
      expect(expected).toHaveLength(1)
      expect(Checklist.evidence(Checklist.repository(root)).flows).toEqual(expected)
      expect(Checklist.evidence(Checklist.memoryRepository(root, files)).flows).toEqual(expected)
    }
  )

  it("bounds recursive readers without directory identities at the registry depth", () => {
    const shallow = ".smithers/flows/" + Array(32).fill("nested").join("/") + "/flow.ts"
    const deep = ".smithers/flows/" + Array(33).fill("nested").join("/") + "/flow.ts"
    const memory = Checklist.memoryRepository("/repo", { [shallow]: "", [deep]: "" })
    const reader = { root: memory.root, exists: memory.exists, list: memory.list, read: memory.read }
    expect(Checklist.evidence(reader).flows).toEqual([shallow])
  })

  it("selects regular entries without reading bodies or accepting directories and special files", () => {
    root = mkdtempSync(join(tmpdir(), "smthrs-suggest-entry-types-"))
    const directory = ".smithers/flows/review"
    mkdirSync(join(root, directory, "flow.ts"), { recursive: true })
    writeFileSync(join(root, directory, "flow.mdx"), "")
    if (process.platform !== "win32") {
      const fifo = spawnSync("mkfifo", [join(root, directory, "flow.vibe")], { encoding: "utf8" })
      expect(fifo.status, fifo.stderr).toBe(0)
    }
    const reader = Checklist.repository(root)
    const safe = {
      ...reader,
      read: (file: string) => {
        if (file.startsWith(".smithers/flows/")) throw new Error("Inventory must not read an entry body")
        return reader.read(file)
      }
    }
    expect(Checklist.evidence(safe).flows).toEqual([directory + "/flow.mdx"])
  })

  it("reads a real directory the same way the memory reader does", async () => {
    root = mkdtempSync(join(tmpdir(), "smthrs-suggest-checklist-"))
    mkdirSync(join(root, ".smithers", "flows", "ship"), { recursive: true })
    writeFileSync(join(root, ".smithers", "flows", "ship", "flow.mdx"), "---\ndescription: x\n---\n")
    mkdirSync(join(root, "flows", "retired"), { recursive: true })
    writeFileSync(join(root, "flows", "retired", "flow.mdx"), "---\ndescription: x\n---\n")
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }))
    writeFileSync(join(root, "biome.json"), "{}")
    const reader = Checklist.repository(root)

    expect(reader.exists(".smithers/flows")).toBe(true)
    expect(reader.list(".smithers/flows")).toEqual(["ship"])
    expect(reader.list("package.json")).toEqual([])
    expect(reader.read("missing")).toBeUndefined()
    expect(Checklist.evidence(reader).flows).toEqual([".smithers/flows/ship/flow.mdx"])
    expect((await collect(reader)).map((item) => item.id)).toEqual(["test-target", "lint-target", "agents-md"])
  })
})
