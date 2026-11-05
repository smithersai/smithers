import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { targetsInstall } from "../src/internal/backend/Destination.ts"

const home = mkdtempSync(join(tmpdir(), "smithers-control-triage-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const environment = { HOME: home, XDG_CONFIG_HOME: home }

describe("#4309 credential-only destination routing", () => {
  it.each([
    { SMITHERS_TOKEN_FILE: join(home, "absent-token") },
    { SMITHERS_TOKEN: "routing-test-token" },
    { SMITHERS_TOKEN_FILE: join(home, "absent-token"), SMITHERS_TOKEN: "routing-test-token" }
  ])("keeps local list and run inspection local with %j", (credential) => {
    const runtime = { environment: { ...environment, ...credential } }
    expect(targetsInstall({ args: {}, options: {} }, runtime)).toBe(false)
    expect(targetsInstall({ args: { run: "run-1" }, options: {} }, runtime)).toBe(false)
  })

  it("uses a configured origin and preserves explicit routing precedence", () => {
    const runtime = { environment: { ...environment, SMITHERS_URL: "https://smithers.example" } }
    expect(targetsInstall({ args: {}, options: {} }, runtime)).toBe(true)
    expect(targetsInstall({ args: { run: "run-1" }, options: {} }, runtime)).toBe(false)
    expect(targetsInstall({ args: {}, options: { root: home, cloud: true } }, runtime)).toBe(false)
    expect(targetsInstall({ args: {}, options: { repo: "owner/repo" } }, { environment })).toBe(true)
    expect(targetsInstall({ args: {}, options: { cloud: true } }, { environment })).toBe(true)
  })

  it("routes a saved install without requiring credentials", () => {
    const saved = join(home, "saved")
    mkdirSync(join(saved, "smithers"), { recursive: true })
    writeFileSync(join(saved, "smithers", "config.toon"), "api_origin: https://smithers.example\n")
    expect(targetsInstall({ args: {}, options: {} }, {
      environment: { ...environment, XDG_CONFIG_HOME: saved }
    })).toBe(true)
  })
})
