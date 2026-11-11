/**
 * The batched file calls' scripts and how their answers are read.
 *
 * The guest here answers with fixed output, so every answer a real guest can
 * give, and some it should not, is read on every host. `BatchedFlows.test.ts`
 * runs the same scripts on a real userland.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"
import * as Base64 from "effect/encoding/Base64"
import {
  Batched,
  batchedFiles,
  commitScript,
  fileType,
  listScript,
  snapshotScript
} from "../src/internal/linuxBatch.ts"
import { linuxFileSystem } from "../src/internal/linuxFileSystem.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import type { Session } from "../src/Sandbox/Session.ts"

const encoder = new TextEncoder()

interface Answer {
  readonly stdout?: string
  readonly stderr?: string
  readonly code?: number
}

/** A guest that gives each script the next answer, or refuses to run it. */
const guest = (...answers: ReadonlyArray<Answer | "unreachable">) => {
  const sent: Array<{ readonly script: string; readonly stdin: Uint8Array | undefined }> = []
  const session: Session = {
    id: "fixed",
    remoteId: "fixed",
    workdir: "/work",
    spawn: (script, options) => {
      const answer = answers[sent.length]!
      sent.push({ script, stdin: options.stdin })
      return answer === "unreachable"
        ? Effect.fail(new ProviderError({ code: "unavailable", message: "disconnected" }))
        : Effect.succeed({
          stdout: Stream.make(encoder.encode(answer.stdout ?? "")),
          stderr: Stream.make(encoder.encode(answer.stderr ?? "")),
          exitCode: Effect.succeed(answer.code ?? 0)
        })
    },
    readFile: () => Effect.die("unused"),
    writeFile: () => Effect.die("unused")
  }
  return { files: batchedFiles(session, "container"), sent, session }
}

/** One snapshot record: resolution, version, stat, read. */
const record = (...fields: ReadonlyArray<string>) => fields.map((field) => `${field}\0`).join("")

