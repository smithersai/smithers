import { spawn } from "node:child_process"
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveJobExecutable, WindowsProcessJob } from "../src/internal/WindowsProcessJob.ts"
import { waitForExit } from "./helpers/waitForExit.ts"

const identity = "123456789012345678"
const ready = { status: "ready", ownerPid: 4321 }
const settled = { status: "settled" }
const directories: Array<string> = []
const jobs: Array<{ readonly job: WindowsProcessJob; readonly pidFile?: string }> = []
const configured = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY

// A real child owns the three pipes. It verifies the command and isolation at
// the OS boundary, emits the requested protocol, then exits only after EOF.
const scriptFor = (source: string) => {
  const directory = mkdtempSync(join(tmpdir(), "windows-job-protocol-"))
  directories.push(directory)
  const script = join(directory, "guardian.cjs")
  const pidFile = join(directory, "pid")
  writeFileSync(
    script,
    `
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const path = require("node:path");
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--process-job", "4321", "${identity}"])) process.exit(90);
    if (process.cwd() !== path.parse(process.execPath).root) process.exit(91);
    if (process.env.SMITHERS_JOB_TEST_SECRET !== undefined) process.exit(92);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    ${source}
  `
  )
  return { script, pidFile }
}
const jobFor = (source: string) => {
  const { script, pidFile } = scriptFor(source)
  const job = new WindowsProcessJob(4321, identity, process.execPath, [script])
  jobs.push({ job, pidFile })
  return job
}
const expectStopped = async (job: WindowsProcessJob) => {
  const pidFile = jobs.find((entry) => entry.job === job)!.pidFile!
  const pid = Number(readFileSync(pidFile, "utf8"))
  expect(await waitForExit(pid, 2000), "failure must close the control pipe without caller cleanup").toBe(true)
}
const frames = (values: ReadonlyArray<unknown>) =>
  `process.stdout.write(${JSON.stringify(values.map((value) => JSON.stringify(value) + "\n").join(""))});`

