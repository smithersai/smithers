import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Session } from "../src/internal/backend/Session.ts"

const root = mkdtempSync(join(tmpdir(), "smithers-credential-isolation-"))
const originalHome = process.env.HOME
const environment: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_RUNTIME_DIR: root,
  SMITHERS_API_ORIGIN: "https://api.credential-isolation.test"
}
const origin = environment.SMITHERS_API_ORIGIN!
let busPid: number | undefined
let keyringPid: number | undefined
beforeAll(() => {
  process.env.HOME = root
  if (process.platform === "linux") {
    const [address, pid] = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], {
      encoding: "utf8",
      env: environment
    }).trim().split("\n")
    busPid = Number(pid)
    environment.DBUS_SESSION_BUS_ADDRESS = address
    const output = execFileSync("gnome-keyring-daemon", ["--unlock", "--components=secrets"], {
      input: "fixture-password",
      encoding: "utf8",
      env: environment
    })
    for (const line of output.trim().split("\n")) {
      const split = line.indexOf("=")
      if (split > 0) environment[line.slice(0, split)] = line.slice(split + 1)
    }
    if (environment.GNOME_KEYRING_PID) keyringPid = Number(environment.GNOME_KEYRING_PID)
  }
})
afterAll(() => {
  if (keyringPid) process.kill(keyringPid, "SIGTERM")
  if (busPid) process.kill(busPid, "SIGTERM")
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
})
const session = (file: string, extra: Record<string, string> = {}) =>
  new Session({
    ...environment,
    SMITHERS_AUTH_FILE: join(root, file),
    ...extra
  })

describe("credential-store isolation (#4223)", () => {
  it("keeps simultaneous logins to one origin independent through reload and logout", async () => {
    const a = new Session(environment), b = session("bob.json")
    await Promise.all([a.save(origin, "synthetic-alice-token"), b.save(origin, "synthetic-bob-token")])
    expect((await new Session(environment).require()).token === "synthetic-alice-token").toBe(true)
    expect((await session("bob.json").require()).token === "synthetic-bob-token").toBe(true)
    expect(readFileSync(a.authPath, "utf8")).not.toContain("synthetic-alice-token")
    expect(readFileSync(b.authPath, "utf8")).not.toContain("synthetic-bob-token")
    await a.clear()
    expect(await a.resolve()).toBeUndefined()
    expect((await b.require()).token === "synthetic-bob-token").toBe(true)
    await b.clear()
  })

  it("uses one canonical identity for relative paths and symlinked parents", async () => {
    const directory = join(root, "canonical")
    mkdirSync(directory)
    symlinkSync(directory, join(root, "alias"), "dir")
    const a = session("canonical/auth.json")
    const b = session("unused", { SMITHERS_AUTH_FILE: relative(process.cwd(), join(root, "alias/auth.json")) })
    await a.save(origin, "synthetic-canonical-token")
    expect((await b.require()).token === "synthetic-canonical-token").toBe(true)
    await b.clear()
    expect(await a.resolve()).toBeUndefined()
  })

  it("separates the full API origin even when hostnames match", async () => {
    const a = session("ports.json")
    await a.keyring("set", "https://api.credential-isolation.test:8443", "synthetic-first-port")
    await a.keyring("set", "https://api.credential-isolation.test:9443", "synthetic-second-port")
    expect(await a.keyring("get", "https://api.credential-isolation.test:8443") === "synthetic-first-port").toBe(true)
    expect(await a.keyring("get", "https://api.credential-isolation.test:9443") === "synthetic-second-port").toBe(true)
    await a.keyring("delete", "https://api.credential-isolation.test:8443")
    await a.keyring("delete", "https://api.credential-isolation.test:9443")
  })
})

const legacy = (action: "set" | "get" | "delete", host: string, token?: string): string => {
  if (process.platform === "linux") {
    const args = [
      action === "set" ? "store" : action === "get" ? "lookup" : "clear",
      ...(action === "set" ? ["--label=Smithers CLI isolation test"] : []),
      "service",
      "smithers-cli",
      "host",
      host
    ]
    try {
      return execFileSync("secret-tool", args, { input: token, env: environment, encoding: "utf8" }).trim()
    } catch (error) {
      if (action !== "set" && (error as { status?: number }).status === 1) return ""
      throw error
    }
  }
  const args = [
    action === "set" ? "add-generic-password" : action === "get" ? "find-generic-password" : "delete-generic-password",
    "-s",
    "smithers-cli",
    "-a",
    host,
    ...(action === "get" ? ["-w"] : [])
  ]
  if (action === "set") {
    // Synthetic test data alone. The production writer uses stdin.
    args.push("-U", "-w", token!)
  }
  try {
    return execFileSync("security", args, { env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .trim()
  } catch (error) {
    if (action !== "set" && (error as { status?: number }).status === 44) return ""
    throw error
  }
}

describe("legacy credential migration (#4223)", () => {
  it("an alternate process HOME cannot claim or delete a legacy credential", async () => {
    const host = "credential-isolation.test"
    legacy("set", host, "synthetic-legacy-token")
    // beforeAll sets the real process HOME too, as a CLI launched with HOME=...
    // does. os.homedir() alone would incorrectly trust this store.
    const alternate = new Session(environment)
    alternate.write(alternate.authPath, JSON.stringify({ api_url: origin, host }))
    expect(await alternate.resolve()).toBeUndefined()
    const custom = session("legacy-custom.json")
    custom.write(custom.authPath, JSON.stringify({ api_url: origin, host }))
    expect(await custom.resolve()).toBeUndefined()
    await alternate.clear()
    await custom.clear()
    expect(legacy("get", host) === "synthetic-legacy-token").toBe(true)
    await alternate.save(origin, "synthetic-new-token")
    expect((await alternate.require()).token === "synthetic-new-token").toBe(true)
    expect(JSON.parse(readFileSync(alternate.authPath, "utf8")).credential_store).toBe("v2")
    await alternate.clear()
    expect(await alternate.resolve()).toBeUndefined()
    expect(legacy("get", host) === "synthetic-legacy-token").toBe(true)
    legacy("delete", host)
  })

  it("keeps a file-backed login authoritative over an older native credential", async () => {
    const current = session("file-priority.json")
    await current.save(origin, "synthetic-old-native-token")
    current.write(current.authPath, JSON.stringify({ api_url: origin, token: "synthetic-file-token" }))
    expect((await current.require()).token === "synthetic-file-token").toBe(true)
    await current.clear()
  })

  it("does not share lookup identities between empty stores", () => {
    const a = session("empty-a.json"), b = session("empty-b.json")
    expect(a.credentialIdentity(origin)).not.toBe(b.credentialIdentity(origin))
  })
})
