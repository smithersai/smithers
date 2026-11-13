import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { Scope } from "effect/Scope"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import { linuxFileSystem } from "../src/internal/linuxFileSystem.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import { rawPlatform } from "./helpers/containedPlatform.ts"

const bytes = new TextEncoder()
const fixture = (
  output = "81a0 3 1000 100 9 123 1 1700000000\n",
  code = 0,
  fail = false,
  stderr = "guest error"
) => {
  const commands: Array<{ command: string; stdin: Uint8Array | undefined }> = []
  const writes: Array<Uint8Array> = []
  const session: Session = {
    id: "test",
    remoteId: "test",
    workdir: "/workspace",
    spawn: (command, options) => {
      commands.push({ command, stdin: options.stdin })
      return fail ?
        Effect.fail(new ProviderError({ code: "unavailable", message: "disconnected" }))
        : Effect.succeed({
          stdout: Stream.make(bytes.encode(output)),
          stderr: Stream.make(bytes.encode(stderr)),
          exitCode: Effect.succeed(code)
        })
    },
    readFile: () => Effect.die("unused"),
    writeFile: (_path, content) =>
      fail
        ? Effect.fail(new ProviderError({ code: "unavailable", message: "disconnected" }))
        : Effect.sync(() => {
          writes.push(content)
        })
  }
  return { fs: linuxFileSystem(session, "container"), commands, writes }
}

describe("container native filesystem", () => {
  it.effect("returns real mode, ownership, inode, size and time", () =>
    Effect.gen(function*() {
      const { fs } = fixture()
      const info = yield* fs.stat!("/workspace/a")
      expect(info).toMatchObject({ type: "File", mode: 0o100640, size: 3n, dev: 9n })
      expect(Option.getOrThrow(info.uid)).toBe(1000)
      expect(Option.getOrThrow(info.gid)).toBe(100)
      expect(Option.getOrThrow(info.ino)).toBe(123n)
      expect(Option.getOrThrow(info.mtime).getTime()).toBe(1700000000000)
    }))
  it.effect.each([
    ["41ed", "Directory"],
    ["a1ff", "SymbolicLink"],
    ["11a4", "FIFO"],
    ["21a4", "CharacterDevice"],
    ["61a4", "BlockDevice"],
    ["c1a4", "Socket"],
    ["01a4", "Unknown"]
  ])("decodes file type %s", ([mode, type]) =>
    Effect.gen(function*() {
      expect((yield* fixture(`${mode} 0 0 0 0 0 0 0`).fs.stat!("/file")).type).toBe(type)
    }))
  it.effect.each([
    "",
    "xyz 3 0 0 0 0 0 0",
    "fffffffffffffffffff 3 0 0 0 0 0 0",
    "81a0 1.5 0 0 0 0 0 0",
    "81a0 -1 0 0 0 0 0 0"
  ])("refuses malformed metadata %s", (output) =>
    Effect.gen(function*() {
      expect((yield* Effect.flip(fixture(output).fs.stat!("/file"))).reason._tag).toBe("Unknown")
    }))
  it.effect.each([[9, "NotFound"], [10, "AlreadyExists"], [1, "Unknown"]] as const)(
    "preserves guest failure %s",
    ([code, reason]) =>
      Effect.gen(function*() {
        expect((yield* Effect.flip(fixture("", code).fs.stat!("/file"))).reason._tag).toBe(reason)
      })
  )
  it.effect("reports a refusal the guest words as Permission denied or Operation not permitted as PermissionDenied", () =>
    Effect.gen(function*() {
      const denied = "chmod: /file: Permission denied"
      expect((yield* Effect.flip(fixture("", 1, false, denied).fs.chmod!("/file", 0o640))).reason._tag)
        .toBe("PermissionDenied")
      // EPERM, as Node's filesystem maps it too, so `Preserve` falls back for
      // a file whose owner an unprivileged guest cannot assign.
      const owner = "chown: /file: Operation not permitted"
      expect((yield* Effect.flip(fixture("", 1, false, owner).fs.chown!("/file", 0, 0))).reason._tag)
        .toBe("PermissionDenied")
      const other = "chown: /file: invalid group"
      expect((yield* Effect.flip(fixture("", 1, false, other).fs.chown!("/file", 0, 0))).reason._tag).toBe("Unknown")
    }))
  it.effect.each(
    [
      [1, "stat: cannot statx '/file': No such file or directory", "NotFound"],
      [1, "stat: can't stat '/file': No such file or directory", "NotFound"],
      [127, "env: 'sh': No such file or directory", "Unknown"],
      [127, "sh: /usr/bin/stat: No such file or directory", "Unknown"],
      [1, "sh: cd: /workspace: No such file or directory", "Unknown"],
      [127, "stat: No such file or directory", "Unknown"]
    ] as const
  )(
    "distinguishes stat absence from a broken utility or transport: %s %s",
    ([code, stderr, reason]) =>
      Effect.gen(function*() {
        expect((yield* Effect.flip(fixture("", code, false, stderr).fs.stat!("/file"))).reason._tag).toBe(reason)
      })
  )

  it.effect("does not turn a disconnected container into an absent file", () =>
    Effect.gen(function*() {
      const { fs } = fixture("", 0, true)
      expect((yield* Effect.flip(fs.stat!("/file"))).reason._tag).toBe("Unknown")
      expect((yield* Effect.flip(fs.writeFile!("/file", bytes.encode("x")))).reason._tag).toBe("Unknown")
    }))
  it.effect("keeps ordinary byte writes and streams exclusive UTF-8 content through stdin", () =>
    Effect.gen(function*() {
      const { fs, commands, writes } = fixture()
      yield* fs.writeFile!("/file", bytes.encode("plain"))
      yield* fs.writeFile!("/file", bytes.encode("plain"), { flag: "w" })
      yield* fs.writeFileString!("/file 'quoted'", "héllo", { flag: "wx" })
      yield* fs.writeFile!("/file", bytes.encode("private"), { flag: "wx", mode: 0o600 })
      expect(writes).toHaveLength(2)
      expect(commands).toHaveLength(2)
      expect(new TextDecoder().decode(commands[0]!.stdin)).toBe("héllo")
      expect(commands[0]!.command).not.toContain("héllo")
    }))
  it.effect("refuses unsupported flags and invalid modes before contacting the guest", () =>
    Effect.gen(function*() {
      const { fs, commands, writes } = fixture()
      for (
        const options of [{ flag: "a" as const }, { mode: 0o600 }, { flag: "wx" as const, mode: -1 }, {
          flag: "wx" as const,
          mode: 0o10000
        }, { flag: "wx" as const, mode: 0.5 }]
      ) {
        expect((yield* Effect.flip(fs.writeFile!("/file", bytes.encode("x"), options))).reason._tag).toBe("BadArgument")
      }
      expect(commands).toEqual([])
      expect(writes).toEqual([])
    }))
  it.effect("sets permissions and individual ownership fields", () =>
    Effect.gen(function*() {
      const { fs, commands } = fixture()
      yield* fs.chmod!("/file", 0o640)
      yield* fs.chown!("/file", 1000, 100)
      yield* fs.chown!("/file", -1, 100)
      yield* fs.chown!("/file", 1000, -1)
      yield* fs.chown!("/file", -1, -1)
      expect(commands.map(({ command }) => command)).toEqual([
        "chmod 640 -- /file",
        "chown 1000:100 -- /file",
        "chown :100 -- /file",
        "chown 1000 -- /file",
        "LC_ALL=C stat -L -c '%f %s %u %g %d %i %h %Y' -- /file"
      ])
      for (const mode of [-1, 0o10000, NaN]) {
        expect((yield* Effect.flip(fs.chmod!("/file", mode))).reason._tag).toBe("BadArgument")
      }
      for (const [uid, gid] of [[-2, 0], [0, -2], [0xffffffff, 0], [0, 0xffffffff], [0.5, 0]]) {
        expect((yield* Effect.flip(fs.chown!("/file", uid!, gid!))).reason._tag).toBe("BadArgument")
      }
      expect(commands).toHaveLength(5)
    }))
})

