import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { splitFrontmatter } from "../markdown.mjs"

const siteSource = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workSource = resolve(siteSource, "../mvp/docs/work")
const statuses = ["idea", "todo", "designing", "in-progress", "blocked", "done"]
const note = (status) => `---\ntitle: Example\nstatus: ${status}\narea: app\n---\n\nFinished work.\n`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "maintainer-build-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const site = join(root, "apps/maintainer-site")
  const work = join(root, "apps/mvp/docs/work")
  const out = join(root, "site")
  mkdirSync(site, { recursive: true })
  mkdirSync(work, { recursive: true })
  for (const path of ["build.mjs", "markdown.mjs", "client"]) cpSync(join(siteSource, path), join(site, path), { recursive: true })
  for (const status of statuses) writeFileSync(join(work, `${status}.md`), note(status))
  mkdirSync(join(work, "evidence"), { recursive: true })
  writeFileSync(join(work, "evidence/historical.md"), note("completed"))
  return {
    work,
    read: (path) => readFileSync(join(out, path), "utf8"),
    build: () => spawnSync(process.execPath, [join(site, "build.mjs")], {
      encoding: "utf8",
      env: { ...process.env, MAINTAINER_SITE_OUT: out, MAINTAINER_SITE_GIFS: join(root, "gifs") },
    }),
  }
}
const data = (f) => JSON.parse(f.read("assets/data.js").slice("window.SITE = ".length, -2))

test("work board puts finished work in Done and excludes it from the open count", (t) => {
  const f = fixture(t)
  const result = f.build()
  assert.equal(result.status, 0, result.stderr)
  const board = data(f)
  assert.deepEqual(board.workStatuses.map((column) => column.id), statuses)
  assert.deepEqual(board.work.map((item) => item.status).sort(), [...statuses].sort())
  assert.deepEqual(board.work.filter((item) => item.status === "done").map((item) => item.path), ["apps/mvp/docs/work/done.md"])
  assert.match(f.read("index.html"), /data-view="work">Work <span class="count">5<\/span>/)
  assert.ok(board.notes.some((item) => item.path === "apps/mvp/docs/work/evidence/historical.md"))
})

test("work-note validation rejects unsupported values without replacing the published board", (t) => {
  const f = fixture(t)
  assert.equal(f.build().status, 0)
  const published = f.read("assets/data.js")
  const index = f.read("index.html")
  for (const status of ["complete", "completed", "review", "in-review", "DONE", "unknown", "", '""', "[]", "[done]"]) {
    writeFileSync(join(f.work, "invalid.md"), note(status))
    const result = f.build()
    assert.notEqual(result.status, 0, `status ${status} must be rejected`)
    assert.match(result.stderr, /work note apps\/mvp\/docs\/work\/invalid\.md: status .* is not one of idea, todo, designing, in-progress, blocked, done/)
    assert.equal(f.read("assets/data.js"), published)
    assert.equal(f.read("index.html"), index)
  }
})

test("notes without a status keep their warning and remain open", (t) => {
  const f = fixture(t)
  for (const source of ["# Missing metadata\n", "---\ntitle: Missing status\narea: app\n---\n"]) {
    writeFileSync(join(f.work, "missing.md"), source)
    const result = f.build()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /status \(none\) is not one of/)
    assert.equal(data(f).work.find((item) => item.path.endsWith("/missing.md")).status, "unknown")
    assert.match(f.read("index.html"), /data-view="work">Work <span class="count">6<\/span>/)
  }
})

test("repository work-note status values use the board vocabulary", () => {
  const invalid = []
  for (const path of readdirSync(workSource).filter((path) => path.endsWith(".md"))) {
    const { data } = splitFrontmatter(readFileSync(join(workSource, path), "utf8"))
    if (data && "status" in data && !statuses.includes(data.status)) invalid.push({ path, status: data.status })
  }
  assert.deepEqual(invalid, [])
})