afterEach(async () => {
  for (const { job, pidFile } of jobs.splice(0)) {
    job.stop()
    // A rejected protocol promise precedes process exit. Verify the OS child
    // separately before removing its files, also on malformed-output paths.
    if (pidFile !== undefined && existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"))
      const exited = await waitForExit(pid, 2000)
      if (!exited) {
        process.kill(pid, "SIGKILL")
        await waitForExit(pid, 2000)
      }
      await job.settled.promise.catch(() => {})
      expect(exited, "the fixture must exit after its control pipe closes").toBe(true)
    } else {
      await job.settled.promise.catch(() => {})
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (configured === undefined) delete process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  else process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = configured
  delete process.env.SMITHERS_JOB_TEST_SECRET
})

describe("Windows native job connection", () => {
  it("pins identity and isolation, parses split frames, and waits for helper close", async () => {
    process.env.SMITHERS_JOB_TEST_SECRET = "must-stay-in-host"
    const job = jobFor(`
      process.stdout.write('{"status":"rea');
      setTimeout(() => process.stdout.write('dy","ownerPid":4321}\\n{"status":"settled"}\\n'), 20);
    `)
    let done = false
    void job.settled.promise.then(() => {
      done = true
    })
    await job.ready.promise
    expect(done).toBe(false)
    job.reference(false)
    job.reference(true)
    job.stop()
    await job.settled.promise
    expect(done).toBe(true)
  })

  for (const referenced of [false, true]) {
    it(`makes the real child and its pipes keep the host alive only when referenced=${referenced}`, async () => {
      const { script, pidFile } = scriptFor(frames([ready, settled]))
      const module = new URL("../src/internal/WindowsProcessJob.ts", import.meta.url).href
      const source = `
        import { WindowsProcessJob } from ${JSON.stringify(module)};
        const job = new WindowsProcessJob(4321, "${identity}", process.execPath, [${JSON.stringify(script)}]);
        await job.ready.promise;
        job.reference(false);
        if (${referenced}) job.reference(true);
        process.stdout.write("ready");
      `
      const driver = spawn(process.execPath, ["--input-type=module", "-e", source], {
        stdio: ["ignore", "pipe", "pipe"]
      })
      let diagnostics = ""
      driver.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString()
      })
      const closed = new Promise<number | null>((resolve) => driver.once("close", (code) => resolve(code)))
      const started = new Promise<void>((resolve, reject) => {
        driver.stdout.once("data", () => resolve())
        driver.once("error", reject)
        driver.once("close", (code) => reject(new Error(`reference driver exited ${code}: ${diagnostics}`)))
      })
      try {
        await started
        expect(await waitForExit(driver.pid!, 2000)).toBe(!referenced)
        if (!referenced) expect(await closed).toBe(0)
      } finally {
        driver.kill("SIGKILL")
        await closed
        if (existsSync(pidFile)) {
          expect(await waitForExit(Number(readFileSync(pidFile, "utf8")), 2000)).toBe(true)
        }
      }
    })
  }

  it("names the variable and install hint for a genuinely missing configured helper", () => {
    const directory = mkdtempSync(join(tmpdir(), "windows-job-missing-"))
    directories.push(directory)
    process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = join(directory, "missing")
    expect(() => resolveJobExecutable()).toThrow(/SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=.*ENOENT.*cargo build --locked/)
  })

  it("uses the installed default or reports its missing installation when unconfigured", () => {
    delete process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
    let executable: string | undefined
    let failure: unknown
    try {
      executable = resolveJobExecutable()
    } catch (cause) {
      failure = cause
    }
    if (failure === undefined) {
      expect(executable).toBeDefined()
      expect(() => accessSync(executable!, constants.X_OK)).not.toThrow()
    } else {
      expect(failure).toMatchObject({
        code: "helper_missing",
        message: expect.stringContaining("first run cargo build --locked")
      })
    }
  })

  it("validates an explicitly configured executable on the real filesystem", () => {
    process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = process.execPath
    const executable = resolveJobExecutable()
    expect(executable).toBe(realpathSync(process.execPath))
    expect(existsSync(executable)).toBe(true)
    expect(() => accessSync(executable, constants.X_OK)).not.toThrow()
  })

  for (const created of [undefined, null, 123, "", "0", "-1", "1e10", "123456789012345678901"]) {
    it(`refuses an unverified owner-reported identity ${String(created)}`, () => {
      expect(() => new WindowsProcessJob(4321, created, join(tmpdir(), "missing-job-executable"))).toThrow(
        expect.objectContaining({ code: "owner_identity_missing" })
      )
    })
  }

  for (
    const values of [
      [settled],
      [{ ...ready, ownerPid: 999 }],
      [ready, ready],
      [ready, settled, settled],
      [null],
      [{ status: "unknown" }]
    ]
  ) {
    it(`refuses out-of-order or malformed status ${JSON.stringify(values)}`, async () => {
      const job = jobFor(frames([...values, ready]))
      await expect(job.settled.promise).rejects.toMatchObject({ code: "status_invalid" })
      await expectStopped(job)
    })
  }

  for (const output of ["x".repeat(4097), "invalid\n"]) {
    it("refuses oversized or unparseable output from a real helper", async () => {
      const job = jobFor(`process.stdout.write(${JSON.stringify(output)});`)
      const fault = output.length > 4096 ? { code: "status_too_large" } : { name: "SyntaxError" }
      await expect(job.ready.promise).rejects.toMatchObject(fault)
      await expect(job.settled.promise).rejects.toMatchObject(fault)
      await expectStopped(job)
    })
  }

  it("retains an actual spawn failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "windows-job-spawn-"))
    directories.push(directory)
    const job = new WindowsProcessJob(4321, identity, join(directory, "missing"))
    jobs.push({ job })
    await expect(job.ready.promise).rejects.toMatchObject({ code: "ENOENT" })
    await expect(job.settled.promise).rejects.toMatchObject({ code: "ENOENT" })
  })

  for (const [code, receipt, trailing] of [[1, true, ""], [0, false, ""], [0, true, "partial"]] as const) {
    it(`requires verified close ${code}/${receipt}/${trailing}`, async () => {
      const job = jobFor(`
        ${frames(receipt ? [ready, settled] : [ready])}
        process.stdout.write(${JSON.stringify(trailing)}, () => process.exit(${code}));
      `)
      await expect(job.settled.promise).rejects.toMatchObject({
        _tag: "@smthrs/platform-node/ProcessFault",
        code: "cleanup_unverified"
      })
    })
  }

  it.skipIf(process.platform === "win32")(
    "rejects a helper terminated by a signal even after its receipt",
    async () => {
      const output = JSON.stringify(ready) + "\n" + JSON.stringify(settled) + "\n"
      const job = jobFor(
        `process.stdout.write(${JSON.stringify(output)}, () => process.kill(process.pid, "SIGKILL"));`
      )
      await job.ready.promise
      await expect(job.settled.promise).rejects.toMatchObject({ code: "cleanup_unverified" })
    }
  )
})
