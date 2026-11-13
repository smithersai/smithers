import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Effect, PlatformError } from "effect"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

const temporary: Array<string> = []
afterEach(() => {
  for (const directory of temporary.splice(0)) Fs.rmSync(directory, { recursive: true, force: true })
})
const directory = () => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "contained-module-"))
  temporary.push(root)
  return root
}
const options = {
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  cwd: process.cwd(),
  stdout: () => {},
  stderr: () => {}
}

for (const extension of ["mjs", "cjs", "js"]) {
  it.runIf(process.platform === "win32")(
    `launches a Windows .${extension} module with literal Node argv`,
    async () => {
      const command = Path.join(directory(), `literal module.${extension}`)
      Fs.writeFileSync(command, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exitCode=23")
      const args = ["space argument", "$(never-evaluate)", "a\"b", "trailing\\", "é"]
      let stdout = ""
      expect(await ContainedProcess.run({ ...options, command, args, stdout: (text) => stdout += text })).toBe(23)
      expect(JSON.parse(stdout)).toEqual(args)
    }
  )
}

it.each(["missing.mjs", "directory.mjs"])("preserves native spawn refusal for %s", async (name) => {
  const command = Path.join(directory(), name)
  if (name === "directory.mjs") Fs.mkdirSync(command)
  await expect(ContainedProcess.run({ ...options, command })).rejects.toMatchObject({ code: "process_failed" })
})

it.each([false, true])(
  "retains an injected cleanup failure after stopping the real child (timeout=%s)",
  async (timeout) => {
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "kill",
      cause: new Error("owner stop denied")
    })
    let stopped = 0
    const spawner = {
      spawn: (options: ScopedProcess.Options) =>
        ScopedProcess.spawn(options).pipe(Effect.map((handle) => ({
          ...handle,
          kill: (options: Parameters<typeof handle.kill>[0]) =>
            handle.kill(options).pipe(
              Effect.andThen(Effect.sync(() => stopped++)),
              Effect.andThen(Effect.fail(failure))
            )
        })))
    }
    const error = await Effect.runPromise(Effect.flip(
      ContainedProcess.runEffect({
        ...options,
        args: timeout ? ["-e", "setInterval(() => {}, 1000)"] : options.args,
        ...(timeout ? { timeoutMs: 1000 } : {})
      }).pipe(
        Effect.provideService(ContainedProcess.ProcessSpawner, spawner)
      )
    ))
    expect(error).toMatchObject({ code: "cleanup_failed", cause: failure })
    expect(stopped).toBe(1)
  }
)

for (const timeout of [false, true]) {
  it.runIf(process.platform === "win32")(`joins the native Windows process tree (timeout=${timeout})`, async () => {
    let stdout = ""
    let pid: number | undefined
    const pending = ContainedProcess.run({
      ...options,
      args: [
        "-e",
        `
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
child.unref(); process.stdout.write(String(child.pid));
${timeout ? "setInterval(()=>{},1000)" : ""}
`
      ],
      timeoutMs: 5000,
      stdout: (text) => stdout += text
    })
    try {
      if (timeout) await expect(pending).rejects.toMatchObject({ code: "timed_out" })
      else expect(await pending).toBe(0)
      pid = Number(stdout)
      expect(pid).toBeGreaterThan(0)
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      const ownedPid = pid ?? Number(stdout)
      if (Number.isSafeInteger(ownedPid) && ownedPid > 0) {
        try {
          process.kill(ownedPid, "SIGKILL")
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
        }
      }
    }
  }, 30_000)
}