describe("snapshot", () => {
  it.effect("roots each path, asks for the bytes it was told to read, and reads the four fields", () =>
    Effect.gen(function*() {
      const { files, sent } = guest({
        stdout: record("e/work/a.txt", "f 1 2 5 9 9 77 5", "S81a4 5", `B${Base64.encode(encoder.encode("hello"))}\n`) +
          record("p1/work", "a", "N", "-") + record("p1/", "a", "N", "-") + record("n", "a", "N", "-") +
          record("p2/real/work", "a", "N", "-") + record("p3/", "a", "N", "-")
      })
      const taken = yield* files.snapshot(["a.txt", "new.txt", "/top.txt", "x/y/z.txt", "d/e.txt", "/u/v/w.txt/"], {
        read: ["a.txt", "new.txt"],
        maxBytes: 64
      })
      expect(sent[0]!.script).toContain(
        "\nq /work/a.txt 1 64\nq /work/new.txt 1 64\nq /top.txt 0 64\nq /work/x/y/z.txt 0 64"
      )
      // An absent parent resolves through the nearest ancestor that exists.
      expect(taken.map(({ canonical }) => canonical)).toEqual([
        "/work/a.txt",
        "/work/new.txt",
        "/top.txt",
        undefined,
        "/real/work/d/e.txt",
        "/u/v/w.txt"
      ])
      expect(taken[0]).toMatchObject({
        version: "f 1 2 5 9 9 77 5",
        info: Result.succeed({ type: "File", size: 5 }),
        content: Result.succeed(encoder.encode("hello"))
      })
      expect(taken[1]!.info).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "NotFound" } } })
      expect(taken[1]!.content).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "NotFound" } } })
      expect("content" in taken[2]!).toBe(false)
    }))

  it.effect("reads each kind of answer the way the stat and readFile overrides do", () =>
    Effect.gen(function*() {
      const read = ["dir", "big", "locked", "bad", "denied", "e", "odd"]
      const { files, sent } = guest({
        stdout: record("e/work/dir", "e 41ed 1 2", "S41ed 4096", "-") +
          record("e/work/big", "f", "S81a4 99", "-") +
          record("e/work/locked", "f", "S8180 3", "R") +
          record("e/work/bad", "f", "S81a4 3", "B*not base64*") +
          record("p1/work", "a", "Estat: cannot stat '/work/denied': Permission denied", "-") +
          record("e", "f", "S81a4", "-") +
          record("e/work/odd", "e", "S1a4 0", "-")
      })
      const taken = yield* files.snapshot(read, { read })
      expect(sent[0]!.script).toContain("q /work/dir 1 -1")
      const reason = (result: Result.Result<unknown, { readonly reason: { readonly _tag: string } }> | undefined) =>
        result === undefined ? undefined : Result.isSuccess(result) ? "success" : result.failure.reason._tag
      expect(taken.map(({ content, info }) => [reason(info), reason(content)])).toEqual([
        ["success", "BadResource"],
        ["success", undefined],
        ["success", "PermissionDenied"],
        ["success", "Unknown"],
        ["PermissionDenied", "PermissionDenied"],
        ["Unknown", "Unknown"],
        ["success", "BadResource"]
      ])
      expect(taken[5]!.canonical).toBeUndefined()
      expect(taken[6]!.info).toEqual(Result.succeed({ type: "Unknown", size: 0 }))
    }))

  it.effect.each([
    ["xyz 3", "invalid metadata"],
    ["81a4 -1", "invalid metadata"],
    ["81a4 1.5", "invalid metadata"]
  ])("refuses malformed metadata %s", ([stat, words]) =>
    Effect.gen(function*() {
      const [taken] = yield* guest({ stdout: record("e/work/a", "f", `S${stat}`, "-") }).files.snapshot(["a"])
      expect(taken!.info).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "Unknown" } } })
      expect(Result.isFailure(taken!.info) && taken!.info.failure.message).toContain(words)
    }))

  it.effect("fails the whole call for a guest that failed, answered badly, or cannot be reached", () =>
    Effect.gen(function*() {
      const failed = yield* Effect.flip(
        guest({ stderr: "sh: base64: not found\n", code: 1 }).files.snapshot(["a"], { read: ["a"] })
      )
      expect(failed).toMatchObject({ reason: { _tag: "Unknown", method: "stat", pathOrDescriptor: "/work/a" } })
      expect(failed.message).toContain("base64: not found")
      const short = yield* Effect.flip(guest({ stdout: record("e/work/a", "f", "S81a4 1") }).files.snapshot(["a"]))
      expect(short.message).toContain("invalid output")
      const trailing = yield* Effect.flip(
        guest({ stdout: `${record("e/a", "f", "S81a4 1", "-")}x` }).files.snapshot(["a"])
      )
      expect(trailing.message).toContain("invalid output")
      const unreachable = yield* Effect.flip(guest("unreachable").files.snapshot([]))
      expect(unreachable).toMatchObject({ reason: { _tag: "Unknown", pathOrDescriptor: "/work" } })
    }))
})

