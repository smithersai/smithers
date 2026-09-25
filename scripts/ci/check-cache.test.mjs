import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { partitionOf, toolIdentity, trim } from "./check-cache.mjs"

const script = resolve(import.meta.dirname, "check-cache.mjs")

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-cache-")))
  const tools = join(root, "tools")
  mkdirSync(tools)
  writeFileSync(join(tools, "jj"), "#!/bin/sh\necho jj 1\n", { mode: 0o755 })
  writeFileSync(join(root, "exporter"), "exporter bytes")
  const environment = { PATH: `${tools}:${process.env.PATH}`, HOME: root,
    SMITHERS_CHECK_CACHE_DIR: join(root, "cache"), SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(root, "exporter") }
  const workspace = (name) => {
    const directory = join(root, name)
    mkdirSync(join(directory, ".flows", "cache"), { recursive: true })
    return directory
  }
  const entry = (directory, key, value) => {
    mkdirSync(join(directory, ".flows", "cache", key.slice(0, 2)), { recursive: true })
    writeFileSync(join(directory, ".flows", "cache", key.slice(0, 2), `${key}.json`), value)
  }
  const read = (directory, key) => readFileSync(join(directory, ".flows", "cache", key.slice(0, 2), `${key}.json`), "utf8")
  const cache = (command, directory) => {
    const result = spawnSync(process.execPath, [script, command, directory], { env: environment, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stderr
  }
  return { root, tools, environment, workspace, entry, read, cache, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test("a later export at another path receives the results an earlier one saved", () => {
  const f = fixture()
  try {
    const first = f.workspace("first")
    f.cache("seed", first)
    f.entry(first, "aa11", '{"exitOk":true}')
    writeFileSync(join(first, ".flows", "cache", "aa", ".aa11.json.tmp"), "in flight")
    assert.match(f.cache("save", first), /saved 1 new entries/)
    const second = f.workspace("second")
    assert.match(f.cache("seed", second), /seeded 1 entries/)
    assert.equal(f.read(second, "aa11"), '{"exitOk":true}')
    assert.deepEqual(readdirSync(join(second, ".flows", "cache", "aa")), ["aa11.json"])
  } finally {
    f.cleanup()
  }
})

test("save never replaces a stored entry, except one that no longer parses", () => {
  const f = fixture()
  try {
    const first = f.workspace("first")
    f.cache("seed", first)
    f.entry(first, "bb22", '{"first":true}')
    f.entry(first, "cc33", "{truncated")
    f.cache("save", first)
    const second = f.workspace("second")
    f.cache("seed", second)
    f.entry(second, "bb22", '{"second":true}')
    f.entry(second, "cc33", '{"repaired":true}')
    assert.match(f.cache("save", second), /saved 1 new entries/)
    const third = f.workspace("third")
    f.cache("seed", third)
    assert.equal(f.read(third, "bb22"), '{"first":true}')
    assert.equal(f.read(third, "cc33"), '{"repaired":true}')
  } finally {
    f.cleanup()
  }
})

test("a different tool binary selects a different partition", () => {
  const f = fixture()
  try {
    const before = partitionOf(f.environment.SMITHERS_CHECK_CACHE_DIR, toolIdentity(f.environment))
    const first = f.workspace("first")
    f.cache("seed", first)
    f.entry(first, "dd44", "{}")
    f.cache("save", first)
    // Same version string, different bytes.
    writeFileSync(join(f.tools, "jj"), "#!/bin/sh\necho jj 1\n# rebuilt\n", { mode: 0o755 })
    const after = partitionOf(f.environment.SMITHERS_CHECK_CACHE_DIR, toolIdentity(f.environment))
    assert.notEqual(after, before)
    const second = f.workspace("second")
    assert.match(f.cache("seed", second), /seeded 0 entries/)
    // A tool replaced between seed and save publishes nothing.
    const third = f.workspace("third")
    f.cache("seed", third)
    f.entry(third, "ff55", "{}")
    writeFileSync(join(f.tools, "jj"), "#!/bin/sh\necho jj 2\n", { mode: 0o755 })
    const refused = spawnSync(process.execPath, [script, "save", third], { env: f.environment, encoding: "utf8" })
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /host tools changed/)
  } finally {
    f.cleanup()
  }
})

test("trim removes the oldest entries until the partition fits", () => {
  const f = fixture()
  try {
    const partition = join(f.root, "partition")
    mkdirSync(join(partition, "ee"), { recursive: true })
    for (const [index, name] of ["old", "middle", "new"].entries()) {
      const file = join(partition, "ee", `${name}.json`)
      writeFileSync(file, "x".repeat(100))
      utimesSync(file, 1_000 + index, 1_000 + index)
    }
    assert.equal(trim(partition, 250), 1)
    assert.deepEqual(readdirSync(join(partition, "ee")).sort(), ["middle.json", "new.json"])
  } finally {
    f.cleanup()
  }
})
