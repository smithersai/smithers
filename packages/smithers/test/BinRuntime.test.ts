/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Environment from "../src/Environment.ts"
import { Version } from "../src/index.ts"
import {
  binDirectory,
  executable,
  freePort,
  inEmptyDirectory,
  launch,
  packageRoot,
  processBudget,
  refusal,
  run,
  scriptedHost,
  shim,
  temporaryDirectoryPrefix
} from "./support/bin.ts"
import { childEnvironment, spawnNodeSync } from "./support/node-child.ts"

describe("reserved system flow ids", processBudget, () => {
  // `SystemFlows.catalog` reserves 23 `system/*` ids so the control plane can
  // project a verb onto a flow row. None of them has a body in rc.0, so a
  // launch parks at `accepted` and never moves: the "partial appearance"
  // the release policy forbids. They are not flows an operator may name.
  it("refuses to plan a reserved system flow", () => {
    const result = run(["plan", "system/replay", "--json"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs flow plan system/replay")
    expect(result.stderr).toContain("reserved system flow")
    expect(result.stdout).not.toContain("planId")
  })

  it("refuses to launch a reserved system flow instead of parking a run forever", () => {
    const result = run(["up", "system/release", "--json"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs flow start system/release")
    expect(result.stdout).not.toContain("Accepted")
  })

  it("lists no reserved system flow", () => {
    const result = run(["ls", "--json"])
    const listed = JSON.parse(result.stdout) as {
      readonly items: ReadonlyArray<{ readonly flowId: string }>
    }

    expect(result.status).toBe(0)
    expect(listed.items.filter((item) => item.flowId.startsWith("system/"))).toEqual([])
  })
})

describe("the SQLite-only database contract", processBudget, () => {
  it("accepts `--backend sqlite` as a no-op and exits 0", () => {
    const result = run(["--backend", "sqlite", "--json", "ls"])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
  })

  it("refuses `--backend pglite` with the release policy's sentence", () => {
    const result = run(["--backend", "pglite", "ls"])

    expect(result.status).toBe(1)
    // The whole sentence, not a substring: the unsupported-name contract fixes it, and a
    // paraphrase that still contains "unsupported_database" is a contract
    // change an operator's script would not see coming.
    expect(result.stderr.trim()).toBe(Environment.unsupportedBackendMessage)
  })

  it.each([
    ["flow", "list"],
    ["flow", "show", "absent"],
    ["runs", "list"],
    ["runs", "show", "absent"],
    ["runs", "logs", "absent"],
    ["approvals", "list"]
  ])("refuses SMITHERS_BACKEND=mysql, which a script exports rather than passes (%s %s)", (...args) => {
    const result = run([...args, "--json"], { SMITHERS_BACKEND: "mysql", SMITHERS_REMOTE: "" })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).message).toBe(Environment.unsupportedBackendMessage)
  })

  it("recognizes PostgreSQL configuration and announces only unused test configuration", () => {
    const result = run(["--json", "ls"], {
      SMITHERS_BACKEND: "sqlite",
      SMITHERS_POSTGRES_URL: "postgres://localhost/smithers",
      SMITHERS_TEST_PG_URL: "postgres://localhost/test"
    })

    // A notice, not a refusal: these names are ignored, and an
    // ignored name must not change what the command does or what it returns.
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
    expect(result.stderr.split("\n").filter((line) => line.startsWith("ignored: "))).toEqual([
      // The storage notice names the release, which the bump keeps equal to this package's.
      `ignored: SMITHERS_TEST_PG_URL has no effect in ${Version.packageVersion} (use SMITHERS_POSTGRES_URL to select PostgreSQL)`
    ])
  })

  it("refuses a 0.x database file by its contract code in structured output", () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(cwd, ".flows"))
      // One table and no `flows_migrations`: exactly the shape the guard
      // refuses, and exactly the shape a 0.x `smithers.db` has.
      const zeroX = new DatabaseSync(join(cwd, ".flows", "control.db"))
      zeroX.exec("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY)")
      zeroX.close()

      const result = spawnNodeSync([
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "runs",
        "list",
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env }
      })

      expect(result.status).toBe(1)
      const error = JSON.parse(result.stdout)
      expect(error.code).toBe("unsupported_database_file")
      expect(error.message).toContain("is not a Smithers 1.0 database")
      // The tagged-error name is how the value travelled, not what the
      // contract promises an operator or what a script greps for.
      expect(result.stdout).not.toContain("@smthrs/database/UnsupportedDatabase")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("the served gateway", processBudget, () => {
  it.each(["serve", "gateway"])("%s answers every mount and starts the scheduler", async (verb) => {
    const port = await freePort()
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--import",
      scriptedHost,
      executable,
      verb,
      // 538b5500d413 suppresses progress for piped auto-audience output.
      "--audience",
      "human",
      "--ui",
      "plain",
      "--port",
      String(port)
    ], {
      cwd,
      env: childEnvironment()
    })
    const exited = new Promise((resolve) => child.once("exit", resolve))
    let banner = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      banner += chunk
    })
    try {
      const base = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 120_000
      let health: Response | undefined
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Gateway exited before readiness: ${banner}`)
        }
        try {
          health = await fetch(`${base}/health`)
          break
        } catch (cause) {
          if (Date.now() > deadline) throw cause
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }

      // `GET /health` is the probe a supervisor uses to decide whether the
      // gateway it found belongs to this workspace, so it answers unauthenticated
      // and carries identity only.
      expect(health!.status).toBe(200)
      const identity = await health!.json() as Record<string, unknown>
      expect(typeof identity.workspaceHash).toBe("string")
      expect(identity.version).toBe(Version.packageVersion)

      const database = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
      try {
        const heartbeat = database.prepare("SELECT ticked_at_ms FROM flows_scheduler_heartbeat")
        const deadline = Date.now() + 10_000
        while (heartbeat.get() === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(heartbeat.get()).toEqual({ ticked_at_ms: expect.any(Number) })
      } finally {
        database.close()
      }

      // The three RPC mounts. A 404 here is the defect this case exists for:
      // the banner advertised routes only the control server carried.
      for (const path of ["/rpc", "/projections", "/sync"]) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/ndjson" },
          body: ""
        })
        expect({ path, status: response.status }).not.toEqual({ path, status: 404 })
      }

      // Every line the banner advertises is a route that answered.
      expect(banner).toContain(`${base}/health`)
      expect(banner).toContain(`${base}/sync`)
      expect(banner).toContain("/projections/ws")
    } finally {
      child.kill("SIGTERM")
      await exited
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 240_000)
})

describe("the --json stdout contract", processBudget, () => {
  it("prints exactly one JSON document on stdout and nothing else", () => {
    const result = run(["--json", "ls"])

    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  })

  it("keeps the JSON document on stdout under --quiet", () => {
    const result = run(["--json", "--quiet", "ls"])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
  })
})

describe("flow start outside a repository", processBudget, () => {
  it("names the empty directory instead of silently exiting 130", () =>
    inEmptyDirectory((cwd) => {
      const result = spawnNodeSync(["--no-warnings", executable, "flow", "start", "missing"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: cwd, NODE_OPTIONS: "" }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.status).not.toBe(130)
      // The refusal is the CLI's ordinary error envelope, on stdout like every other one.
      expect(result.stdout).toContain("code: no_flows")
      expect(result.stdout).toContain(`No flows found in ${cwd}`)
      expect(result.stderr).toBe("")
    }))

  it("refuses a project whose only flows sit in the retired root flows/", () =>
    inEmptyDirectory((cwd) => {
      mkdirSync(join(cwd, "flows", "missing"), { recursive: true })
      writeFileSync(join(cwd, "flows", "missing", "flow.mdx"), "---\ndescription: Old.\n---\nOld.\n")
      const result = spawnNodeSync(["--no-warnings", executable, "flow", "start", "missing"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: cwd, NODE_OPTIONS: "" }
      })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain("code: no_flows")
      expect(existsSync(join(cwd, ".flows"))).toBe(false)
    }))
})

describe("the signal exit codes", processBudget, () => {
  const interrupted = async (signal: "SIGINT" | "SIGTERM") => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      const child = spawn(
        process.execPath,
        ["--no-warnings", "--import", scriptedHost, executable, "logs", "--follow"],
        {
          cwd,
          env: childEnvironment(),
          stdio: ["ignore", "pipe", "pipe"]
        }
      )
      const exited = new Promise<{ readonly status: number | null; readonly signal: string | null }>((resolve) => {
        child.on("exit", (status, killedBy) => resolve({ status, signal: killedBy }))
      })
      // The signal has to land after the handler is installed and the engine
      // has opened its database. A fixed sleep is a race: on a loaded machine
      // the module graph alone can take seconds to parse, and the process then
      // dies from the default action instead of running its teardown. The
      // control database appearing is the readiness proof.
      const database = join(cwd, ".flows", "control.db")
      const deadline = Date.now() + 120_000
      while (!existsSync(database) && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 25))
      expect(existsSync(database)).toBe(true)
      child.kill(signal)
      return await exited
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it("exits 130 on SIGINT", async () => {
    expect(await interrupted("SIGINT")).toEqual({ status: 130, signal: null })
  }, 240_000)

  it("exits 143 on SIGTERM", async () => {
    expect(await interrupted("SIGTERM")).toEqual({ status: 143, signal: null })
  }, 240_000)
})

describe("the smithers bin shim", processBudget, () => {
  it("declares smthrs and its smithers alias on one shim, and ships it in the tarball", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly bin?: Record<string, string>
      readonly files?: ReadonlyArray<string>
    }

    // The imported `flows` bin is gone. `smthrs` is the primary spelling and
    // `smithers` stays as an alias; both names run the same shim.
    expect(manifest.bin).toEqual({ smithers: "./bin/smithers.mjs", smthrs: "./bin/smithers.mjs" })
    expect(manifest.files).toContain("bin/**/*.mjs")
  })

  it("runs the built entry when dist is present, and leaves src alone", () => {
    // The packaged install: a tarball ships `dist/esm/bin.js` beside `src`,
    // and the shim must run the build. Staging the build here rather than
    // gating on `existsSync(dist)` is the point. `dist` is gitignored, so the
    // gated form skipped in every fresh clone and in this worktree, which is
    // no pin at all. The marker proves which entry ran, where asserting
    // `--version` could not: both entries print the same version.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      mkdirSync(join(root, "dist", "esm"), { recursive: true })
      writeFileSync(join(root, "dist", "esm", "bin.js"), "process.stdout.write(\"built entry ran\\n\")\n")

      const result = spawnNodeSync([join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("built entry ran")
      // `src/bin.ts` is right there and must not have run: an installed CLI
      // that type-stripped its own sources would be running unbuilt code.
      expect(result.stdout).not.toContain(Version.packageVersion)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runs the working-tree source when dist is absent", () => {
    // The development path `packages/smithers/test/support/check-local-smithers.mjs` requires: a fresh
    // checkout has no `dist`, and `pnpm exec smithers` must still run the code
    // under edit rather than a published build. The shim is copied into a
    // package root that has `src` and no `dist`, which is exactly that shape.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      // The whole directory, not just the entry: the shim imports its
      // sibling helpers, and copying one file made this case fail the moment a
      // second one appeared.
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      expect(existsSync(join(root, "dist"))).toBe(false)

      const result = spawnNodeSync([join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      // Type stripping is stable on Node 26, so a development invocation
      // prints no experimental warning ahead of its output.
      expect(result.stderr).not.toContain("Type Stripping")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
