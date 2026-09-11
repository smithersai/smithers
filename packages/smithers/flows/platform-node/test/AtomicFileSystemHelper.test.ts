/**
 * The helper is a trust boundary in three directions, and this file pins all
 * three.
 *
 * 1. **Which program runs.** The interpreter is an absolute host identity, not
 *    a `PATH` lookup, so a `python3` planted in the workspace or injected into
 *    the environment is never executed.
 * 2. **How much can cross.** Both directions are length-framed and bounded, so
 *    neither a large file nor a hostile helper can make the host allocate
 *    without limit, hang, or leak a child.
 * 3. **What may be opened.** Content reads and writes require a regular file
 *    descriptor, so a FIFO, a socket, a device, or a directory is refused with
 *    a typed error instead of blocking or reporting an empty success.
 *
 * `AtomicFileSystem.test.ts` pins the confinement races and the operation
 * semantics; this file pins the helper protocol itself.
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import { afterEach, describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, FileSystem, Layer, Option, Path, type PlatformError, Result } from "effect"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { vi } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const directories = new Set<string>()

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "flows-atomic-helper-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const guarded = (root: string, host: Layer.Layer<FileSystem.FileSystem>) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(host),
    Layer.provide(Path.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

const run = <A, E>(
  root: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
  host: Layer.Layer<FileSystem.FileSystem> = AtomicFileSystem.layer
) => effect.pipe(Effect.provide(guarded(root, host)))

const runDirect = <R extends KernelFileSystem.AtomicRequest>(
  request: R,
  host: Layer.Layer<FileSystem.FileSystem>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
    return yield* atomic.execute(request)
  }).pipe(Effect.provide(host))

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * A stand-in interpreter. It is a real absolute executable outside the
 * workspace, so it passes the toolchain checks and exercises the protocol
 * rather than the identity guard. The body is Node, which can write exact
 * bytes; `python3 -I -X utf8 -c <program>` arrives as ignored arguments.
 */