describe("commit", () => {
  const change = (path: string, content: string | null, metadataFrom?: string, lock?: string) => ({
    path,
    content: content === null ? null : encoder.encode(content),
    version: `v ${path}`,
    ...metadataFrom === undefined ? {} : { metadataFrom },
    ...lock === undefined ? {} : { lock }
  })

  it.effect("compares, checks removals, prepares writes, locks, stages, compares again, then applies in order", () =>
    Effect.gen(function*() {
      const { files, sent } = guest({ stdout: "+\n+\n+\n" })
      const committed = yield* files.commit([
        change("a.txt", "first", undefined, "/work/.smithers-1.lock"),
        change("gone.txt", null, undefined, "/work/.smithers-2.lock"),
        change("new/b.txt", "second", "old.txt"),
        change("a.txt", null, undefined, "/work/.smithers-1.lock")
      ])
      expect(committed).toEqual({ applied: 4 })
      const lines = sent[0]!.script.split("\n")
      const body = lines.slice(lines.findIndex((line) => line.startsWith("A=; trap 'for y")))
      expect(body).toEqual([
        `A=; trap 'for y in "$t" "$A" "$t0" "$t2"; do [ -z "$y" ] || rm -f -- "$y"; done; ` +
        `for y in "$h" "$h0" "$h1"; do [ -z "$y" ] || rm -rf -- "$y"; done' EXIT`,
        "x 0 /work/a.txt 'v a.txt'",
        "x 1 /work/gone.txt 'v gone.txt'",
        "x 2 /work/new/b.txt 'v new/b.txt'",
        "x 3 /work/a.txt 'v a.txt'",
        "r 1 /work/gone.txt",
        "r 3 /work/a.txt",
        "w 0 /work/a.txt ''; d0=$d; f0=$f",
        "w 2 /work/new/b.txt /work/old.txt; d2=$d; f2=$f",
        // Each lock once, deferring signals until each is recorded for release.
        "D",
        "l 0 /work/.smithers-1.lock; h0=$h; h=",
        "l 1 /work/.smithers-2.lock; h1=$h; h=",
        "E",
        // Two writes: each names where its bytes start, and is cut from the spooled input.
        `s 0 "$d0" "$f0" 5 0; t0=$t; i0=$i; t=`,
        `s 2 "$d2" "$f2" 6 5; t2=$t; i2=$i; t=`,
        "x 0 /work/a.txt 'v a.txt'",
        "x 1 /work/gone.txt 'v gone.txt'",
        "x 2 /work/new/b.txt 'v new/b.txt'",
        "x 3 /work/a.txt 'v a.txt'",
        `a 0 "$t0" "$d0" "$i0"; t0=; echo +`,
        "rm -- /work/gone.txt || k 1 remove; echo +",
        `a 2 "$t2" "$d2" "$i2"; t2=; echo +`,
        "rm -- /work/a.txt || k 3 remove; echo +"
      ])
      // The bytes travel on standard input, in staging order, and never in the script.
      expect(new TextDecoder().decode(sent[0]!.stdin)).toBe("firstsecond")
      expect(sent[0]!.script).not.toContain("first")
    }))

  it.effect.each(
    [
      [{ stdout: "=1\n", code: 20 }, { applied: 0, stopped: { index: 1, reason: "changed" } }],
      [{ stdout: "#1\n", code: 20 }, { applied: 0, stopped: { index: 1, reason: "locked" } }],
      [{ stdout: "!0 lock -\n", stderr: "mkdir: Permission denied\n", code: 20 }, {
        applied: 0,
        stopped: { index: 0, reason: { reason: { _tag: "PermissionDenied", method: "lock" } } }
      }],
      [{ stdout: "+\n+\n", code: 143 }, { applied: 2 }],
      [{ stdout: "!0 makeDirectory -\n", stderr: "mkdir: Permission denied\n", code: 20 }, {
        applied: 0,
        stopped: { index: 0, reason: { reason: { _tag: "PermissionDenied", method: "makeDirectory" } } }
      }],
      [{ stdout: "+\n!1 remove NotFound\n", code: 20 }, {
        applied: 1,
        stopped: { index: 1, reason: { reason: { _tag: "NotFound", method: "remove", pathOrDescriptor: "/work/b" } } }
      }],
      [{ stdout: "!1 remove BadResource\n", stderr: "/work/b: is a directory\n", code: 20 }, {
        applied: 0,
        stopped: { index: 1, reason: { reason: { _tag: "BadResource", method: "remove" } } }
      }],
      [{ stdout: "+\n", code: 137 }, {
        applied: 1,
        stopped: {
          index: 1,
          reason: { reason: { _tag: "Unknown", method: "writeFile" }, message: expect.stringContaining("exited 137") }
        }
      }],
      [{ stdout: "garbled\n", stderr: "killed\n", code: 20 }, {
        applied: 0,
        stopped: { index: 0, reason: { reason: { _tag: "Unknown" }, message: expect.stringContaining("killed") } }
      }],
      // A guest that died before it reported anything applied nothing it can vouch for.
      [{ stdout: "", code: 137 }, {
        applied: 0,
        stopped: {
          index: 0,
          reason: { reason: { _tag: "Unknown", method: "writeFile" }, message: expect.stringContaining("exited 137") }
        }
      }]
    ] as const
  )("reads the guest's report %j", ([answer, expected]) =>
    Effect.gen(function*() {
      const { files } = guest(answer)
      expect(yield* files.commit([change("a", "x"), change("b", null)])).toMatchObject(expected)
    }))

  it.effect("reports a session that cannot run the commit as a failure of the first change", () =>
    Effect.gen(function*() {
      expect(yield* guest("unreachable").files.commit([])).toMatchObject({
        applied: 0,
        stopped: { index: 0, reason: { reason: { _tag: "Unknown", pathOrDescriptor: "/work" } } }
      })
    }))
})

