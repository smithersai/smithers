import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  MATRIX_OBLIGATIONS,
  MATRIX_SCENARIO_IDS,
  MODE_DESCRIPTORS,
  missingModeReadiness,
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
const receipt = (mode: "native-own" | "native-plue", startedRoles: readonly ProcessRole[]) => ({
  mode,
  revision,
  origin: "https://example.test",
  ready: true,
  startedRoles,
  freshLaunch: true,
  restarted: mode === "native-own",
  dataPreserved: mode === "native-own",
  observedAt: "2026-09-21T00:00:00.000Z"
})

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("deployment mode matrix", () => {
  test("enumerates six modes over one obligation catalog", () => {
    expect(Object.keys(MODE_DESCRIPTORS)).toEqual([...DEPLOYMENT_MODES])
    expect(MATRIX_OBLIGATIONS.length).toBeGreaterThan(10)
    expect(new Set(MATRIX_OBLIGATIONS.map(({ id }) => id)).size).toBe(MATRIX_OBLIGATIONS.length)
  })

  test("every implemented matrix scenario resolves to the canonical real suite", () => {
    const report = checkRealE2E({
      realDir: resolve(import.meta.dir, ".."),
      flowNameFile: resolve(import.meta.dir, "../../../src/mainview/flows/FlowName.ts")
    })
    const declared = new Set(report.scenarios.map(({ id }) => id))
    expect(MATRIX_SCENARIO_IDS.filter((id) => !declared.has(id))).toEqual([])
    expect(MATRIX_OBLIGATIONS.filter(({ scenarios }) => scenarios.length === 0).map(({ id }) => id)).toEqual([
      "repository-create", "github-import", "approval-decision", "review"
    ])
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

  test("reports missing scenarios and missing executions as unavailable, never passed", () => {
    const readiness = { ...missingModeReadiness("web-selfhost", "not launched"), origin: "https://example.test" }
    const rows = scenarioReceipts(readiness, revision, [])
    expect(rows.every(({ status }) => status === "unavailable")).toBe(true)
    expect(rows.find(({ obligation }) => obligation === "approval-decision")?.reason).toBe("no real product scenario is implemented")
    expect(rows.find(({ obligation }) => obligation === "chat")?.reason).toBe("not launched")
  })

  test("a failed attempt prevents a later pass from satisfying an obligation", () => {
    const readiness = { mode: "web-plue" as const, status: "passed" as const, tier: "plue-production" as const, origin: "https://example.test", capabilities: ["agent"], reasons: [] }
    const base = { scenarioId: "chat.stream-grounded", host: "production" as const, mode: "web-plue" as const, revision, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }
    const rows = scenarioReceipts(readiness, revision, [{ ...base, status: "failed" as const }, { ...base, status: "passed" as const }])
    expect(rows.find(({ scenarioId }) => scenarioId === "chat.stream-grounded")?.status).toBe("failed")
  })

  test("readiness joins a real execution receipt with health and advertised capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-own", ["native-ui", "supervisor", "app", "postgres"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-own", origin: "https://example.test", auth: { kind: "browser-profile", environment: "OWNER" }, executionReceipt: path
    }] }).modes[0]!
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      return url.pathname === "/api/health"
        ? new Response("ok")
        : Response.json({
          apiVersion: 1,
          host: "local",
          version: "test",
          buildSha: revision,
          capabilities: ["agent", "browser.read", "identity", "cloud", "cloud.terminal"],
          authFlow: "both",
          sandbox: null
        })
    }) as typeof fetch
    expect((await probeMode(config, revision, { OWNER: "configured" }, fetcher)).status).toBe("passed")
  })

  test("an owner session cannot claim readiness before the real fixture can inject it", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-own", ["native-ui", "supervisor", "app", "postgres"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-own", origin: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: path
    }] }).modes[0]!
    const fetcher = (async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: revision,
      capabilities: [], authFlow: "none", sandbox: null
    })) as typeof fetch
    const result = await probeMode(config, revision, { OWNER: "configured" }, fetcher)
    expect(result.status).toBe("unavailable")
    expect(result.reasons).toContain("owner-session injection is not implemented by the real product fixture")
  })

  test("rejects invented launcher roles", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify({ ...receipt("native-own", ["native-ui", "supervisor", "app", "postgres"]), startedRoles: ["native-ui", "magic"] }))
    expect(() => readExecutionReceipt(path)).toThrow("malformed execution receipt")
  })
})