const fakeInterpreter = async (body: string, directory?: string) => {
  const bin = directory ?? await temporaryDirectory()
  const executable = join(bin, "python3")
  await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(body)}\n`)
  await chmod(executable, 0o755)
  return executable
}

const frame = (payload: string) => {
  const body = Buffer.from(payload, "utf8")
  return `flows-atomic/1 ${body.byteLength}\n${payload}`
}

/** An interpreter that writes exactly `output` to stdout and exits `code`. */
const writing = (output: string, options?: { readonly code?: number; readonly stderr?: string }) =>
  fakeInterpreter(
    `process.stdout.write(Buffer.from(${JSON.stringify(output)}, "utf8"));` +
      (options?.stderr === undefined ? "" : `process.stderr.write(${JSON.stringify(options.stderr)});`) +
      `process.exitCode = ${options?.code ?? 0};`
  )

const hostedBy = (executable: string, limits?: Partial<AtomicFileSystem.Limits>) =>
  AtomicFileSystem.layerWith(limits === undefined ? { executable } : { executable, limits })

const missing = (path: string) => readFile(path, "utf8").then(() => true, () => false)

/** The typed reason's description, which carries the fail-closed cause. */
const described = (failure: PlatformError.PlatformError) =>
  String((failure.reason as { readonly description?: string }).description)

describe("atomic helper source", () => {
  const packageRoot = join(import.meta.dirname, "..")

  // The Python file is the one source; the TypeScript module that ships it is
  // generated. Compared as bytes, so an edit to either side alone fails here.
  it("runs the committed Python file byte for byte", async () => {
    const python = await readFile(join(packageRoot, "src/internal/AtomicFileSystemHelper.py"), "utf8")
    expect(AtomicFileSystem.program).toBe(`\n${python}`)
  })

  it("keeps the embedded module equal to its generator's output", async () => {
    await expect(
      promisify(execFile)(process.execPath, [join(packageRoot, "scripts/generate-atomic-helper.mjs"), "--check"])
    ).resolves.toMatchObject({ stderr: "" })
  })
})

describe("atomic helper toolchain identity", () => {
  it.live("follows real interpreter symlinks while refusing workspace targets and link cycles", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const tools = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "content.txt")
      yield* Effect.promise(() => writeFile(target, "resolved interpreter"))
      yield* Effect.promise(() => symlink("second", join(tools, "first")))
      yield* Effect.promise(() => symlink(AtomicFileSystem.defaultExecutable, join(tools, "second")))
      expect(
        yield* run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(target)),
          hostedBy(join(tools, "first"))
        )
      ).toBe("resolved interpreter")

      const marker = join(tools, "executed")
      const untrusted = yield* Effect.promise(() =>
        fakeInterpreter(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`,
          root
        )
      )
      yield* Effect.promise(() => symlink(untrusted, join(tools, "outside-name")))
      const refusal = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(target))),
        hostedBy(join(tools, "outside-name"))
      )
      expect(described(refusal)).toContain("outside the confined workspace")
      expect(yield* Effect.promise(() => missing(marker))).toBe(false)

      yield* Effect.promise(() => symlink("cycle-b", join(tools, "cycle-a")))
      yield* Effect.promise(() => symlink("cycle-a", join(tools, "cycle-b")))
      const cycle = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(target))),
        hostedBy(join(tools, "cycle-a"))
      )
      expect(described(cycle)).toContain("too many symbolic links")
    }))

  it.live("resolves a symlink before traversing a following parent component", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const tools = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(tools, "actual", "deep"), { recursive: true }))
      yield* Effect.promise(() => symlink("actual/deep", join(tools, "bridge")))
      yield* Effect.promise(() => symlink(AtomicFileSystem.defaultExecutable, join(tools, "actual", "python3")))
      yield* Effect.promise(() => symlink("bridge/../python3", join(tools, "python3")))
      const target = join(root, "content.txt")
      yield* Effect.promise(() => writeFile(target, "filesystem traversal"))
      expect(
        yield* run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(target)),
          hostedBy(join(tools, "python3"))
        )
      ).toBe("filesystem traversal")
    }))

  /**
   * `-I` isolates an interpreter that has already been chosen. Choosing it
   * through `PATH` — or through a cwd that a shell would search — hands
   * arbitrary code the pinned root descriptor before isolation ever applies.
   * The proof plants a `python3` that records that it ran and answers with a
   * corrupted read, then puts it on `PATH` and makes it the working directory.
   */
  it.live("never runs a python3 planted on PATH or in the working directory", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const bin = yield* Effect.promise(() => temporaryDirectory())
      const marker = join(yield* Effect.promise(() => temporaryDirectory()), "path-executed")
      yield* Effect.promise(() =>
        fakeInterpreter(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");` +
            `process.stdout.write(${JSON.stringify(frame(`{"ok":true,"value":{"base64":"UFdORUQ="}}`))});`,
          bin
        )
      )

      const originalPath = process.env.PATH
      const originalCwd = process.cwd()
      let text: string
      try {
        process.env.PATH = bin
        process.chdir(bin)
        text = yield* run(root, Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(target)))
      } finally {
        process.chdir(originalCwd)
        process.env.PATH = originalPath
      }

      // The real interpreter answered, so the caller sees the real file...
      expect(text).toBe("inside")
      // ...and the planted one never ran at all.
      expect(yield* Effect.promise(() => missing(marker))).toBe(false)
    }), 30_000)

  it.live("refuses a configured executable that is relative, absent, not a file, or not executable", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const plain = join(directory, "not-executable")
      yield* Effect.promise(() => writeFile(plain, "#!/bin/sh\nexit 0\n"))
      yield* Effect.promise(() => chmod(plain, 0o644))

      const attempt = (executable: string) =>
        run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
          hostedBy(executable)
        )

      for (const executable of ["python3", join(directory, "absent"), directory, plain]) {
        expect(yield* attempt(executable)).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      }
    }))

  /**
   * A workspace the adapter confines is exactly where an attacker can write.
   * An interpreter reachable from inside it is refused even when it is
   * configured deliberately, so a misconfiguration cannot turn the confined
   * tree into the code that enforces the confinement.
   */
  it.live("refuses an interpreter that lives inside the confined workspace", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const marker = join(yield* Effect.promise(() => temporaryDirectory()), "workspace-executed")
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`,
          root
        )
      )

      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )

      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(yield* Effect.promise(() => missing(marker))).toBe(false)
    }))

  /**
   * The kernel always pins a boundary root before it calls the executor, but
   * the request type does not require one, so the executor is exercised
   * directly to pin that a request without one still fails closed rather than
   * skipping the interpreter's location check.
   */
  it.live("fails closed for a request that names no boundary root", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const failure = yield* (
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
          return yield* Effect.flip(atomic.execute({ operation: "exists", path: join(root, "any.txt") }))
        }).pipe(Effect.provide(AtomicFileSystem.layer))
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))
})

describe("atomic helper root identity", () => {
  it.live("requires the authorized root identity for ordinary requests", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(async () => realpath(await temporaryDirectory()))
      const target = join(root, "value")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const info = yield* Effect.promise(() => stat(root))
      const request = { operation: "readFileString", boundaryRoot: root, logicalRoot: root, path: target } as const
      for (const rootIdentity of [undefined, "0:0"]) {
        const failure = yield* Effect.flip(runDirect({ ...request, rootIdentity }, AtomicFileSystem.layer))
        expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
        expect(described(failure)).toContain("root no longer names the authorized descriptor")
      }
      expect(
        yield* runDirect(
          { ...request, rootIdentity: `${info.dev}:${info.ino}` },
          AtomicFileSystem.layer
        )
      ).toBe("inside")
    }))
})

describe("atomic helper limits", () => {
  for (const contentBytes of [4 * 1024 * 1024, 16 * 1024 * 1024]) {
    for (const operation of ["readFile", "readFileString", "batch"] as const) {
      it.live(
        `reads ${contentBytes} bytes through ${operation} without overflowing the base64 validator`,
        () =>
          Effect.gen(function*() {
            const root = yield* Effect.promise(() => temporaryDirectory())
            const path = join(root, "large.txt")
            const bytes = Buffer.alloc(contentBytes, 0x61)
            yield* Effect.promise(() => writeFile(path, bytes))
            yield* run(
              root,
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                if (operation === "readFileString") {
                  expect(yield* fs.readFileString(path)).toBe(bytes.toString("utf8"))
                } else {
                  let actual: Uint8Array
                  if (operation === "batch") {
                    const response = yield* KernelFileSystem.batch(fs)!.execute([
                      { operation: "digest", path, content: true }
                    ])
                    const result = Result.getOrThrow(response.entries[0]!.result)
                    expect(result.operation).toBe("digest")
                    if (result.operation !== "digest") throw new Error("expected digest")
                    expect(result.sizeBytes).toBe(contentBytes)
                    expect(result.digest).toBe(createHash("sha256").update(bytes).digest("hex"))
                    actual = result.bytes!
                  } else {
                    actual = yield* fs.readFile(path)
                  }
                  expect(actual.byteLength).toBe(contentBytes)
                  expect(Buffer.from(actual).equals(bytes)).toBe(true)
                }
              })
            )
          }),
        60_000
      )
    }
  }

  it.live("refuses every non-positive, fractional, non-finite, or over-hard-cap limit before spawning", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const marker = join(yield* Effect.promise(() => temporaryDirectory()), "invalid-limit-executed")
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`
        )
      )
      const invalid: ReadonlyArray<readonly [keyof AtomicFileSystem.Limits, number]> = [
        ["content", 0],
        ["request", -1],
        ["response", 1.5],
        ["stderr", Number.NaN],
        ["content", Number.POSITIVE_INFINITY],
        ["request", 256 * 1024 * 1024 + 1]
      ]

      for (const [field, value] of invalid) {
        const failure = yield* run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
          hostedBy(executable, { [field]: value })
        )
        expect(failure).toMatchObject({ reason: { _tag: "BadArgument" } })
      }
      const throwingLimits = Object.defineProperty({}, "content", {
        get: () => {
          throw "limit getter failed"
        }
      }) as Partial<AtomicFileSystem.Limits>
      const getterFailure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable, throwingLimits)
      )
      expect(getterFailure).toMatchObject({ reason: { _tag: "BadArgument" } })
      expect(described(getterFailure)).toContain("limits are invalid")
      expect(yield* Effect.promise(() => missing(marker))).toBe(false)
    }))

  it.live("refuses an over-limit request before an interpreter is started", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const marker = join(yield* Effect.promise(() => temporaryDirectory()), "request-executed")
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`
        )
      )

      const failure = yield* run(
        root,
        Effect.flatMap(
          FileSystem.FileSystem,
          (fs) => Effect.flip(fs.writeFileString(join(root, "big.txt"), "x".repeat(4096)))
        ),
        hostedBy(executable, { request: 512 })
      )

      expect(failure.reason._tag).toBe("BadArgument")
      expect(String(failure.reason)).toContain("exceeds the 512 byte limit")
      // Nothing was spawned: an over-limit request never reaches an interpreter.
      expect(yield* Effect.promise(() => missing(marker))).toBe(false)
    }))

  it.live("reads up to the content limit and refuses one byte more", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => writeFile(join(root, "exact.txt"), "12345678"))
      yield* Effect.promise(() => writeFile(join(root, "over.txt"), "123456789"))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            exact: yield* fs.readFileString(join(root, "exact.txt")),
            over: yield* Effect.flip(fs.readFile(join(root, "over.txt")))
          }
        }),
        AtomicFileSystem.layerWith({ limits: { content: 8 } })
      )

      expect(outcome.exact).toBe("12345678")
      expect(outcome.over).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(described(outcome.over)).toContain("atomic read limit")
    }))

  it.live("refuses an over-limit write without touching the file it would have replaced", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "seed"))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            bytes: yield* Effect.flip(fs.writeFile(target, new Uint8Array(64))),
            text: yield* Effect.flip(fs.writeFileString(target, "123456789"))
          }
        }),
        AtomicFileSystem.layerWith({ limits: { content: 8 } })
      )

      expect(outcome.text).toMatchObject({ reason: { _tag: "BadResource" } })
      // The guarded binary `writeFile` is refused earlier than the string
      // one: the kernel checks the payload against the content limit this
      // host advertises and fails with a typed BadArgument before encoding,
      // so the helper's own BadResource ceiling is now the backstop.
      expect(outcome.bytes).toMatchObject({ reason: { _tag: "BadArgument" } })
      expect(described(outcome.bytes)).toContain("exceeds the 8 byte limit")
      // Measured before the open, so the target was never truncated.
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("seed")
    }))

  it.live("refuses a listing and a glob that would exceed the response limit", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (let index = 0; index < 64; index++) {
        yield* Effect.promise(() => writeFile(join(root, `entry-${index}.txt`), ""))
      }
      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            glob: yield* Effect.flip(fs.glob("**/*.txt", { root })),
            listing: yield* Effect.flip(fs.readDirectory(root))
          }
        }),
        // Large enough that the REJECTION still fits inside it — a refusal the
        // helper cannot frame degrades to the fail-closed reason instead of the
        // typed one — and far smaller than the 64 names either call would
        // return.
        AtomicFileSystem.layerWith({ limits: { response: 256 } })
      )
      expect(outcome.listing).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.glob).toMatchObject({ reason: { _tag: "BadResource" } })
    }))

  /**
   * The response bound is charged for what the selector names, not for what
   * the walk could have read. A literal selector beside a wide unrelated tree
   * used to exhaust the bound on names the answer never held, so a one-path
   * answer that fit was refused; the same tree still exhausts it for a
   * selector that names every file in it.
   */
  it.live("charges a glob only for the subtrees its selector can reach", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => writeFile(join(root, "wanted.ts"), ""))
      // Twenty directories of fifty 30-byte names: far past an 8 KiB response,
      // while the one selected path fits many times over.
      for (let directory = 0; directory < 20; directory++) {
        const folder = join(root, "unrelated", String(directory))
        yield* Effect.promise(() => mkdir(folder, { recursive: true }))
        yield* Effect.promise(() =>
          Promise.all(
            Array.from(
              { length: 50 },
              (_, index) => writeFile(join(folder, `entry-${index}-${"x".repeat(16)}.txt`), "")
            )
          )
        )
      }
      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            literal: yield* fs.glob(join(root, "wanted.ts"), { root }),
            shallow: yield* fs.glob(join(root, "*.ts"), { root }),
            everything: yield* Effect.flip(fs.glob(join(root, "**/*.txt"), { root }))
          }
        }),
        AtomicFileSystem.layerWith({ limits: { response: 8192 } })
      )
      expect(outcome.literal).toEqual([join(root, "wanted.ts")])
      expect(outcome.shallow).toEqual([join(root, "wanted.ts")])
      expect(outcome.everything).toMatchObject({ reason: { _tag: "BadResource" } })
    }))

  it.live("stops accumulating a helper that writes more than the response limit", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `const block = Buffer.alloc(1 << 16, 0x61);` +
            `const send = () => { while (process.stdout.write(block)) {} };` +
            `process.stdout.on("drain", send); send(); setTimeout(() => {}, 30000);`
        )
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable, { response: 1024 })
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("more than 1024 response bytes")
    }), 30_000)

  it.live("refuses a byte after an exact full response buffer without retaining it", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `process.stdout.write(Buffer.alloc(1088, 0x61));` +
            `setTimeout(() => process.stdout.write(Buffer.from([0x62])), 25);` +
            `setTimeout(() => {}, 30000);`
        )
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable, { response: 1024 })
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("more than 1024 response bytes")
    }), 30_000)

  it.live("bounds retained stderr independently of stdout", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `process.stderr.write(Buffer.alloc(1 << 20, 0x62).toString("latin1"));` +
            `process.exitCode = 7;`
        )
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable, { stderr: 2048 })
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("(truncated)")
      // A megabyte of diagnostics is not retained just because it was offered.
      expect(described(failure).length).toBeLessThan(4096)
    }), 30_000)

  /**
   * The helper enforces the same ceilings on its own side, against a host that
   * declares a length it should not honour. Nothing the adapter sends can
   * reach these, so they are driven with hand-built frames.
   */
  it("refuses an over-declared, unframed, or trailing request on the helper side", async () => {
    const ask = (input: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(AtomicFileSystem.defaultExecutable, ["-I", "-X", "utf8", "-c", AtomicFileSystem.program], {
          cwd: "/",
          env: {},
          stdio: ["pipe", "pipe", "pipe"]
        })
        const chunks: Array<Buffer> = []
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
        child.on("error", reject)
        child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")))
        child.stdin.end(input)
      })

    // A declared length far past the limit is refused before it is read.
    expect(await ask(`flows-atomic/1 999999999 1024 1024 1024\n`)).toContain(`"code":"EFBIG"`)
    // A header that never ends is capped rather than buffered.
    expect(await ask("x".repeat(4096))).toContain(`"ok":false`)
    // A frame followed by more bytes is two requests, not one.
    expect(await ask(`flows-atomic/1 2 1024 1024 1024\n{}extra`)).toContain(`"ok":false`)
    // Limits outside the helper's own hard cap are refused.
    expect(await ask(`flows-atomic/1 2 999999999999 1024 1024\n{}`)).toContain(`"ok":false`)
    // A header that is not the protocol at all.
    expect(await ask(`other/9 2 1024 1024 1024\n{}`)).toContain(`"ok":false`)
  }, 30_000)
})

describe("atomic helper response framing", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["an unframed response", "garbage-with-no-newline"],
    ["a header longer than the frame header allowance", `${"x".repeat(80)}\n{}`],
    ["an unknown protocol tag", `other/1 2\n{}`],
    ["a non-numeric length", `flows-atomic/1 abc\n{}`],
    ["an empty length", `flows-atomic/1 \n{}`],
    ["an extra header field", `flows-atomic/1 2 extra\n{}`],
    ["a negative length", `flows-atomic/1 -1\n{}`],
    ["a length past the response limit", `flows-atomic/1 999999\n{}`],
    ["a truncated body", `flows-atomic/1 10\n{}`],
    ["two frames in one stream", `${frame(`{"ok":true,"value":true}`)}${frame(`{"ok":true,"value":true}`)}`],
    ["a body that is not JSON", frame("{")],
    ["a null envelope", frame("null")],
    ["a non-object envelope", frame("5")],
    ["an envelope without ok", frame("{}")],
    ["a rejection with a non-string code", frame(`{"ok":false,"code":7}`)],
    ["a rejection with a non-string syscall", frame(`{"ok":false,"code":"ENOENT","syscall":7}`)],
    ["a rejection with a non-boolean badArgument", frame(`{"ok":false,"badArgument":"yes"}`)],
    ["a rejection with a non-string message", frame(`{"ok":false,"message":{"text":"no"}}`)]
  ]

  it.live.each(cases)("fails closed on %s", ([_name, output]) =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => writing(output))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable, { response: 4096 })
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("fails closed when the framed response body is not valid UTF-8", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `process.stdout.write(Buffer.concat([Buffer.from("flows-atomic/1 1\\n", "ascii"), Buffer.from([0xff])]));`
        )
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("refuses non-serializable direct requests before an interpreter starts", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const marker = join(yield* Effect.promise(() => temporaryDirectory()), "serialization-executed")
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`
        )
      )
      const host = hostedBy(executable)
      const omitted = {
        operation: "exists",
        boundaryRoot: root,
        logicalRoot: root,
        path: join(root, "any.txt"),
        toJSON: () => undefined
      } as KernelFileSystem.AtomicRequest
      const cyclicOptions: Record<string, unknown> = {}
      cyclicOptions.self = cyclicOptions
      const cyclic = {
        operation: "exists",
        boundaryRoot: root,
        logicalRoot: root,
        path: join(root, "any.txt"),
        options: cyclicOptions
        // No operation declares options this shape; only a serialized boundary
        // could frame one, which is what the refusal below is about.
      } as unknown as KernelFileSystem.AtomicRequest

      expect(yield* Effect.flip(runDirect(omitted, host))).toMatchObject({ reason: { _tag: "BadArgument" } })
      expect(yield* Effect.flip(runDirect(cyclic, host))).toMatchObject({ reason: { _tag: "BadArgument" } })
      expect(yield* Effect.promise(() => missing(marker))).toBe(false)
    }))

  it.live("fails closed when a helper claims success for an unsupported direct operation", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => writing(frame(`{"ok":true,"value":null}`)))
      const failure = yield* Effect.flip(runDirect(
        // The union names every operation, so an unsupported one reaches the
        // helper only across the serialized boundary this stands in for.
        {
          operation: "unsupported",
          boundaryRoot: root,
          logicalRoot: root
        } as unknown as KernelFileSystem.AtomicRequest,
        hostedBy(executable)
      ))
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("reports a rejection envelope that carries no message", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => writing(frame(`{"ok":false}`)))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("rejected the operation")
    }))

  it.live("prefers the helper's own rejection over a nonzero exit and its stderr", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        writing(frame(`{"ok":false,"code":"ENOENT","message":"gone"}`), {
          code: 7,
          stderr: "noise on the way out"
        })
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )
      // The errno the syscall produced survives; the exit status does not
      // overwrite it with a generic fail-closed reason.
      expect(failure).toMatchObject({ reason: { _tag: "NotFound" } })
    }))

  it.live("refuses a well-formed success that arrives with a nonzero exit", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => writing(frame(`{"ok":true,"value":true}`), { code: 7 }))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("exited 7")
    }))

  it.live("reports the broken request pipe when a helper exits before draining stdin", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => fakeInterpreter(`process.exitCode = 0;`))
      // Larger than any pipe buffer, so the request write reaches a helper that
      // has already exited and the pipe raises EPIPE mid-write.
      const failure = yield* run(
        root,
        Effect.flatMap(
          FileSystem.FileSystem,
          (fs) => Effect.flip(fs.writeFileString(join(root, "big.txt"), "x".repeat(8 * 1024 * 1024)))
        ),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }), 30_000)

  it.live("fails the operation when the interpreter cannot be executed at all", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = join(yield* Effect.promise(() => temporaryDirectory()), "python3")
      // A regular, executable file that is neither a script nor a binary: the
      // exec fails after the checks pass, which is the child `error` path.
      yield* Effect.promise(() => writeFile(executable, Buffer.from([0x00, 0x01, 0x02, 0x03])))
      yield* Effect.promise(() => chmod(executable, 0o755))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("handles the child error event when an executable names an absent loader", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = join(yield* Effect.promise(() => temporaryDirectory()), "python3")
      yield* Effect.promise(() => writeFile(executable, "#!/definitely/not/a/real/interpreter\n"))
      yield* Effect.promise(() => chmod(executable, 0o755))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("fails closed when spawning the configured helper throws synchronously", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      // Node rejects a NUL-bearing executable before it can create a child or
      // emit its asynchronous `error` event.
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        hostedBy("\0")
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  /**
   * A response is decoded from the complete frame, never from per-chunk
   * strings, so a character split across two stdout writes survives. Decoding
   * each chunk would have produced replacement characters for both halves.
   */
  it.live("decodes a response whose multi-byte character is split across stdout chunks", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const complete = Buffer.from(frame(`{"ok":true,"value":["ラン.txt"]}`), "utf8")
      // Inside the first byte of the three-byte encoding of "ラ".
      const cut = complete.indexOf(Buffer.from("ラン", "utf8")) + 1
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `const all = Buffer.from(${JSON.stringify(complete.toString("base64"))}, "base64");` +
            `process.stdout.write(all.subarray(0, ${cut}));` +
            `setTimeout(() => process.stdout.write(all.subarray(${cut})), 25);`
        )
      )
      const entries = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(root)),
        hostedBy(executable)
      )
      expect(entries).toEqual(["ラン.txt"])
    }))
})

