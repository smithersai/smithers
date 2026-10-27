// The CLI reference generator: captured help and manifest in, Markdown
// sections out; every disagreement between the two sources throws; the script
// writes, checks and reports drift in a copied tree.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { COPY, MARKER, PAGE, main, parseHelp, projection, prose, renderBody, typeOf } from "./gen-cli-reference.mjs"

const globalsHelp = [
  "Custom Global Options:",
  "  --audience <auto|human|agent>  Presentation audience (default: auto)",
  ""
]
const page = (head, usage, ...sections) => [head, "", `Usage: ${usage}`, "", ...sections.flatMap((lines) => [...lines, ""]), ...globalsHelp].join("\n")
const verbose = { default: false, description: "Show redacted diagnostic details", type: "boolean" }

/** Two groups: `host` has only subcommands; `stack` is a command and a group. */
function fixture() {
  const manifest = {
    version: "incur.v1",
    commands: [
      { name: "host backup", description: "Back up the installation", schema: { args: { type: "object", properties: {} }, options: { type: "object", properties: { verbose }, required: ["verbose"] } } },
      {
        name: "stack",
        description: "Show the stack",
        schema: {
          args: { type: "object", properties: {} },
          options: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500, description: "Runs per page" } } }
        }
      },
      {
        name: "stack move",
        description: "Reorder an item",
        schema: {
          args: {
            type: "object",
            properties: { n: { type: "string", pattern: "^T[1-9]\\d*$" }, direction: { type: "string", enum: ["up", "down"], description: "Which way" } },
            required: ["n", "direction"]
          },
          options: {
            type: "object",
            properties: {
              user: { default: "developer", type: "string", description: "Guest user" },
              dryRun: { type: ["string", "null"] },
              reason: { type: "string", description: "Why it moves" }
            },
            required: ["user", "reason"]
          }
        }
      }
    ],
    globals: { type: "object", properties: { audience: { default: "auto", description: "Presentation audience", type: "string", enum: ["auto", "human", "agent"] } }, required: ["audience"] }
  }
  const help = new Map([
    ["", page("smthrs@1.2.3 — Operate flows", "smthrs <command>", ["Commands:", "  host   Operate the host", "  stack  Show the stack"], ["Global Options:", "  --format <toon|json>  Output format", "  --help               Show help"])],
    ["host", page("smthrs host — Operate this installation’s host", "smthrs host <command>", ["Commands:", "  backup  Back up the installation"])],
    ["host backup", page("smthrs host backup — Back up the installation", "smthrs host backup [options]", ["Options:", "  --verbose  Show redacted diagnostic details"])],
    ["stack", page("smthrs stack — Show the stack", "smthrs stack [options] | <command>", ["Commands:", "  move  Reorder an item"], ["Options:", "  --limit <number>"])],
    ["stack move", page("smthrs stack move — Reorder an item", "smthrs stack move <n> <direction> [options]",
      ["Arguments:", "  n", "  direction  Which way"],
      ["Options:", "  --user, -u <string>  (default: developer)", "  --dry-run <value>", "  --reason <string>"])]
  ])
  return { manifest, help: (path) => help.get(path), map: help }
}

test("one section per command: usage from the help, tables from the schema, globals once at the top", () => {
  const body = renderBody(fixture())
  assert.ok(body.startsWith("Install discovery for `smthrs` 1.2.3, plus additional local commands, as their `--help` describes them."))
  assert.ok(body.includes([
    "| Command | Description |",
    "| --- | --- |",
    "| [`host`](#host) | Operate this installation’s host |",
    "| [`stack`](#stack) | Show the stack |"
  ].join("\n")))
  assert.ok(body.includes([
    "## Global options",
    "",
    "Every command takes these options.",
    "",
    "| Option | Type | Default | Required | Description |",
    "| --- | --- | --- | --- | --- |",
    "| `--audience` | one of `auto`, `human`, `agent` | `auto` | no | Presentation audience |",
    "",
    "`smthrs --help` also lists these built-in options.",
    "",
    "| Option | Value | Description |",
    "| --- | --- | --- |",
    "| `--format` | `toon\\|json` | Output format |",
    "| `--help` |  | Show help |"
  ].join("\n")), "a schema-required global with a default is not required of the reader")
  // A group without a command of its own shows its usage and no tables.
  assert.ok(body.includes("## `host`\n\nOperate this installation’s host\n\n```text\nsmthrs host <command>\n```\n\n### `host backup`\n"))
  assert.ok(body.includes("## `stack`\n\nShow the stack\n\n```text\nsmthrs stack [options] | <command>\n```\n\n| Option | Type | Default | Required | Description |\n| --- | --- | --- | --- | --- |\n| `--limit` | integer, minimum 1, maximum 500 |  | no | Runs per page |\n\n### `stack move`"))
  assert.ok(body.endsWith([
    "### `stack move`",
    "",
    "Reorder an item",
    "",
    "```text",
    "smthrs stack move <n> <direction> [options]",
    "```",
    "",
    "| Argument | Type | Default | Required | Description |",
    "| --- | --- | --- | --- | --- |",
    "| `n` | string, pattern `^T[1-9]\\d*$` |  | yes |  |",
    "| `direction` | one of `up`, `down` |  | yes | Which way |",
    "",
    "| Option | Type | Default | Required | Description |",
    "| --- | --- | --- | --- | --- |",
    "| `--user`, `-u` | string | `developer` | no | Guest user |",
    "| `--dry-run` | string |  | no |  |",
    "| `--reason` | string |  | yes | Why it moves |",
    ""
  ].join("\n")))
  assert.ok(body.indexOf("## `host`") < body.indexOf("### `host backup`") && body.indexOf("### `host backup`") < body.indexOf("## `stack`"))
})

