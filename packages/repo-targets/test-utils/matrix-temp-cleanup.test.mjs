import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

for (const [fails, preserve] of [[false, false], [true, false], [false, true]]) {
  test(`real SQLite/Postgres matrix and merged coverage leave no scratch after ${fails ? "failure" : preserve ? "publishing" : "success"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "m-"))
    const scratch = join(root, "t")
    mkdirSync(scratch)
    try {
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction")
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
      writeFileSync(join(root, "value.js"), "export const value = 1;")
      writeFileSync(
        join(root, "case.test.js"),
        `import { test, expect } from 'vitest'; import {value} from './value.js'; test('matrix', () => expect(value).toBe(${
          fails ? 2 : 1
        }));`
      )
      // Deliberately no globalSetup: Vitest's mergeReports never initializes it.
      writeFileSync(
        join(root, "vitest.config.js"),
        `
        import {tmpdir} from 'node:os'; import {join} from 'node:path';
        export default {cacheDir:join(tmpdir(), 'vite'),test: {include:['case.test.js'], maxWorkers:1,
          coverage:{enabled:true,provider:'v8',include:['value.js'],reporter:['json'],
          reportsDirectory:join(tmpdir(), 'flows-matrix-probe-coverage-' + process.pid)}}};
      `
      )
      const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }
      delete env.SMITHERS_TEST_PG_URL
      const result = spawnSync(process.execPath, [
        resolve("../smithers/flows/database/scripts/test-matrix.mjs"),
        ...(preserve
          ? [
            "--coverage.reportsDirectory",
            join(root, "published"),
            "--coverage.reporter=json",
            "--coverage.thresholds.lines=100"
          ]
          : [])
      ], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30_000
      })
      assert.equal(result.status === 0, !fails, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /Storage matrix: sqlite/)
      assert.match(result.stdout, /Storage matrix: postgres/)
      if (preserve) assert.equal(existsSync(join(root, "published", "coverage-final.json")), true)
      if (fails) assert.match(result.stdout + result.stderr, /expected 1 to be 2/)
      assert.deepEqual(readdirSync(scratch), [], "the real merge must write inside the matrix's cleanup scope")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`real PostgreSQL matrix reclaims scratch on ${signal}`, { skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "m-"))
    let child
    let postgres
    try {
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction")
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
      writeFileSync(
        join(root, "vitest.config.js"),
        "import {tmpdir} from 'node:os'; import {join} from 'node:path'; export default {cacheDir:join(tmpdir(), 'vite'),test:{include:['case.test.js'],testTimeout:60000,coverage:{enabled:false}}}"
      )
      // Vitest buffers console output until a test finishes; this deliberately
      // pending worker must signal through its actual pipe before cancellation.
      writeFileSync(
        join(root, "case.test.js"),
        "import {test} from 'vitest'; test('running worker', async()=>{process.stdout.write('MATRIX_WORKER_READY\\n');await new Promise(()=>{})})"
      )
      const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root }
      delete env.SMITHERS_TEST_PG_URL
      child = spawn(process.execPath, [
        resolve("../smithers/flows/database/scripts/test-matrix.mjs"),
        "--coverage.enabled=false"
      ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      let sent = false
      child.stdout.on("data", (chunk) => {
        output += chunk
        if (!sent && output.includes("MATRIX_WORKER_READY")) {
          sent = true
          const directory = readdirSync(root).find((name) => name.startsWith("smithers-sql-matrix-"))
          postgres = Number(readFileSync(join(root, directory, "data", "postmaster.pid"), "utf8").split("\n")[0])
          child.kill(signal)
        }
      })
      child.stderr.on("data", (chunk) => {
        output += chunk
      })
      const status = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`matrix ${signal} probe timed out waiting for ${sent ? "child exit" : "worker readiness"}\n${output}`))
        }, 30_000)
        child.on("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on("exit", (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })
      assert.equal(sent, true, output)
      assert.equal(status, signal === "SIGINT" ? 130 : 143, output)
      assert.match(output, /Storage matrix interrupted by/)
      assert.throws(() => process.kill(postgres, 0), { code: "ESRCH" })
      assert.deepEqual(readdirSync(root).sort(), ["case.test.js", "node_modules", "package.json", "vitest.config.js"])
    } finally {
      if (child?.exitCode === null && child?.signalCode === null) {
        // Capture this test's descendants before the parent dies and they are reparented.
        const rows = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout.trim().split("\n").map((row) =>
          row.trim().split(/\s+/).map(Number)
        )
        const owned = new Set([child.pid])
        let changed = true
        while (changed) {
          changed = false
          for (const [pid, parent] of rows) {
            if (owned.has(parent) && !owned.has(pid)) {
              owned.add(pid)
              changed = true
            }
          }
        }
        const exited = new Promise((resolve) => child.once("exit", resolve))
        for (const pid of [...owned].reverse()) {
          try {
            process.kill(-pid, "SIGKILL")
          } catch (error) {
            if (error.code !== "ESRCH") throw error
          }
          try {
            process.kill(pid, "SIGKILL")
          } catch (error) {
            if (error.code !== "ESRCH") throw error
          }
        }
        await exited
      }
      // The postmaster is daemonized, so stop it by its private data directory too.
      for (const name of readdirSync(root).filter((name) => name.startsWith("smithers-sql-matrix-"))) {
        const bin = process.env.PG_BIN ?? (process.platform === "darwin" ? "/opt/homebrew/opt/postgresql@18/bin" : "")
        const result = spawnSync(bin ? join(bin, "pg_ctl") : "pg_ctl", [
          "-D",
          join(root, name, "data"),
          "-m",
          "immediate",
          "-w",
          "stop"
        ], { encoding: "utf8" })
        // A server that never started has no postmaster.pid.
        assert.ok(result.status === 0 || !existsSync(join(root, name, "data", "postmaster.pid")), result.stderr)
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
}
