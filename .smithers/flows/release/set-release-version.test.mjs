import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { changelogMismatches, mismatches, readManifests, readVersionedManifests, releaseChangelog, retarget, retargetSource, sourceMismatches, versionedChangelogs, versionedSources, versionedTemplates } from "./set-release-version.mjs"
import { repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"

const workspaceNames = new Set(["@smthrs/kernel", "@smthrs/flows"])

const example = {
  name: "@smthrs/flows",
  version: "0.1.0",
  dependencies: {
    "@smthrs/kernel": "0.1.0"
  },
  // A library's Effect peer is a range the cut has no business moving.
  peerDependencies: {
    effect: "4.0.5"
  },
  devDependencies: {
    "@smthrs/kernel": "workspace:*",
    effect: "4.0.5",
    vitest: "5.0.0"
  }
}

test("retarget moves the version and the exact workspace ranges together", () => {
  assert.deepEqual(retarget(example, "0.1.0-next.0", workspaceNames), {
    name: "@smthrs/flows",
    version: "0.1.0-next.0",
    dependencies: {
      "@smthrs/kernel": "0.1.0-next.0"
    },
    peerDependencies: {
      effect: "4.0.5"
    },
    devDependencies: {
      "@smthrs/kernel": "workspace:*",
      effect: "4.0.5",
      vitest: "5.0.0"
    }
  })
  assert.equal(example.version, "0.1.0")
})

test("retarget leaves third-party ranges alone", () => {
  const retargeted = retarget(example, "9.9.9", new Set())
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0")
  assert.equal(retargeted.version, "9.9.9")
})

test("retarget preserves private versions while updating exact workspace ranges", () => {
  const privateManifest = { ...example, private: true, version: "0.0.0" }
  const retargeted = retarget(privateManifest, "0.1.0-next.0", workspaceNames)
  assert.equal(retargeted.version, "0.0.0")
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0-next.0")
  assert.equal(retargeted.devDependencies["@smthrs/kernel"], "workspace:*")
})

test("a private shipped template requires registry versions even for a workspace protocol", () => {
  const manifest = { ...example, private: true, version: "0.0.0" }
  const updated = retarget(manifest, "1.0.0", workspaceNames, { registryDependencies: true })
  assert.equal(updated.version, "0.0.0")
  assert.equal(updated.devDependencies["@smthrs/kernel"], "1.0.0")
  const entries = [
    { directory: "template", manifest, registryDependencies: true },
    { directory: "kernel", manifest: { name: "@smthrs/kernel", version: "1.0.0" } }
  ]
  assert.deepEqual(mismatches(entries, "1.0.0"), [
    "template/package.json: dependencies.@smthrs/kernel is 0.1.0, expected 1.0.0",
    "template/package.json: devDependencies.@smthrs/kernel is workspace:*, expected 1.0.0"
  ])
})

test("mismatches names the version and every stale internal range", () => {
  const entries = [
    { directory: "packages/smithers/flows", manifest: example },
    {
      directory: "packages/smithers/flows/kernel",
      manifest: { name: "@smthrs/kernel", version: "0.1.0-next.0" }
    }
  ]

  assert.deepEqual(mismatches(entries, "0.1.0-next.0"), [
    "packages/smithers/flows/package.json: version is 0.1.0, expected 0.1.0-next.0",
    "packages/smithers/flows/package.json: dependencies.@smthrs/kernel is 0.1.0, expected 0.1.0-next.0"
  ])
  assert.deepEqual(mismatches(entries.slice(1), "0.1.0-next.0"), [])
  assert.deepEqual(mismatches([{ ...entries[0], directory: "packages/smithers/flows/package.json" }, entries[1]], "0.1.0-next.0"),
    mismatches(entries, "0.1.0-next.0"), "a manifest path is not given a second package.json suffix")
})

test("release bumps preserve local workspace links and retarget explicit workspace versions", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [range, expected] of [
      ["workspace:*", "workspace:*"], ["workspace:^", "workspace:^"], ["workspace:~", "workspace:~"],
      ["workspace:0.1.0", "workspace:1.0.0"], ["workspace:^0.1.0", "workspace:^1.0.0"],
      ["workspace:~0.1.0", "workspace:~1.0.0"]
    ]) {
      const manifest = { name: "@smthrs/flows", version: "1.0.0", [field]: { "@smthrs/kernel": range } }
      const kernel = { directory: "kernel", manifest: { name: "@smthrs/kernel", version: "1.0.0" } }
      const updated = retarget(manifest, "1.0.0", workspaceNames)
      assert.equal(updated[field]["@smthrs/kernel"], expected)
      assert.deepEqual(mismatches([{ directory: "flows", manifest: updated }, kernel], "1.0.0"), [])
      assert.equal(mismatches([{ directory: "flows", manifest }, kernel], "1.0.0").length, range === expected ? 0 : 1)
      assert.equal(retarget(manifest, "1.0.0", workspaceNames, { registryDependencies: true })[field]["@smthrs/kernel"], "1.0.0")
    }
  }
})

