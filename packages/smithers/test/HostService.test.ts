import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createServer, type RequestListener } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Host from "../src/internal/backend/HostService.ts"

const hostExpectations = JSON.parse(readFileSync(new URL("./fixtures/host-service-r4.json", import.meta.url), "utf8"))
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-host-")))
  roots.push(root)
  const bundle = join(root, "bundle & <dir>")
  mkdirSync(join(bundle, "bin"), { recursive: true })
  const files = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"].map((path) => {
    // Unit-only bytes, never used as a launcher or a repository process.
    writeFileSync(join(bundle, path), path, { mode: 0o755 })
    return { path, sha256: createHash("sha256").update(path).digest("hex"), stage: "fixture", mode: 0o755 }
  })
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files })
  )
  let running = false
  const calls: string[][] = []
  const system = {
    agentsDir: join(root, "LaunchAgents"),
    domain: "gui/501",
    launchctl: (args: ReadonlyArray<string>) => {
      calls.push([...args])
      if (args[0] === "print") return { status: running ? 0 : 113, stdout: "", stderr: "" }
      if (args[0] === "bootstrap") running = true
      if (args[0] === "bootout") running = false
      return { status: 0, stdout: "", stderr: "" }
    }
  } satisfies Host.Launchd
  return { root, bundle, files, system, calls, options: { bundle, stateDir: join(root, "state"), home: root } }
}

