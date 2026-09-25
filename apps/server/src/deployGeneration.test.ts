import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { classifyLocal } from "../scripts/deployGuard"
import { WORKER_IDENTITY } from "./workerIdentity"
import { parseWranglerConfig, readWranglerConfig } from "./wranglerConfig"

/*
 * Main deploys one generation. Until docs/shared-edge-cutover.md records the
 * activation, the live Worker is the legacy `index.js`, and the deploy guard
 * refuses an edge checkout over it (DEPLOY_GUARD_EDGE_BEFORE_CUTOVER). 5d776f34b
 * landed the edge as wrangler.jsonc early and every deploy after it refused.
 * The edge candidate lives in wrangler.edge.jsonc until activation.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const cutoverHeld = read("../docs/shared-edge-cutover.md").split("\n")[0]!.includes("not activated")
const deployed = readWranglerConfig()
const candidate = parseWranglerConfig(read("../wrangler.edge.jsonc"))

describe("the deployed generation", () => {
  test("while the cutover is held, main's deploy config classifies as the legacy Worker", () => {
    expect(cutoverHeld).toBe(true)
    expect(classifyLocal(deployed.main, WORKER_IDENTITY.entry)).toBe("legacy")
  })

  test("while the cutover is held, no hosted document selects the shared backend", () => {
    for (const layout of ["Base", "AppShell"]) {
      expect(read(`../../site/src/layouts/${layout}.astro`)).not.toContain("smithers-application-target")
    }
  })

  test("the edge candidate is the shared edge and differs from the deployed config only in entry and vars", () => {
    expect(classifyLocal(candidate.main, "src/edge.ts")).toBe("edge")
    const frozen = ({ main: _main, vars: _vars, ...rest }: typeof deployed) => rest
    expect(frozen(candidate)).toEqual(frozen(deployed))
    expect(candidate.vars).toEqual({ SMITHERS_BACKEND_ORIGIN: "https://api.jjhub.tech" })
  })
})