test("this workspace is internally coherent at its current version", () => {
  const entries = readVersionedManifests()
  const version = entries.find(({ directory }) => directory === "packages/smithers/flows").manifest.version

  assert.deepEqual(mismatches(entries, version), [])
  for (const path of versionedTemplates) {
    assert.equal(entries.find((entry) => entry.directory === path)?.registryDependencies, true)
  }
})

test("workspace discovery follows every pnpm-workspace package glob", () => {
  const directories = new Set(readManifests().map(({ directory }) => directory))
  assert.equal(directories.has("packages/smithers/build/infra"), true)
  assert.equal(directories.has(".smithers/flows/coding"), true)
  assert.equal(directories.has("apps/site"), true)
  assert.equal(directories.has("packages/rpc"), true)
  assert.equal(directories.has("apps/mvp"), true)
})

test("retargetSource rewrites the version literal and nothing else", () => {
  const source = versionedSources.find(({ path }) => path.endsWith("Otlp.ts"))
  const text = [
    "/** @since 0.1.0 */",
    'export const defaultServiceVersion = "1.0.0-rc.0"',
    'export const other = "1.0.0-rc.0"'
  ].join("\n")

  assert.equal(
    retargetSource(text, "1.0.0-rc.1", source),
    [
      // A `@since` tag records when the export appeared, not what ships today.
      "/** @since 0.1.0 */",
      'export const defaultServiceVersion = "1.0.0-rc.1"',
      'export const other = "1.0.0-rc.0"'
    ].join("\n")
  )
})

test("the MCP client identity is a versioned source", () => {
  const source = versionedSources.find(({ path }) => path === "packages/smithers/mcp/src/McpClient.ts")
  assert.ok(source, "McpClient.ts clientInfo.version is not in versionedSources")
  const text = [
    "export const clientInfo = Object.freeze({",
    '  name: "smithers",',
    '  version: "1.0.0-rc.0"',
    "})",
    'export const other = "1.0.0-rc.0"'
  ].join("\n")

  assert.equal(
    retargetSource(text, "1.0.0-rc.1", source),
    text.replace('version: "1.0.0-rc.0"', 'version: "1.0.0-rc.1"')
  )
})

test("the storage release policy is a versioned source", () => {
  // Its refusal texts quote the release; the rc.2 and rc.3 bumps left it at rc.1.
  const source = versionedSources.find(({ path }) => path.endsWith("flows/database/src/internal/ReleasePolicy.ts"))
  assert.ok(source, "ReleasePolicy.ts releaseVersion is not in versionedSources")
  const text = ['export const releaseVersion = "1.0.0-rc.1"', 'export const nodeFloor = ">=26.4.0"'].join("\n")

  assert.equal(
    retargetSource(text, "1.0.0-rc.3", source),
    text.replace('releaseVersion = "1.0.0-rc.1"', 'releaseVersion = "1.0.0-rc.3"')
  )
})