test("a disagreement between the help and the manifest throws instead of publishing", () => {
  const cases = [
    ["help lacks a schema option", (f) => f.map.set("host backup", f.map.get("host backup").replace("  --verbose  Show redacted diagnostic details\n", "")), /schema has option verbose, but the help lists no --verbose/],
    ["help lists an option the schema lacks", (f) => f.map.set("stack", f.map.get("stack").replace("  --limit <number>", "  --limit <number>\n  --all")), /lists --all, which the schema lacks/],
    ["arguments differ", (f) => f.map.set("stack move", f.map.get("stack move").replace("  n\n", "")), /help lists arguments \[direction\], the schema \[n, direction\]/],
    ["descriptions differ", (f) => { f.manifest.commands[0].description = "Back it up" }, /manifest says "Back it up", the help "Back up the installation"/],
    ["a capture is missing", (f) => f.map.delete("host"), /no help capture for smthrs host/],
    ["a schema keyword has no rendering", (f) => { f.manifest.commands[1].schema.options.properties.limit.format = "int32" }, /--limit: schema keyword format has no rendering/],
    ["globals differ per command", (f) => f.map.set("host", f.map.get("host").replace("Presentation audience (default: auto)", "Audience")), /different global options than smthrs --help/],
    ["the root names no version", (f) => f.map.set("", f.map.get("").replace("smthrs@1.2.3", "smthrs")), /names no version/]
  ]
  for (const [name, change, error] of cases) {
    const f = fixture()
    change(f)
    assert.throws(() => renderBody(f), error, name)
  }
})

test("CLI text renders literally and types read as the schema states them", () => {
  assert.equal(prose("Local path or <workspace-id>:<path>"), "Local path or \\<workspace-id>:\\<path>")
  assert.equal(prose("seeds ANTHROPIC_API_KEY, a _b_ *c* [d] `e`"), "seeds ANTHROPIC_API_KEY, a \\_b\\_ \\*c\\* \\[d\\] \\`e\\`")
  assert.equal(typeOf({ anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] }, "t"), "string, min length 1")
  assert.equal(typeOf({ type: "array", items: { type: "string" }, minItems: 1 }, "t"), "array of string, min items 1")
  assert.equal(typeOf({ type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }, "t"), "integer, greater than 0")
  assert.equal(typeOf({ anyOf: [{ type: "object", properties: {}, additionalProperties: {} }, { type: "null" }] }, "t"), "object")
  assert.throws(() => typeOf({ description: "no type" }, "t"), /t: schema has no type/)
})

