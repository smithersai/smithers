import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { sessionDirOf, SettingsNotPrivate, settingsFileOf, withSettings } from "./settings"
import { sessionFiles } from "./target"

const root = mkdtempSync(join(tmpdir(), "e2e-settings-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const write = (text: string, mode = 0o600) => {
  const path = settingsFileOf("https://smithers.example", { E2E_SESSION_DIR: root })
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

describe("a deployment run's settings file", () => {
  it("sits beside the stored session, one per host", () => {
    const env = { E2E_SESSION_DIR: root }
    expect(settingsFileOf("https://smithers.example/app", env)).toBe(join(root, "smithers.example", "e2e.env"))
    expect(sessionFiles("https://smithers.example", env).settings).toBe(settingsFileOf("https://smithers.example", env))
    expect(sessionFiles("https://smithers.example", env).dir).toBe(sessionDirOf("https://smithers.example", env))
    expect(sessionDirOf("https://localhost:1338", {})).toBe(join(homedir(), ".smithers-e2e", "localhost_1338"))
    expect(settingsFileOf("https://smithers.example")).toBe(settingsFileOf("https://smithers.example", process.env))
  })

  it("isolates each run's session and metadata while retaining shared private settings", () => {
    const shared = sessionFiles("https://smithers.example", { E2E_SESSION_DIR: root })
    const a = sessionFiles("https://smithers.example", { E2E_SESSION_DIR: root, E2E_RUN_DIR: join(root, "run-a") })
    const b = sessionFiles("https://smithers.example", { E2E_SESSION_DIR: root, E2E_RUN_DIR: join(root, "run-b") })
    expect(a.settings).toBe(shared.settings)
    expect(b.settings).toBe(shared.settings)
    for (const field of ["session", "identity", "conversation", "repositories"] as const) {
      expect(a[field]).not.toBe(b[field])
      expect(a[field]).not.toBe(shared[field])
      expect(a[field]).toContain(join(root, "run-a"))
    }
  })

  it("adds its variables under the environment, which wins, and names the ones it set", () => {
    const path = write([
      "# scratch repositories",
      "E2E_STACK_REPOSITORY=owner/scratch",
      "E2E_FACTORY_REPOSITORY=owner/scratch",
      'E2E_RUNNER_MIRROR="/home/me/mirror"',
      "E2E_ISSUES_REPOSITORY=owner/from-file",
    ].join("\n"))
    const { env, set } = withSettings({ E2E_ISSUES_REPOSITORY: "owner/from-env", E2E_FACTORY_REPOSITORY: "", PATH: "/bin" }, path)
    expect(env).toEqual({
      E2E_ISSUES_REPOSITORY: "owner/from-env",
      E2E_STACK_REPOSITORY: "owner/scratch",
      E2E_FACTORY_REPOSITORY: "owner/scratch",
      E2E_RUNNER_MIRROR: "/home/me/mirror",
      PATH: "/bin",
    })
    expect(set).toEqual(["E2E_FACTORY_REPOSITORY", "E2E_RUNNER_MIRROR", "E2E_STACK_REPOSITORY"])
  })

  it("adds nothing when there is no file", () => {
    expect(withSettings({ A: "1" }, join(root, "none", "e2e.env"))).toEqual({ env: { A: "1" }, set: [] })
  })

  it("fails on any read error but a missing file", () => {
    expect(() => withSettings({}, root)).toThrow(/EISDIR/)
  })

  it("is refused when others can read it, without reading a value out", () => {
    const path = write("E2E_PERSONAL_MODEL_KEY=secret-value", 0o644)
    expect(() => withSettings({}, path)).toThrow(SettingsNotPrivate)
    expect(() => withSettings({}, path)).not.toThrow(/secret-value/)
  })
})

describe("pnpm e2e:prod", () => {
  it("reads the settings file before it takes the lock, and refuses one others can read", () => {
    write("E2E_STACK_REPOSITORY=owner/scratch", 0o644)
    const prod = join(dirname(fileURLToPath(import.meta.url)), "prod.mjs")
    const run = spawnSync(process.execPath, [prod], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, E2E_PROD_URL: "https://smithers.example", E2E_SESSION_DIR: root },
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain(join(root, "smithers.example", "e2e.env"))
    expect(run.stderr).toContain("chmod 600")
  })
})
