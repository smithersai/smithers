import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  MANDATORY_DETERMINISTIC_BUN_TESTS,
  MANDATORY_DETERMINISTIC_BROWSER_SPECS,
  MATRIX_OBLIGATIONS,
  MATRIX_SCENARIO_IDS,
  applicableScenarioIds,
  MODE_DESCRIPTORS,
  missingModeReadiness,
  matrixPasses,
  parseMatrixConfig,
  probeMode,
  readExecutionReceipt,
  scenarioReceipts,
  validateExecutionReceipt
} from "./matrix"
import { checkRealE2E } from "./gate"
import { DEPLOYMENT_MODES } from "./types"
import type { ProcessRole } from "./matrix"

const roots: string[] = []
const revision = "a".repeat(40)
const receipt = (mode: "local-own" | "local-plue" | "native-own" | "native-plue", startedRoles: readonly ProcessRole[]) => ({
  mode,
  revision,
  origin: "https://example.test",
  ready: true,
  startedRoles,
  freshLaunch: true,
  restarted: mode.endsWith("-own"),
  dataPreserved: mode.endsWith("-own"),
  ...(mode.endsWith("-own") ? {
    persistenceProof: {
      database: { before: "database-marker", after: "database-marker" },
      dataVolume: { before: "volume-marker", after: "volume-marker" }
    }
  } : {}),
  observedAt: "2026-09-21T00:00:00.000Z"
})

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("deployment mode matrix", () => {
  test("enumerates six modes over one obligation catalog", () => {
    expect(Object.keys(MODE_DESCRIPTORS)).toEqual([...DEPLOYMENT_MODES])
    expect(MATRIX_OBLIGATIONS.length).toBeGreaterThan(10)
    expect(new Set(MATRIX_OBLIGATIONS.map(({ id }) => id)).size).toBe(MATRIX_OBLIGATIONS.length)
    expect(DEPLOYMENT_MODES.map((mode) => [mode, MODE_DESCRIPTORS[mode].legacyHost])).toEqual([
      ["web-selfhost", "local"], ["web-plue", "production"],
      ["local-own", "local"], ["local-plue", "production"],
      ["native-own", "local"], ["native-plue", "production"]
    ])
  })

  test("every implemented matrix scenario resolves to the canonical real suite", () => {
    const report = checkRealE2E({
      realDir: resolve(import.meta.dir, ".."),
      flowNameFile: resolve(import.meta.dir, "../../../src/mainview/flows/FlowName.ts")
    })
    const declared = new Set(report.scenarios.map(({ id }) => id))
    expect(MATRIX_SCENARIO_IDS.filter((id) => !declared.has(id))).toEqual([])
    expect(MATRIX_OBLIGATIONS.filter(({ scenarios }) => scenarios.length === 0).map(({ id }) => id)).toEqual([])
  })

  test("GitHub import runs only when the host advertises its configured integration", () => {
    const owned = applicableScenarioIds(["identity", "agent", "model.turn", "cloud", "cloud.terminal"])
    expect(owned).toContain("repositories.local-git-push-file-readback")
    expect(owned).not.toContain("repositories.github-import-direct-readback")
    expect(applicableScenarioIds(["identity", "github"])).toContain("repositories.github-import-direct-readback")
  })

  test("parses credential-free origins and secret references without requiring every mode", () => {
    expect(parseMatrixConfig({
      revision,
      modes: [{
        mode: "native-own",
        origin: "https://example.test",
        auth: { kind: "owner-session", environment: "SMITHERS_OWNER_SESSION" },
        executionReceipt: "/tmp/native-own.json"
      }]
    }).modes[0]).toEqual({
      mode: "native-own",
      origin: "https://example.test",
      auth: { kind: "owner-session", environment: "SMITHERS_OWNER_SESSION" },
      executionReceipt: "/tmp/native-own.json"
    })
    expect(() => parseMatrixConfig({ revision, modes: [{
      mode: "web-plue", origin: "https://secret@example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: "x"
    }] })).toThrow("credential-free")
  })

  test("requires native own supervision and proves remote native starts neither backend nor postgres", () => {
    const ownConfig = parseMatrixConfig({ revision, modes: [{
      mode: "native-own", origin: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: "x"
    }] }).modes[0]!
    expect(validateExecutionReceipt(ownConfig, revision, receipt("native-own", ["native-ui", "app", "postgres"]))).toContain("launcher did not prove supervisor started")
    expect(validateExecutionReceipt(ownConfig, revision, receipt("native-own", ["native-ui", "supervisor", "app", "postgres"]))).toEqual([])

    const remoteConfig = parseMatrixConfig({ revision, modes: [{
      mode: "native-plue", origin: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: "x"
    }] }).modes[0]!
    expect(validateExecutionReceipt(remoteConfig, revision, receipt("native-plue", ["native-ui", "app"]))).toContain("remote mode unexpectedly started app")
    expect(validateExecutionReceipt(remoteConfig, revision, receipt("native-plue", ["native-ui"]))).toEqual([])
  })

  test("reports unlaunched own modes as failed, never passed", () => {
    const readiness = { ...missingModeReadiness("web-selfhost", "not launched"), origin: "https://example.test" }
    const rows = scenarioReceipts(readiness, revision, [])
    expect(rows.every(({ status }) => status === "failed")).toBe(true)
    expect(rows.find(({ obligation }) => obligation === "flow")?.reason).toBe("not launched")
    expect(rows.find(({ obligation }) => obligation === "chat")?.reason).toBe("not launched")
  })

  test("a failed attempt prevents a later pass from satisfying an obligation", () => {
    const readiness = { mode: "web-plue" as const, status: "passed" as const, tier: "plue-production" as const, origin: "https://example.test", capabilities: ["identity", "model.turn"], reasons: [] }
    const base = { scenarioId: "chat.owner-credential-ui", host: "production" as const, mode: "web-plue" as const, revision, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }
    const rows = scenarioReceipts(readiness, revision, [{ ...base, status: "failed" as const }, { ...base, status: "passed" as const }])
    expect(rows.find(({ scenarioId }) => scenarioId === "chat.owner-credential-ui")?.status).toBe("failed")
  })

  test("readiness joins a real execution receipt with health and advertised capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-plue", ["local-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-plue", origin: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path
    }] }).modes[0]!
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      return url.pathname === "/api/health"
        ? new Response("ok")
        : Response.json({
          apiVersion: 1,
          host: "cloud",
          version: "test",
          buildSha: revision,
          capabilities: ["agent", "model.turn", "browser.read", "identity", "cloud", "cloud.terminal"],
          authFlow: "both",
          sandbox: null
        })
    })
    expect((await probeMode(config, revision, { PROFILE: "configured" }, fetcher)).status).toBe("passed")
  })

  test("readiness rejects a bootstrap from the wrong provider or revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-plue", ["local-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-plue", origin: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: "b".repeat(40),
      capabilities: [], authFlow: "redirect", sandbox: null
    }))
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("bootstrap host local does not match local-plue provider plue")
    expect(result.reasons).toContain(`bootstrap revision ${"b".repeat(40)} does not match ${revision}`)
  })

  test("an owner session cannot enter readiness without an owner-credentials bootstrap contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-own", ["local-ui", "app", "postgres"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-own", origin: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: path
    }] }).modes[0]!
    const fetcher = (async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: revision,
      capabilities: [], authFlow: "none", sandbox: null
    }))
    const result = await probeMode(config, revision, { OWNER: "configured" }, fetcher)
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("bootstrap authFlow none does not advertise owner credentials")
  })

  test("native readiness remains unavailable without a packaged native driver envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-own", ["native-ui", "supervisor", "app", "postgres"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-own", origin: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: path
    }] }).modes[0]!
    const result = await probeMode(config, revision, { OWNER: "configured" }, async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: revision,
      capabilities: [], authFlow: "none", sandbox: null
    }))
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("native mode has no packaged Electrobun CDP driver configuration")
  })

  test("native readiness accepts only an explicit available driver reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-plue", ["native-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-plue",
      origin: "https://example.test",
      auth: { kind: "application-token", environment: "PLUE_TOKEN" },
      executionReceipt: path,
      surfaceDriver: { kind: "electrobun-cdp", environment: "NATIVE_PLUE_DRIVER" }
    }] }).modes[0]!
    const fetcher = async (input: string | URL | Request) => new URL(String(input)).pathname === "/api/health"
      ? new Response("ok")
      : Response.json({
        apiVersion: 1, host: "cloud", version: "test", buildSha: revision,
        capabilities: ["identity", "agent", "model.turn", "cloud", "cloud.terminal"], authFlow: "both", sandbox: null
      })
    expect((await probeMode(config, revision, { PLUE_TOKEN: "configured" }, fetcher)).reasons)
      .toContain("native driver environment NATIVE_PLUE_DRIVER is unavailable")
    expect((await probeMode(config, revision, {
      PLUE_TOKEN: "configured", NATIVE_PLUE_DRIVER: "configured"
    }, fetcher)).status).toBe("passed")
  })

  test("native auth follows the package handshake instead of a browser-profile substitute", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-plue", ["native-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-plue",
      origin: "https://example.test",
      auth: { kind: "browser-profile", environment: "PROFILE" },
      executionReceipt: path,
      surfaceDriver: { kind: "electrobun-cdp", environment: "NATIVE_DRIVER" }
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "x", NATIVE_DRIVER: "x" }, async (input) =>
      new URL(String(input)).pathname === "/api/health" ? new Response("ok") : Response.json({
        apiVersion: 1, host: "cloud", version: "test", buildSha: revision,
        capabilities: [], authFlow: "both", sandbox: null
      }))
    expect(result.reasons).toContain("native-plue requires the packaged application-token flow")
  })

  test("rejects invented launcher roles", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify({ ...receipt("native-own", ["native-ui", "supervisor", "app", "postgres"]), startedRoles: ["native-ui", "magic"] }))
    expect(() => readExecutionReceipt(path)).toThrow("malformed execution receipt")
  })

  test("missing a required capability fails a configured mode and filters its scenarios", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-plue", ["local-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-plue", origin: "https://example.test",
      auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, async (input) =>
      new URL(String(input)).pathname === "/api/health" ? new Response("ok") : Response.json({
        apiVersion: 1, host: "cloud", version: "test", buildSha: revision,
        capabilities: ["identity", "agent", "model.turn", "cloud"], authFlow: "redirect", sandbox: null
      }))
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("bootstrap does not advertise required cloud.terminal")
    expect(applicableScenarioIds(result.capabilities)).not.toContain("workspaces.cloud-terminal-keyboard-output")
    const readiness = DEPLOYMENT_MODES.map((mode) => mode === "local-plue" ? result :
      mode.endsWith("-plue") ? missingModeReadiness(mode, "not configured") :
      { ...missingModeReadiness(mode, "not launched"), status: "passed" as const })
    expect(matrixPasses(readiness, [], true, true)).toBe(false)
  })

  test("unconfigured Plue modes remain distinct from a passing owned gate", () => {
    const readiness = DEPLOYMENT_MODES.map((mode) => mode.endsWith("-plue")
      ? missingModeReadiness(mode, "not configured")
      : { ...missingModeReadiness(mode, "ready"), status: "passed" as const })
    expect(readiness.filter(({ status }) => status === "not-configured")).toHaveLength(3)
    const rows = readiness.flatMap((state) => scenarioReceipts(state, revision, []).map((row) => ({
      ...row, status: state.status === "not-configured" ? "not-configured" as const : "passed" as const
    })))
    expect(matrixPasses(readiness, rows, true, false)).toBe(true)
    expect(matrixPasses(readiness, rows, true, true)).toBe(false)
    expect(matrixPasses(readiness, rows.slice(1), true, false)).toBe(false)
  })

  test("runner partitions cover only their declared modes while the default still requires all six", () => {
    const ubuntu = ["web-selfhost", "web-plue", "local-own", "local-plue"] as const
    const mac = ["native-own", "native-plue"] as const
    expect(new Set([...ubuntu, ...mac])).toEqual(new Set(DEPLOYMENT_MODES))
    const readiness = ubuntu.map((mode) => mode.endsWith("-plue")
      ? missingModeReadiness(mode, "not configured")
      : { ...missingModeReadiness(mode, "ready"), status: "passed" as const })
    const rows = readiness.flatMap((state) => scenarioReceipts(state, revision, []).map((row) => ({
      ...row, status: state.status === "not-configured" ? "not-configured" as const : "passed" as const
    })))
    expect(matrixPasses(readiness, rows, true, false, ubuntu)).toBe(true)
    expect(matrixPasses(readiness, rows, true, false)).toBe(false)
    expect(matrixPasses(readiness, rows, true, false, ["web-selfhost", "web-selfhost"])).toBe(false)
  })
})


test("every mandatory deterministic suite names an executable file", () => {
  for (const file of [...MANDATORY_DETERMINISTIC_BUN_TESTS, ...MANDATORY_DETERMINISTIC_BROWSER_SPECS]) {
    expect(existsSync(resolve(import.meta.dirname, "../../..", file)), file).toBe(true)
  }
})