test("the script writes the page and its copy, then --check names drift without changing it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gen-cli-reference-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = join(root, "apps/site/scripts/gen-cli-reference.mjs")
  mkdirSync(dirname(script), { recursive: true })
  cpSync(new URL("./gen-cli-reference.mjs", import.meta.url), script)
  const { manifest, map } = fixture()
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put("apps/site/src/data/cli-commands.json", JSON.stringify(manifest))
  for (const [path, text] of map) {
    const tokens = path === "" ? ["smthrs"] : path.split(" ")
    put(join("apps/site/src/data/help", ...tokens.slice(0, -1), `${tokens.at(-1)}.txt`), text)
  }
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
  const read = (path) => readFileSync(join(root, path), "utf8")

  const written = run()
  assert.equal(written.status, 0, written.stderr)
  const sitePage = read(PAGE)
  assert.ok(sitePage.startsWith(`---\n${MARKER}\neditUrl: https://github.com/smithersai/smithers/edit/main/apps/site/scripts/gen-cli-reference.mjs\ntitle: "CLI reference"\ndescription: "`))
  assert.match(sitePage, /^ {6}type: text\/markdown\n {6}href: \/docs\/reference\/cli\.md\n---\n\nInstall discovery for `smthrs` 1\.2\.3/m)
  assert.doesNotMatch(sitePage.split("\n---\n")[1], /^# /m, "the frontmatter title owns the page heading")
  const copy = read(COPY)
  assert.ok(copy.startsWith("# CLI reference\n\n> Install discovery and additional local commands"))
  assert.equal(copy.split("\n\n").slice(2).join("\n\n"), sitePage.split("\n---\n\n")[1], "the copy carries the page's body")
  assert.equal(run("--check").status, 0)

  put(PAGE, sitePage.replace("Reorder an item", "Move it"))
  const drifted = run("--check")
  assert.equal(drifted.status, 1)
  assert.match(drifted.stderr, /cli reference drift: apps\/site\/src\/content\/docs\/docs\/reference\/cli\.md differs/)
  assert.match(drifted.stderr, /run node apps\/site\/scripts\/gen-cli-reference\.mjs/)
  assert.match(read(PAGE), /Move it/, "check mode writes nothing")
  rmSync(join(root, COPY))
  assert.match(run("--check").stderr, /public\/docs\/reference\/cli\.md is missing/)
  assert.equal(run().status, 0)
  assert.equal(run("--check").status, 0)
  put("apps/site/src/data/help/mcp.txt", "smthrs mcp — Integrations\n\nUsage: smthrs mcp <command>\n")
  const incomplete = run()
  assert.equal(incomplete.status, 1)
  assert.match(incomplete.stderr, /no integration help capture for smthrs mcp add/)
})