describe("list", () => {
  it.effect("names each entry under the directory and marks the directories", () =>
    Effect.gen(function*() {
      const { files, sent } = guest(
        { stdout: "/work/src/a.txt\0/work/src/lib\0/elsewhere\0\0/work/src/lib\0" },
        { stdout: "/bin\0/etc\0\0/bin\0" }
      )
      expect(yield* files.list("src/")).toEqual([
        { name: "a.txt", directory: false },
        { name: "lib", directory: true },
        { name: "/elsewhere", directory: false }
      ])
      expect(sent[0]!.script.split("\n")[0]).toBe("d=/work/src")
      expect(yield* files.list("/")).toEqual([{ name: "bin", directory: true }, { name: "etc", directory: false }])
      expect(sent[1]!.script.split("\n")[0]).toBe("d=/")
    }))

  it.effect.each(
    [
      [{ code: 9 }, "NotFound"],
      [{ code: 11 }, "BadResource"],
      [{ code: 1, stderr: "find: '/work/x': Permission denied" }, "PermissionDenied"],
      [{ stdout: "/work/x/a" }, "Unknown"]
    ] as const
  )("refuses %j as %s", ([answer, reason]) =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(guest(answer).files.list("x"))
      expect(error).toMatchObject({ reason: { _tag: reason, method: "readDirectory", pathOrDescriptor: "/work/x" } })
    }))
})

describe("the scripts", () => {
  it("quote every path once and carry no file content", () => {
    expect(snapshotScript([{ path: "/w/it's", read: true }], -1)).toContain(`q '/w/it'\\''s' 1 -1`)
    expect(listScript("/w/a b")).toContain(`d='/w/a b'`)
    const script = commitScript([{ path: "/w/a b", size: 3, version: "a", metadataFrom: undefined, lock: "/w/l k" }])
    expect(script).toContain(`w 0 '/w/a b' ''; d0=$d; f0=$f`)
    expect(script).toContain(`l 0 '/w/l k'; h0=$h; h=`)
    // A script with no locks defers no signals.
    expect(commitScript([{ path: "/w/a", size: 1, version: "a", metadataFrom: undefined }]).split("\n")).not.toContain(
      "D"
    )
  })

  it("name an unknown file type Unknown", () => {
    expect([fileType(0o100644), fileType(0o040755), fileType(0o000644)]).toEqual(["File", "Directory", "Unknown"])
  })
})

describe("Sandbox.fileSystem", () => {
  it("carries the batched calls on the filesystem it builds, and never onto a copy of it", () => {
    const { session } = guest()
    const fs = Sandbox.fileSystem({ ...session, files: linuxFileSystem(session, "container") })
    expect((fs as unknown as Record<symbol, unknown>)[Batched]).toBeDefined()
    expect(Object.getOwnPropertySymbols({ ...fs })).not.toContain(Batched)
  })
})