test("retargetSource refuses a file that no longer carries the declaration", () => {
  const source = versionedSources.find(({ path }) => path.endsWith("Otlp.ts"))

  assert.throws(
    () => retargetSource("export const somethingElse = \"1.0.0-rc.0\"", "1.0.0-rc.1", source),
    /no longer declares defaultServiceVersion/
  )
})

test("sourceMismatches names a literal the manifests left behind", () => {
  const manifests = readManifests()
  assert.deepEqual(sourceMismatches("9.9.9"), versionedSources.map(({ path, declaration, package: ownerPackage }) => {
    const version = manifests.find((entry) => entry.directory === (ownerPackage ?? path.split("/src/")[0])).manifest.version
    return `${path}: ${declaration} is ${version}, expected 9.9.9`
  }))
})

test("every versioned source agrees with the version its own package declares", () => {
  const entries = readManifests()
  for (const { path, package: ownerPackage } of versionedSources) {
    const directory = ownerPackage ?? path.split("/src/")[0]
    const owner = entries.find((entry) => entry.directory === directory)
    assert.ok(owner, `${path} is not inside a workspace package`)
    assert.deepEqual(sourceMismatches(owner.manifest.version), [])
  }
})

test("the storage docs quote the release through versioned sources, on the package page and its site copy", () => {
  // api.md and troubleshooting.md still said 1.0.0-rc.0 at rc.3: the bump never knew the lines.
  const rows = versionedSources.filter(({ package: owner }) => owner === "packages/smithers/flows/database")
  assert.deepEqual(rows.map(({ path }) => path).sort(), [
    "apps/site/src/content/docs/docs/reference/api/database.mdx",
    "apps/site/src/content/docs/docs/reference/api/database.mdx",
    "apps/site/src/content/docs/docs/reference/api/database.mdx",
    "packages/smithers/flows/database/docs/api.md",
    "packages/smithers/flows/database/docs/api.md",
    "packages/smithers/flows/database/docs/api.md",
    "packages/smithers/flows/database/docs/troubleshooting.md",
    "packages/smithers/flows/database/docs/troubleshooting.md"
  ])
  const text = [
    "ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.0 (use SMITHERS_POSTGRES_URL to select PostgreSQL)",
    "A refusal to open a durable database in 1.0.0-rc.0, raised as a defect rather",
    "| `<path> is not a Smithers 1.0 database (1.0.0-rc.0 does not load a 0.x smithers.db)` |",
    "### `1.0.0-rc.0 runs the durable engine on Node.js >=26.4.0 only`"
  ].join("\n")
  const rewritten = rows.reduce((current, row) => row.pattern.test(current) ? retargetSource(current, "1.0.0-rc.10", row) : current, text)
  // "Smithers 1.0 database" names the format, not the release, and stays.
  assert.equal(rewritten, text.replaceAll("1.0.0-rc.0", "1.0.0-rc.10"))
})

