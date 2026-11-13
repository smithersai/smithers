import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { type Host, main } from "../src/cli/Entry.ts"

const directories: Array<string> = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-step-cache-")))
  directories.push(root)
  const nested = join(root, "src", "nested")
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(root, ".flows"))
  for (const name of ["control.db", "engine.db"]) {
    const db = new DatabaseSync(join(root, ".flows", name))
    try {
      db.exec(`CREATE TABLE flows_step_cache (
        key_digest TEXT PRIMARY KEY, result_json TEXT NOT NULL, meta_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, recorded_run_id TEXT NOT NULL, recorded_event_seq INTEGER NOT NULL
      )`)
      db.prepare("INSERT INTO flows_step_cache VALUES (?, ?, ?, ?, ?, ?)")
        .run("head", "{\"value\":1}", "{}", 1000, "run-one", 1)
    } finally {
      db.close()
    }
  }
  return { root, nested }
}
const invoke = async (args: Array<string>, environment: Host["env"] = {}) => {
  const signals = new EventEmitter()
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  await main({
    argv: args,
    env: environment,
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    on: (signal, listener) => {
      signals.on(signal, listener)
    },
    removeListener: (signal, listener) => {
      signals.removeListener(signal, listener)
    },
    setExitCode: (code) => {
      result.codes.push(code)
    }
  })
  expect(signals.eventNames()).toEqual([])
  return result
}
const leaves = [
  ["ls"],
  ["show", "head"],
  ["evict", "head", "--if-recorded-by", "run-one"],
  ["sweep", "--older-than", "7d"]
]

describe("step-cache project selection through the process entry", () => {
  it.each(leaves)("uses the containing project for %s from a nested directory", async (...leaf) => {
    const { root, nested } = fixture()
    const cwd = process.cwd()
    process.chdir(nested)
    try {
      const result = await invoke(["cache", "steps", ...leaf, "--json"])
      expect(result.codes.at(-1)).toBe(0)
      const rows = JSON.parse(result.stdout)
      expect(rows).toHaveLength(2)
      expect(rows.map((row: { database: string }) => row.database).sort()).toEqual(
        ["control.db", "engine.db"].map((name) => join(root, ".flows", name)).sort()
      )
      if (leaf[0] === "ls") expect(rows.every((row: { key_digest: string }) => row.key_digest === "head")).toBe(true)
      if (leaf[0] === "show") {
        expect(rows.every((row: { result: unknown }) => JSON.stringify(row.result) === "{\"value\":1}")).toBe(true)
      }
      if (leaf[0] === "evict" || leaf[0] === "sweep") {
        expect(rows.every((row: { removed: unknown }) => Boolean(row.removed))).toBe(true)
        for (const name of ["control.db", "engine.db"]) {
          const db = new DatabaseSync(join(root, ".flows", name), { readOnly: true })
          try {
            expect(db.prepare("SELECT 1 FROM flows_step_cache").get()).toBeUndefined()
          } finally {
            db.close()
          }
        }
      }
      expect(existsSync(join(nested, ".flows"))).toBe(false)
    } finally {
      process.chdir(cwd)
    }
  })

  it.each(leaves)("preserves explicit --root for %s during entry normalization", async (...leaf) => {
    const { root } = fixture()
    const result = await invoke(["cache", "steps", ...leaf, "--root", root, "--json"])
    expect(result.codes.at(-1)).toBe(0)
    expect(JSON.parse(result.stdout)).toHaveLength(2)
  })

  it("honors a relative root before the command over the containing project", async () => {
    const first = fixture()
    const second = fixture()
    const cwd = process.cwd()
    process.chdir(first.nested)
    try {
      const result = await invoke(["--root=" + relative(first.nested, second.root), "cache", "steps", "ls", "--json"])
      expect(result.codes.at(-1)).toBe(0)
      expect(result.stdout).toContain(second.root)
      expect(result.stdout).not.toContain(first.root)
    } finally {
      process.chdir(cwd)
    }
  })

  it.each(leaves)("refuses remote configuration before %s touches local data", async (...leaf) => {
    const { root } = fixture()
    const result = await invoke(["cache", "steps", ...leaf, "--root", root, "--json"], {
      SMITHERS_REMOTE: "https://control.invalid"
    })
    expect(result.codes.at(-1)).toBe(1)
    expect(result.stdout).toContain("local project")
    for (const name of ["control.db", "engine.db"]) {
      const db = new DatabaseSync(join(root, ".flows", name), { readOnly: true })
      try {
        expect(db.prepare("SELECT 1 FROM flows_step_cache").get()).toBeDefined()
      } finally {
        db.close()
      }
    }
  })

  it("refuses an inaccessible explicit root", async () => {
    const { root } = fixture()
    const result = await invoke(["cache", "steps", "ls", "--root", join(root, "missing"), "--json"])
    expect(result.codes.at(-1)).toBe(2)
    expect(result.stdout).toContain("accessible directory")
  })
})
