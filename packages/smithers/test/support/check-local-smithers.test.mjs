import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  ALLOWLIST,
  REPO_ROOT,
  SOURCE_ENTRY,
  findViolationsInFile,
  isCommentLine,
  listScannedFiles,
  check,
} from "./check-local-smithers.mjs"

describe("isCommentLine", () => {
  it("recognises the comment styles used across the repo", () => {
    assert.equal(isCommentLine("  // run it"), true)
    assert.equal(isCommentLine("# shell comment"), true)
    assert.equal(isCommentLine(" * jsdoc continuation"), true)
    assert.equal(isCommentLine("/* block start"), true)
  })

  it("does not treat code as a comment", () => {
    assert.equal(isCommentLine('const x = "// not a comment";'), false)
  })
})

describe("findViolationsInFile", () => {
  it("flags a published-CLI call in a shell script", () => {
    const violations = findViolationsInFile("a.sh", "bunx smthrs up flow.tsx\n")
    assert.equal(violations.length, 1)
    assert.equal(violations[0].line, 1)
  })

  it("flags every runner that fetches the published package", () => {
    for (const runner of ["bunx", "npx", "pnpm dlx", "yarn dlx"]) {
      const violations = findViolationsInFile("a.sh", `${runner} smthrs ps\n`)
      assert.equal(violations.length, 1, `${runner} should be flagged`)
    }
  })

  it("ignores comments in a shell script", () => {
    assert.deepEqual(findViolationsInFile("a.sh", "# bunx smthrs ps\n"), [])
  })

  it("flags a published-CLI call in package.json scripts", () => {
    const contents = JSON.stringify({ scripts: { build: "tsc", release: "bunx smthrs up r.tsx" } }, null, 2)
    const violations = findViolationsInFile("package.json", contents)
    assert.equal(violations.length, 1)
    assert.match(violations[0].text, /^release: /)
  })

  it("ignores non-script package.json fields", () => {
    const contents = JSON.stringify({ description: "run bunx smthrs up" })
    assert.deepEqual(findViolationsInFile("package.json", contents), [])
  })

  it("survives malformed package.json instead of throwing", () => {
    assert.deepEqual(findViolationsInFile("package.json", "{not json"), [])
  })

  it("flags a shell-executed call in TypeScript", () => {
    const source = "const res = await $`bunx smthrs graph f.tsx`.nothrow();\n"
    const violations = findViolationsInFile("w.tsx", source)
    assert.equal(violations.length, 1)
  })

  it("flags a spawnSync call in JavaScript", () => {
    const source = 'spawnSync("sh", ["-c", "bunx smthrs ps"]);\n'
    assert.equal(findViolationsInFile("h.mjs", source).length, 1)
  })

  it("leaves prose in agent prompts and docs assertions alone", () => {
    const source = 'const prompt = "Verify with `bunx smthrs graph <file>`";\n'
    assert.deepEqual(findViolationsInFile("w.tsx", source), [])
  })

  it("flags every line of an MCP server config", () => {
    const contents = JSON.stringify({
      mcpServers: { smithers: { command: "bunx smthrs", args: ["--mcp"] } },
    })
    assert.equal(findViolationsInFile("examples/.mcp.json", contents).length, 1)
  })

  it("decodes command and argv in real MCP configurations", () => {
    for (const [command, args] of [
      ["bunx", ["smthrs", "--mcp"]],
      ["npx", ["--yes", "smthrs@next", "--mcp"]],
      ["pnpm", ["dlx", "smthrs", "--mcp"]],
      ["deno", ["run", "-A", "npm:smthrs", "--mcp"]],
    ]) {
      const contents = JSON.stringify({ mcpServers: { smithers: { command, args } } }, null, 2)
      const violations = findViolationsInFile("example/.mcp.json", contents)
      assert.equal(violations.length, 1, contents)
      assert.ok(violations[0].line > 0)
    }
  })

  it("flags literal argv process calls, including multiline calls and Bun cmd arrays", () => {
    for (const source of [
      'spawn("bunx", ["smthrs", "--version"])',
      'spawnSync("npx", ["--yes", "smthrs@next", "--version"])',
      'execFile(\n  "pnpm",\n  ["dlx", "smthrs", "--version"]\n)',
      'execFileSync("yarn", ["dlx", "smthrs", "--version"])',
      'Bun.spawn(["bunx", "smthrs", "--version"])',
      'Bun.spawn({ cmd: ["bunx", "smthrs", "--version"] })',
      'execa("deno", ["run", "-A", "npm:smthrs@next", "--version"])',
    ]) assert.equal(findViolationsInFile("example/tool.mjs", source).length, 1, source)
  })

  it("checks namespaced process calls and statically known template command segments", () => {
    for (const source of [
      'cp.execSync("bunx smthrs --version")',
      'childProcess.spawn("bunx", ["smthrs"])',
      'cp.spawnSync("bunx", ["smthrs"])',
      'execSync(`bunx smthrs ${args}`)',
      'execFile("bunx", [`smthrs@${version}`, "--version"])',
      'execSync(`bunx ${"smthrs"} --version`)',
    ]) assert.equal(findViolationsInFile("tool.mjs", source).length, 1, source)
    assert.deepEqual(findViolationsInFile("tool.mjs",
      'const prompt = `cp.execSync("bunx smthrs ${args}")`'), [])
  })

  it("matches Deno npm specifiers without a space after the colon", () => {
    assert.equal(findViolationsInFile("a.sh", "deno run -A npm:smthrs --version").length, 1)
    assert.equal(findViolationsInFile("a.sh", "deno run -A npm:@smthrs/cli@next --version").length, 1)
  })

  it("ignores local argv, unrelated packages, config descriptions and quoted prompts", () => {
    for (const source of [
      'spawn("node", ["packages/smithers/bin/smithers.mjs", "--version"])',
      'spawn("bunx", ["smthrs-unrelated", "--version"])',
      'const prompt = \'spawn("bunx", ["smthrs"])\'',
      '// spawn("bunx", ["smthrs"])',
    ]) assert.deepEqual(findViolationsInFile("tool.mjs", source), [], source)
    assert.deepEqual(findViolationsInFile("a.sh", "bunx smthrs-unrelated --version"), [])
    assert.deepEqual(findViolationsInFile("example/.mcp.json", JSON.stringify({
      description: "bunx smthrs", mcpServers: { local: { command: "node", args: [SOURCE_ENTRY] } },
    })), [])
    assert.deepEqual(findViolationsInFile("example/.mcp.json", "{bad json"), [])
  })

  it("returns nothing for an allowlisted path", () => {
    const [allowlisted] = Object.keys(ALLOWLIST)
    assert.deepEqual(findViolationsInFile(allowlisted, "bunx smthrs ps\n"), [])
  })
})

describe("the repo itself", () => {
  it("scans the internal execution surfaces", () => {
    const scanned = listScannedFiles()
    assert.ok(scanned.includes("package.json"))
    assert.ok(scanned.includes(".github/scripts/ci/cloud.sh"))
    assert.ok(scanned.some((path) => path.startsWith(".smithers/flows/")))
    assert.ok(!scanned.some((path) => path.includes("node_modules")))
  })

  it("names a working-tree entry that exists", () => {
    assert.ok(existsSync(join(REPO_ROOT, SOURCE_ENTRY)), `${SOURCE_ENTRY} must exist`)
  })

  it("has no internal script running the published CLI", () => {
    const { violations } = check()
    assert.deepEqual(
      violations.map((violation) => `${violation.path}:${violation.line}`),
      [],
    )
  })
})