test("every Flows page that gives the pnpm install line names the version the bump writes", () => {
  // pnpm 11 installs only versions at least 24 hours old, so `@next` can lag
  // more than one release; the pages pin the version, and a pin the bump does
  // not know would go stale silently.
  const rows = versionedSources.filter(({ declaration }) => declaration === "the pnpm install line")
  const directory = join(repoRoot, "packages/smithers/flows")
  const pages = ["README.md", ...readdirSync(join(directory, "docs"), { recursive: true }).map((entry) => join("docs", String(entry)))]
    .filter((page) => page.endsWith(".md"))
    .map((page) => join("packages/smithers/flows", page))
  const line = /pnpm add\s+@smthrs\/platform-node@\S+\s+@smthrs\/flows@/g
  const giving = pages.filter((page) => line.test(readFileSync(join(repoRoot, page), "utf8")))
  assert.deepEqual(rows.map(({ path }) => path).sort(), giving.sort())
  const pins = versionedSources.filter(({ declaration }) => declaration === "the platform-node pin on the pnpm install line")
  assert.deepEqual(pins.map(({ path }) => path).sort(), giving.sort())
  for (const page of giving) {
    // retargetSource rewrites the first match only, so a page gives the line once.
    const lines = readFileSync(join(repoRoot, page), "utf8").match(line)
    assert.equal(lines.length, 1, page + " gives the pnpm install line more than once")
  }
  const given = "run `pnpm add @smthrs/platform-node@1.0.0-rc.6 @smthrs/flows@1.0.0-rc.6 effect` instead"
  assert.equal(
    retargetSource(retargetSource(given, "1.0.0-rc.7", pins[0]), "1.0.0-rc.7", rows[0]),
    "run `pnpm add @smthrs/platform-node@1.0.0-rc.7 @smthrs/flows@1.0.0-rc.7 effect` instead"
  )
})

test("every Bun host page that gives the bun install line names the version the bump writes", () => {
  const rows = versionedSources.filter(({ declaration }) => declaration === "the bun install line")
  const directory = join(repoRoot, "packages/smithers/flows/platform-bun")
  const pages = ["README.md", ...readdirSync(join(directory, "docs"), { recursive: true }).map((entry) => join("docs", String(entry)))]
    .filter((page) => page.endsWith(".md"))
    .map((page) => join("packages/smithers/flows/platform-bun", page))
  const giving = pages.filter((page) => /bun add\s+@smthrs\/platform-bun@/.test(readFileSync(join(repoRoot, page), "utf8")))
  assert.deepEqual(rows.map(({ path }) => path).sort(), giving.sort())
  for (const page of giving) {
    // retargetSource rewrites the first match only, so a page gives the line once.
    const lines = readFileSync(join(repoRoot, page), "utf8").match(/bun add\s+@smthrs\/platform-bun@/g)
    assert.equal(lines.length, 1, page + " gives the bun install line more than once")
  }
  assert.equal(
    retargetSource("bun add @smthrs/platform-bun@1.0.0-rc.7 effect", "1.0.0-rc.8", rows[0]),
    "bun add @smthrs/platform-bun@1.0.0-rc.8 effect"
  )
})

test("every Bun host page that declares the kernel on its install line names the version the bump writes", () => {
  // contained.ts imports @smthrs/kernel/ProcessLedger; under Bun's isolated
  // linker and pnpm an undeclared kernel does not resolve (#4016).
  const rows = versionedSources.filter(({ declaration }) => declaration === "the kernel on the bun install line")
  const directory = join(repoRoot, "packages/smithers/flows/platform-bun")
  const pages = ["README.md", ...readdirSync(join(directory, "docs"), { recursive: true }).map((entry) => join("docs", String(entry)))]
    .filter((page) => page.endsWith(".md"))
    .map((page) => join("packages/smithers/flows/platform-bun", page))
  const giving = pages.filter((page) => /bun add\s+@smthrs\/platform-bun@\S+\s+effect\s+@smthrs\/kernel@/.test(readFileSync(join(repoRoot, page), "utf8")))
  assert.deepEqual(rows.map(({ path }) => path).sort(), giving.sort())
  // The quickstart gives the line inline, so the version stops at the closing backtick.
  assert.equal(
    retargetSource("`bun add @smthrs/platform-bun@1.0.0-rc.8 effect @smthrs/kernel@1.0.0-rc.7`.", "1.0.0-rc.9", rows[0]),
    "`bun add @smthrs/platform-bun@1.0.0-rc.8 effect @smthrs/kernel@1.0.0-rc.9`."
  )
})