test("reference supplements retain invocation schemas, notes and literal integration help", () => {
  const f = fixture()
  const extra = { name: "host status", description: "Read the host", schema: { args: { type: "object", properties: {} }, options: { type: "object", properties: {} } } }
  f.map.set(extra.name, page("smthrs host status — Read the host", "smthrs host status"))
  const body = renderBody({ ...f, additional: [extra], notes: { "host status": "### Details\n\nRead-only host status." }, integrations: [{ name: "completions", captures: ["smthrs completions — Generate a script\n\nUsage: smthrs completions <shell>\n\n  --help\n"] }] })
  assert.match(body, /### `host status`\n\nRead the host/)
  assert.match(body, /### Details\n\nRead-only host status/)
  assert.match(body, /## `completions`\n\n```text\nsmthrs completions/)
  assert.match(body, /  --help\n```/)
  assert.throws(() => renderBody({ ...f, integrations: [{ name: "host", captures: [] }] }), /two headings share the anchor/)
})

test("help and schema failures identify the command instead of emitting partial documentation", () => {
  assert.throws(() => renderBody({ manifest: { commands: [] }, help: () => undefined }), /lists no commands/)
  assert.throws(() => parseHelp("bad header", "smthrs"), /first line/)
  assert.throws(() => parseHelp("smthrs — Purpose\n", "smthrs"), /no usage line/)
  assert.throws(() => parseHelp("smthrs — Purpose\nUsage: one\nUsage: two", "smthrs"), /more than one usage/)
  assert.throws(() => parseHelp("smthrs — Purpose\nUsage: one\nUnexpected", "smthrs"), /unexpected line/)
  assert.equal(parseHelp("smthrs — Purpose\r\nUsage: one\r\n", "smthrs").usage, "one")
  const f = fixture()
  f.map.set("host backup", f.map.get("host backup").replace("  --verbose  Show redacted diagnostic details", "  !!! bad option"))
  assert.throws(() => renderBody(f), /option line.*does not parse/)
  const args = fixture()
  args.map.set("stack move", args.map.get("stack move").replace("  n\n", "  ??? bad argument\n"))
  assert.throws(() => renderBody(args), /argument line.*does not parse|help lists arguments/)
  const group = fixture()
  group.map.set("host", page("smthrs host — Operate the host", "smthrs host", ["Options:", "  --unexpected"]))
  assert.throws(() => renderBody(group), /help lists arguments or options, but the manifest has no such command/)
})

test("constraint rendering covers bounds, empty unions and code punctuation", () => {
  assert.equal(typeOf({ type: "null" }, "field"), "null")
  assert.equal(typeOf({ anyOf: [{ type: "null" }] }, "field"), "null")
  assert.equal(typeOf({ type: "array" }, "field"), "array of any")
  assert.equal(typeOf({ type: "string", maxLength: 9 }, "field"), "string, max length 9")
  assert.equal(typeOf({ type: "number", maximum: 7, exclusiveMaximum: 8 }, "field"), "number, maximum 7, less than 8")
  assert.equal(typeOf({ type: "array", maxItems: 3 }, "field"), "array of any, max items 3")
  assert.equal(typeOf({ enum: ["a`b"] }, "field"), "one of `` a`b ``")
})

test("entrypoint writes real files, checks drift without writing, and repairs missing outputs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reference-writer-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = fileURLToPath(new URL("./gen-cli-reference.mjs", import.meta.url))
  const files = new Map([["docs/reference.md", "Canonical reference\n"], ["copy.md", "Canonical copy\n"]])
  const output = join(directory, "docs/reference.md")
  const previous = process.exitCode
  try {
    main([])
    main([process.execPath, script], { directory, files })
    assert.equal(readFileSync(output, "utf8"), "Canonical reference\n")
    main([process.execPath, script, "--check"], { directory, files })
    writeFileSync(output, "drifted\n")
    rmSync(join(directory, "copy.md"))
    main([process.execPath, script, "--check"], { directory, files })
    assert.equal(process.exitCode, 1)
    assert.equal(readFileSync(output, "utf8"), "drifted\n")
    process.exitCode = previous
    main([process.execPath, script], { directory, files })
    main([process.execPath, script, "--check"])
    assert.equal(process.exitCode, previous)
  } finally {
    process.exitCode = previous
  }
})

test("a real capture directory can predate supplements; incomplete integration captures fail closed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "reference-captures-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const put = (path, text) => {
    const target = join(directory, "apps/site/src/data", path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  const f = fixture()
  put("cli-commands.json", JSON.stringify(f.manifest))
  for (const [path, text] of f.map) {
    const tokens = path === "" ? ["smthrs"] : path.split(" ")
    put(join("help", ...tokens.slice(0, -1), `${tokens.at(-1)}.txt`), text)
  }
  assert.match(projection(directory).get(PAGE), /### `stack move`/)
  put("cli-reference-extra.json", "[]")
  put("help/mcp.txt", "smthrs mcp — Register as MCP server\n\nUsage: smthrs mcp <command>\n")
  assert.throws(() => projection(directory), /no integration help capture for smthrs mcp add/)
  put("help/mcp/add.txt", "smthrs mcp add — Register a server\n\nUsage: smthrs mcp add\n")
  put("help/mcp/doctor.txt", "smthrs mcp doctor — Validate a server\n\nUsage: smthrs mcp doctor\n")
  assert.match(projection(directory).get(PAGE), /## `mcp`/)
  main([process.execPath, fileURLToPath(new URL("./gen-cli-reference.mjs", import.meta.url))], { directory })
  assert.match(readFileSync(join(directory, PAGE), "utf8"), /### `stack move`/)
})

test("commands without custom globals and explicit empty defaults retain their meaning", () => {
  const manifest = { commands: [{ name: "plain", description: "Pure command" }] }
  const captures = new Map([
    ["", "smthrs@1.2.3 — Root\n\nUsage: smthrs <command>\n"],
    ["plain", "smthrs plain — Pure command\n\nUsage: smthrs plain\n"]
  ])
  assert.match(renderBody({ manifest, help: path => captures.get(path) }), /## `plain`/)
  assert.throws(() => renderBody({ manifest: { commands: null }, help: () => undefined }), /lists no commands/)
  assert.throws(() => parseHelp("smthrs — Purpose\nUsage: one\n  orphan", "smthrs"), /unexpected line/)
  const f = fixture()
  f.manifest.commands[2].schema.options.properties.user.default = ""
  f.map.set("stack move", f.map.get("stack move").replace("default: developer", 'default: ""'))
  assert.ok(renderBody(f).includes('| `--user`, `-u` | string | `""` | no'))
})

test("a group cannot publish arguments without an invocation schema", () => {
  const f = fixture()
  f.map.set("host", page("smthrs host — Operate the host", "smthrs host <name>", ["Arguments:", "  name"]))
  assert.throws(() => renderBody(f), /help lists arguments or options, but the manifest has no such command/)
})
