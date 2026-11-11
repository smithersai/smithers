/**
 * The staging path every input-channel-less provider feeds standard input
 * through.
 *
 * `AwsSandbox`, `VercelSandbox`, `DaytonaSandbox`, and `CloudflareSandbox` all
 * put a command's standard input in a temporary file outside the checkout because their transports
 * take a command line and nothing else, so a caller's script, patch, or
 * credential blob lives on the machine for as long as this module leaves it
 * there. The provider suites prove the happy path end to end; these cases
 * prove the ones a working transport never reaches.
 */
import { describe, expect, it } from "@effect/vitest"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { stdinRedirect } from "../src/internal/stdinRedirect.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"

/**
 * A target that records what it was asked to do, and can fail the write the
 * way a chunked one does: after some of the bytes are already on the machine.
 */
const recorded = (options: { readonly failWrite?: boolean; readonly workdir?: string } = {}) => {
  const writes: Array<string> = []
  const removals: Array<string> = []
  return {
    writes,
    removals,
    target: {
      workdir: options.workdir ?? "/workspace/",
      writeFile: (path: string, _content: Uint8Array) => {
        writes.push(path)
        return options.failWrite === true
          ? Effect.fail(
            new ProviderError({ code: "unknown", message: "the fourth slice of the write failed" })
          )
          : Effect.void
      },
      remove: (path: string) => {
        removals.push(path)
        return Effect.void
      }
    }
  }
}

describe("stdinRedirect", () => {
  it.effect.each([
    "/tmp",
    "/tmp/",
    "/tmp/../tmp",
    "/tmp/.smthrs-stdin",
    "/tmp/.smthrs-stdin/child"
  ])("selects a disjoint staging directory for checkout %s", (workdir) =>
    Effect.gen(function*() {
      const { target, writes } = recorded({ workdir })
      yield* Effect.scoped(stdinRedirect(target)("cat", new Uint8Array([1])))
      expect(writes[0]).toMatch(/^\/var\/tmp\/\.smthrs-stdin\/[0-9a-f]{32}\/[0-9a-f]{32}$/)
    }))

  it.effect.each(["/", "//", "/tmp/.."])(
    "refuses staged input for root checkout %s before writing",
    (workdir) =>
      Effect.gen(function*() {
        const { target, writes, removals } = recorded({ workdir })
        const error = yield* Effect.flip(Effect.scoped(stdinRedirect(target)("cat", new Uint8Array([1]))))
        expect(error.code).toBe("spawn_error")
        expect(error.message).toContain("outside the checkout")
        expect(writes).toEqual([])
        expect(removals).toEqual([])
        expect(yield* Effect.scoped(stdinRedirect(target)("true", undefined))).toBe("true")
      })
  )

  for (
    const { command, name, stdout } of [
      { name: "a trailing comment", command: "cat # trailing comment", stdout: "staged input\n" },
      { name: "a final heredoc terminator", command: "cat <<EOF\nhello\nEOF", stdout: "hello\n" }
    ]
  ) {
    it.effect.skipIf(!existsSync("/bin/sh"))(
      `executes a command ending with ${name}`,
      () =>
        Effect.scoped(Effect.gen(function*() {
          const workdir = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync(join(tmpdir(), "smthrs-stdin redirect-"))),
            (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
          )
          const line = yield* stdinRedirect({
            workdir,
            writeFile: (path, content) =>
              Effect.sync(() => {
                mkdirSync(dirname(path), { recursive: true })
                writeFileSync(path, content)
              }),
            remove: (path) => Effect.sync(() => rmSync(path))
          })(command, new TextEncoder().encode("staged input\n"))
          const result = spawnSync("/bin/sh", ["-c", line], { encoding: "utf8", timeout: 5000 })

          expect(result.error).toBeUndefined()
          expect(result.status, result.stderr).toBe(0)
          expect(result.stderr).toBe("")
          expect(result.stdout).toBe(stdout)
        }))
    )
  }

  it.effect("keeps staged input outside the checkout even when removal fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const workdir = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "smthrs-stdin-checkout-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
      )
      const files: Array<string> = []
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const file of files) rmSync(file, { force: true })
        })
      )
      yield* Effect.scoped(Effect.gen(function*() {
        const target = {
          workdir,
          writeFile: (path: string, content: Uint8Array) =>
            Effect.sync(() => {
              files.push(path)
              mkdirSync(dirname(path), { recursive: true })
              writeFileSync(path, content)
            }),
          remove: () => Effect.fail(new ProviderError({ code: "unknown", message: "removal failed" }))
        }
        const line = yield* stdinRedirect(target)("cat", new TextEncoder().encode("private input"))
        const result = spawnSync("/bin/sh", ["-c", line], { cwd: workdir, encoding: "utf8" })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toBe("private input")
        expect(relative(workdir, files[0]!)).toMatch(/^\.\.\//)
      }))
      expect(existsSync(files[0]!)).toBe(true)
    })))

  it.effect("leaves a command with no input alone", () =>
    Effect.gen(function*() {
      const { removals, target, writes } = recorded()
      const line = yield* Effect.scoped(stdinRedirect(target)("cat", undefined))

      expect(line).toBe("cat")
      expect(writes).toEqual([])
      expect(removals).toEqual([])
    }))

  it.effect("stages input outside the workspace and takes it away when the scope closes", () =>
    Effect.gen(function*() {
      const { removals, target, writes } = recorded()
      const line = yield* Effect.scoped(
        Effect.tap(stdinRedirect(target)("cat > out", new Uint8Array([1, 2, 3])), () =>
          Effect.sync(() => {
            // The file is still there while the command that reads it runs.
            expect(removals).toEqual([])
          }))
      )
      const staged = writes[0]!

      expect(staged).toMatch(/^\/tmp\/\.smthrs-stdin\/[0-9a-f]{32}\/[0-9a-f]{32}$/)
      expect(line).toBe(`(\ncat > out\n) < ${CommandLine.quote(staged)}`)
      expect(removals).toEqual([staged])
    }))

  // The removal used to be registered by `Effect.acquireRelease` with the
  // write as its acquire, and Effect registers a release only after its
  // acquire SUCCEEDS. No bundled provider writes atomically: `AwsSandbox`
  // sends one `printf | base64 -d` per `ExecTransport.chunkBytes` bytes and
  // stops at the first non-zero status, so a session that dropped partway
  // through a 32 KiB input left the earlier chunks in the workspace with
  // nothing registered to remove them, for the life of the machine and across
  // a reattach. That is the leak the scoped staging exists to close, and it
  // has to be closed before the first byte is written rather than after the
  // last one.
  it.effect("removes the staging file when the write itself fails partway", () =>
    Effect.gen(function*() {
      const { removals, target, writes } = recorded({ failWrite: true })
      const exit = yield* Effect.exit(
        Effect.scoped(stdinRedirect(target)("cat", new Uint8Array([1, 2, 3])))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(writes).toHaveLength(1)
      expect(removals).toEqual(writes)
    }))

  it.effect("names every staged file differently, so a reattach cannot read the last one", () =>
    Effect.gen(function*() {
      const { target, writes } = recorded()
      const redirect = stdinRedirect(target)
      yield* Effect.scoped(
        Effect.andThen(
          redirect("first", new Uint8Array([1])),
          redirect("second", new Uint8Array([2]))
        )
      )

      expect(writes).toHaveLength(2)
      expect(new Set(writes).size).toBe(2)
    }))
})