test("every build page that pins the CLI devDependency names the version the bump writes", () => {
  // A pin the bump does not know goes stale silently: these pages said rc.1 at rc.7.
  const rows = versionedSources.filter(({ declaration }) => declaration === "the build-cli devDependency")
  const pages = ["packages/smithers/build/docs", "packages/smithers/build/targets/docs"]
    .flatMap((directory) =>
      readdirSync(join(repoRoot, directory), { recursive: true }).map((entry) => join(directory, String(entry)))
    )
    .filter((page) => page.endsWith(".md"))
  const giving = pages.filter((page) => /"@smthrs\/build-cli": "/.test(readFileSync(join(repoRoot, page), "utf8")))
  assert.deepEqual(rows.map(({ path }) => path).sort(), giving.sort())
  for (const page of giving) {
    // retargetSource rewrites the first match only, so a page pins each package once.
    const text = readFileSync(join(repoRoot, page), "utf8")
    assert.equal(text.match(/"@smthrs\/build-cli": "/g).length, 1, page + " pins @smthrs/build-cli more than once")
    assert.equal(text.match(/"@smthrs\/targets": "/g).length, 1, page + " pins @smthrs/targets more than once")
  }
  const targets = versionedSources.find(({ declaration, path }) => declaration === "the targets devDependency" && path === rows[0].path)
  const block = '"@smthrs/build-cli": "1.0.0-rc.7",\n"@smthrs/targets": "1.0.0-rc.7"'
  assert.equal(
    retargetSource(retargetSource(block, "1.0.0-rc.8", rows[0]), "1.0.0-rc.8", targets),
    '"@smthrs/build-cli": "1.0.0-rc.8",\n"@smthrs/targets": "1.0.0-rc.8"'
  )
})

test("releaseChangelog moves the unreleased entries under a dated heading for the version", () => {
  const text = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- `Rubric`.",
    "",
    "## [1.0.0-rc.2] - 2026-10-09",
    "",
    "- Earlier.",
    ""
  ].join("\n")
  assert.equal(
    releaseChangelog(text, "1.0.0-rc.3", "2026-10-10"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [1.0.0-rc.3] - 2026-10-10",
      "",
      "### Added",
      "",
      "- `Rubric`.",
      "",
      "## [1.0.0-rc.2] - 2026-10-09",
      "",
      "- Earlier.",
      ""
    ].join("\n")
  )
})

test("releaseChangelog records an unchanged ride, keeps a released file, and refuses one with nothing to release", () => {
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.2] - 2026-10-09\n\n- Earlier.\n"
  const released = releaseChangelog(empty, "1.0.0-rc.3", "2026-10-10")
  assert.equal(
    released,
    "# Changelog\n\n## [Unreleased]\n\n## [1.0.0-rc.3] - 2026-10-10\n\n### Changed\n\n"
      + "- Released with the workspace package train. No change to this package since the previous release.\n\n"
      + "## [1.0.0-rc.2] - 2026-10-09\n\n- Earlier.\n"
  )
  // A second pass at the same version, or a rerun after a failed cut, changes nothing.
  assert.equal(releaseChangelog(released, "1.0.0-rc.3", "2026-10-11"), released)
  // rc.3 is not a prefix match for rc.30.
  assert.notEqual(releaseChangelog(released, "1.0.0-rc.30", "2026-11-01"), released)
  assert.throws(() => releaseChangelog("# Changelog\n\n## [1.0.0-rc.2]\n", "1.0.0-rc.3", "2026-10-10"), /no `## \[Unreleased\]` section/)
})

test("every versioned changelog has a section for the version its package declares", () => {
  const entries = readManifests()
  for (const path of versionedChangelogs) {
    const owner = entries.find((entry) => entry.directory === path.replace(/\/CHANGELOG\.md$/, ""))
    assert.ok(owner, `${path} is not a workspace package's changelog`)
    assert.deepEqual(changelogMismatches(owner.manifest.version), [])
    assert.deepEqual(changelogMismatches("9.9.9"), [`${path}: no \`## [9.9.9]\` section`])
  }
})