describe("restored launchd service", () => {
  it("matches the committed r4 service contract on every host", () => {
    const text = Host.hostPlist({ bundle: "/fixture/bundle", stateDir: "/fixture/state", home: "/fixture/home" }, {})
    for (
      const value of [
        hostExpectations.label,
        "/fixture/bundle/bin/smithers-server",
        hostExpectations.handoff_argument,
        "/fixture/state",
        "/fixture/state/logs/host.log",
        "/fixture/home",
        "/fixture/bundle/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      ]
    ) expect(text).toContain(`<string>${value}</string>`)
    expect(text).toMatch(
      new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${hostExpectations.throttle_seconds}</integer>`)
    )
    expect(text).toMatch(
      new RegExp(`<key>ExitTimeOut</key>\\s*<integer>${hostExpectations.exit_timeout_seconds}</integer>`)
    )
    for (const field of ["RunAtLoad"]) expect(text).toMatch(new RegExp(`<key>${field}</key>\\s*<true/>`))
    expect(text).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>PathState<\/key>\s*<dict>\s*<key>\/fixture\/state\/start-refusal.json<\/key>\s*<false\/>/
    )
    for (const field of ["UserName", "GroupName", "RootDirectory"]) expect(text).not.toContain(`<key>${field}</key>`)
  })

  it.each([43.99, 44, 44.01])("starts through the CLI host adapter with %s GiB free", async (free) => {
    const f = fixture()
    const handoff = vi.fn(async () => ({
      code: "setup_ready",
      setup_urls: ["http://localhost/setup?token=fixture"],
      exitCode: 0
    }))
    const probe = async () => {
      // Stand-in for the bundled backend's authoritative ValidateStart result.
      if (free < 44) {
        writeFileSync(
          join(f.options.stateDir, "start-refusal.json"),
          JSON.stringify({
            code: "host_capacity_zero",
            message: `cannot start a fresh install: disk: ${
              free.toFixed(2)
            } GiB free on the state volume; 44 GiB required`
          })
        )
      }
      return true
    }
    if (free < 44) {
      await expect(Host.startInstalled(f.options, f.system, probe, handoff)).rejects.toThrow(
        "host_capacity_zero: cannot start a fresh install: disk: 43.99 GiB free on the state volume; 44 GiB required"
      )
      expect(Host.loaded(f.system)).toBe(false)
      expect(Host.startRefusal(f.options.stateDir)?.code).toBe("host_capacity_zero")
      await expect(Host.status(f.system, f.options.stateDir)).rejects.toThrow(
        "43.99 GiB free on the state volume; 44 GiB required"
      )
      expect(handoff).not.toHaveBeenCalled()
      await expect(Host.startInstalled(f.options, f.system, async () => true, handoff)).resolves.toMatchObject({
        code: "setup_ready"
      })
      expect(Host.startRefusal(f.options.stateDir)).toBeUndefined()
    } else {
      await expect(Host.startInstalled(f.options, f.system, probe, handoff)).resolves.toMatchObject({
        code: "setup_ready"
      })
      expect(Host.loaded(f.system)).toBe(true)
      expect(handoff).toHaveBeenCalledOnce()
    }
  })

  it("persists only the launcher's network policy and reloads when it changes", async () => {
    const f = fixture()
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:45678")
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1")
    vi.stubEnv("SSL_CERT_FILE", "/owner/fixture & ca.pem")
    vi.stubEnv("SMITHERS_MICROSANDBOX_BIN", "/hostile/msb")
    vi.stubEnv("SMITHERS_WORKSPACE_ISOLATION", "process")
    vi.stubEnv("CEREBRAS_API_KEY", "provider-secret")
    vi.stubEnv("NODE_OPTIONS", "--import=/hostile/code.mjs")
    try {
      expect(await Host.install(f.options, f.system)).toBe("installed")
      const text = readFileSync(Host.plistFile(f.system), "utf8")
      expect(text).toContain("<string>http://127.0.0.1:45678</string>")
      expect(text).toContain("<string>localhost,127.0.0.1</string>")
      expect(text).toContain("<string>/owner/fixture &amp; ca.pem</string>")
      for (
        const denied of [
          "SMITHERS_MICROSANDBOX_BIN",
          "SMITHERS_WORKSPACE_ISOLATION",
          "CEREBRAS_API_KEY",
          "provider-secret",
          "NODE_OPTIONS",
          "/hostile/"
        ]
      ) {
        expect(text).not.toContain(denied)
      }
      expect(await Host.install(f.options, f.system)).toBe("unchanged")
      vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:45679")
      expect(await Host.install(f.options, f.system)).toBe("reloaded")
      expect(readFileSync(Host.plistFile(f.system), "utf8")).toContain("<string>http://127.0.0.1:45679</string>")
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it("keeps upper/lowercase proxy and CA policy while refusing unrelated environment", () => {
    const allowed = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "all_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR"
    ]
    const environment = Object.fromEntries(allowed.map((name) => [name, "value-" + name]))
    const text = Host.hostPlist(fixture().options, {
      ...environment,
      HTTPS_PROXY: "",
      HOME: "/hostile",
      PATH: "/hostile",
      SMITHERS_BACKEND_MODE: "plue"
    })
    for (const name of allowed.filter((name) => name !== "HTTPS_PROXY")) {
      expect(text).toContain(`<key>${name}</key>`)
      expect(text).toContain(`<string>value-${name}</string>`)
    }
    expect(text).not.toContain("<key>HTTPS_PROXY</key>")
    expect(text).not.toContain("/hostile")
    expect(text).not.toContain("SMITHERS_BACKEND_MODE")
  })
  it.each(["still loaded", "cannot observe launcher"])(
    "refuses replacement when %s without rewriting the plist",
    async (failure) => {
      const f = fixture(), other = fixture()
      await Host.install(f.options, f.system)
      const before = readFileSync(Host.plistFile(f.system), "utf8")
      f.calls.splice(0)
      f.system.launchctl = (args) => {
        f.calls.push([...args])
        if (failure === "still loaded" && args[0] === "bootout") {
          vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_000)
        }
        return { status: 0, stdout: failure === "cannot observe launcher" ? "pid = 123" : "", stderr: "" }
      }
      if (failure === "cannot observe launcher") {
        vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("cannot observe launcher"), { code: "EPERM" })
        })
      }
      await expect(Host.install({ ...f.options, bundle: other.bundle }, f.system)).rejects.toThrow(
        failure === "still loaded" ? "did not stop" : "cannot observe launcher"
      )
      expect(readFileSync(Host.plistFile(f.system), "utf8")).toBe(before)
      expect(f.calls.some((args) => args[0] === "bootstrap")).toBe(false)
    }
  )
  it.each(["replacement", "stop"])("waits for the old launcher to exit before %s completes", async (action) => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on(\"SIGTERM\",()=>setTimeout(()=>process.exit(0),150));console.log(\"ready\");setInterval(()=>{},1000)"
    ])
    const exited = new Promise<void>((done) => child.once("exit", () => done()))
    await new Promise<void>((done) => child.stdout!.once("data", () => done()))
    const f = fixture(), other = fixture()
    await Host.install(f.options, f.system)
    const launch = f.system.launchctl
    f.system.launchctl = (args) => {
      if (args[0] === "print") return { ...launch(args), stdout: `pid = ${child.pid}` }
      if (args[0] === "bootout") child.kill("SIGTERM")
      if (args[0] === "bootstrap" && child.exitCode === null) {
        return { status: 5, stdout: "", stderr: "old job is stopping" }
      }
      return launch(args)
    }
    try {
      if (action === "stop") expect(await Host.stop(f.system)).toEqual({ state: "stopped" })
      else expect(await Host.install({ ...f.options, bundle: other.bundle }, f.system)).toBe("reloaded")
      expect(child.exitCode).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM")
      await exited
    }
  })
  it("refuses root before any launchctl invocation", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0)
    expect(() => Host.launchd()).toThrow("unprivileged macOS login session")
  })
  it("escapes every plist value type and parses with macOS plutil", () => {
    const text = Host.plist({ A: "x<&>\"", B: 3, C: true, D: false, E: ["1", "2"], F: { G: "h" } })
    expect(text).toContain("<string>x&lt;&amp;&gt;&quot;</string>")
    expect(text).toContain("<integer>3</integer>")
    expect(text).toContain("<true/>")
    expect(text).toContain("<false/>")
    if (process.platform === "darwin") {
      const f = fixture(), file = join(f.root, "parse.plist")
      writeFileSync(file, text)
      expect(spawnSync("/usr/bin/plutil", ["-lint", file]).status).toBe(0)
    }
  })
  it.skipIf(process.platform !== "darwin")(
    "runs the absolute bundled launcher at login without shell tools or privileged fields",
    () => {
      const f = fixture(), text = Host.hostPlist(f.options, {}), file = join(f.root, "parse.plist")
      writeFileSync(file, text)
      const parsed = JSON.parse(
        spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout
      )
      expect(parsed).toEqual({
        Label: "sh.smithers.host",
        ProgramArguments: [join(f.bundle, "bin/smithers-server"), "--setup-handoff=socket"],
        WorkingDirectory: f.options.stateDir,
        EnvironmentVariables: { HOME: f.root, PATH: `${f.bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
        RunAtLoad: true,
        KeepAlive: { PathState: { [join(f.options.stateDir, "start-refusal.json")]: false } },
        ThrottleInterval: 5,
        ExitTimeOut: 30,
        ProcessType: "Standard",
        StandardOutPath: join(f.root, "state/logs/host.log"),
        StandardErrorPath: join(f.root, "state/logs/host.log")
      })
    }
  )
  it("starts once, keeps an unchanged agent, then reloads a changed bundle once", async () => {
    const f = fixture()
    expect(await Host.install(f.options, f.system)).toBe("installed")
    expect(await Host.install(f.options, f.system)).toBe("unchanged")
    const other = fixture()
    expect(await Host.install({ ...f.options, bundle: other.bundle }, f.system)).toBe("reloaded")
    expect(f.calls.filter((args) => args[0] !== "print")).toEqual([
      ["bootstrap", "gui/501", join(f.root, "LaunchAgents/sh.smithers.host.plist")],
      ["bootout", "gui/501/sh.smithers.host"],
      ["bootstrap", "gui/501", join(f.root, "LaunchAgents/sh.smithers.host.plist")]
    ])
    expect(Host.installedBundle(f.system)).toBe(other.bundle)
    expect(await Host.stop(f.system)).toEqual({ state: "stopped" })
    expect(existsSync(f.options.stateDir)).toBe(true)
    expect(existsSync(Host.plistFile(f.system))).toBe(false)
    await Host.stop(f.system)
  })
  it.each(["hash", "extra", "traversal", "duplicate", "missing", "symlink", "not executable", "empty"])(
    "refuses %s before plist or launchctl mutations",
    async (kind) => {
      const f = fixture()
      if (kind === "hash") writeFileSync(join(f.bundle, "bin/msb"), "changed")
      if (kind === "extra") writeFileSync(join(f.bundle, "extra"), "undeclared")
      if (kind === "traversal") f.files[0]!.path = "../escape"
      if (kind === "duplicate") f.files.push(f.files[0]!)
      if (kind === "missing") rmSync(join(f.bundle, "bin/msb"))
      if (kind === "symlink") {
        rmSync(join(f.bundle, "bin/msb"))
        writeFileSync(join(f.root, "outside"), "bin/msb")
        symlinkSync(join(f.root, "outside"), join(f.bundle, "bin/msb"))
      }
      if (kind === "not executable") chmodSync(join(f.bundle, "bin/msb"), 0o644)
      if (kind === "empty") f.files.splice(0)
      writeFileSync(
        join(f.bundle, "manifest.json"),
        JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files: f.files })
      )
      await expect(Host.install(f.options, f.system)).rejects.toThrow()
      expect(f.calls).toEqual([])
      expect(existsSync(f.system.agentsDir)).toBe(false)
    }
  )
  it.each(["version", "platform", "revision", "mode", "stage", "symlink"])(
    "verifies landed manifest %s metadata before touching launchd",
    async (kind) => {
      const f = fixture(), path = join(f.bundle, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"))
      if (["version", "platform", "revision"].includes(kind)) manifest[kind] = "invalid"
      else if (kind === "mode") manifest.files[0].mode = 0o644
      else if (kind === "stage") delete manifest.files[0].stage
      else manifest.files[0].symlink = "other"
      writeFileSync(path, JSON.stringify(manifest))
      await expect(Host.install(f.options, f.system)).rejects.toThrow()
      expect(f.calls).toEqual([])
    }
  )
  it("does not replace the plist when bootout fails", async () => {
    const f = fixture()
    await Host.install(f.options, f.system)
    const before = readFileSync(Host.plistFile(f.system), "utf8")
    f.system.launchctl = (args) => ({ status: args[0] === "print" ? 0 : 5, stdout: "", stderr: "refused" })
    const other = fixture()
    await expect(Host.install({ ...f.options, bundle: other.bundle }, f.system)).rejects.toThrow("bootout failed")
    expect(readFileSync(Host.plistFile(f.system), "utf8")).toBe(before)
    await expect(Host.stop(f.system)).rejects.toThrow("bootout failed")
  })
  it("reports bootstrap failure and permits the next unloaded retry", async () => {
    const f = fixture(), launch = f.system.launchctl
    f.system.launchctl = (args) => args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "refused" } : launch(args)
    await expect(Host.install(f.options, f.system)).rejects.toThrow("bootstrap failed")
    f.system.launchctl = launch
    expect(await Host.install(f.options, f.system)).toBe("installed")
  })
  it("runs bundled doctor with the required state root and no shell credentials", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync
    Host.doctor("/bundle", "/state", run)
    expect(run).toHaveBeenCalledWith("/bundle/bin/smithers-backend", ["microvm", "doctor"], {
      encoding: "utf8",
      timeout: 30000,
      env: { HOME: homedir(), PATH: "/bundle/bin:/usr/bin:/bin", SMITHERS_DATA_ROOT: "/state" }
    })
    const failed = vi.fn(() => ({ status: 1, stdout: "", stderr: "private diagnostic" })) as unknown as typeof spawnSync
    expect(() => Host.doctor("/bundle", "/state", failed)).toThrow("Bundled microVM doctor failed: /bundle")
  })
  it("resolves explicit bundle paths and refuses a missing default naming both choices", () => {
    expect(Host.resolveBundle(".")).toBe(process.cwd())
    if (!existsSync("/opt/homebrew/opt/smithers/libexec/manifest.json")) {
      expect(() => Host.resolveBundle()).toThrow("--bundle <dir>")
    }
  })
  it("waits for real readiness and refuses an expired readiness deadline", async () => {
    let calls = 0
    await Host.waitReady(async () => ++calls === 2, 1000)
    expect(calls).toBe(2)
    await expect(Host.waitReady(async () => false, 1)).rejects.toThrow("readiness failed")
  })
  it("keeps waiting while a first boot's migrations advance, and not when they stall", async () => {
    // Five 250 ms polls, each a new step, outlast a 400 ms deadline.
    let calls = 0
    await Host.waitReady(async () => ++calls > 5 || JSON.stringify(["migrating", calls, 116]), 400)
    expect(calls).toBe(6)
    calls = 0
    await expect(Host.waitReady(async () => (++calls, JSON.stringify(["migrating", 1, 116])), 400))
      .rejects.toThrow("readiness failed")
    expect(calls).toBeLessThan(5)
  })
})

