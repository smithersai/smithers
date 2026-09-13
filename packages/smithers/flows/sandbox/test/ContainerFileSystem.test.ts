import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { fileSystem } from "../src/ContainerSandbox/fileSystem.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"

const bytes = new TextEncoder()
const fixture = (output = "81a0 3 1000 100 9 123 1 1700000000\n", code = 0, fail = false) => {
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
          stderr: Stream.make(bytes.encode("guest error")),
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
  return { fs: fileSystem(session), commands, writes }
}

describe("container native filesystem", () => {
  it.effect("returns real mode, ownership, inode, size and time", () =>
    Effect.gen(function*() {
      const { fs } = fixture()
      const info = yield* fs.stat!("/workspace/a")
      expect(info).toMatchObject({ type: "File", mode: 0o100640, size: 3n, dev: 9 })
      expect(Option.getOrThrow(info.uid)).toBe(1000)
      expect(Option.getOrThrow(info.gid)).toBe(100)
      expect(Option.getOrThrow(info.ino)).toBe(123)
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
      expect(commands).toHaveLength(5)
      for (const mode of [-1, 0o10000, NaN]) {
        expect((yield* Effect.flip(fs.chmod!("/file", mode))).reason._tag).toBe("BadArgument")
      }
      for (const [uid, gid] of [[-2, 0], [0, -2], [0xffffffff, 0], [0, 0xffffffff], [0.5, 0]]) {
        expect((yield* Effect.flip(fs.chown!("/file", uid!, gid!))).reason._tag).toBe("BadArgument")
      }
      expect(commands).toHaveLength(5)
    }))
})
