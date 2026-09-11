/**
 * The CLI reference pages match the shipped command tree.
 *
 * The generated Incur manifest and help describe the canonical parser; their
 * separate generation gate checks them against the executable. `Verb.ts`
 * describes the retained Effect CLI handlers, whose reference pages remain
 * useful for compatibility. Reading these artifacts avoids starting the CLI's
 * control runtime merely to check its documentation.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

const subcommands = (source) => {
  const table = source.match(/export const shipped:[\s\S]*?= \[([\s\S]*?)\n\]/)?.[1]
  assert.ok(table, "packages/smithers/src/Verb.ts must declare the shipped verb table")
  return [...table.matchAll(/verb\("([^"]+)"/g)]
    .filter((match) => match[1] !== "completions")
    .map((match) => match[1])
}

const compare = (required, accepted, pages) => {
  const expected = new Set(required)
  const available = new Set(accepted)
  const documented = new Set(pages)
  return [
    ...[...documented].filter((page) => !available.has(page)).map((page) => `reference/cli/${page}.mdx documents no shipped verb: ${page}`),
    ...[...expected].filter((verb) => !documented.has(verb)).map((verb) => `shipped verb has no reference/cli page: ${verb}`)
  ]
}

const indexedCommands = (page) => new Set(page.split("\n")
  .filter((line) => line.startsWith("|"))
  .flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)])
  .flatMap((match) => match[1].split(/\s/, 1)[0].split("/")))

const cliPages = (directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".mdx") && name !== "index.mdx")
    .map((name) => name.slice(0, -4))

const markdownFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "coverage", ".git", ".flows"].includes(entry.name)) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && /\.mdx?$/.test(entry.name) ? [path] : []
  })

describe("the CLI reference", () => {
  const verbSource = readFileSync(join(root, "packages/smithers/src/Verb.ts"), "utf8")
  const pagesDirectory = join(root, "apps/site/src/content/docs/docs/reference/cli")
  const manifest = JSON.parse(readFileSync(join(root, "apps/site/src/data/cli-commands.json"), "utf8"))
  const canonical = [...new Set(manifest.commands.map((command) => command.name.split(" ")[0]))]
  const legacy = subcommands(verbSource)
  const help = readFileSync(join(root, "apps/site/src/data/help/smthrs.txt"), "utf8")

  it("retains compatibility pages and documents the canonical durable groups", () => {
    const durableGroups = ["flow", "runs", "approvals"]
    for (const group of durableGroups) assert.ok(canonical.includes(group), `${group} must be a public command`)
    assert.deepEqual(compare([...legacy, ...durableGroups], [...legacy, ...canonical], cliPages(pagesDirectory)), [])
  })

  it("indexes every canonical command, including those without a dedicated page", () => {
    assert.equal(manifest.version, "incur.v1")
    assert.ok(canonical.length > 0)
    const indexed = indexedCommands(readFileSync(join(pagesDirectory, "index.mdx"), "utf8"))
    assert.deepEqual(canonical.filter((command) => !indexed.has(command)), [])
  })

  it("accepts a canonical page that has no legacy handler", () => {
    assert.deepEqual(compare(["status"], ["status", "runs"], ["status", "runs"]), [])
  })

  it("rejects an added page for a nonexistent verb", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cli-reference-"))
    try {
      writeFileSync(join(directory, "run.mdx"), "")
      writeFileSync(join(directory, "imaginary.mdx"), "")
      assert.deepEqual(compare(["run"], ["run"], cliPages(directory)), [
        "reference/cli/imaginary.mdx documents no shipped verb: imaginary"
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects a removed page for a shipped verb", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cli-reference-"))
    try {
      writeFileSync(join(directory, "run.mdx"), "")
      assert.deepEqual(compare(["run", "status"], ["run", "status"], cliPages(directory)), [
        "shipped verb has no reference/cli page: status"
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("names the dist-tag the update command actually reads", () => {
    const files = [
      ...markdownFiles(join(root, "packages/smithers/docs")),
      ...markdownFiles(join(root, "apps/docs/cli/src/content/docs")),
      ...markdownFiles(join(root, "apps/site/src/content/docs/docs"))
    ]
    const stale = files.flatMap((file) => {
      const contents = readFileSync(file, "utf8")
      return /(?:the |against the? )?`rc` and `latest`|under the `rc` tag|compares `rc` first|available \(rc\)/.test(contents)
        ? [file.slice(root.length + 1)]
        : []
    })

    assert.deepEqual(stale, [], `update documentation must name the next dist-tag:\n${stale.join("\n")}`)
  })

  it("keeps installation commands on a published CLI tag", () => {
    const files = [
      ...markdownFiles(join(root, "packages")),
      ...markdownFiles(join(root, "apps/site/src/content/docs"))
    ]
    const stale = files.flatMap((file) => readFileSync(file, "utf8").split("\n")
      .filter((line) => /(?:npm (?:install|i)|npx|pnpm (?:add|dlx)|bun (?:add|x))\b/.test(line) && !line.includes("--filter"))
      .filter((line) => /@smthrs\/cli(?=[\s`";]|$)/.test(line))
      .map(() => file.slice(root.length + 1)))
    assert.deepEqual(stale, [], `CLI install commands need an explicit tag: ${stale.join(", ")}`)
  })

  it("documents the public help, schema, and presentation flags", () => {
    const page = readFileSync(join(pagesDirectory, "index.mdx"), "utf8")
    for (const flag of ["--help", "--schema", "--format", "--silent", "--audience"]) {
      assert.match(help, new RegExp(`^  ${flag}(?:\\s|,|$)`, "m"), `${flag} must be accepted by the public parser`)
      assert.match(page, new RegExp("`" + flag + "(?:\\s|`)"), `${flag} needs an explanation in the CLI reference`)
    }
  })

  it("distinguishes the review service from the model-review target command", () => {
    const page = readFileSync(join(root, "apps/site/src/content/docs/docs/guides/pr-review-action.mdx"), "utf8")
    assert.ok(page.includes("`smithers-review`"))
    assert.ok(page.includes("`smthrs review <pattern>`"))
    assert.ok(page.includes("model-review targets"))
    assert.ok(!page.includes("review` subcommand was removed"))
  })

})