describe("private setup handoff", () => {
  it.each([
    [200, { setup_urls: ["http://localhost:4000/setup?token=fixture-secret"] }, "setup_ready", 0],
    [401, { error: "setup_closed" }, "setup_closed", 3],
    [503, { error: "setup_mint_failed" }, "setup_mint_failed", 4],
    [401, { error: "unrelated" }, "invalid", 1],
    [200, { setup_urls: [] }, "invalid", 1],
    [200, { setup_urls: ["http://localhost:4000/setup?token=x\nforged"] }, "invalid", 1],
    [200, { setup_urls: ["file:///setup?token=x"] }, "invalid", 1],
    [200, { setup_urls: ["http://localhost:4000/setup?token=x"], extra: true }, "invalid", 1]
  ])("maps HTTP %s %j without treating transport failures as owner state", async (status, body, code, exitCode) => {
    const f = fixture()
    mkdirSync(join(f.root, "run"))
    const socket = join(f.root, "run/host.sock")
    const server = createServer((req, res) => {
      expect(req.url).toBe("/setup-urls")
      expect(req.method).toBe("GET")
      res.writeHead(status)
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((done) => server.listen(socket, done))
    chmodSync(socket, 0o600)
    try {
      if (code === "invalid") await expect(Host.setupURLs(f.root)).rejects.toThrow("Invalid setup handoff response")
      else expect(await Host.setupURLs(f.root)).toMatchObject({ code, exitCode })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
  it("rejects a missing, regular or insecure socket", async () => {
    const f = fixture()
    mkdirSync(join(f.root, "run"))
    await expect(Host.setupURLs(f.root)).rejects.toThrow()
    const socket = join(f.root, "run/host.sock")
    writeFileSync(socket, "", { mode: 0o600 })
    await expect(Host.setupURLs(f.root)).rejects.toThrow("mode 0600")
  })
})

it("passes explicit network settings to the existing bundled launcher", () => {
  const text = Host.hostPlist({
    bundle: "/bundle",
    stateDir: "/state",
    home: "/home",
    bind: "0.0.0.0",
    origins: ["http://lan-a:4000", "https://box.example"]
  })
  expect(text).toContain("<string>--bind</string>")
  expect(text).toContain("<string>0.0.0.0</string>")
  expect(text).toContain("<string>http://lan-a:4000</string>")
  expect(text).toContain("<string>https://box.example</string>")
  expect(text.match(/<string>--origin<\/string>/g)).toHaveLength(2)
})

it("refuses invalid serving flags before host service effects", () => {
  for (
    const address of [
      { bind: "invalid" },
      { bind: "0.0.0.0:4001" },
      { origins: ["/relative"] },
      { origins: ["http://box?"] },
      { origins: ["http://box#"] },
      { origins: ["ftp://box"] },
      { origins: ["http://box/path"] },
      { origins: ["http://box", "https://box"] },
      { origins: ["https://localhost:4000"] },
      { origins: ["https://127.0.0.1:4000"] },
      { origins: ["https://[::1]:4000"] }
    ]
  ) expect(() => Host.validateAddress(address)).toThrow()
  expect(() => Host.validateAddress({ bind: "0.0.0.0", origins: ["http://lan-a:4000", "https://box.example"] })).not
    .toThrow()
  expect(() => Host.validateAddress({ bind: "[::]:4000" })).not.toThrow()
})

describe("install telemetry over HTTP", () => {
  it.each([200, 401, 404, 503])(
    "probes GET /api/install with HTTP %s and omits unavailable telemetry",
    async (code) => {
      const server = createServer((req, res) => {
        expect(req.method).toBe("GET")
        expect(req.url).toBe("/api/install")
        expect(req.headers.authorization).toBe("Bearer fixture-person")
        res.writeHead(code, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            capacity: 2,
            this_mac: { memory_gb: 32, perf_cores: 10, capacity: 3, limit: { fix: "private" } },
            github_app: { configured: true, installed: false, install_url: "secret" },
            setup_urls: ["secret"]
          })
        )
      })
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
      try {
        const address = server.address() as { port: number }
        expect(await Host.installTelemetry(`http://127.0.0.1:${address.port}/api/install`, "fixture-person")).toEqual(
          code === 200 ?
            {
              capacity: 2,
              this_mac: { memory_gb: 32, perf_cores: 10, capacity: 3 },
              github_app: { configured: true, installed: false }
            } :
            undefined
        )
      } finally {
        await new Promise<void>((done) => server.close(() => done()))
      }
    }
  )
  it.each([
    ["memory", "needs 14 GiB of memory"],
    ["cores", "needs 2 performance cores"],
    ["disk", "free 12 GiB on the state volume"]
  ])("shows the zero-capacity %s fix from the authenticated install response", async (term, fix) => {
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-person")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          capacity: 0,
          this_mac: { capacity: 0, limit: { term, fix, secret: "omitted" } },
          setup_urls: ["secret"]
        })
      )
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address() as { port: number }
      expect(await Host.installTelemetry(`http://127.0.0.1:${address.port}/api/install`, "fixture-person")).toEqual({
        capacity: 0,
        this_mac: { capacity: 0, limit: { term, fix } }
      })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
  it("omits malformed and unreachable telemetry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid"))
    expect(await Host.installTelemetry()).toBeUndefined()
    vi.mocked(fetch).mockRejectedValue(new Error("offline"))
    expect(await Host.installTelemetry()).toBeUndefined()
  })
})