describe("atomic helper result validation", () => {
  const statCases: ReadonlyArray<readonly [string, string]> = [
    ["a non-object stat", `{"ok":true,"value":5}`],
    ["a null stat", `{"ok":true,"value":null}`],
    ["an unknown file type", `{"ok":true,"value":{"type":"Other"}}`],
    ["a non-numeric time", `{"ok":true,"value":{"type":"File","mtime":"soon"}}`],
    ["a non-finite time", `{"ok":true,"value":{"type":"File","mtime":1e999,"atime":1}}`],
    [
      "a finite time outside the Date range",
      `{"ok":true,"value":{"type":"File","mtime":9000000000000000,"atime":1,"birthtime":null,"dev":1,` +
      `"ino":1,"mode":1,"nlink":1,"uid":1,"gid":1,"rdev":1,"size":"1"}}`
    ],
    [
      "a fractional size",
      `{"ok":true,"value":{"type":"File","mtime":1,"atime":1,"birthtime":null,"dev":1,"ino":1,"mode":1,` +
      `"nlink":1,"uid":1,"gid":1,"rdev":1,"size":1.5}}`
    ],
    [
      "a negative size",
      `{"ok":true,"value":{"type":"File","mtime":1,"atime":1,"birthtime":null,"dev":1,"ino":1,"mode":1,` +
      `"nlink":1,"uid":1,"gid":1,"rdev":1,"size":-1}}`
    ]
  ]

  it.live.each(statCases)("fails closed on %s", ([_name, payload]) =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => writing(frame(payload)))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.stat(root))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("accepts a stat whose optional fields are absent or null", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        writing(frame(
          `{"ok":true,"value":{"type":"FIFO","mtime":1000,"atime":2000,"birthtime":null,"dev":1,"ino":2,` +
            `"mode":420,"nlink":1,"uid":3,"gid":4,"rdev":0,"size":0,"blksize":null}}`
        ))
      )
      const info = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(root)),
        hostedBy(executable)
      )
      expect(info.type).toBe("FIFO")
      // The helper reports milliseconds; each survives as its own value.
      expect(Option.map(info.mtime, (value) => value.getTime())).toEqual(Option.some(1000))
      expect(Option.map(info.atime, (value) => value.getTime())).toEqual(Option.some(2000))
      expect(info.birthtime._tag).toBe("None")
      expect(info.blksize._tag).toBe("None")
      // `blocks` is absent from the payload entirely rather than null.
      expect(info.blocks._tag).toBe("None")
    }))

  it.live("accepts a stat whose optional birthtime is present", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        writing(frame(
          `{"ok":true,"value":{"type":"File","mtime":1000,"atime":2000,"birthtime":3000,"dev":1,"ino":2,` +
            `"mode":420,"nlink":1,"uid":3,"gid":4,"rdev":0,"size":0}}`
        ))
      )
      const info = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(root)),
        hostedBy(executable)
      )
      // Each timestamp is the millisecond the helper reported, unscaled and
      // not swapped with its neighbours.
      expect(Option.map(info.mtime, (value) => value.getTime())).toEqual(Option.some(1000))
      expect(Option.map(info.atime, (value) => value.getTime())).toEqual(Option.some(2000))
      expect(Option.map(info.birthtime, (value) => value.getTime())).toEqual(Option.some(3000))
    }))

  const readCases: ReadonlyArray<readonly [string, string]> = [
    ["a non-object read result", `{"ok":true,"value":7}`],
    ["a null read result", `{"ok":true,"value":null}`],
    ["a non-string payload", `{"ok":true,"value":{"base64":7}}`],
    ["a payload that is not base64", `{"ok":true,"value":{"base64":"not base64!!"}}`],
    ...["AAA", "A===", "=AAA", "AA=A", "AAAA====", "AAA\\n", "AAAé"].map((base64) =>
      [
        `invalid base64 shape ${base64}`,
        JSON.stringify({ ok: true, value: { base64 } })
      ] as const
    )
  ]

  it.live.each(readCases)("fails closed on %s", ([_name, payload]) =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const executable = yield* Effect.promise(() => writing(frame(payload)))
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(target))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("validates success values for every non-file operation", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const attempt = (
        value: string,
        invoke: (fs: FileSystem.FileSystem) => Effect.Effect<unknown, PlatformError.PlatformError>
      ) =>
        Effect.gen(function*() {
          const executable = yield* Effect.promise(() => writing(frame(`{"ok":true,"value":${value}}`)))
          return yield* run(
            root,
            Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(invoke(fs))),
            hostedBy(executable)
          )
        })

      const failures = yield* Effect.all([
        attempt(`"yes"`, (fs) => fs.exists(target)),
        attempt(`{}`, (fs) => fs.readDirectory(root)),
        attempt(`["same","same"]`, (fs) => fs.readDirectory(root)),
        attempt(`["bad\\u0000name"]`, (fs) => fs.readDirectory(root)),
        attempt(`7`, (fs) => fs.realPath(target)),
        attempt(`true`, (fs) => fs.writeFileString(target, "replacement"))
      ], { concurrency: "unbounded" })
      for (const failure of failures) {
        expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      }
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("inside")
    }), 30_000)

  it.live("refuses a helper listing above the entry-count ceiling", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `const value = Array.from({ length: 100001 }, (_, index) => String(index));` +
            `const body = Buffer.from(JSON.stringify({ ok: true, value }));` +
            `process.stdout.write(Buffer.concat([Buffer.from("flows-atomic/1 " + body.length + "\\n"), body]));`
        )
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readDirectory(root))),
        hostedBy(executable)
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }), 30_000)

  it.live("preserves a file size beyond JavaScript's safe integer range", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const payload = `{"ok":true,"value":{"type":"File","mtime":1,"atime":1,"birthtime":null,"dev":1,"ino":1,` +
        `"mode":420,"nlink":1,"uid":1,"gid":1,"rdev":0,"size":"9007199254740993",` +
        `"blksize":"4096","blocks":1}}`
      const executable = yield* Effect.promise(() => writing(frame(payload)))
      const info = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(root)),
        hostedBy(executable)
      )
      expect(String(info.size)).toBe("9007199254740993")
      expect(info.blksize).toMatchObject({ _tag: "Some", value: 4096n })
    }))

  it.live("refuses a payload that decodes to more than the read limit", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const executable = yield* Effect.promise(() =>
        writing(frame(
          `{"ok":true,"value":{"base64":"${Buffer.alloc(64, 0x61).toString("base64")}"}}`
        ))
      )
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(target))),
        hostedBy(executable, { content: 8 })
      )
      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("over the 8 byte read limit")
    }))
})

