import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import {
  checkGeneratedFile,
  failureMessage,
  maximumFailureMessageCodeUnits,
  maximumGeneratedFileBytes,
  resolveOutputPath,
  writeGeneratedFile
} from "../src/GeneratedFile.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"

let root: string
const outside: Array<string> = []

const scratchOutside = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-generated-outside-"))
  outside.push(directory)
  return directory
}

/** Polls until `read` reports a value, so a test never sleeps a fixed span. */
const until = async <A>(read: () => Promise<A | undefined>): Promise<A> => {
  const deadline = Date.now() + 20_000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const write = (path: string, contents: string): Promise<void> =>
  Effect.runPromise(writeGeneratedFile(root, { path, contents }))

const check = (path: string, contents: string): Promise<void> =>
  Effect.runPromise(checkGeneratedFile(root, { path, contents }))

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-generated-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  for (const directory of outside.splice(0)) await Fs.rm(directory, { recursive: true, force: true })
})

describe("failureMessage", () => {
  it("does not invoke accessors, proxy traps, or user string conversion", () => {
    let calls = 0
    const getter = Object.defineProperty({}, "message", {
      get: () => {
        calls += 1
        return "getter message"
      }
    })
    const converted = {
      toString: () => {
        calls += 1
        return "converted message"
      }
    }
    const proxied = new Proxy(new Error("proxied message"), {
      getOwnPropertyDescriptor: (target, property) => {
        calls += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })

    expect(failureMessage(getter)).toBe("unknown failure")
    expect(failureMessage(converted)).toBe("unknown failure")
    expect(failureMessage(proxied)).toBe("unknown failure")
    expect(calls).toBe(0)
  })

  it("bounds and well-forms diagnostic text", () => {
    expect(failureMessage("")).toBe("unknown failure")
    expect(failureMessage("bad\ud800text")).toBe("bad\ufffdtext")
    expect(failureMessage("x".repeat(maximumFailureMessageCodeUnits + 1))).toHaveLength(
      maximumFailureMessageCodeUnits
    )
  })

  it.each([
    [42, "42"],
    [42n, "42"],
    [false, "false"],
    [Symbol.for("failure"), "Symbol(failure)"]
  ])("renders the primitive failure %s without user conversion", (cause, expected) => {
    expect(failureMessage(cause)).toBe(expected)
  })
})

describe("generated file paths", () => {
  it("normalizes workspace-root notation", () => {
    expect(resolveOutputPath("//generated/config.json")).toBe("generated/config.json")
  })

  it.each(["", ".", "../outside", "/tmp/outside", "C:\\outside", "bad\0name"])(
    "refuses %j",
    (path) => expect(() => resolveOutputPath(path)).toThrow()
  )

  it("revalidates a forged public action payload", async () => {
    const directory = await scratchOutside()
    const escaped = NodePath.join(directory, "escaped.txt")
    const path = NodePath.relative(root, escaped)

    await expect(write(path, "must not escape\n")).rejects.toThrow(/stay inside|leave|escapes the workspace/)
    await expect(Fs.stat(escaped)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("atomic generated-file writes", () => {
  it("creates nested parents and publishes the whole file", async () => {
    await write("generated/nested/config.json", "{\"ok\":true}\n")
    expect(await Fs.readFile(NodePath.join(root, "generated/nested/config.json"), "utf8"))
      .toBe("{\"ok\":true}\n")
    expect(await Fs.readdir(NodePath.join(root, "generated/nested"))).toEqual(["config.json"])
  })

  it("preserves the permission bits of an existing file", async () => {
    const path = NodePath.join(root, "config.json")
    await Fs.writeFile(path, "old\n", { mode: 0o640 })
    await Fs.chmod(path, 0o640)

    await write("config.json", "new\n")
    expect((await Fs.lstat(path)).mode & 0o7777).toBe(0o640)
    expect(await Fs.readFile(path, "utf8")).toBe("new\n")
  })

  it.skipIf(process.platform === "win32")("refuses a parent symlink that leaves the workspace", async () => {
    const directory = await scratchOutside()
    await Fs.symlink(directory, NodePath.join(root, "linked"))

    await expect(write("linked/config.json", "outside\n")).rejects.toThrow(/parent is a symbolic link/)
    expect(await Fs.readdir(directory)).toEqual([])
  })

  it.skipIf(process.platform === "win32")("refuses a parent symlink even when it points inside", async () => {
    await Fs.mkdir(NodePath.join(root, "real"))
    await Fs.symlink(NodePath.join(root, "real"), NodePath.join(root, "linked"))

    await expect(write("linked/config.json", "ambiguous\n")).rejects.toThrow(/parent is a symbolic link/)
    expect(await Fs.readdir(NodePath.join(root, "real"))).toEqual([])
  })

  it.skipIf(process.platform === "win32")("refuses to replace a generated-file symlink", async () => {
    const directory = await scratchOutside()
    const target = NodePath.join(directory, "target.json")
    await Fs.writeFile(target, "outside\n", "utf8")
    await Fs.symlink(target, NodePath.join(root, "config.json"))

    await expect(write("config.json", "replacement\n")).rejects.toThrow(/is a symbolic link/)
    expect(await Fs.readFile(target, "utf8")).toBe("outside\n")
  })

  it("refuses a directory at the output path", async () => {
    await Fs.mkdir(NodePath.join(root, "config.json"))
    await expect(write("config.json", "not a directory\n")).rejects.toThrow(/not a regular file/)
  })

  it("refuses contents that UTF-8 would encode lossily", async () => {
    await expect(write("config.json", "bad\ud800text")).rejects.toThrow(/unpaired UTF-16 surrogate/)
    await expect(Fs.stat(NodePath.join(root, "config.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses oversize contents before creating output parents", async () => {
    await expect(write("generated/config.json", "x".repeat(maximumGeneratedFileBytes + 1)))
      .rejects.toThrow(/generated contents exceed/)
    await expect(Fs.stat(NodePath.join(root, "generated"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses an overlong output path before touching the filesystem", async () => {
    await expect(write(`${"a".repeat(16 * 1024)}.json`, "content\n"))
      .rejects.toThrow(/path exceeds 16384 UTF-8 bytes/)
    expect(await Fs.readdir(root)).toEqual([])
  })

  it("refuses an output path deeper than the component ceiling", async () => {
    const path = `${Array.from({ length: 257 }, () => "a").join("/")}/out.txt`

    await expect(write(path, "content\n")).rejects.toThrow(/path exceeds 256 components/)
    expect(await Fs.readdir(root)).toEqual([])
  })

  it("refuses a workspace root that is not a real directory", async () => {
    const file = NodePath.join(root, "not-a-directory")
    await Fs.writeFile(file, "content\n", "utf8")

    await expect(Effect.runPromise(writeGeneratedFile(file, { path: "out.txt", contents: "new\n" })))
      .rejects.toThrow(/workspace root is not a real directory/)
  })

  it("honors cancellation before filesystem work starts", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled generated write"))
    await expect(Effect.runPromise(
      writeGeneratedFile(root, { path: "config.json", contents: "cancelled\n" }),
      { signal: controller.signal }
    )).rejects.toThrow()
    await expect(Fs.stat(NodePath.join(root, "config.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("generated-file checks", () => {
  it("accepts an exact file and reports missing and drifted files", async () => {
    await Fs.writeFile(NodePath.join(root, "config.json"), "expected\n", "utf8")
    await expect(check("config.json", "expected\n")).resolves.toBeUndefined()
    await expect(check("config.json", "different\n")).rejects.toThrow(/drifted/)
    await expect(check("missing.json", "expected\n")).rejects.toThrow(/missing/)
  })

  it.skipIf(process.platform === "win32")("refuses a checked-in symlink", async () => {
    await Fs.writeFile(NodePath.join(root, "target.json"), "expected\n", "utf8")
    await Fs.symlink("target.json", NodePath.join(root, "config.json"))
    await expect(check("config.json", "expected\n")).rejects.toThrow(/symbolic link/)
  })

  it("refuses invalid UTF-8", async () => {
    await Fs.writeFile(NodePath.join(root, "config.json"), Buffer.from([0xc3, 0x28]))
    await expect(check("config.json", "expected\n")).rejects.toThrow(/not valid UTF-8/)
  })

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting for a writer", async () => {
    execFileSync("mkfifo", [NodePath.join(root, "config.json")])
    await expect(check("config.json", "expected\n")).rejects.toThrow(/not a regular file/)
  })
})

/**
 * The generator drift check `S.Generate` plans for the `lint` verb.
 *
 * The generator writes into the real tree, so what is pinned here is the
 * bracket around it: every declared output is compared and restored, whether
 * the generator rewrote it, created it, or failed outright.
 */
describe("checkGenerator", () => {
  const generator = (body: string): Promise<void> => Fs.writeFile(NodePath.join(root, "gen.mjs"), body, "utf8")

  const payload = (changes: ReadonlyArray<string>): Compose.GenerateCheckPayload => ({
    run: {
      cwd: ".",
      argv: [process.execPath, "gen.mjs"],
      env: {},
      secrets: [],
      expectedExitCodes: [0],
      timeoutMs: 60_000
    },
    changes
  })

  const check = (changes: ReadonlyArray<string>): Promise<void> =>
    Effect.runPromise(Compose.checkGenerator({ workspaceRoot: root }, payload(changes)))

  const failure = (
    changes: ReadonlyArray<string>
  ): Promise<{ readonly tag: string; readonly message: string; readonly text: string }> =>
    Effect.runPromise(
      Effect.flip(
        Compose.checkGenerator({ workspaceRoot: root }, payload(changes)).pipe(
          Effect.mapError((error) => ({
            tag: error._tag,
            message: "message" in error ? error.message : "",
            text: JSON.stringify(error)
          }))
        )
      )
    )

  it("passes when the generator rewrites the bytes already checked in", async () => {
    await generator(`import { writeFileSync } from "node:fs"\nwriteFileSync("out.txt", "generated\\n")\n`)
    await Fs.writeFile(NodePath.join(root, "out.txt"), "generated\n", "utf8")

    await expect(check(["out.txt"])).resolves.toBeUndefined()
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("generated\n")
  })

  it("fails with the first differing line and restores the checked-in file", async () => {
    await generator(`import { writeFileSync } from "node:fs"\nwriteFileSync("out.txt", "generated\\n")\n`)
    await Fs.writeFile(NodePath.join(root, "out.txt"), "hand edited\n", "utf8")

    expect((await failure(["out.txt"])).message).toBe(
      "out.txt drifted from its generated form: 2 line(s) checked in, 2 regenerated; " +
        "first difference at line 1: \"hand edited\" became \"generated\""
    )
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("hand edited\n")
  })

  it("fails and removes a declared output the checkout does not carry", async () => {
    await generator(`import { writeFileSync } from "node:fs"\nwriteFileSync("out.txt", "generated\\n")\n`)

    expect((await failure(["out.txt"])).message).toContain("the checkout does not carry it")
    await expect(Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).rejects.toThrow()
  })

  /**
   * A declared output inside a nested package is still this declaration's
   * output. `changes` is a write set, not a glob over the declaring package,
   * so package scope must not shrink it: scoping it would snapshot nothing,
   * and the check would rewrite the tree and report success.
   */
  it("compares and restores a declared output inside a nested package", async () => {
    await Fs.mkdir(NodePath.join(root, "pkg"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "pkg/PACKAGE.ts"), "export const nested = 1\n", "utf8")
    await generator(`import { writeFileSync } from "node:fs"\nwriteFileSync("pkg/out.txt", "generated\\n")\n`)
    await Fs.writeFile(NodePath.join(root, "pkg/out.txt"), "hand edited\n", "utf8")

    const outcome = await check(["pkg/out.txt"]).then(() => "the check passed", String)

    expect(await Fs.readFile(NodePath.join(root, "pkg/out.txt"), "utf8")).toBe("hand edited\n")
    expect(outcome).toContain("pkg/out.txt drifted from its generated form")
  })

  /**
   * Interruption is one more way the check settles, and it settles after the
   * generator has already written. The restore is a finalizer so that a
   * cancelled `lint` leaves the checked-in bytes behind, exactly as a passing
   * or failing one does.
   */
  it("restores the checked-in bytes when the check is interrupted", async () => {
    await generator(
      `import { writeFileSync } from "node:fs"\n` +
        `writeFileSync("out.txt", "generated\\n")\n` +
        `setInterval(() => {}, 1000)\n`
    )
    await Fs.writeFile(NodePath.join(root, "out.txt"), "hand edited\n", "utf8")

    const fiber = Effect.runFork(Compose.checkGenerator({ workspaceRoot: root }, payload(["out.txt"])))
    await until(async () =>
      (await Fs.readFile(NodePath.join(root, "out.txt"), "utf8").catch(() => "")) === "generated\n"
        ? true
        : undefined
    )
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("hand edited\n")
  })

  it("reports a generator that failed, with the tree restored", async () => {
    await generator(
      `import { writeFileSync } from "node:fs"\nwriteFileSync("out.txt", "half written\\n")\nprocess.exit(3)\n`
    )
    await Fs.writeFile(NodePath.join(root, "out.txt"), "generated\n", "utf8")

    const reported = await failure(["out.txt"])
    expect(reported.tag).toBe("smithers-build/ExecError")
    expect(reported.text).toContain("\"exitCode\":3")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("generated\n")
  })
})

/**
 * What a `S.Generate` declaration has to say about the paths it writes.
 *
 * `changes` and `stdout` are the write set: the build system confines the spawn to
 * it, and a PACKAGE.ts workspace compares and restores exactly those paths under
 * the `lint` verb. A process form that declares neither is unconfined, so the
 * declaration is refused rather than checked against nothing.
 */
describe("Generate declarations", () => {
  it("refuses a script form that declares neither changes nor stdout", () => {
    expect(() => Compose.Generate({ script: Input.file("//gen.mjs") }))
      .toThrow(/changes or stdout/)
  })

  it("refuses a command form whose changes list is empty", () => {
    expect(() => Compose.Generate({ command: "printf ok", changes: [] }))
      .toThrow(/changes or stdout/)
  })

  it("accepts the emit form, which names its outputs as the map keys", () => {
    expect(() => Compose.Generate({ emit: { "CLAUDE.md": "AGENTS.md" } })).not.toThrow()
  })

  it("declares the drift failure the lint verb reports", () => {
    const target = Compose.Generate({ script: Input.file("//gen.mjs"), changes: ["out.txt"] })

    expect(JSON.stringify(Target.metadata(target).schemaIdentity))
      .toContain("smithers-build/DriftError")
  })
})
