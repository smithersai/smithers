import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

describe("pnpm e2e:prod's lock", () => {
  it("is held while Playwright runs and released before the recordings are made", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-prod-lock-"))
    try {
      const lock = join(dir, "run.lock")
      const seen = join(dir, "seen.log")
      // Stand-ins for Playwright (pnpm on PATH) and for e2e/gifs.mjs, run from the working directory: each notes the lock.
      const bin = join(dir, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "pnpm"), `#!/bin/sh\n[ -d "${lock}" ] && echo "tests: held" >> "${seen}" || echo "tests: free" >> "${seen}"\n`)
      chmodSync(join(bin, "pnpm"), 0o755)
      mkdirSync(join(dir, "e2e"))
      writeFileSync(
        join(dir, "e2e", "gifs.mjs"),
        `import { appendFileSync, existsSync } from "node:fs"\nappendFileSync(${JSON.stringify(seen)}, existsSync(${JSON.stringify(lock)}) ? "recordings: held\\n" : "recordings: free\\n")\n`,
      )
      const prod = join(dirname(fileURLToPath(import.meta.url)), "prod.mjs")
      const run = spawnSync(process.execPath, [prod], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, E2E_PROD_URL: "https://smithers.example", E2E_SESSION_DIR: dir, E2E_PROD_LOCK: lock },
      })
      expect(run.status).toBe(0)
      expect(readFileSync(seen, "utf8")).toBe("tests: held\nrecordings: free\n")
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