/** Rewrites the fixture manifest to describe the bundle's current bytes and modes. */
const reseal = (f: ReturnType<typeof fixture>, paths: ReadonlyArray<string>) =>
  writeFileSync(
    join(f.bundle, "manifest.json"),
    JSON.stringify({
      version: 1,
      platform: "darwin-arm64",
      revision: "b".repeat(40),
      files: paths.map((path) => {
        const file = join(f.bundle, path), info = lstatSync(file)
        return {
          path,
          sha256: createHash("sha256").update(info.isFile() ? readFileSync(file) : "").digest("hex"),
          stage: "fixture",
          mode: info.mode & 0o777
        }
      })
    })
  )
const executables = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]

/** One loopback HTTP server for the duration of `use`. */
const serving = async <A>(listener: RequestListener, use: (origin: string) => Promise<A>): Promise<A> => {
  const server = createServer(listener)
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  try {
    return await use(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
const json = (status: number, body: unknown): RequestListener => (_req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

describe("host service seams", () => {
  it("roots state under the given home, or the current user's", () => {
    expect(Host.stateDirectory("/owner")).toBe("/owner/Library/Application Support/Smithers")
    expect(Host.stateDirectory()).toBe(join(homedir(), "Library/Application Support/Smithers"))
  })

  it.each([["linux", 501], ["darwin", 0]] as const)(
    "refuses %s uid %s before running launchctl",
    (platform, uid) => {
      const run = vi.fn() as unknown as typeof spawnSync
      expect(() => Host.launchd(platform, uid, "/owner", run)).toThrow(
        expect.objectContaining({ code: "host_platform" })
      )
      expect(run).not.toHaveBeenCalled()
    }
  )

  it("drives the login session's launchctl and reports its spawn failure text", () => {
    const answers = [
      { status: 0, stdout: "pid = 7", stderr: "" },
      { status: null, stdout: null, stderr: null, error: new Error("spawn /bin/launchctl ENOENT") },
      { status: null, stdout: null, stderr: null }
    ]
    const calls: Array<ReadonlyArray<string>> = []
    const run = ((file: string, args: ReadonlyArray<string>) => {
      calls.push([file, ...args])
      return answers.shift()
    }) as unknown as typeof spawnSync
    const system = Host.launchd("darwin", 501, "/owner", run)
    expect(system.agentsDir).toBe("/owner/Library/LaunchAgents")
    expect(system.domain).toBe("gui/501")
    expect(system.launchctl(["print", "gui/501/sh.smithers.host"])).toEqual({
      status: 0,
      stdout: "pid = 7",
      stderr: ""
    })
    expect(system.launchctl(["bootout", "gui/501/sh.smithers.host"])).toEqual({
      status: null,
      stdout: "",
      stderr: "spawn /bin/launchctl ENOENT"
    })
    expect(system.launchctl(["print", "gui/501/sh.smithers.host"])).toEqual({ status: null, stdout: "", stderr: "" })
    expect(calls[0]).toEqual(["/bin/launchctl", "print", "gui/501/sh.smithers.host"])
  })

  it("refuses a service operation while another holds the installation lock, then proceeds", async () => {
    const f = fixture()
    mkdirSync(f.system.agentsDir, { recursive: true })
    const holder = new DatabaseSync(`${Host.plistFile(f.system)}.lock.sqlite`)
    holder.exec("BEGIN EXCLUSIVE")
    try {
      await expect(Host.install(f.options, f.system)).rejects.toMatchObject({ code: "host_service_busy" })
      await expect(Host.stop(f.system)).rejects.toMatchObject({ code: "host_service_busy" })
      expect(() => Host.maintenance("restore", f.root, f.system, spawnSync)).toThrow(
        expect.objectContaining({ code: "host_service_busy" })
      )
      expect(f.calls).toEqual([])
    } finally {
      holder.close()
    }
    expect(await Host.install(f.options, f.system)).toBe("installed")
  })

  it("surfaces a corrupt installation lock instead of reporting it busy", async () => {
    const f = fixture()
    mkdirSync(f.system.agentsDir, { recursive: true })
    writeFileSync(`${Host.plistFile(f.system)}.lock.sqlite`, "x".repeat(4096))
    await expect(Host.install(f.options, f.system)).rejects.toThrow("file is not a database")
    expect(f.calls).toEqual([])
  })

  it("refuses a bundle whose required executable is undeclared or not executable", () => {
    const undeclared = fixture()
    rmSync(join(undeclared.bundle, "bin/msb"))
    reseal(undeclared, executables.slice(0, 2))
    expect(() => Host.verifyBundle(undeclared.bundle)).toThrow("Bundle executable missing: bin/msb")
    const inert = fixture()
    chmodSync(join(inert.bundle, "bin/msb"), 0o644)
    reseal(inert, executables)
    expect(() => Host.verifyBundle(inert.bundle)).toThrow("Bundle executable missing: bin/msb")
    reseal(inert, [...executables, "bin"])
    expect(() => Host.verifyBundle(inert.bundle)).toThrow("Bundle metadata differs: bin")
  })

  it("reads a stopped install's bundle and refuses a plist without a program", async () => {
    const f = fixture()
    await Host.install(f.options, f.system)
    await Host.stop(f.system)
    expect(Host.installedBundle(f.system)).toBe(f.bundle)
    writeFileSync(Host.plistFile(f.system), Host.plist({ Label: Host.label }))
    expect(() => Host.installedBundle(f.system)).toThrow("Installed host bundle path unavailable")
  })

  it("resolves the keg bundle only when its manifest exists", () => {
    const f = fixture()
    expect(Host.resolveBundle(undefined, f.bundle)).toBe(f.bundle)
    expect(() => Host.resolveBundle(undefined, f.root)).toThrow(`install the bundle at ${f.root}`)
  })

  it("refuses restore while loaded or without a directory before running the backend", async () => {
    const f = fixture()
    const run = vi.fn() as unknown as typeof spawnSync
    await Host.install(f.options, f.system)
    expect(() => Host.maintenance("restore", f.root, f.system, run)).toThrow(
      expect.objectContaining({ code: "install_running" })
    )
    await Host.stop(f.system)
    expect(() => Host.maintenance("restore", "  ", f.system, run)).toThrow(
      expect.objectContaining({ code: "invalid_backup" })
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.skipIf(existsSync("/opt/homebrew/opt/smithers/libexec/manifest.json"))(
    "refuses maintenance of an absent install without the Homebrew bundle",
    () => {
      const f = fixture()
      const run = vi.fn() as unknown as typeof spawnSync
      expect(() => Host.maintenance("backup", undefined, f.system, run)).toThrow(
        expect.objectContaining({ code: "bundle_missing" })
      )
      expect(run).not.toHaveBeenCalled()
    }
  )

  it.each([
    [{ status: 1, stdout: "", stderr: "host_snapshot_missing: no snapshot here\n" }, "host_snapshot_missing"],
    [{ status: 1, stdout: "", stderr: "" }, "host_maintenance_failed"],
    [{ status: null, stdout: "", stderr: null }, "host_maintenance_failed"]
  ])("classifies a failed backend answer %j", (answer, code) => {
    const f = fixture()
    mkdirSync(f.system.agentsDir, { recursive: true })
    writeFileSync(Host.plistFile(f.system), Host.hostPlist(f.options))
    const run = (() => answer) as unknown as typeof spawnSync
    expect(() => Host.maintenance("backup", undefined, f.system, run)).toThrow(
      expect.objectContaining({
        code,
        message: answer.stderr?.trim() || "Host maintenance backend did not answer"
      })
    )
  })

  it.each(
    [
      ["ready", json(200, {}), true],
      ["starting", json(503, { status: "starting", phase: "migrate", applied: 3, total: 9 }), "[\"migrate\",3,9]"],
      ["unavailable", json(503, { status: "draining" }), false],
      ["failing", json(500, {}), false],
      [
        "redirecting",
        ((_req, res) => {
          res.writeHead(302, { Location: "http://127.0.0.1:1/readyz" })
          res.end()
        }) as RequestListener,
        false
      ]
    ] as const
  )("reads a %s readiness answer", async (_name, listener, expected) => {
    await serving(listener, async (origin) => expect(await Host.ready(origin)).toBe(expected))
  })

  it("reports an unreachable host as not ready", async () => {
    const origin = await serving(json(200, {}), async (origin) => origin)
    expect(await Host.ready(origin)).toBe(false)
  })
})

describe("host start and status", () => {
  const handoff = async () => ({ code: "setup_ready", setup_urls: ["http://lan-a:4000/setup?token=x"], exitCode: 0 })

  it("starts the given bundle and warns only when a LAN bind names no origin", async () => {
    const f = fixture()
    await expect(
      Host.start(f.bundle, { bind: "0.0.0.0" }, () => f.system, f.options.stateDir, async () => true, handoff)
    ).resolves.toEqual({ ...(await handoff()), warning: "LAN browsers need --origin" })
    expect(readFileSync(Host.plistFile(f.system), "utf8")).toContain(`<string>${homedir()}</string>`)
    await expect(
      Host.start(
        f.bundle,
        { bind: "0.0.0.0", origins: ["http://lan-a:4000"] },
        () => f.system,
        f.options.stateDir,
        async () => true,
        handoff
      )
    ).resolves.toEqual(await handoff())
  })

  it("validates serving flags before touching launchd", async () => {
    const host = vi.fn()
    await expect(Host.start(undefined, { bind: "invalid" }, host)).rejects.toThrow("Invalid bind address")
    expect(host).not.toHaveBeenCalled()
  })

  it("stops and refuses when the backend records a refusal as the job loads", async () => {
    const f = fixture(), launch = f.system.launchctl
    f.system.launchctl = (args) => {
      const result = launch(args)
      if (args[0] === "bootstrap") {
        writeFileSync(
          join(f.options.stateDir, "start-refusal.json"),
          JSON.stringify({ code: "host_capacity_zero", message: "memory: needs 14 GiB" })
        )
      }
      return result
    }
    const probe = vi.fn(async () => true)
    await expect(Host.startInstalled(f.options, f.system, probe, handoff)).rejects.toThrow(
      "host_capacity_zero: memory: needs 14 GiB"
    )
    expect(probe).not.toHaveBeenCalled()
    expect(Host.loaded(f.system)).toBe(false)
  })

  it("ignores a refusal file the backend did not write as a capacity refusal", () => {
    const f = fixture()
    mkdirSync(f.options.stateDir, { recursive: true })
    writeFileSync(join(f.options.stateDir, "start-refusal.json"), JSON.stringify({ code: "other", message: "x" }))
    expect(Host.startRefusal(f.options.stateDir)).toBeUndefined()
    writeFileSync(join(f.options.stateDir, "start-refusal.json"), JSON.stringify({ code: "host_capacity_zero" }))
    expect(Host.startRefusal(f.options.stateDir)).toBeUndefined()
  })

  it.each([
    [null, ""],
    [{ message: "Already set up." }, "Already set up."],
    [{ setup_urls: ["http://a/setup?token=1"] }, "http://a/setup?token=1"],
    [
      { setup_urls: ["http://a/setup?token=1"], warning: "LAN browsers need --origin" },
      "http://a/setup?token=1\nLAN browsers need --origin"
    ]
  ])("renders start result %j", (value, text) => {
    expect(Host.startText(value)).toBe(text)
  })

  /** A fixture whose bundled backend is a real program that checks the doctor's arguments and state root. */
  const doctorBundle = (f: ReturnType<typeof fixture>) => {
    writeFileSync(
      join(f.bundle, "bin/smithers-backend"),
      `#!/bin/sh\n[ "$1 $2" = "microvm doctor" ] && [ "$SMITHERS_DATA_ROOT" = ${
        JSON.stringify(f.options.stateDir)
      } ]\n`,
      { mode: 0o755 }
    )
    reseal(f, executables)
  }

  it.each(
    [
      [200, { capacity: 2 }, { install: { capacity: 2 } }],
      [404, {}, {}]
    ] as const
  )("reports a loaded, ready, diagnosed host with install telemetry %s", async (code, body, extra) => {
    const f = fixture()
    doctorBundle(f)
    await Host.install(f.options, f.system)
    await serving((req, res) => {
      if (req.url === "/readyz") return json(200, {})(req, res)
      expect(req.headers.authorization).toBe("Bearer fixture-person")
      return json(code, body)(req, res)
    }, async (origin) => {
      expect(await Host.status(f.system, f.options.stateDir, origin, "fixture-person")).toEqual({
        state: "ready",
        bundle: f.bundle,
        version: "b".repeat(40),
        launchd: "running",
        readiness: "ready",
        doctor: "ready",
        ...extra
      })
    })
  })

  it("reports an unready or unloaded host unhealthy", async () => {
    const f = fixture()
    doctorBundle(f)
    await Host.install(f.options, f.system)
    await serving(json(500, {}), async (origin) => {
      await expect(Host.status(f.system, f.options.stateDir, origin)).rejects.toMatchObject({ code: "host_unhealthy" })
      await Host.stop(f.system)
      await expect(Host.status(f.system, f.options.stateDir, origin)).rejects.toMatchObject({ code: "host_unhealthy" })
    })
  })

  it("refuses more than ten public origins", () => {
    const origins = Array.from({ length: 11 }, (_, index) => `http://lan-${index}:4000`)
    expect(() => Host.validateAddress({ origins })).toThrow("Invalid public origins")
    expect(() => Host.validateAddress({ origins: origins.slice(0, 10) })).not.toThrow()
  })
})

describe("private setup handoff failures", () => {
  const socketServer = async (f: ReturnType<typeof fixture>, listener: RequestListener) => {
    mkdirSync(join(f.root, "run"))
    const socket = join(f.root, "run/host.sock")
    const server = createServer(listener)
    await new Promise<void>((done) => server.listen(socket, done))
    chmodSync(socket, 0o600)
    return {
      close: () => {
        server.closeAllConnections()
        return new Promise<void>((done) => server.close(() => done()))
      }
    }
  }

  it.each(
    [
      [
        "an oversized body",
        ((_req, res) => {
          res.writeHead(200)
          res.end(JSON.stringify({ setup_urls: ["x".repeat(70_000)] }))
        }) as RequestListener,
        "invalid_setup_response"
      ],
      ["a non-string setup URL", json(200, { setup_urls: [7] }), "invalid_setup_response"],
      ["a dropped connection", ((req) => req.socket.destroy()) as RequestListener, "setup_socket_unavailable"],
      ["no answer", (() => {}) as RequestListener, "setup_socket_timeout"]
    ] as const
  )("refuses %s", async (_name, listener, code) => {
    const f = fixture()
    const server = await socketServer(f, listener)
    try {
      await expect(Host.setupURLs(f.root, 200)).rejects.toMatchObject({ code })
    } finally {
      await server.close()
    }
  })
})

describe("install telemetry filtering", () => {
  it.each(
    [
      ["a null body", null, undefined],
      ["an array body", [{ capacity: 2 }], undefined],
      [
        "no usable field",
        { capacity: -1, this_mac: { memory_gb: "32" }, github_app: { configured: "yes" } },
        undefined
      ],
      ["a non-finite capacity beside usable fields", {
        capacity: "2",
        this_mac: { memory_gb: -4, capacity: 0, limit: { term: "memory", fix: "  " } },
        github_app: { installed: true }
      }, { this_mac: { capacity: 0 }, github_app: { installed: true } }],
      ["an unknown limit term", { this_mac: { capacity: 0, limit: { term: "network", fix: "x" } } }, {
        this_mac: { capacity: 0 }
      }]
    ] as const
  )("keeps only typed public fields from %s", async (_name, body, expected) => {
    await serving(
      json(200, body),
      async (origin) => expect(await Host.installTelemetry(`${origin}/api/install`)).toEqual(expected)
    )
  })
})
