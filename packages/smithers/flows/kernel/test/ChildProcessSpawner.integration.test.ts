import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber, Option, type PlatformError, Redacted } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner as EffectChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as CommandLine from "../src/CommandLine.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as Workspace from "../src/Workspace.ts"

const directories = new Set<string>()

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "flows-kernel-process-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

const withGuardedSpawner = <A, E>(
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, EffectChildProcessSpawner>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make(options)
      return yield* use(store).pipe(
        Effect.provide(ChildProcessSpawner.layer),
        Effect.provide(ProcessConfinement.layerNoop),
        Effect.provide(NodeChildProcessSpawner.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer(process.cwd())))

const waitForEsrch = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
        return
      }
      throw error
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`process ${pid} was not reaped`)
}

describe("ChildProcessSpawner real Node lifecycle", () => {
  it.effect("refuses oversized command metadata in the typed channel before execution", () =>
    withGuardedSpawner({
      attended: false,
      rules: [
        new Permission.Rule({
          effect: "allow",
          pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" })
        })
      ]
    }, () =>
      Effect.gen(function*() {
        const spawner = yield* EffectChildProcessSpawner
        const code = `/*${"x".repeat(GrantStore.maximumMetadataBytes)}*/`
        const error = yield* Effect.flip(spawner.string(ChildProcess.make(process.execPath, ["-e", code])))
        expect(Option.getOrThrow(Permission.fromPlatformError(error))).toMatchObject({
          code: "invalid_resolution",
          message: expect.stringContaining("metadata exceeds")
        })
      })))

  it.effect("never reuses a digest-form literal run grant for a different long shell command", () =>
    withGuardedSpawner({ planDigest: "command-plan" }, (store) =>
      Effect.gen(function*() {
        const spawner = yield* EffectChildProcessSpawner
        const line = `echo ${" ".repeat(3895)}long-text${" ".repeat(500)}`
        const literal = `${line.slice(0, 3900)}… sha256:${createHash("sha256").update(line).digest("hex")}`
        const first = yield* spawner.string(ChildProcess.make(literal, { shell: true })).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const approved = yield* awaitPending(store)
        expect(approved.capability.resource).not.toBe(literal)
        yield* store.reply(approved.requestId, "run")
        expect((yield* Fiber.join(first)).trim()).toContain("sha256:")
        const next = yield* spawner.string(ChildProcess.make(line, { shell: true })).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* Effect.raceFirst(
          awaitPending(store),
          Fiber.join(next).pipe(
            Effect.andThen(Effect.fail(new Error("a literal run grant authorized another command")))
          )
        )
        expect(pending.capability.resource).not.toBe(approved.capability.resource)
        yield* store.reply(pending.requestId, "deny")
        expect((yield* Fiber.await(next))._tag).toBe("Failure")
      })))

  it.effect("runs long argument and shell commands under an explicit allow policy", () =>
    Effect.gen(function*() {
      const code = `console.log(42);//${"x".repeat(5000)}`
      const rules = [
        new Permission.Rule({
          effect: "allow",
          pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" })
        })
      ]
      for (
        const command of [
          ChildProcess.make(process.execPath, ["-e", code]),
          ChildProcess.make(`echo 42 #${"x".repeat(5000)}`, { shell: true })
        ]
      ) {
        const output = yield* withGuardedSpawner(
          { attended: false, rules },
          () => Effect.flatMap(EffectChildProcessSpawner, (spawner) => spawner.string(command))
        )
        expect(output.trim()).toBe("42")
      }
    }))

  it.effect("retains the full rendered command in attended metadata and binds the whole suffix", () =>
    withGuardedSpawner({ planDigest: "command-plan" }, (store) =>
      Effect.gen(function*() {
        const spawner = yield* EffectChildProcessSpawner
        const code = `console.log(42);//${"x".repeat(5000)}`
        const command = ChildProcess.make(process.execPath, ["-e", code])
        const rendered = CommandLine.resource(command)
        const child = yield* spawner.string(command).pipe(Effect.forkChild({ startImmediately: true }))
        const pending = yield* awaitPending(store)
        const digest = createHash("sha256").update(rendered).digest("hex")
        expect(pending.capability).toEqual({
          action: "proc:spawn",
          resource: `${rendered.slice(0, 3900)}… sha256:${digest}`
        })
        expect(pending.meta.commandLine).toBe(rendered)
        yield* store.reply(pending.requestId, "run")
        expect((yield* Fiber.join(child)).trim()).toBe("42")
        const changed = ChildProcess.make(process.execPath, ["-e", code + "y"])
        const next = yield* spawner.string(changed).pipe(Effect.forkChild({ startImmediately: true }))
        const second = yield* awaitPending(store)
        expect(second.capability.resource).not.toBe(pending.capability.resource)
        yield* store.reply(second.requestId, "deny")
        expect((yield* Fiber.await(next))._tag).toBe("Failure")
      })))

  it.effect("withholds ambient credentials unless a child explicitly declares them", () =>
    Effect.gen(function*() {
      const name = "SMITHERS_CHILD_TEST_SECRET"
      const previous = process.env[name]
      process.env[name] = "ambient-secret"
      try {
        const cases: Array<ChildProcess.CommandOptions> = [
          {},
          { extendEnv: true },
          { env: { ORDINARY: "kept" }, extendEnv: true },
          { env: { [name]: "declared-secret" }, extendEnv: true },
          { env: { [name]: "declared-secret" }, extendEnv: false },
          { env: { PATH: undefined }, extendEnv: true }
        ]
        for (const options of cases) {
          const command = ChildProcess.make(process.execPath, [
            "-e",
            "console.log(JSON.stringify({secret:process.env.SMITHERS_CHILD_TEST_SECRET,path:process.env.PATH,ordinary:process.env.ORDINARY}))"
          ], options)
          const pattern = new CapabilityPattern({ action: "proc:spawn", resource: "**" })
          const output = yield* withGuardedSpawner({
            attended: false,
            rules: [new Permission.Rule({ effect: "allow", pattern })]
          }, () => Effect.flatMap(EffectChildProcessSpawner, (spawner) => spawner.string(command)))
          const declared = options.env
          expect(JSON.parse(output)).toEqual({
            ...(declared?.[name] === undefined ? {} : { secret: declared[name] }),
            ...(declared?.ORDINARY === undefined ? {} : { ordinary: declared.ORDINARY }),
            ...(options.extendEnv === false || declared !== undefined && "PATH" in declared
              ? process.platform === "win32" ? { path: "" } : {}
              : { path: process.env.PATH })
          })
        }
        const producer = ChildProcess.make(process.execPath, [
          "-e",
          "console.log(process.env.SMITHERS_CHILD_TEST_SECRET ?? 'withheld')"
        ])
        const consumer = ChildProcess.make(process.execPath, [
          "-e",
          "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({input,secret:process.env.SMITHERS_CHILD_TEST_SECRET})))"
        ], { extendEnv: true })
        const pattern = new CapabilityPattern({ action: "proc:spawn", resource: "**" })
        const output = yield* withGuardedSpawner({
          attended: false,
          rules: [new Permission.Rule({ effect: "allow", pattern })]
        }, () =>
          Effect.flatMap(EffectChildProcessSpawner, (spawner) =>
            spawner.string(ChildProcess.pipeTo(consumer)(producer))))
        expect(JSON.parse(output)).toEqual({ input: "withheld\n" })
      } finally {
        if (previous === undefined) {
          delete process.env[name]
        } else process.env[name] = previous
      }
    }))

  it.effect("reveals a protected argument to the real child while its grant binds that one hidden value", () =>
    Effect.gen(function*() {
      const command = (secret: string) =>
        ChildProcess.make(process.execPath, ["-e", "console.log(process.argv[1])", Redacted.make(secret)])
      const outputs = yield* withGuardedSpawner(
        { runId: "protected-argument", planDigest: "protected-plan" },
        (store) =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            const first = yield* spawner.string(command("protected argument")).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const approved = yield* awaitPending(store)
            expect(approved.capability.resource).toMatch(/'<redacted:[0-9a-f]{16}>'$/)
            expect(approved.capability.resource).not.toContain("protected argument")
            yield* store.reply(approved.requestId, "run")
            const revealed = yield* Fiber.join(first)
            const again = yield* spawner.string(command("protected argument"))

            const other = yield* spawner.string(command("other value")).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const asked = yield* awaitPending(store)
            expect(asked.capability.resource).not.toBe(approved.capability.resource)
            yield* store.reply(asked.requestId, "deny")
            const denied = yield* Effect.flip(Fiber.join(other))
            return { revealed, again, denied }
          })
      )
      expect(outputs.revealed.trim()).toBe("protected argument")
      expect(outputs.again.trim()).toBe("protected argument")
      expect(Option.isSome(Permission.fromPlatformError(outputs.denied as PlatformError.PlatformError))).toBe(true)
    }))

  it.effect("refuses a protected argument passed through a shell before asking for a grant", () =>
    Effect.gen(function*() {
      const shells: ReadonlyArray<ChildProcess.CommandOptions["shell"]> = [true, "/bin/sh"]
      for (const shell of shells) {
        const failure = yield* withGuardedSpawner({ runId: "protected-shell" }, (store) =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            const failure = yield* Effect.flip(
              spawner.string(ChildProcess.make("echo", [Redacted.make("x; touch pwned")], { shell }))
            )
            expect(yield* store.list).toEqual([])
            return failure
          }))
        expect(failure).toMatchObject({
          reason: { _tag: "InvalidData", description: expect.stringContaining("protected argument") }
        })
      }
    }))

  it.effect("passes own __proto__ and ordinary environment values to a real child", () =>
    Effect.gen(function*() {
      const env = Object.create(null) as Record<string, string>
      env.__proto__ = "kept-env"
      env.ORDINARY = "kept"
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "console.log(JSON.stringify({ordinary:process.env.ORDINARY,special:process.env['__proto__']}))"
      ], { env, extendEnv: false })
      const pattern = new CapabilityPattern({ action: "proc:spawn", resource: "**" })
      const output = yield* withGuardedSpawner({
        attended: false,
        rules: [new Permission.Rule({ effect: "allow", pattern })]
      }, () =>
        Effect.gen(function*() {
          const spawner = yield* EffectChildProcessSpawner
          return yield* spawner.string(command)
        }))
      expect(JSON.parse(output)).toEqual({ ordinary: "kept", special: "kept-env" })
    }))

  it.effect("leaves no process side effect when the real store denies before spawn", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const token = join(directory, "denied-token")
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
        token
      ])

      const failure = yield* (
        withGuardedSpawner({ attended: false, runId: "denied-process" }, () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            return yield* Effect.flip(spawner.exitCode(command))
          }))
      )
      const permission = Option.getOrThrow(
        Permission.fromPlatformError(failure as PlatformError.PlatformError)
      )

      expect(permission).toBeInstanceOf(Permission.PermissionRequired)
      expect(permission).toMatchObject({
        code: "permission_required",
        capability: { action: "proc:spawn", resource: CommandLine.render(command) }
      })
      expect(yield* Effect.promise(() => exists(token))).toBe(false)
    }))

  it.effect("executes exactly once after replying to the attended pending request", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const token = join(directory, "attended-token")
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        token
      ])

      const exitCode = yield* (
        withGuardedSpawner({ runId: "attended-process" }, (store) =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            const execution = yield* spawner.exitCode(command).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const pending = yield* awaitPending(store)
            expect(pending.capability).toMatchObject({
              action: "proc:spawn",
              resource: CommandLine.render(command)
            })
            expect(yield* Effect.promise(() => exists(token))).toBe(false)

            yield* store.reply(pending.requestId, "once")
            return yield* Fiber.join(execution)
          }))
      )

      expect(exitCode).toBe(0)
      expect(yield* Effect.promise(() => readFile(token, "utf8"))).toBe("x")
    }))

  it.effect("reaps a real child when its owning fiber is interrupted", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "setInterval(() => {}, 1_000)"
      ])
      const pattern = new CapabilityPattern({
        action: "proc:spawn",
        resource: CommandLine.render(command)
      })

      const pid = yield* (
        withGuardedSpawner({
          attended: false,
          rules: [new Permission.Rule({ effect: "allow", pattern })]
        }, () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            const started = yield* Deferred.make<number>()
            const owner = yield* Effect.scoped(
              Effect.gen(function*() {
                const handle = yield* spawner.spawn(command)
                yield* Deferred.succeed(started, Number(handle.pid))
                return yield* Effect.never
              })
            ).pipe(Effect.forkChild({ startImmediately: true }))
            const pid = yield* Deferred.await(started)
            expect(() => process.kill(pid, 0)).not.toThrow()
            yield* Fiber.interrupt(owner)
            return pid
          }))
      )

      yield* Effect.promise(() => waitForEsrch(pid))
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }))
})
