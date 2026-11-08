import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { SHIP_FEATURES, SHIP_TARGETS, shipInventory, shipListingDiagnostics } from "./ship"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const playwright = require.resolve("@playwright/test/cli")
const modulePath = (name: string) => fileURLToPath(new URL(name, import.meta.url))

// Real Playwright, with tests that exercise its modifiers/reporter only: no browser, app, model or network fixture.
describe("ship gate through Playwright", () => {
  it("accepts the complete JSON inventory round trip on both real Playwright projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-roundtrip-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }))
      await symlink(modulePath("../node_modules"), join(dir, "node_modules"), "dir")
      const specs = [...new Set(SHIP_FEATURES.flatMap((feature) => feature.specs))]
      for (const spec of specs) await writeFile(join(dir, spec), `
        import { test, expect } from "@playwright/test"
        test("harness receipt", ({}, info) => { expect(${JSON.stringify(SHIP_TARGETS)}).toContain(info.project.name) })
      `)
      const output = join(dir, "output")
      await writeFile(join(dir, "config.ts"), `
        import ${JSON.stringify(require.resolve("vibelang/register"))}
        export default { testDir: ${JSON.stringify(dir)}, workers: 1, retries: 0,
          outputDir: ${JSON.stringify(output)}, reporter: [[${JSON.stringify(modulePath("./reporter.ts"))}]],
          projects: ${JSON.stringify(SHIP_TARGETS.map((name) => ({ name })))}
        }
      `)
      const env: NodeJS.ProcessEnv = { ...process.env, E2E_SHIP_ACCEPTANCE: "0" }
      delete env.E2E_SHIP_INVENTORY
      const listed = await exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts"), "--list", "--reporter=json"], { env, maxBuffer: 4_000_000 })
        .catch((error: { stderr: string; stdout: string }) => { throw new Error(shipListingDiagnostics(error.stderr, error.stdout, env)) })
      const inventory = shipInventory(JSON.parse(listed.stdout))
      expect(inventory).toHaveLength(specs.length * SHIP_TARGETS.length)
      const path = join(dir, "inventory.json")
      await writeFile(path, JSON.stringify(inventory), { mode: 0o600 })
      await exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts")], {
        env: { ...env, E2E_SHIP_ACCEPTANCE: "1", E2E_SHIP_INVENTORY: path }, maxBuffer: 4_000_000,
      })
      const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8"))
      expect(summary.passed).toBe(true)
      expect(summary.total).toMatchObject({ passed: specs.length * SHIP_TARGETS.length, failed: 0, skipped: 0 })
      expect(summary.acceptance.every((receipt: { executed: number }) => receipt.executed === 1)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("rejects focused tests during inventory collection through the app's actual config", async () => {
    const focus = modulePath(`./ship-focused-${randomUUID()}.spec.ts`)
    try {
      await writeFile(focus, 'import { test } from "./fixtures"\nif (process.env.E2E_SHIP_COLLECT === "1") test.only("ship gate focus", () => {})\n')
      const env: NodeJS.ProcessEnv = {
        ...process.env, E2E_TARGET: "deployment", BASE_URL: "https://ship-harness.invalid",
        E2E_SHIP_ACCEPTANCE: "0", E2E_SHIP_COLLECT: "1",
      }
      delete env.E2E_PERSONAL_MODEL_KEY
      const result = await exec(process.execPath, [playwright, "test", "--config", modulePath("../playwright.config.ts"), "--list", "--reporter=json", "--project=deployment", "--grep", "ship gate focus"], { env, maxBuffer: 4_000_000 })
        .then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string }) => error)
      expect(result.code).toBe(1)
      const report = JSON.parse(result.stdout)
      expect(report.errors.some((error: { message: string }) => error.message.includes("forbidOnly"))).toBe(true)
    } finally {
      await rm(focus, { force: true })
    }
  }, 120_000)

  it("refuses missing credentials before waiting on an existing account lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-preflight-"))
    try {
      const lock = join(dir, "run.lock")
      await mkdir(lock)
      await writeFile(join(lock, "owner"), "this test's existing lock\n")
      const env: NodeJS.ProcessEnv = {
        ...process.env, E2E_PROD_URL: "https://ship-harness.invalid", E2E_SHIP_ACCEPTANCE: "1",
        E2E_SESSION_DIR: dir, E2E_PROD_LOCK: lock, E2E_PERSONAL_MODEL_KEY: "",
      }
      const result = await exec(process.execPath, [modulePath("./prod.mjs")], { env, timeout: 5_000 })
        .then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => error)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("Ship acceptance missing prerequisites:")
      expect(result.stderr).toContain("E2E_PERSONAL_MODEL_KEY")
      expect(result.stderr).not.toContain("Waiting for the production e2e lock")
      expect(await readFile(join(lock, "owner"), "utf8")).toBe("this test's existing lock\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps declared developer skips and fails unmet ship needs in bodies and scope modifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-harness-"))
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }))
      await symlink(modulePath("../node_modules"), join(dir, "node_modules"), "dir")
      await writeFile(join(dir, "agent.spec.ts"), `
        import { test } from "@playwright/test"
        import { requires } from ${JSON.stringify(modulePath("./target.ts"))}
        test.describe("scope", () => {
          requires("personalModel")
          test("missing at declaration", () => {})
        })
        test("missing in body", () => { requires("personalModel") })
        test("available in body", () => { requires("outsideRoles") })
      `)
      const results = join(dir, "results.json")
      const inventoryFile = join(dir, "inventory.json")
      await writeFile(join(dir, "config.ts"), `
        import ${JSON.stringify(require.resolve("vibelang/register"))}
        export default {
        testDir: ${JSON.stringify(dir)}, workers: 1, retries: 0,
        outputDir: ${JSON.stringify(join(dir, "output"))},
        reporter: [["json", { outputFile: ${JSON.stringify(results)} }], [${JSON.stringify(modulePath("./reporter.ts"))}]],
        projects: [{ name: "deployment" }]
      }`)
      const run = async (acceptance: string, list = false) => {
        const env: NodeJS.ProcessEnv = { ...process.env, E2E_TARGET: "deployment", BASE_URL: "https://ship-harness.invalid", E2E_SHIP_ACCEPTANCE: acceptance, E2E_SHIP_INVENTORY: inventoryFile }
        delete env.E2E_PERSONAL_MODEL_KEY
        return exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts"), ...(list ? ["--list"] : [])], { env, maxBuffer: 2_000_000 })
          .then(({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }), async (error: { code: number; stdout: string; stderr: string }) => ({
            code: error.code,
            output: shipListingDiagnostics(error.stderr, error.stdout, env) + shipListingDiagnostics("", await readFile(results, "utf8").catch(() => ""), env),
          }))
      }
      const collected = await run("0", true)
      expect(collected.code, collected.output).toBe(0)
      const inventory = shipInventory(JSON.parse(await readFile(results, "utf8")))
      expect(inventory).toHaveLength(3)
      await writeFile(inventoryFile, JSON.stringify(inventory))
      const ordinary = await run("0")
      expect(ordinary.code, ordinary.output).toBe(0)
      const developer = JSON.parse(await readFile(join(dir, "output", "summary.json"), "utf8"))
      expect(developer.total).toMatchObject({ passed: 1, skipped: 2, failed: 0 })
      expect(developer.passed).toBe(true)
      const ship = await run("1")
      expect(ship.code, ship.output).toBe(1)
      const acceptance = JSON.parse(await readFile(join(dir, "output", "summary.json"), "utf8"))
      expect(acceptance.total).toMatchObject({ passed: 1, failed: 2 })
      expect(acceptance.passed).toBe(false)
      expect(acceptance.failing.some((line: string) => line.includes("available in body: collected journey"))).toBe(false)
      expect(acceptance.acceptance.some((receipt: { spec: string; project: string; executed: number }) =>
        receipt.spec === "agent.spec.ts" && receipt.project === "deployment" && receipt.executed === 1)).toBe(true)
      const report = await readFile(results, "utf8")
      expect(report).toContain("Ship acceptance requires personalModel")
      const shipList = await run("1", true)
      expect(shipList.code, shipList.output).toBe(1)
      const listed = JSON.parse(await readFile(join(dir, "output", "summary.json"), "utf8"))
      expect(listed.passed).toBe(false)
      expect(listed.acceptance.every((receipt: { executed: number }) => receipt.executed === 0)).toBe(true)
      const ordinaryList = await run("0", true)
      expect(ordinaryList.code, ordinaryList.output).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("reports the real personal-model setup skipped when no key is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-setup-"))
    try {
      const results = join(dir, "results.json")
      await writeFile(join(dir, "config.ts"), `
        import ${JSON.stringify(require.resolve("vibelang/register"))}
        export default {
          testDir: ${JSON.stringify(modulePath("./deployment"))},
          testMatch: "sign-in.setup.ts", grep: /personal model:/, workers: 1,
          outputDir: ${JSON.stringify(join(dir, "output"))},
          reporter: [["json", { outputFile: ${JSON.stringify(results)} }], [${JSON.stringify(modulePath("./reporter.ts"))}]]
        }
      `)
      const env: NodeJS.ProcessEnv = { ...process.env, E2E_TARGET: "deployment", BASE_URL: "https://ship-harness.invalid", E2E_SHIP_ACCEPTANCE: "0" }
      delete env.E2E_PERSONAL_MODEL_KEY
      await exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts")], { env, maxBuffer: 2_000_000 })
      const summary = JSON.parse(await readFile(join(dir, "output", "summary.json"), "utf8"))
      expect(summary.passed).toBe(true)
      expect(summary.total).toMatchObject({ passed: 0, skipped: 1 })
      expect(summary.reasons[0].reason).toContain("needs personalModelKey:")
      const report = JSON.parse(await readFile(results, "utf8"))
      expect(report.stats).toMatchObject({ expected: 0, skipped: 1, unexpected: 0 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("fails explicitly when a summary artifact cannot be written, even though Playwright's tests passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-artifact-"))
    try {
      const output = join(dir, "output")
      await writeFile(join(dir, "artifact.spec.ts"), `
        import { test } from ${JSON.stringify(require.resolve("@playwright/test"))}
        import { mkdirSync } from "node:fs"
        test("artifact storage fails", () => { mkdirSync(${JSON.stringify(join(output, "summary.json"))}, { recursive: true }) })
      `)
      await writeFile(join(dir, "config.ts"), `export default {
        testDir: ${JSON.stringify(dir)}, workers: 1, outputDir: ${JSON.stringify(output)},
        reporter: [[${JSON.stringify(modulePath("./reporter.ts"))}]]
      }`)
      const env: NodeJS.ProcessEnv = { ...process.env, E2E_SHIP_ACCEPTANCE: "1" }
      delete env.E2E_SHIP_INVENTORY
      const result = await exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts")], { env, maxBuffer: 2_000_000 })
        .then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => error)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("E2E summary failed at persist (EISDIR); run failed")
      const missing: NodeJS.ProcessEnv = { ...env, E2E_SHIP_INVENTORY: join(dir, "missing-inventory.json") }
      const unreadable = await exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts")], { env: missing, maxBuffer: 2_000_000 })
        .then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => error)
      expect(unreadable.code).toBe(1)
      expect(unreadable.stderr).toContain("E2E summary failed at inventory (ENOENT); run failed")
      await writeFile(missing.E2E_SHIP_INVENTORY!, "private-invalid-json")
      const invalid = await exec(process.execPath, [playwright, "test", "--config", join(dir, "config.ts")], { env: missing, maxBuffer: 2_000_000 })
        .then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => error)
      expect(invalid.code).toBe(1)
      expect(invalid.stderr).toContain("E2E summary failed at inventory (summary_error); run failed")
      expect(invalid.stderr).not.toContain("private-invalid-json")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
