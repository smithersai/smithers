import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { copyMissing, partitionOf, toolIdentity, trim } from "./check-cache.mjs"

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

for (const command of ["seed", "save"]) {
  for (const component of ["root", "ancestor", "shard", "nested-shard"]) {
    test(`${command} refuses a linked destination ${component} without writing outside the cache`, () => {
      const f = fixture()
      try {
        const workspace = f.workspace("workspace")
        f.cache("seed", workspace)
        const partition = partitionOf(f.environment.SMITHERS_CHECK_CACHE_DIR, toolIdentity(f.environment))
        const local = join(workspace, ".flows", "cache")
        const [source, destination] = command === "seed" ? [partition, local] : [local, partition]
        const shard = component === "nested-shard" ? join("aa", "nested") : "aa"
        mkdirSync(join(source, shard), { recursive: true })
        writeFileSync(join(source, shard, "result.json"), '{"ran":true}')
        const outside = join(f.root, "outside")
        mkdirSync(outside)
        const target = component === "root" ? destination
          : component === "ancestor" ? (command === "seed" ? join(workspace, ".flows") : f.environment.SMITHERS_CHECK_CACHE_DIR)
          : join(destination, shard)
        rmSync(target, { recursive: true, force: true })
        mkdirSync(resolve(target, ".."), { recursive: true })
        symlinkSync(outside, target, "dir")
        const result = spawnSync(process.execPath, [script, command, workspace], { env: f.environment, encoding: "utf8" })
        assert.notEqual(result.status, 0, result.stderr)
        assert.match(result.stderr, /without symlinks/)
        assert.deepEqual(readdirSync(outside), [])
        assert.equal(lstatSync(target).isSymbolicLink(), true)
      } finally {
        f.cleanup()
      }
    })
  }
}

test("copying refuses linked source roots and ancestors and ignores linked source entries", () => {
  const f = fixture()
  try {
    const source = join(f.root, "source")
    const target = join(f.root, "target")
    const outside = join(f.root, "outside")
    mkdirSync(source)
    mkdirSync(outside)
    writeFileSync(join(outside, "result.json"), "{}")
    symlinkSync(outside, join(source, "linked"), "dir")
    symlinkSync(join(outside, "result.json"), join(source, "linked.json"))
    assert.equal(copyMissing(source, target), 0)
    assert.equal(existsSync(target), false)
    symlinkSync(outside, join(f.root, "linked-root"), "dir")
    assert.throws(() => copyMissing(join(f.root, "linked-root"), target), /without symlinks/)
    mkdirSync(join(outside, "nested"))
    writeFileSync(join(outside, "nested", "result.json"), "{}")
    assert.throws(() => copyMissing(join(f.root, "linked-root", "nested"), target), /without symlinks/)
    assert.equal(existsSync(target), false)
    assert.equal(copyMissing(join(f.root, "missing"), target), 0)
  } finally {
    f.cleanup()
  }
})

for (const kind of ["valid", "corrupt", "dangling", "directory"]) {
  test(`copying refuses a ${kind} destination entry without replacing it`, () => {
    const f = fixture()
    try {
      const source = join(f.root, "source")
      const target = join(f.root, "target")
      const outside = join(f.root, "outside.json")
      mkdirSync(source)
      mkdirSync(target)
      writeFileSync(join(source, "result.json"), "{}")
      if (kind === "directory") mkdirSync(join(target, "result.json"))
      else {
        if (kind !== "dangling") writeFileSync(outside, kind === "valid" ? "{}" : "truncated")
        symlinkSync(outside, join(target, "result.json"))
      }
      assert.throws(() => copyMissing(source, target), /regular file without symlinks/)
      const stat = lstatSync(join(target, "result.json"))
      assert.equal(kind === "directory" ? stat.isDirectory() : stat.isSymbolicLink(), true)
      assert.equal(existsSync(outside), kind === "valid" || kind === "corrupt")
      if (existsSync(outside)) assert.equal(readFileSync(outside, "utf8"), kind === "valid" ? "{}" : "truncated")
      assert.deepEqual(readdirSync(target), ["result.json"])
    } finally {
      f.cleanup()
    }
  })
}

test("copying refuses a regular file used as a directory component", () => {
  const f = fixture()
  try {
    const source = join(f.root, "source")
    const target = join(f.root, "target")
    mkdirSync(join(source, "aa"), { recursive: true })
    mkdirSync(target)
    writeFileSync(join(source, "aa", "result.json"), "{}")
    writeFileSync(join(target, "aa"), "keep")
    assert.throws(() => copyMissing(source, target), /directory without symlinks/)
    assert.equal(readFileSync(join(target, "aa"), "utf8"), "keep")
  } finally {
    f.cleanup()
  }
})
