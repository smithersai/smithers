import { mkdirSync, mkdtempSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { invoke } from "./support/unified-cli.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-root-commands-"))
  roots.push(root)
  return root
}

describe("unified root commands with real handlers", () => {
  it("cache steps conditional evict preserves a foreign run and removes only matching heads", async () => {
    const directory = await fixture()
    const root = mkdtempSync(join(directory, "step-cache-"))
    mkdirSync(join(root, ".flows"))
    const db = new DatabaseSync(join(root, ".flows", "engine.db"))
    try {
      db.exec(`CREATE TABLE flows_step_cache (
        key_digest TEXT PRIMARY KEY, result_json TEXT NOT NULL, meta_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, recorded_run_id TEXT NOT NULL,
        recorded_event_seq INTEGER NOT NULL
      )`)
      const put = db.prepare(
        "INSERT INTO flows_step_cache VALUES (?, ?, ?, ?, ?, ?)"
      )
      put.run("poisoned", "{\"value\":1}", "{}", 1000, "run-one", 1)
      const wrong = await invoke([
        "cache",
        "steps",
        "evict",
        "poisoned",
        "--if-recorded-by",
        "run-two",
        "--root",
        root,
        "--json"
      ])
      expect(wrong.codes).not.toContain(1)
      expect(db.prepare("SELECT recorded_run_id FROM flows_step_cache WHERE key_digest = ?").get("poisoned"))
        .toMatchObject({ recorded_run_id: "run-one" })
      const shown = await invoke(["cache", "steps", "show", "poisoned", "--root", root, "--json"])
      expect(shown.stdout).toContain("run-one")
      const removed = await invoke([
        "cache",
        "steps",
        "evict",
        "poisoned",
        "--if-recorded-by",
        "run-one",
        "--root",
        root,
        "--json"
      ])
      expect(removed.codes).not.toContain(1)
      expect(db.prepare("SELECT 1 FROM flows_step_cache WHERE key_digest = ?").get("poisoned")).toBeUndefined()
      // A later execution can publish a fresh result under the same digest.
      put.run("poisoned", "{\"value\":2}", "{}", Date.now(), "run-two", 2)
      put.run("stale", "{\"value\":0}", "{}", 1000, "old-run", 3)
      const listed = await invoke(["cache", "steps", "ls", "--root", root, "--json"])
      expect(listed.stdout).toContain("poisoned")
      const sweep = await invoke(["cache", "steps", "sweep", "--older-than", "7d", "--root", root, "--json"])
      expect(sweep.codes).not.toContain(1)
      expect(db.prepare("SELECT 1 FROM flows_step_cache WHERE key_digest = ?").get("stale")).toBeUndefined()
      expect(db.prepare("SELECT recorded_run_id FROM flows_step_cache WHERE key_digest = ?").get("poisoned"))
        .toMatchObject({ recorded_run_id: "run-two" })
    } finally {
      db.close()
    }
  })

  it("keeps help inert across root commands", async () => {
    const root = await fixture()
    for (const command of ["init", "doctor", "serve", "gc", "suggest", "open", "tui", "migrate", "update", "bug"]) {
      const result = await invoke([command, "--root", root, "--help"])
      expect(result.codes, result.stdout + result.stderr).not.toContain(1)
      expect(result.stdout).toContain(command)
    }
    expect(await readdir(root)).toEqual([])
  })

  it("initializes named files and preserves them on a second invocation", async () => {
    const root = await fixture()
    const at = ["--root", root, "--json"]
    const first = await invoke(["init", "sample", ...at])
    expect(first.codes, first.stdout + first.stderr).toEqual([])
    const output = JSON.parse(first.stdout)
    expect(output.created).toContain("WORKSPACE.ts")
    expect(output.flow.name).toBe("sample")
    expect(await readFile(join(root, ".smithers/flows/sample/flow.ts"), "utf8")).toContain("sample")
    const original = await readFile(join(root, "WORKSPACE.ts"), "utf8")
    expect(original).toContain("sample")
    const repeated = await invoke(["init", "sample", ...at])
    expect(JSON.parse(repeated.stdout).retained).toContain("WORKSPACE.ts")
    expect(await readFile(join(root, "WORKSPACE.ts"), "utf8")).toBe(original)
  })

  it("retains the full doctor report on a real blocking backend error", async () => {
    const root = await fixture()
    const result = await invoke(["doctor", "--root", root, "--quiet", "--json"], {
      environment: { SMITHERS_BACKEND: "legacy" }
    })
    expect(result.codes).toContain(1)
    const report = JSON.parse(result.stdout)
    expect(report.root).toBe(root)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ level: "fail", name: expect.stringContaining("backend") })
    )
    expect(await readdir(root)).toEqual([])
  })

  it.each([false, true])("runs garbage collection with its real cutoff and dry-run=%s", async (dryRun) => {
    const root = await fixture()
    const result = await invoke([
      "gc",
      "--root",
      root,
      "--older-than",
      "12h",
      ...(dryRun ? ["--dry-run"] : []),
      "--json"
    ])
    expect(result.codes, result.stdout).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({ olderThan: "12h", dryRun, reports: [], failures: [] })
    expect(await readdir(root)).toEqual([])
  })

  it("reports corrupt storage as a partial sweep with a nonzero exit", async () => {
    const root = await fixture()
    mkdirSync(join(root, ".flows"))
    await writeFile(join(root, ".flows/engine.db"), "not a database")
    const result = await invoke(["gc", "--root", root, "--json"])
    expect(result.codes).toContain(1)
    expect(JSON.parse(result.stdout).failures).toHaveLength(1)
    expect(await readFile(join(root, ".flows/engine.db"), "utf8")).toBe("not a database")
  })

  it("scans a real migration target without initializing execution databases", async () => {
    const root = await fixture()
    const manifest = JSON.stringify({ name: "scan-target", private: true, type: "module" })
    await writeFile(join(root, "package.json"), manifest)
    const result = await invoke([
      "migrate",
      root,
      "--root",
      root,
      "--scan",
      "--allow-no-vcs",
      "--max-repair-rounds",
      "0",
      "--json"
    ])
    expect(result.codes, result.stdout + result.stderr).not.toContain(1)
    expect(JSON.parse(result.stdout)).toHaveProperty("units")
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest)
    expect(await readdir(root)).not.toContain(".flows")
  }, 120_000)

  it("previews the real redacted bug payload on session stderr, including under quiet", async () => {
    const root = await fixture()
    const result = await invoke(["bug", "first", "second", "--dry-run", "--quiet", "--root", root, "--json"], {
      environment: { SMITHERS_BUG_ENDPOINT: "http://127.0.0.1:1/report" }
    })
    expect(result.codes, result.stdout).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      reported: false,
      endpoint: "http://127.0.0.1:1/report",
      payload: { summary: "first second" }
    })
    expect(result.stderr).toContain("http://127.0.0.1:1/report")
    expect(result.stderr).toContain("\"summary\":\"first second\"")
  }, 120_000)

  it.each(["gc", "migrate"])("refuses remote %s without creating local state", async (command) => {
    const root = await fixture()
    const result = await invoke([command, "--root", root, "--remote", "https://fixture.invalid", "--json"])
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("requires the host")
    expect(await readdir(root)).toEqual([])
  })

  it.each(["-1", "65536", "1.5"])("refuses invalid port %s before acquiring a host", async (port) => {
    const root = await fixture()
    const result = await invoke(["serve", "--root", root, `--port=${port}`, "--json"])
    expect(result.codes.some((code) => code !== 0)).toBe(true)
    expect(await readdir(root)).toEqual([])
  })

  it("refuses missing open and suggestion paths before writing", async () => {
    const root = await fixture()
    for (const command of ["open", "suggest"]) {
      const result = await invoke([command, join(root, "missing"), "--json"])
      expect(result.codes).toContain(2)
      expect(result.stdout + result.stderr).toContain(command === "open" ? "does not exist" : "must be a directory")
    }
    expect(await readdir(root)).toEqual([])
  })
})
