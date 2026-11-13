import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const workDir = "apps/mvp/docs/work/"

function build(repo, args = []) {
  return spawnSync(process.execPath, ["apps/maintainer-site/build.mjs", ...args], {
    cwd: repo,
    env: { ...process.env, MAINTAINER_SITE_OUT: join(repo, "output") },
    encoding: "utf8"
  })
}

const check = (repo, paths = []) => build(repo, ["--check", ...paths])

function fixture(t, files) {
  const repo = mkdtempSync(join(tmpdir(), "maintainer-metadata-"))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  for (const name of ["build.mjs", "markdown.mjs", "client/site.css", "client/site.js"]) {
    const target = join(repo, "apps/maintainer-site", name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(root, "apps/maintainer-site", name), target)
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  return repo
}

const note = (status, extra = "", body = "# Work\n") =>
  `---\ntitle: Work\nstatus: ${status}\narea: sdk\nowner: Maintainer\nupdated: 2026-10-22\n${extra}---\n${body}`

test("the board excludes completed work from its open count and retains report metadata", (t) => {
  const repo = fixture(t, {
    [workDir + "finished.md"]: note("done"),
    [workDir + "active.md"]: note("in-progress")
  })
  const result = build(repo)
  assert.equal(result.status, 0, result.stderr)
  const site = JSON.parse(readFileSync(join(repo, "output/assets/data.js"), "utf8").replace(/^window.SITE = /, "").trim().replace(/;$/, ""))
  const finished = site.work.find((item) => item.path.endsWith("/finished.md"))
  assert.deepEqual(finished, {
    path: workDir + "finished.md", title: "Work", status: "done", area: "sdk",
    owner: "Maintainer", updated: "2026-10-22"
  })
  assert.equal(site.work.filter((item) => item.status !== "done").length, 1)
  assert.match(readFileSync(join(repo, "output/index.html"), "utf8"), /Work <span class="count">1<\/span>/)
})

test("check accepts every board status and writes no site output", (t) => {
  const files = Object.fromEntries(["idea", "todo", "designing", "in-progress", "blocked", "done"]
    .map((status) => [`${workDir}${status}.md`, note(status)]))
  const repo = fixture(t, files)
  const result = check(repo)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Checked 6 notes: 0 errors/)
  assert.equal(existsSync(join(repo, "output")), false)
})

for (const status of ["complete", "completed", "unknown", "", "[]", "[done]"]) {
  test(`check rejects unsupported or missing status ${JSON.stringify(status)}`, (t) => {
    const repo = fixture(t, { [workDir + "invalid.md"]: note(status) })
    const result = check(repo)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /work note apps\/mvp\/docs\/work\/invalid.md: status .* is not one of/)
    assert.equal(existsSync(join(repo, "output")), false)
  })
}

test("check rejects absent or unterminated frontmatter and malformed properties", (t) => {
  const repo = fixture(t, {
    [workDir + "absent.md"]: "status: done\nowner: Maintainer\n",
    [workDir + "unterminated.md"]: "---\nstatus: done\n",
    [workDir + "missing-status.md"]: "---\ntitle: Work\n---\n",
    [workDir + "malformed.md"]: note("done", "invalid property\n")
  })
  const result = check(repo)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /work note without front matter: .*absent.md/)
  assert.match(result.stderr, /work note without front matter: .*unterminated.md/)
  assert.match(result.stderr, /front matter in .*malformed.md: line 7: invalid property/)
})

test("check applies the renderer's destination rules to body and frontmatter links", (t) => {
  const repo = fixture(t, {
    [workDir + "links.md"]: note("done", [
      "links:", "  - packages/example/source.ts", "  - ../../../../../packages/example/source.ts",
      "  - ../../../../packages/example/missing.ts", "  - javascript:alert(1)", ""
    ].join("\n"), "[Missing](missing.md)\n![Missing](missing.png)\n[[Missing note]]\n"),
    "packages/example/source.ts": "export const value = 1\n"
  })
  const result = check(repo)
  assert.equal(result.status, 1)
  for (const message of ["packages/example/source.ts", "../../../../../packages/example/source.ts",
    "../../../../packages/example/missing.ts", "unsafe link", "missing.md", "missing image", "unresolved wikilink"]) {
    assert.ok(result.stderr.includes(message), message)
  }
})

test("check accepts relative, root, encoded, external and note links", (t) => {
  const repo = fixture(t, {
    [workDir + "links.md"]: note("done", [
      "links:", "  - ../../../../packages/example/source.ts", "  - ../../../../packages/example",
      "  - /packages/example/source.ts", "  - ../../../../packages/example/with%20space.ts",
      "  - https://example.com/source", "  - '#work'", "  - ../features/example.md#example", ""
    ].join("\n"), "[Example](../features/example.md)\n[[Example]]\n"),
    "apps/mvp/docs/features/example.md": "# Example\n",
    "packages/example/source.ts": "export const value = 1\n",
    "packages/example/with space.ts": "export const value = 2\n"
  })
  const result = check(repo)
  assert.equal(result.status, 0, result.stderr)
})

test("check can validate selected notes without accepting unknown paths", (t) => {
  const path = workDir + "valid.md"
  const repo = fixture(t, {
    [path]: note("done"),
    [workDir + "invalid.md"]: note("completed")
  })
  assert.equal(check(repo).status, 1)
  const selected = check(repo, [path])
  assert.equal(selected.status, 0, selected.stderr)
  assert.match(selected.stdout, /Checked 1 notes: 0 errors/)
  const missing = check(repo, [workDir + "missing.md"])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Not a site note:/)
})
