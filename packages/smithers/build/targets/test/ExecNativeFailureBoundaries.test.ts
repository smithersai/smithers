import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import { Process } from "../src/internal/Process.ts"
import { SandboxHost } from "../src/internal/SandboxHost.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "exec-native-boundary-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload = (script: string): Exec.Payload => ({
  cwd: ".",
  argv: [process.execPath, "-e", script],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 5000
})

describe("native exec confinement and capture", () => {
  it("keeps an exact full prefix when another real stdout chunk arrives later", async () => {
    const result = await Effect.runPromise(Exec.run(
      { workspaceRoot: root },
      payload(
        `process.stdout.write("a".repeat(${Exec.outputLimit}),()=>setTimeout(()=>process.stdout.write("later"),50))`
      )
    ))
    expect(result.stdout).toBe("a".repeat(Exec.outputLimit))
  })

  it.runIf(process.platform !== "win32")("refuses an actual symlink loop in the configured cache path", async () => {
    await Fs.symlink("loop", Path.join(root, "loop"))
    const error = await Effect.runPromise(Effect.flip(Exec.run({
      workspaceRoot: root,
      cacheDirectory: "loop/cache"
    }, payload("process.stdout.write('unexpected')"))))
    expect(error.code).toBe("invalid_payload")
    expect(error.stderr).toContain("ELOOP")
    expect(error.stdout).toBe("")
  })

  it("resolves through an ENOTDIR cache ancestor before the child reports a native write failure", async () => {
    await Fs.writeFile(Path.join(root, "file"), "regular file")
    const error = await Effect.runPromise(Effect.flip(Exec.run({
      workspaceRoot: root,
      cacheDirectory: "file/cache"
    }, payload(`require("node:fs").mkdirSync(${JSON.stringify(Path.join(root, "file/cache"))},{recursive:true})`))))
    expect(error.code).toBe("exit_status")
    expect(error.stderr).toContain("ENOTDIR")
    expect(await Fs.readFile(Path.join(root, "file"), "utf8")).toBe("regular file")
  })
})

it.each(["stdout", "status"] as const)("preserves a %s service failure without an underlying cause", async (site) => {
  const failure = PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: site,
    description: "host pipe unavailable"
  })
  const error = await Effect.runPromise(Effect.flip(
    Exec.run({ workspaceRoot: root }, payload("setTimeout(()=>{},10000)")).pipe(
      Effect.provideService(Process, {
        spawn: (options) =>
          ScopedProcess.spawn(options).pipe(
            Effect.map((handle) => site === "stdout" ? { ...handle, stdout: Stream.fail(failure) } : handle)
          ),
        status: site === "status" ? () => Effect.fail(failure) : ScopedProcess.status
      })
    )
  ))
  expect(error.code).toBe("stream_failed")
  expect(error.stderr).toBe(site === "stdout" ? "stdout could not be read: unknown failure" : "unknown failure")
})

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "annotates a native permission denial from a confined launcher",
  async () => {
    const directory = Path.join(root, "denied")
    await Fs.mkdir(directory, { mode: 0 })
    try {
      const script = `require("node:fs").writeFileSync(${JSON.stringify(Path.join(directory, "file"))},"attempt")`
      const error = await Effect.runPromise(Effect.flip(
        Exec.run({
          workspaceRoot: root,
          environment: { path: process.env.PATH ?? "", variables: { OPTIONAL_BOUNDARY: undefined as never } },
          sandbox: { policy: {}, reads: [], writes: [], mechanism: { _tag: "SandboxDocker", image: "fixture" } }
        }, payload(script)).pipe(
          Effect.provideService(SandboxHost, {
            ...ExecSandbox.host(),
            executable: () => process.execPath
          }),
          Effect.provideService(Process, {
            spawn: (options) =>
              ScopedProcess.spawn({
                ...options,
                command: process.execPath,
                args: options.args?.[0] === "rm" ? ["-e", ""] : ["-e", script]
              }),
            status: ScopedProcess.status
          })
        )
      ))
      expect(error.code).toBe("exit_status")
      expect(error.stderr).toContain("EACCES")
      expect(error.stderr).toContain("sandbox: denied/file is outside the declared read set")
    } finally {
      await Fs.chmod(directory, 0o700)
    }
  }
)