describe("atomic special files", () => {
  const makeFifo = (path: string) =>
    promisify(execFile)(AtomicFileSystem.defaultExecutable, [
      "-I",
      "-c",
      "import os, sys; os.mkfifo(sys.argv[1])",
      path
    ])

  const makeSocket = (path: string) =>
    promisify(execFile)(AtomicFileSystem.defaultExecutable, [
      "-I",
      "-c",
      "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
      path
    ])

  /**
   * A FIFO used to read as a successful, empty regular file: the descriptor
   * was opened non-blocking and the empty read looked like end-of-file. A
   * caller could not tell that from an empty file, so a planted pipe silently
   * replaced content. The kind is now required on the descriptor itself.
   */
  it.live("refuses to read or write a FIFO while still answering metadata for it", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const pipe = join(root, "pipe")
      yield* Effect.promise(() => makeFifo(pipe))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            existing: yield* fs.exists(pipe),
            info: yield* fs.stat(pipe),
            listed: yield* fs.readDirectory(root),
            read: yield* Effect.flip(fs.readFile(pipe)),
            writes: yield* Effect.forEach(
              ["r+", "w", "w+", "a", "a+"] as ReadonlyArray<FileSystem.OpenFlag>,
              (flag) =>
                Effect.map(
                  Effect.result(fs.writeFileString(pipe, "escaped", { flag })),
                  (result) => `${flag}:${result._tag}`
                )
            )
          }
        })
      )

      expect(outcome.existing).toBe(true)
      // Effect declares FIFO as a file type; the helper reports the real kind.
      expect(outcome.info.type).toBe("FIFO")
      expect(outcome.listed).toEqual(["pipe"])
      expect(outcome.read).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.writes).toEqual(["r+:Failure", "w:Failure", "w+:Failure", "a:Failure", "a+:Failure"])
    }), 30_000)

  it.live("refuses to read or write a socket while still answering metadata for it", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const socket = join(root, "s")
      yield* Effect.promise(() => makeSocket(socket))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            existing: yield* fs.exists(socket),
            info: yield* fs.stat(socket),
            read: yield* Effect.flip(fs.readFile(socket)),
            write: yield* Effect.flip(fs.writeFileString(socket, "escaped"))
          }
        })
      )

      expect(outcome.existing).toBe(true)
      expect(outcome.info.type).toBe("Socket")
      expect(outcome.read._tag).toBe("PlatformError")
      expect(outcome.write._tag).toBe("PlatformError")
    }), 30_000)

  it.live("refuses to read or write a directory as content", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const directory = join(root, "nested")
      yield* Effect.promise(() => mkdir(directory))
      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            read: yield* Effect.flip(fs.readFile(directory)),
            write: yield* Effect.flip(fs.writeFileString(directory, "escaped"))
          }
        })
      )
      expect(outcome.read).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.write).toMatchObject({ reason: { _tag: "BadResource" } })
    }))

  /**
   * Everything that names an entry rather than reading it keeps working over a
   * special file, so ordinary workspaces are unaffected by the refusals above.
   */
  it.live("keeps naming operations working over a FIFO", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const pipe = join(root, "pipe")
      yield* Effect.promise(() => makeFifo(pipe))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            // A recursive makeDirectory may not absorb a FIFO the way it absorbs
            // an existing directory.
            directory: yield* Effect.flip(fs.makeDirectory(pipe, { recursive: true })),
            real: yield* fs.realPath(pipe),
            renamed: yield* Effect.result(fs.rename(pipe, join(root, "moved"))),
            removed: yield* Effect.result(fs.remove(join(root, "moved"))),
            gone: yield* fs.exists(join(root, "moved"))
          }
        })
      )

      expect(outcome.directory).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      expect(outcome.real).toMatch(/pipe$/)
      expect(outcome.renamed._tag).toBe("Success")
      expect(outcome.removed._tag).toBe("Success")
      expect(outcome.gone).toBe(false)
    }), 30_000)

  /**
   * The two grammar bounds are refusals rather than silent truncation: a
   * pattern that expands past them would otherwise match some prefix of what
   * the caller asked for, which is the worst possible answer for a selector.
   */
  it.live("reports a glob pattern past the grammar bounds as bad input", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      // 2^20 alternatives, refused before a single directory is read.
      const braces = yield* run(
        root,
        Effect.flatMap(
          FileSystem.FileSystem,
          (fs) => Effect.flip(fs.glob(join(root, `${"{a,b}".repeat(20)}.txt`), { root }))
        )
      )
      // The length bound is driven directly: the kernel's own capability schema
      // refuses a 5000-character resource before the helper is reached, so the
      // helper's bound is only observable underneath it.
      const boundaryRoot = yield* Effect.promise(() => realpath(root))
      const info = yield* Effect.promise(() => stat(boundaryRoot))
      const long = yield* Effect.flip(runDirect(
        {
          operation: "glob",
          pattern: join(root, `${"a".repeat(5000)}.txt`),
          root,
          boundaryRoot,
          rootIdentity: `${info.dev}:${info.ino}`,
          logicalRoot: root,
          options: { exclude: [] }
        },
        AtomicFileSystem.layer
      ))

      expect(braces.reason._tag).toBe("BadArgument")
      expect(long).toMatchObject({ reason: { _tag: "BadArgument" } })
    }))

  /**
   * A character class the old regex translation could not close was reported as
   * bad input. It is not bad input: "[]]" is a class holding one bracket, and
   * the native globber matches a file named "]" with it.
   */
  it.live("reads a bracket in the first position of a class as a member", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => writeFile(join(root, "]"), ""))
      yield* Effect.promise(() => writeFile(join(root, "a"), ""))
      const matched = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.glob(join(root, "[]]"), { root }))
      )
      expect(matched).toEqual([join(root, "]")])
    }))

  /**
   * The grammar used to be translated into a regular expression, where every
   * `*` became an independent greedy `[^/]*`. A pattern built from repeated
   * `*<char>` fragments made that regex backtrack exponentially: thirteen of
   * them against forty characters did not finish in over a hundred seconds,
   * and the compiled matcher then ran against every listed name, so one
   * authorized `glob` was a CPU exhaustion. The segment matcher that replaced
   * it is linear in the candidate's length, and the budget below is what says
   * so: no backtracking translator meets it.
   */
  it.live("answers a pattern of repeated wildcards within a fixed budget", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      // Forty characters carrying no `b` at all, so every alignment of every
      // fragment has to be ruled out before the name is refused.
      yield* Effect.promise(() => writeFile(join(root, `${"a".repeat(40)}.txt`), ""))
      const started = Date.now()
      const matched = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.glob(join(root, `${"*a".repeat(13)}*b.txt`), { root }))
      )
      expect(matched).toEqual([])
      // One CPython fork plus a two-entry listing. The bound is generous by two
      // orders of magnitude and still a hundred times under the blowup.
      expect(Date.now() - started).toBeLessThan(10_000)
    }), 60_000)

  /**
   * Every operation is one CPython fork, so without a ceiling an unbounded
   * `Effect.forEach` starts one interpreter per entry and pins every core. The
   * ceiling is one semaphore for the whole layer, which is the only arrangement
   * that bounds anything: one built per request would bound nothing.
   */
  it.live("admits queued writes before serializing or framing their payloads", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => fakeInterpreter("setInterval(() => {}, 1000);"))
      const originalConcat = Buffer.concat
      const originalStringify = JSON.stringify
      let frames = 0
      let serialized = 0
      let attempts = 0
      const concat = vi.spyOn(Buffer, "concat").mockImplementation((chunks, length) => {
        if (chunks.length === 2 && Buffer.from(chunks[0]!).toString("ascii").startsWith("flows-atomic/1 ")) {
          frames++
        }
        return originalConcat(chunks, length)
      })
      const stringify = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
        if (value?.operation === "writeFileString") serialized++
        return originalStringify(value, ...args)
      })
      try {
        yield* Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
          const data = "x".repeat(1024 * 1024)
          const before = AtomicFileSystem.helperSpawns()
          const pending = yield* Effect.forEach(Array.from({ length: 16 }, (_, index) => index), (index) =>
            Effect.suspend(() => {
              attempts++
              return atomic.execute({
                operation: "writeFileString",
                boundaryRoot: root,
                logicalRoot: root,
                path: join(root, String(index)),
                data
              })
            }), { concurrency: "unbounded" }).pipe(Effect.forkChild)
          try {
            while (attempts < 16) {
              yield* Effect.sleep(10)
            }
            yield* Effect.sleep(100)
            expect(AtomicFileSystem.helperSpawns() - before).toBe(1)
            expect({ serialized, frames }).toEqual({ serialized: 1, frames: 1 })
          } finally {
            yield* Fiber.interrupt(pending)
          }
        }).pipe(Effect.provide(AtomicFileSystem.layerWith({ executable, concurrency: 1 })))
      } finally {
        stringify.mockRestore()
        concat.mockRestore()
      }
    }))

  it.live("never runs more helper processes at once than the configured ceiling", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const log = join(yield* Effect.promise(() => temporaryDirectory()), "overlap.log")
      // Each stand-in marks its own start and end in one shared file. Small
      // appends from separate processes do not interleave, so the running sum
      // of the marks is the live process count.
      const executable = yield* Effect.promise(() =>
        fakeInterpreter(
          `const fs = require("node:fs");` +
            `fs.appendFileSync(${JSON.stringify(log)}, "+");` +
            `setTimeout(() => {` +
            `fs.appendFileSync(${JSON.stringify(log)}, "-");` +
            `process.stdout.write(Buffer.from(${JSON.stringify(frame(`{"ok":true,"value":true}`))}, "utf8"));` +
            `}, 150);`
        )
      )

      yield* run(
        root,
        Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          (index) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(join(root, `probe-${index}.txt`))),
          { concurrency: "unbounded" }
        ),
        AtomicFileSystem.layerWith({ executable, concurrency: 2 })
      )

      const marks = yield* Effect.promise(() => readFile(log, "utf8"))
      let live = 0
      let peak = 0
      for (const mark of marks) {
        live += mark === "+" ? 1 : -1
        peak = Math.max(peak, live)
      }
      // Every request ran, and never more than two interpreters at a time.
      expect(marks.split("+").length - 1).toBe(8)
      expect(peak).toBeLessThanOrEqual(2)
    }), 60_000)

  /**
   * Every other ceiling bounds what a helper may SAY. Nothing bounded how long
   * it could take to say it, so a helper that never answered held the fiber
   * until the run itself was interrupted.
   */
  it.live("kills a helper that never answers and fails the operation closed", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const executable = yield* Effect.promise(() => fakeInterpreter(`setTimeout(() => {}, 600000);`))

      const started = Date.now()
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
        AtomicFileSystem.layerWith({ executable, timeoutMs: 250 })
      )

      expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(described(failure)).toContain("did not answer within 250 ms")
      expect(Date.now() - started).toBeLessThan(30_000)
    }), 60_000)

  it.live("refuses a concurrency ceiling or a timeout that would disable the bound", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const attempt = (options: AtomicFileSystem.Options) =>
        run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.exists(join(root, "any.txt")))),
          AtomicFileSystem.layerWith(options)
        )
      for (
        const options of [
          { concurrency: 0 },
          { concurrency: 1.5 },
          { timeoutMs: 0 },
          { timeoutMs: -1 },
          { timeoutMs: 2_147_483_648 }
        ]
      ) {
        expect(yield* attempt(options)).toMatchObject({ reason: { _tag: "BadArgument" } })
      }
    }))

  /**
   * `Options` is a plain object the caller still holds. Re-reading it per
   * request meant a byte ceiling could change under a running host, which is
   * not a ceiling at all.
   */
  it.live("holds the ceilings it was built with even when the options object changes", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => writeFile(join(root, "over.txt"), "123456789"))
      const limits: { content: number } = { content: 8 }
      const host = AtomicFileSystem.layerWith({ limits })

      const before = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "over.txt")))),
        host
      )
      limits.content = 16 * 1024 * 1024
      const after = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "over.txt")))),
        host
      )

      expect(before).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(after).toMatchObject({ reason: { _tag: "BadResource" } })
    }))
})
