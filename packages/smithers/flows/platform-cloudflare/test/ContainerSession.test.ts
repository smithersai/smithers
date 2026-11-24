/**
 * `ContainerSession` over a container whose commands are real local
 * processes (`fixtures/ProcessContainer.ts`), so `@smthrs/sandbox`'s
 * `SandboxTools` run their real scripts through it, with the container's
 * faults injected through the fixture's options.
 */
import { describe, expect, it } from "@effect/vitest"
import { SandboxTools } from "@smthrs/sandbox"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import { ContainerSession } from "../src/index.ts"
import * as ProcessContainer from "./fixtures/ProcessContainer.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-container-session-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8"
  })

const text = (stream: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(stream))

describe("ContainerSession", () => {
  it.effect("runs commands as its user in its workdir, with its environment under the command's", () =>
    Effect.gen(function*() {
      const { commands, container } = ProcessContainer.make()
      const session = yield* ContainerSession.make(container, {
        id: "branch-1",
        workdir: root,
        user: "100123:2000",
        env: { SHARED: "session", KEPT: "kept" }
      })
      expect(session).toMatchObject({ id: "branch-1", remoteId: "branch-1", workdir: root })
      const out = yield* Effect.scoped(Effect.gen(function*() {
        const process = yield* session.spawn("pwd; echo $SHARED $KEPT; cat", {
          env: { SHARED: "command", DROPPED: undefined },
          stdin: new TextEncoder().encode("fed")
        })
        return { stdout: yield* text(process.stdout), code: yield* process.exitCode }
      }))
      expect(out).toEqual({ stdout: `${root}\ncommand kept\nfed`, code: 0 })
      expect(commands[0]).toEqual({
        argv: ["sh", "-c", "unset DROPPED || exit 125; pwd; echo $SHARED $KEPT; cat"],
        options: {
          user: "100123:2000",
          cwd: root,
          env: { SHARED: "command", KEPT: "kept" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe"
        }
      })
      // A relative cwd is under the workdir; an absolute one is itself.
      const where = (cwd: string) =>
        Effect.scoped(Effect.flatMap(session.spawn("pwd", { cwd }), (process) => text(process.stdout)))
      execFileSync("mkdir", ["-p", join(root, "sub")])
      expect(yield* where("sub")).toBe(`${root}/sub\n`)
      expect(yield* where("/")).toBe("/\n")
      expect(commands.at(-1)!.options.user).toBe("100123:2000")
    }))

  it.effect.each(["smithers", "1000", "1000:2000;id", " 1000:2000"])(
    "refuses user %j before the container runs anything",
    (user) =>
      Effect.gen(function*() {
        const { commands, container } = ProcessContainer.make()
        const session = yield* ContainerSession.make(container, { id: "named", workdir: root, user })
        const error = yield* Effect.flip(Effect.scoped(session.spawn("true", {})))
        expect(error).toMatchObject({
          code: "spawn_error",
          message: "container session: the user is not a numeric uid:gid"
        })
        expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "spawn_error" })
        expect(commands).toEqual([])
      })
  )

  it.effect("reads and writes files byte for byte, making directories, and reports an absent one", () =>
    Effect.gen(function*() {
      const { container } = ProcessContainer.make()
      const session = yield* ContainerSession.make(container, { id: "files", workdir: root })
      const bytes = new Uint8Array([0, 1, 2, 255, 10])
      yield* session.writeFile(join(root, "deep/dir/blob.bin"), bytes)
      expect([...readFileSync(join(root, "deep/dir/blob.bin"))]).toEqual([...bytes])
      expect([...(yield* session.readFile(join(root, "deep/dir/blob.bin")))]).toEqual([...bytes])
      const absent = yield* Effect.flip(session.readFile(join(root, "absent")))
      expect(absent).toMatchObject({ code: "not_found" })
      const directory = yield* Effect.flip(session.readFile(root))
      expect(directory).toMatchObject({ code: "not_found" })
      writeFileSync(join(root, "a-file"), "")
      const blocked = yield* Effect.flip(session.writeFile(join(root, "a-file/below"), bytes))
      expect(blocked).toMatchObject({ code: "unknown" })
      yield* session.ping!
    }))

  it.effect("removes a session and image variable from the guest environment", () =>
    Effect.gen(function*() {
      const { container } = ProcessContainer.make()
      const session = yield* ContainerSession.make(container, {
        id: "env-delete",
        workdir: root,
        env: { HOME: "/session" }
      })
      const read = (env: { HOME?: string | undefined }) =>
        Effect.scoped(Effect.gen(function*() {
          const process = yield* session.spawn("printf '%s' \"${HOME-unset}\"", { env })
          return yield* text(process.stdout)
        }))
      expect(yield* read({})).toBe("/session")
      expect(yield* read({ HOME: undefined })).toBe("unset")
      const image = yield* ContainerSession.make(container, { id: "image-delete", workdir: root })
      expect(
        yield* Effect.scoped(Effect.flatMap(
          image.spawn("printf '%s' \"${HOME-unset}\"", { env: { HOME: undefined } }),
          (process) => text(process.stdout)
        ))
      ).toBe("unset")
      expect(yield* Effect.flip(Effect.scoped(image.spawn("true", { env: { "a-b": undefined } })))).toMatchObject({
        code: "spawn_error"
      })
    }))

  it.live("returns the real exit code when stdin feeding is stalled and interrupts the feed", () =>
    Effect.gen(function*() {
      const real = ProcessContainer.make().container
      let interrupted = false
      const faulty: ContainerSession.Container<ProcessContainer.ProcessFailure> = {
        exec: (argv, options) =>
          Effect.map(real.exec(argv, options), (child) => ({
            ...child,
            stdin: Sink.forEach((_chunk: Uint8Array) =>
              Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
                interrupted = true
              })))
            )
          }))
      }
      const session = yield* ContainerSession.make(faulty, { id: "early-exit", workdir: root })
      const code = yield* Effect.scoped(Effect.gen(function*() {
        const child = yield* session.spawn("exit 7", { stdin: new Uint8Array([1, 2]) })
        return yield* child.exitCode.pipe(Effect.timeout("2 seconds"))
      }))
      expect(code).toBe(7)
      expect(interrupted).toBe(true)
    }))

  it.effect("preserves an early exit code after its stdin sink has already failed", () =>
    Effect.gen(function*() {
      const failed = yield* Deferred.make<void>()
      const real = ProcessContainer.make().container
      const faulty: ContainerSession.Container<ProcessContainer.ProcessFailure> = {
        exec: (argv, options) =>
          Effect.map(real.exec(argv, options), (child) => ({
            ...child,
            stdin: Sink.forEach((_chunk: Uint8Array) =>
              Effect.fail(new ProcessContainer.ProcessFailure({ message: "closed pipe" })).pipe(
                Effect.ensuring(Deferred.succeed(failed, undefined))
              )
            ),
            exitCode: Effect.andThen(Deferred.await(failed), child.exitCode)
          }))
      }
      const session = yield* ContainerSession.make(faulty, { id: "failed-feed", workdir: root })
      expect(
        yield* Effect.scoped(Effect.gen(function*() {
          const child = yield* session.spawn("exit 7", { stdin: new Uint8Array([1]) })
          return yield* child.exitCode
        }))
      ).toBe(7)
    }))

  it.effect("bounds file collection before allocation and can read another file after refusal", () =>
    Effect.gen(function*() {
      const session = yield* ContainerSession.make(ProcessContainer.make().container, {
        id: "bounded",
        workdir: root,
        maxFileBytes: 1024
      })
      const path = join(root, "oversized")
      writeFileSync(path, new Uint8Array(100_000))
      expect(yield* Effect.flip(session.readFile(path))).toMatchObject({
        code: "unknown",
        message: "container session: file byte limit exceeded"
      })
      writeFileSync(path, new Uint8Array([1, 2, 3]))
      expect(yield* session.readFile(path)).toEqual(new Uint8Array([1, 2, 3]))
    }))

  it.effect("carries SandboxTools: a command at most once, a file, the status and the diff", () =>
    Effect.gen(function*() {
      const workdir = join(root, "repo")
      execFileSync("mkdir", ["-p", workdir])
      git(workdir, "init", "-q", "-b", "main")
      writeFileSync(join(workdir, "README.md"), "hello\n")
      git(workdir, "add", ".")
      git(workdir, "commit", "-q", "-m", "first")
      const { container } = ProcessContainer.make()
      const session = yield* ContainerSession.make(container, { id: "tools", workdir })
      const options = { callId: "call-1", callsDirectory: join(root, "calls") }
      const call = { tool: "run", command: "echo ran >> runs.log; cat runs.log" } as const
      const first = yield* SandboxTools.execute(session, call, options)
      expect(yield* SandboxTools.execute(session, call, options)).toEqual(first)
      expect(first).toMatchObject({ exitCode: 0, stdout: "ran\n" })
      yield* SandboxTools.execute(session, { tool: "write", path: "hello.txt", content: "hi\n" }, options)
      expect(yield* SandboxTools.execute(session, { tool: "status" }, options)).toMatchObject({
        branch: "main",
        entries: [{ path: "hello.txt", index: "?", worktree: "?" }, { path: "runs.log", index: "?", worktree: "?" }]
      })
      const diff = yield* SandboxTools.execute(session, { tool: "diff", paths: ["hello.txt"] }, options)
      expect(diff).toMatchObject({ tool: "diff", truncated: false })
      expect((diff as typeof SandboxTools.DiffResult.Type).diff).toContain("+hi")
    }))

  it.effect("fails unavailable when the container can't run a command or gives it no streams", () =>
    Effect.gen(function*() {
      const over = (faults: ProcessContainer.Faults) =>
        ContainerSession.make(ProcessContainer.make(faults).container, { id: "faulty", workdir: root })
      const failing = yield* over({ exec: true })
      expect(yield* Effect.flip(Effect.scoped(failing.spawn("true", {})))).toMatchObject({
        code: "unavailable",
        message: "container session: exec failed"
      })
      expect(yield* Effect.flip(failing.ping!)).toMatchObject({ code: "unavailable" })
      const truncated = yield* over({ truncatedStdin: true, exitCode: 0 })
      expect(yield* Effect.flip(truncated.writeFile("prefix", new Uint8Array([1, 2])))).toMatchObject({
        code: "unavailable",
        message: "container session: stdin failed"
      })
      const silent = yield* over({ noStdout: true })
      expect(yield* Effect.flip(Effect.scoped(silent.spawn("true", {})))).toMatchObject({ code: "unavailable" })
      const deaf = yield* over({ noStdin: true })
      expect(yield* Effect.flip(Effect.scoped(deaf.spawn("cat", { stdin: new Uint8Array([1]) })))).toMatchObject({
        code: "unavailable"
      })
      // Without input asked for, a missing stdin is no fault.
      expect(yield* Effect.scoped(Effect.flatMap(deaf.spawn("echo ok", {}), (process) => text(process.stdout)))).toBe(
        "ok\n"
      )
      // A stream that breaks off and an exit that can't be read fail unavailable, naming the operation.
      const broken = yield* over({ brokenStdout: true })
      expect(yield* Effect.flip(broken.ping!)).toMatchObject({
        code: "unavailable",
        message: "container session: stdout failed"
      })
      const lost = yield* over({ exitFails: "untagged" })
      expect(yield* Effect.flip(lost.ping!)).toMatchObject({
        code: "unavailable",
        message: "container session: exit failed"
      })
      const sick = yield* over({ exitCode: 1 })
      expect(yield* Effect.flip(sick.ping!)).toMatchObject({
        code: "unavailable",
        message: "container session: ping failed (1)"
      })
      expect(yield* Effect.flip(sick.readFile(join(root, "a-file")))).toMatchObject({ code: "unknown" })
    }))

  it.effect("logs the container's own failures by operation and tag, never their text", () => {
    const t = Telemetry.make()
    return Effect.gen(function*() {
      const over = (faults: ProcessContainer.Faults) =>
        ContainerSession.make(ProcessContainer.make(faults).container, { id: "logged", workdir: root })
      yield* Effect.flip((yield* over({ exec: true })).ping!)
      yield* Effect.flip((yield* over({ brokenStdout: true })).ping!)
      yield* Effect.flip((yield* over({ exitFails: "untagged" })).ping!)
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.lines("cloudflare.container_session").map((line) => line.annotations)).toEqual([
          expect.objectContaining({ operation: "exec", outcome: "failed", "error.type": "ProcessFailure" }),
          expect.objectContaining({ operation: "stdout", outcome: "failed", "error.type": "ProcessFailure" }),
          expect.objectContaining({ operation: "exit", outcome: "failed", "error.type": "unknown" })
        ])
        t.expectNoContent("exec broke")
        t.expectNoContent("stdout broke")
      }))
    )
  })
})