// Run the native adapter's actual shell program against the same tree as
// NodeFileSystem, so an exit-code fixture cannot conceal a broken probe.
describe.skipIf(process.platform !== "linux")("container stat on a real Linux tree", () => {
  const withFiles = <A, E>(
    body: (guest: FileSystem.FileSystem, host: FileSystem.FileSystem, root: string) => Effect.Effect<A, E, Scope>
  ) =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner
      const root = yield* host.makeTempDirectoryScoped()
      const session = ContainerSandbox.existing({
        container: "stat-test",
        workdir: root,
        spawner,
        transport: { exec: (request) => Effect.succeed({ file: request.file, args: request.args }) }
      })
      return yield* body(Sandbox.fileSystem(session), host, root)
    })).pipe(Effect.provide(rawPlatform))

  it.effect.each(["missing", "missing/parent/file", "dangling", "dangling/child", "quoted '\n/absent/file"])(
    "agrees with NodeFileSystem for absent path %s",
    (relative) =>
      withFiles((guest, host, root) =>
        Effect.gen(function*() {
          yield* host.symlink(`${root}/missing-target`, `${root}/dangling`)
          yield* host.makeDirectory(`${root}/quoted '\n`)
          const path = `${root}/${relative}`
          const reference = yield* Effect.flip(host.stat(path))
          const actual = yield* Effect.flip(guest.stat(path))
          expect(reference.reason._tag).toBe("NotFound")
          expect(actual.reason._tag).toBe(reference.reason._tag)
          expect(actual.reason.method).toBe("stat")
          expect(actual.reason).toMatchObject({ pathOrDescriptor: path })
        })
      )
  )

  it.effect.skipIf(process.getuid?.() === 0)(
    "preserves a search-permission refusal",
    () =>
      withFiles((guest, host, root) =>
        Effect.gen(function*() {
          const parent = `${root}/No such file or directory`
          yield* host.makeDirectory(parent)
          yield* Effect.acquireRelease(host.chmod(parent, 0), () => Effect.orDie(host.chmod(parent, 0o700)))
          const path = `${parent}/missing/child`
          expect((yield* Effect.flip(host.stat(path))).reason._tag).toBe("PermissionDenied")
          expect((yield* Effect.flip(guest.stat(path))).reason._tag).toBe("PermissionDenied")
        })
      )
  )
})
