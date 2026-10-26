import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxTools from "../src/SandboxTools/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

// The tools run real shell scripts and real git in a real scratch directory (DirectorySandbox), as they run in a
// container: what each call answers is what the guest did.

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-sandbox-tools-")))
const calls = join(root, "calls")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const provider = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return DirectorySandbox.make({ fs, spawner, root: join(root, "machines") })
}).pipe(Effect.provide(platform))

let sessions = 0
/** Runs `body` on a fresh machine whose workdir holds a git repository with one commit of `README.md`. */
const onMachine = <A, E>(
  body: (session: Sandbox.Session) => Effect.Effect<A, E>,
  options: { readonly git?: boolean } = {}
) =>
  Effect.scoped(Effect.gen(function*() {
    const session = yield* (yield* provider).acquire(`tools-${++sessions}`)
    if (options.git !== false) {
      git(session.workdir, "init", "-q", "-b", "main")
      writeFileSync(join(session.workdir, "README.md"), "hello\n")
      git(session.workdir, "add", "README.md")
      git(session.workdir, "commit", "-q", "-m", "first")
    }
    return yield* body(session)
  }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8"
  })

let ids = 0
const exec = (session: Sandbox.Session, call: SandboxTools.Call, callId = `call-${++ids}`) =>
  SandboxTools.execute(session, call, { callId, callsDirectory: calls })

/** The call's failure; a call that succeeds fails the test with its result. */
const failure = <A>(effect: Effect.Effect<A, SandboxTools.ToolFailure>) => Effect.flip(effect)

const slow = { timeout: 60_000 }

describe("SandboxTools.resolve", () => {
  it("takes a path under the workdir and refuses one that leaves it", () => {
    expect(SandboxTools.resolve("/workspace", "src/a.ts")).toBe("/workspace/src/a.ts")
    expect(SandboxTools.resolve("/workspace/", "./src//b/../a.ts")).toBe("/workspace/src/a.ts")
    expect(SandboxTools.resolve("/workspace", "/workspace/a")).toBe("/workspace/a")
    expect(SandboxTools.resolve("/workspace", ".")).toBe("/workspace")
    expect(SandboxTools.resolve("/workspace", "")).toBe("/workspace")
    expect(SandboxTools.resolve("/workspace", "../etc/passwd")).toBeUndefined()
    expect(SandboxTools.resolve("/workspace", "a/../../workspace2")).toBeUndefined()
    expect(SandboxTools.resolve("/workspace", "/etc/passwd")).toBeUndefined()
    expect(SandboxTools.resolve("/workspace", "/workspace2/a")).toBeUndefined()
    expect(SandboxTools.resolve("/workspace", "a\0b")).toBeUndefined()
    expect(SandboxTools.resolve("/workspace", "/..")).toBeUndefined()
    expect(SandboxTools.resolve("/", "etc")).toBe("/etc")
  })

  it("names the tools, and which change the working copy", () => {
    expect(SandboxTools.tools).toEqual(["run", "read", "write", "list", "status", "diff"])
    expect(SandboxTools.tools.filter(SandboxTools.mutates)).toEqual(["run", "write"])
  })
})

describe("SandboxTools run", () => {
  it.effect(
    "answers the exit code and both streams, in the workdir or a cwd under it",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          mkdirSync(join(session.workdir, "sub"))
          const ran = yield* exec(session, { tool: "run", command: "pwd; echo oops >&2; exit 3" })
          expect(ran).toEqual({
            tool: "run",
            exitCode: 3,
            timedOut: false,
            stdout: `${session.workdir}\n`,
            stderr: "oops\n",
            stdoutBytes: session.workdir.length + 1,
            stderrBytes: 5,
            truncated: false
          })
          const inSub = yield* exec(session, { tool: "run", command: "pwd", cwd: "sub" })
          expect(inSub).toMatchObject({ exitCode: 0, stdout: `${session.workdir}/sub\n` })
        })
      ),
    slow
  )

  it.effect(
    "runs a command at most once: the same call again answers what it recorded",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          const call = { tool: "run", command: "echo ran >> runs.log; wc -l < runs.log" } as const
          const first = yield* exec(session, call, "once")
          const again = yield* exec(session, call, "once")
          expect(again).toEqual(first)
          expect(readFileSync(join(session.workdir, "runs.log"), "utf8")).toBe("ran\n")
          // Another call is another run.
          yield* exec(session, call, "twice")
          expect(readFileSync(join(session.workdir, "runs.log"), "utf8")).toBe("ran\nran\n")
        })
      ),
    slow
  )

  it.effect(
    "fails ToolLost for a call an earlier attempt started and never finished, without running it",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          mkdirSync(join(calls, "started-before"), { recursive: true })
          const lost = yield* failure(exec(session, { tool: "run", command: "touch ran" }, "started-before"))
          expect(lost._tag).toBe("@smthrs/sandbox/SandboxTools/ToolLost")
          expect(existsSync(join(session.workdir, "ran"))).toBe(false)
        })
      ),
    slow
  )

  it.effect("stops a command at its timeout and says so", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const ran = yield* exec(session, { tool: "run", command: "echo before; sleep 30", timeoutSeconds: 1 })
        expect(ran).toMatchObject({ tool: "run", timedOut: true, stdout: "before\n" })
        expect((ran as typeof SandboxTools.RunResult.Type).exitCode).toBeGreaterThan(123)
        // A command that fails fast with a high code did not time out.
        const fast = yield* exec(session, { tool: "run", command: "exit 127", timeoutSeconds: 5 })
        expect(fast).toMatchObject({ exitCode: 127, timedOut: false })
      })
    ), slow)

  it.effect(
    "keeps the first outputBytes of each stream and counts the rest",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          const over = SandboxTools.limits.outputBytes + 10
          const ran = yield* exec(session, {
            tool: "run",
            command: `head -c ${over} /dev/zero | tr '\\0' a; head -c ${over} /dev/zero | tr '\\0' b >&2`
          }) as Effect.Effect<typeof SandboxTools.RunResult.Type>
          expect(ran.truncated).toBe(true)
          expect(ran.stdoutBytes).toBe(over)
          expect(ran.stderrBytes).toBe(over)
          expect(ran.stdout).toBe("a".repeat(SandboxTools.limits.outputBytes))
          expect(ran.stderr).toBe("b".repeat(SandboxTools.limits.outputBytes))
          const quiet = yield* exec(session, {
            tool: "run",
            command: `head -c ${over} /dev/zero >&2`
          }) as Effect.Effect<
            typeof SandboxTools.RunResult.Type
          >
          expect(quiet).toMatchObject({ stdout: "", stdoutBytes: 0, stderrBytes: over, truncated: true })
        })
      ),
    slow
  )

  it.effect(
    "refuses a cwd outside the workdir, records a cwd that isn't a directory, and fails on a broken fence",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          const outside = yield* failure(exec(session, { tool: "run", command: "true", cwd: "../.." }))
          expect(outside).toMatchObject({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "path" })
          const missing = { tool: "run", command: "touch ran", cwd: "nowhere" } as const
          expect(yield* failure(exec(session, missing, "no-cwd"))).toMatchObject({ reason: "not_a_directory" })
          mkdirSync(join(session.workdir, "nowhere"))
          // The same call answers what it recorded, even once the directory exists.
          expect(yield* failure(exec(session, missing, "no-cwd"))).toMatchObject({ reason: "not_a_directory" })
          expect(existsSync(join(session.workdir, "nowhere", "ran"))).toBe(false)
          // A command that exits 20 by itself is no refusal.
          expect(yield* exec(session, { tool: "run", command: "exit 20" })).toMatchObject({ exitCode: 20 })
          writeFileSync(join(root, "a-file"), "")
          const broken = yield* failure(
            SandboxTools.execute(session, { tool: "run", command: "true" }, {
              callId: "x",
              callsDirectory: join(root, "a-file", "calls")
            })
          )
          expect(broken).toMatchObject({ _tag: "@smthrs/sandbox/SandboxTools/ToolUnavailable", code: "unknown" })
          const escaping = yield* failure(
            SandboxTools.execute(session, { tool: "run", command: "true" }, { callId: "x", callsDirectory: "/../.." })
          )
          expect(escaping).toMatchObject({ reason: "path" })
        })
      ),
    slow
  )
})

describe("SandboxTools read and write", () => {
  it.effect(
    "writes a file, making its directories, and reads it back",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          const written = yield* exec(session, { tool: "write", path: "src/deep/note.txt", content: "héllo\n" })
          expect(written).toEqual({ tool: "write", path: "src/deep/note.txt", bytes: 7 })
          expect(readFileSync(join(session.workdir, "src/deep/note.txt"), "utf8")).toBe("héllo\n")
          const replaced = yield* exec(session, {
            tool: "write",
            path: `${session.workdir}/src/deep/note.txt`,
            content: ""
          })
          expect(replaced).toEqual({ tool: "write", path: "src/deep/note.txt", bytes: 0 })
          const read = yield* exec(session, { tool: "read", path: "README.md" })
          expect(read).toEqual({ tool: "read", path: "README.md", content: "hello\n", bytes: 6, truncated: false })
        })
      ),
    slow
  )

  it.effect("reads the first fileBytes of a larger file", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const size = SandboxTools.limits.fileBytes + 5
        writeFileSync(join(session.workdir, "big.txt"), "x".repeat(size))
        const read = yield* exec(session, { tool: "read", path: "big.txt" }) as Effect.Effect<
          typeof SandboxTools.ReadResult.Type
        >
        expect(read.bytes).toBe(size)
        expect(read.truncated).toBe(true)
        expect(read.content.length).toBe(SandboxTools.limits.fileBytes)
      })
    ), slow)

  it.effect("refuses what it can't read or write", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        expect(yield* failure(exec(session, { tool: "read", path: "absent" }))).toMatchObject({ reason: "not_found" })
        mkdirSync(join(session.workdir, "dir"))
        expect(yield* failure(exec(session, { tool: "read", path: "dir" }))).toMatchObject({ reason: "not_a_file" })
        expect(yield* failure(exec(session, { tool: "read", path: "../x" }))).toMatchObject({ reason: "path" })
        expect(yield* failure(exec(session, { tool: "write", path: "dir", content: "" }))).toMatchObject({
          reason: "not_a_file"
        })
        expect(yield* failure(exec(session, { tool: "write", path: "README.md/x", content: "" }))).toMatchObject({
          reason: "not_a_directory"
        })
        expect(yield* failure(exec(session, { tool: "write", path: ".", content: "" }))).toMatchObject({
          reason: "path"
        })
        expect(yield* failure(exec(session, { tool: "write", path: "/tmp/x", content: "" }))).toMatchObject({
          reason: "path"
        })
        // Within the character limit, over the byte limit.
        const wide = "é".repeat(SandboxTools.limits.fileBytes / 2 + 1)
        expect(yield* failure(exec(session, { tool: "write", path: "wide.txt", content: wide }))).toMatchObject({
          reason: "too_large"
        })
        expect(existsSync(join(session.workdir, "wide.txt"))).toBe(false)
      })
    ), slow)
})

describe("SandboxTools list", () => {
  it.effect(
    "lists a directory's entries by kind, hidden ones included",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          writeFileSync(join(session.workdir, ".hidden"), "abc")
          writeFileSync(join(session.workdir, "with space.txt"), "")
          mkdirSync(join(session.workdir, "src"))
          symlinkSync("README.md", join(session.workdir, "link"))
          const listed = yield* exec(session, { tool: "list" }) as Effect.Effect<typeof SandboxTools.ListResult.Type>
          expect(listed.path).toBe(".")
          expect(listed.truncated).toBe(false)
          expect([...listed.entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            { name: ".git", kind: "directory", bytes: 0 },
            { name: ".hidden", kind: "file", bytes: 3 },
            { name: "link", kind: "symlink", bytes: 0 },
            { name: "README.md", kind: "file", bytes: 6 },
            { name: "src", kind: "directory", bytes: 0 },
            { name: "with space.txt", kind: "file", bytes: 0 }
          ])
          const sub = yield* exec(session, { tool: "list", path: "src" })
          expect(sub).toEqual({ tool: "list", path: "src", entries: [], truncated: false })
        })
      ),
    slow
  )

  it.effect("cuts a listing at listEntries", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const many = join(session.workdir, "many")
        mkdirSync(many)
        for (let index = 0; index <= SandboxTools.limits.listEntries; index++) {
          writeFileSync(join(many, `f${index}`), "")
        }
        const listed = yield* exec(session, { tool: "list", path: "many" }) as Effect.Effect<
          typeof SandboxTools.ListResult.Type
        >
        expect(listed.truncated).toBe(true)
        expect(listed.entries.length).toBe(SandboxTools.limits.listEntries)
      }), { git: false }), slow)

  it.effect("refuses what isn't a directory under the workdir", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        expect(yield* failure(exec(session, { tool: "list", path: "absent" }))).toMatchObject({ reason: "not_found" })
        expect(yield* failure(exec(session, { tool: "list", path: "README.md" }))).toMatchObject({
          reason: "not_a_directory"
        })
        expect(yield* failure(exec(session, { tool: "list", path: "/" }))).toMatchObject({ reason: "path" })
      })
    ), slow)
})

describe("SandboxTools status and diff", () => {
  it.effect("compares commits and pending changes to a base without changing the real index", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const base = git(session.workdir, "rev-parse", "HEAD").trim()
        writeFileSync(join(session.workdir, "committed.txt"), "committed\n")
        git(session.workdir, "add", ".")
        git(session.workdir, "commit", "-m", "agent")
        git(session.workdir, "mv", "README.md", "renamed.md")
        writeFileSync(join(session.workdir, "pending.txt"), "pending\n")
        const before = git(session.workdir, "status", "--porcelain=v1")
        expect(yield* exec(session, { tool: "status", base })).toEqual({
          tool: "status",
          branch: null,
          entries: [
            { path: "README.md", index: "D", worktree: " " },
            { path: "committed.txt", index: "A", worktree: " " },
            { path: "pending.txt", index: "A", worktree: " " },
            { path: "renamed.md", index: "A", worktree: " " }
          ]
        })
        expect(git(session.workdir, "status", "--porcelain=v1")).toBe(before)
        git(session.workdir, "reset", "--hard", base)
        rmSync(join(session.workdir, "pending.txt"))
        expect(yield* exec(session, { tool: "status", base })).toMatchObject({ entries: [] })
        expect(yield* failure(exec(session, { tool: "status", base: "f".repeat(40) }))).toMatchObject({
          _tag: "@smthrs/sandbox/SandboxTools/ToolUnavailable"
        })
      })
    ))

  it.effect(
    "refuses base-relative status output larger than diffBytes",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          const base = git(session.workdir, "rev-parse", "HEAD").trim()
          const prefix = "x".repeat(240)
          const count = Math.ceil((SandboxTools.limits.diffBytes + 1) / (prefix.length + 8))
          for (let index = 0; index < count; index++) {
            writeFileSync(join(session.workdir, `${prefix}${String(index).padStart(5, "0")}`), "")
          }
          expect(yield* failure(exec(session, { tool: "status", base }))).toEqual(
            new SandboxTools.ToolUnavailable({ code: "unknown" })
          )
          expect(git(session.workdir, "diff", "--cached", "--name-only")).toBe("")
        })
      ),
    slow
  )

  it.effect("refuses a base tree path outside the workdir", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const blob = git(session.workdir, "rev-parse", "HEAD:README.md").trim()
        // An untrusted base can contain a malformed tree even though the index refuses such paths.
        const tree = Buffer.concat([Buffer.from("100644 ../outside\0"), Buffer.from(blob, "hex")])
        const base = execFileSync("git", ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"], {
          cwd: session.workdir,
          input: tree,
          encoding: "utf8"
        }).trim()
        expect(yield* failure(exec(session, { tool: "status", base }))).toMatchObject({
          _tag: "@smthrs/sandbox/SandboxTools/ToolRefused",
          reason: "path"
        })
        expect(readFileSync(join(session.workdir, "README.md"), "utf8")).toBe("hello\n")
        expect(git(session.workdir, "status", "--porcelain=v1")).toBe("")
      })
    ), slow)

  it.effect(
    "reports the branch and every changed path, renames with their old path",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          writeFileSync(join(session.workdir, "README.md"), "changed\n")
          writeFileSync(join(session.workdir, "keep.txt"), "k\n")
          git(session.workdir, "add", "keep.txt")
          git(session.workdir, "commit", "-q", "-m", "keep")
          git(session.workdir, "mv", "keep.txt", "kept.txt")
          writeFileSync(join(session.workdir, "new file.txt"), "new\n")
          const status = yield* exec(session, { tool: "status" }) as Effect.Effect<
            typeof SandboxTools.StatusResult.Type
          >
          expect(status.branch).toBe("main")
          expect(status.entries).toEqual([
            { path: "README.md", index: " ", worktree: "M" },
            { path: "kept.txt", index: "R", worktree: " ", from: "keep.txt" },
            { path: "new file.txt", index: "?", worktree: "?" }
          ])
          git(session.workdir, "checkout", "-q", "--detach")
          expect(yield* exec(session, { tool: "status" })).toMatchObject({ branch: null })
        })
      ),
    slow
  )

  it.effect(
    "names the branch of a repository with no commits, and refuses a workdir that isn't one",
    () =>
      Effect.gen(function*() {
        yield* onMachine((session) =>
          Effect.gen(function*() {
            git(session.workdir, "init", "-q", "-b", "fresh")
            writeFileSync(join(session.workdir, "a"), "")
            expect(yield* exec(session, { tool: "status" })).toEqual({
              tool: "status",
              branch: "fresh",
              entries: [{ path: "a", index: "?", worktree: "?" }]
            })
          }), { git: false })
        yield* onMachine((session) =>
          Effect.gen(function*() {
            expect(yield* failure(exec(session, { tool: "status" }))).toMatchObject({ reason: "not_a_repository" })
            expect(yield* failure(exec(session, { tool: "diff" }))).toMatchObject({ reason: "not_a_repository" })
          }), { git: false })
      }),
    slow
  )

  it.effect(
    "diffs tracked changes and untracked files as new ones, optionally for some paths",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          writeFileSync(join(session.workdir, "README.md"), "hello\nworld\n")
          writeFileSync(join(session.workdir, "hello.txt"), "hi\n")
          const diff = yield* exec(session, { tool: "diff" }) as Effect.Effect<typeof SandboxTools.DiffResult.Type>
          expect(diff.truncated).toBe(false)
          expect(diff.bytes).toBe(new TextEncoder().encode(diff.diff).byteLength)
          expect(diff.diff).toContain("+world")
          expect(diff.diff).toContain("new file mode")
          expect(diff.diff).toContain("+hi")
          const only = yield* exec(session, { tool: "diff", paths: ["hello.txt"] }) as Effect.Effect<
            typeof SandboxTools.DiffResult.Type
          >
          expect(only.diff).toContain("+hi")
          expect(only.diff).not.toContain("+world")
          expect(yield* failure(exec(session, { tool: "diff", paths: ["../x"] }))).toMatchObject({ reason: "path" })
          const clean = yield* onMachine((fresh) => exec(fresh, { tool: "diff" }))
          expect(clean).toEqual({ tool: "diff", diff: "", bytes: 0, truncated: false })
        })
      ),
    slow
  )

  it.effect("cuts a diff at diffBytes", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        writeFileSync(join(session.workdir, "big.txt"), "line\n".repeat(SandboxTools.limits.diffBytes / 4))
        const diff = yield* exec(session, { tool: "diff" }) as Effect.Effect<typeof SandboxTools.DiffResult.Type>
        expect(diff.truncated).toBe(true)
        expect(diff.bytes).toBeGreaterThan(SandboxTools.limits.diffBytes)
        expect(new TextEncoder().encode(diff.diff).byteLength).toBe(SandboxTools.limits.diffBytes)
      })
    ), slow)
})

/**
 * `session`, whose scripts find a `git` that logs each subcommand to `log` before it runs the real one: what a script
 * asked git to do.
 */
const loggingGit = (session: Sandbox.Session, log: string): Sandbox.Session => {
  const bin = mkdtempSync(join(root, "bin-"))
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$1" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  return {
    ...session,
    spawn: (command, options) =>
      session.spawn(command, { ...options, env: { ...options?.env, PATH: `${bin}:${process.env.PATH}` } })
  }
}

describe("SandboxTools checkpoint and restore", () => {
  it.effect(
    "stages from the checkout's own index, so only the files that changed are read, and carries the same patch",
    () =>
      onMachine((session) =>
        Effect.gen(function*() {
          for (let index = 0; index < 20; index++) writeFileSync(join(session.workdir, `f${index}.txt`), `${index}\n`)
          git(session.workdir, "add", ".")
          git(session.workdir, "commit", "-q", "-m", "files")
          writeFileSync(join(session.workdir, "f3.txt"), "changed\n")
          writeFileSync(join(session.workdir, "staged.txt"), "staged\n")
          git(session.workdir, "add", "staged.txt")
          writeFileSync(join(session.workdir, "staged.txt"), "staged, then changed\n")
          rmSync(join(session.workdir, "f7.txt"))
          const log = join(root, `git-${++sessions}.log`)
          const seeded = yield* SandboxTools.checkpoint(loggingGit(session, log))
          // The copied index stands in for `read-tree HEAD`: nothing rebuilt it from the commit.
          expect(readFileSync(log, "utf8").split("\n")).not.toContain("read-tree")
          const patch = new TextDecoder().decode(seeded.patch)
          expect(patch).toContain("+changed")
          expect(patch).toContain("+staged, then changed")
          expect(patch).toContain("deleted file mode")
          // A checkout with no index of its own starts from HEAD, and carries the same patch.
          rmSync(join(session.workdir, ".git", "index"))
          const fresh = yield* SandboxTools.checkpoint(loggingGit(session, log))
          expect(readFileSync(log, "utf8").split("\n")).toContain("read-tree")
          expect(fresh).toEqual(seeded)
        })
      ),
    slow
  )

  it.effect(
    "carries tracked, untracked and deleted changes to a fresh clone at another commit",
    () =>
      Effect.gen(function*() {
        const origin = join(root, `origin-${++sessions}`)
        mkdirSync(origin)
        git(origin, "init", "-q", "-b", "main")
        writeFileSync(join(origin, "a.txt"), "a\n")
        writeFileSync(join(origin, "gone.txt"), "gone\n")
        writeFileSync(join(origin, "bin"), new Uint8Array([0, 1, 2, 255]))
        git(origin, "add", ".")
        git(origin, "commit", "-q", "-m", "base")
        const base = git(origin, "rev-parse", "HEAD").trim()

        const saved = yield* onMachine((session) =>
          Effect.gen(function*() {
            git(session.workdir, "clone", "-q", origin, ".")
            writeFileSync(join(session.workdir, "a.txt"), "a\nmore\n")
            writeFileSync(join(session.workdir, "new.txt"), "new\n")
            writeFileSync(join(session.workdir, "bin"), new Uint8Array([9, 0, 9]))
            rmSync(join(session.workdir, "gone.txt"))
            const saved = yield* SandboxTools.checkpoint(session)
            // Capturing changes nothing: the changes are still unstaged.
            expect(git(session.workdir, "status", "--porcelain")).toContain("?? new.txt")
            return saved
          }), { git: false })
        expect(saved.head).toBe(base)
        // Every commit is on the remote: no bundle.
        expect(saved.bundle!.byteLength).toBe(0)

        // The branch moved on since; the restore puts the working copy back on its own base.
        writeFileSync(join(origin, "later.txt"), "later\n")
        git(origin, "add", ".")
        git(origin, "commit", "-q", "-m", "later")
        yield* onMachine((session) =>
          Effect.gen(function*() {
            git(session.workdir, "clone", "-q", origin, ".")
            yield* SandboxTools.restore(session, saved)
            expect(git(session.workdir, "rev-parse", "HEAD").trim()).toBe(base)
            expect(readFileSync(join(session.workdir, "a.txt"), "utf8")).toBe("a\nmore\n")
            expect(readFileSync(join(session.workdir, "new.txt"), "utf8")).toBe("new\n")
            expect([...readFileSync(join(session.workdir, "bin"))]).toEqual([9, 0, 9])
            expect(existsSync(join(session.workdir, "gone.txt"))).toBe(false)
          }), { git: false })

        // A clean working copy restores with nothing to apply.
        const clean = yield* onMachine((session) => SandboxTools.checkpoint(session))
        expect(clean.patch.byteLength).toBe(0)
        yield* onMachine((session) =>
          Effect.gen(function*() {
            yield* SandboxTools.restore(session, {
              head: git(session.workdir, "rev-parse", "HEAD").trim(),
              patch: clean.patch
            })
            expect(git(session.workdir, "status", "--porcelain")).toBe("")
          })
        )
      }),
    slow
  )

  it.effect("carries a commit made in the box, which no remote has, to a fresh clone", () =>
    Effect.gen(function*() {
      const origin = join(root, `origin-${++sessions}`)
      mkdirSync(origin)
      git(origin, "init", "-q", "-b", "main")
      writeFileSync(join(origin, "a.txt"), "a\n")
      git(origin, "add", ".")
      git(origin, "commit", "-q", "-m", "base")

      const saved = yield* onMachine((session) =>
        Effect.gen(function*() {
          git(session.workdir, "clone", "-q", origin, ".")
          writeFileSync(join(session.workdir, "local.txt"), "committed in the box\n")
          git(session.workdir, "add", "local.txt")
          git(session.workdir, "commit", "-q", "-m", "local")
          writeFileSync(join(session.workdir, "after.txt"), "typed after the commit\n")
          return {
            checkpoint: yield* SandboxTools.checkpoint(session),
            head: git(session.workdir, "rev-parse", "HEAD").trim()
          }
        }), { git: false })
      expect(saved.checkpoint.head).toBe(saved.head)
      expect(saved.checkpoint.bundle!.byteLength).toBeGreaterThan(0)

      yield* onMachine((session) =>
        Effect.gen(function*() {
          git(session.workdir, "clone", "-q", origin, ".")
          // The fresh clone lacks the box's commit; without its bundle, it can't be restored.
          const lacking = yield* Effect.flip(
            SandboxTools.restore(session, { head: saved.head, patch: saved.checkpoint.patch })
          )
          expect(lacking).toMatchObject({ reason: "not_found" })
          yield* SandboxTools.restore(session, saved.checkpoint)
          expect(git(session.workdir, "rev-parse", "HEAD").trim()).toBe(saved.head)
          expect(git(session.workdir, "log", "-1", "--format=%s").trim()).toBe("local")
          expect(readFileSync(join(session.workdir, "local.txt"), "utf8")).toBe("committed in the box\n")
          expect(readFileSync(join(session.workdir, "after.txt"), "utf8")).toBe("typed after the commit\n")
        }), { git: false })
    }), slow)

  it.effect(
    "fetches a bundle's base the shallow clone lacks from origin; an origin that can't be reached is unavailable",
    () =>
      Effect.gen(function*() {
        const origin = join(root, `origin-${++sessions}`)
        mkdirSync(origin)
        git(origin, "init", "-q", "-b", "main")
        git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true")
        writeFileSync(join(origin, "a.txt"), "a\n")
        git(origin, "add", ".")
        git(origin, "commit", "-q", "-m", "base")

        const saved = yield* onMachine((session) =>
          Effect.gen(function*() {
            git(session.workdir, "clone", "-q", `file://${origin}`, ".")
            writeFileSync(join(session.workdir, "local.txt"), "local\n")
            git(session.workdir, "add", "local.txt")
            git(session.workdir, "commit", "-q", "-m", "local")
            return yield* SandboxTools.checkpoint(session)
          }), { git: false })

        // The branch moves on, so a depth-1 clone no longer has the commit the box's commit sits on.
        for (const name of ["b", "c"]) {
          writeFileSync(join(origin, `${name}.txt`), `${name}\n`)
          git(origin, "add", ".")
          git(origin, "commit", "-q", "-m", name)
        }
        yield* onMachine((session) =>
          Effect.gen(function*() {
            git(session.workdir, "clone", "-q", "--depth", "1", `file://${origin}`, ".")
            // An origin that doesn't answer: try again later, never "not found".
            git(session.workdir, "remote", "set-url", "origin", "http://127.0.0.1:9/unreachable")
            const down = yield* Effect.flip(SandboxTools.restore(session, saved))
            expect(down).toEqual(new SandboxTools.ToolUnavailable({ code: "unavailable" }))
            git(session.workdir, "remote", "set-url", "origin", `file://${origin}`)
            yield* SandboxTools.restore(session, saved)
            expect(git(session.workdir, "rev-parse", "HEAD").trim()).toBe(saved.head)
            expect(readFileSync(join(session.workdir, "local.txt"), "utf8")).toBe("local\n")
          }), { git: false })
      }),
    slow
  )

  it.effect("fetches a base commit the fresh clone lacks from origin by its id", () =>
    Effect.gen(function*() {
      const origin = join(root, `origin-${++sessions}`)
      mkdirSync(origin)
      git(origin, "init", "-q", "-b", "main")
      git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
      writeFileSync(join(origin, "a.txt"), "a\n")
      git(origin, "add", ".")
      git(origin, "commit", "-q", "-m", "base")
      writeFileSync(join(origin, "b.txt"), "b\n")
      git(origin, "add", ".")
      git(origin, "commit", "-q", "-m", "rewritten away")
      const gone = git(origin, "rev-parse", "HEAD").trim()

      const saved = yield* onMachine((session) =>
        Effect.gen(function*() {
          git(session.workdir, "clone", "-q", origin, ".")
          writeFileSync(join(session.workdir, "c.txt"), "c\n")
          return yield* SandboxTools.checkpoint(session)
        }), { git: false })
      expect(saved).toMatchObject({ head: gone })

      // The branch is rewritten: its tip no longer reaches the checkpoint's commit, which origin still holds.
      git(origin, "reset", "-q", "--hard", "HEAD~1")
      yield* onMachine((session) =>
        Effect.gen(function*() {
          git(session.workdir, "clone", "-q", "--depth", "1", `file://${origin}`, ".")
          yield* SandboxTools.restore(session, saved)
          expect(git(session.workdir, "rev-parse", "HEAD").trim()).toBe(gone)
          expect(readFileSync(join(session.workdir, "b.txt"), "utf8")).toBe("b\n")
          expect(readFileSync(join(session.workdir, "c.txt"), "utf8")).toBe("c\n")
        }), { git: false })
    }), slow)

  it.effect(
    "refuses a commit the working copy doesn't have, a workdir with no commit, and a patch over the limit",
    () =>
      Effect.gen(function*() {
        yield* onMachine((session) =>
          Effect.gen(function*() {
            const missing = yield* Effect.flip(
              SandboxTools.restore(session, { head: "0".repeat(40), patch: new Uint8Array() })
            )
            expect(missing).toMatchObject({ reason: "not_found" })
            const head = git(session.workdir, "rev-parse", "HEAD").trim()
            const broken = yield* Effect.flip(
              SandboxTools.restore(session, { head, patch: new TextEncoder().encode("not a patch\n") })
            )
            expect(broken).toMatchObject({ _tag: "@smthrs/sandbox/SandboxTools/ToolUnavailable" })
            writeFileSync(
              join(session.workdir, "huge.bin"),
              new Uint8Array(SandboxTools.limits.checkpointBytes + 1).fill(7)
            )
            expect(yield* Effect.flip(SandboxTools.checkpoint(session))).toMatchObject({ reason: "too_large" })
          })
        )
        yield* onMachine((session) =>
          Effect.gen(function*() {
            expect(yield* Effect.flip(SandboxTools.checkpoint(session))).toMatchObject({ reason: "not_a_repository" })
            expect(yield* Effect.flip(SandboxTools.restore(session, { head: "x", patch: new Uint8Array() })))
              .toMatchObject({
                reason: "not_a_repository"
              })
          }), { git: false })
      }),
    slow
  )
})

describe("SandboxTools rebase", () => {
  type Run = typeof SandboxTools.RunResult.Type
  type Read = typeof SandboxTools.ReadResult.Type

  /**
   * An origin serving `try-1` at `base` (A, X, M), the working copy a clone of it at `base`, and `onto`: what the
   * branch's remote reached since, `push` (A changed) merged with `main` (X and M changed), the way GitHub's Update
   * branch merges. The origin serves `try-1` at `onto` from then on.
   */
  const remote = () => {
    const origin = join(root, `rebase-origin-${++sessions}`)
    mkdirSync(origin)
    git(origin, "init", "-q", "-b", "try-1")
    writeFileSync(join(origin, "A"), "a\nb\nc\n")
    writeFileSync(join(origin, "X"), "x1\nx2\n")
    writeFileSync(join(origin, "M"), "m\n")
    writeFileSync(join(origin, "gone"), "deleted on main\n")
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "base")
    const base = git(origin, "rev-parse", "HEAD").trim()
    return { origin, base }
  }

  const move = (origin: string, base: string) => {
    git(origin, "checkout", "-q", "-b", "main", base)
    writeFileSync(join(origin, "X"), "x1\nx2 main\n")
    writeFileSync(join(origin, "M"), "m main\n")
    rmSync(join(origin, "gone"))
    git(origin, "add", "-A")
    git(origin, "commit", "-q", "-m", "main")
    git(origin, "checkout", "-q", "try-1")
    writeFileSync(join(origin, "A"), "a pushed\nb\nc\n")
    git(origin, "commit", "-q", "-am", "push")
    git(origin, "merge", "-q", "--no-edit", "main")
    return git(origin, "rev-parse", "HEAD").trim()
  }

  const run = (session: Sandbox.Session, options: SandboxTools.RebaseOptions) =>
    Effect.flatMap(exec(session, SandboxTools.rebaseCall(options)), (result) => SandboxTools.rebased(result as Run))

  const paths = (session: Sandbox.Session) =>
    Effect.map(exec(session, { tool: "read", path: SandboxTools.REBASE_PATHS }), (read) =>
      SandboxTools.rebasePaths(read as Read))

  const status = (cwd: string) => git(cwd, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean).sort()

  it.effect("plans, then applies: the working copy's changes and commits on top of the moved branch", () =>
    Effect.gen(function*() {
      const { base, origin } = remote()
      yield* onMachine((session) =>
        Effect.gen(function*() {
          const wc = session.workdir
          git(wc, "clone", "-q", "--branch", "try-1", "--single-branch", origin, ".")
          const onto = move(origin, base)
          // Saved as published (A, alike), a commit made in the terminal (L), an edit (X's first line), and a new file.
          writeFileSync(join(wc, "L"), "local\n")
          git(wc, "add", "L")
          git(wc, "commit", "-q", "-m", "terminal")
          writeFileSync(join(wc, "A"), "a pushed\nb\nc\n")
          writeFileSync(join(wc, "N"), "new\n")
          const planned = yield* run(session, { branch: "try-1", onto })
          expect(planned).toMatchObject({ _tag: "Planned", paths: 3 })
          expect([...(yield* paths(session))].sort()).toEqual(["M", "X", "gone"])
          // Planning changed nothing.
          expect(status(wc)).toEqual([" M A", "?? N"])
          const tree = (planned as { readonly tree: string }).tree
          const applied = yield* run(session, { branch: "try-1", onto, expect: tree })
          expect(applied).toEqual({ ...planned, _tag: "Applied" })
          expect(git(wc, "rev-parse", "HEAD").trim()).toBe(onto)
          expect(readFileSync(join(wc, "A"), "utf8")).toBe("a pushed\nb\nc\n")
          expect(readFileSync(join(wc, "X"), "utf8")).toBe("x1\nx2 main\n")
          expect(readFileSync(join(wc, "M"), "utf8")).toBe("m main\n")
          expect(existsSync(join(wc, "gone"))).toBe(false)
          // What GitHub lacks stays, uncommitted: the terminal's commit and the new file.
          expect(status(wc)).toEqual(["?? L", "?? N"])
          // Again: HEAD is there already.
          expect(yield* run(session, { branch: "try-1", onto })).toMatchObject({ _tag: "Current" })
          expect(yield* paths(session)).toEqual([])
        }), { git: false })
    }), slow)

  it.effect("a conflict lists its files and changes nothing; a plan that went stale applies nothing", () =>
    Effect.gen(function*() {
      const { base, origin } = remote()
      yield* onMachine((session) =>
        Effect.gen(function*() {
          const wc = session.workdir
          git(wc, "clone", "-q", "--branch", "try-1", "--single-branch", origin, ".")
          const onto = move(origin, base)
          writeFileSync(join(wc, "M"), "m mine\n")
          writeFileSync(join(wc, "X"), "x1\nx2 mine\n")
          expect(yield* run(session, { branch: "try-1", onto })).toMatchObject({ _tag: "Conflicted", paths: 2 })
          expect([...(yield* paths(session))].sort()).toEqual(["M", "X"])
          expect(git(wc, "rev-parse", "HEAD").trim()).toBe(base)
          expect(readFileSync(join(wc, "M"), "utf8")).toBe("m mine\n")
          // Resolved by hand: X back as it was, M alike to main's. The plan holds no conflict; then a save moves on.
          writeFileSync(join(wc, "X"), "x1\nx2\n")
          writeFileSync(join(wc, "M"), "m main\n")
          const planned = yield* run(session, { branch: "try-1", onto })
          expect(planned).toMatchObject({ _tag: "Planned" })
          writeFileSync(join(wc, "S"), "saved meanwhile\n")
          const moved = yield* run(session, { branch: "try-1", onto, expect: (planned as { readonly tree: string }).tree })
          expect(moved).toMatchObject({ _tag: "Moved" })
          expect(git(wc, "rev-parse", "HEAD").trim()).toBe(base)
          expect(status(wc)).toEqual([" M M", "?? S"])
        }), { git: false })
    }), slow)

  it.effect("refuses a commit origin doesn't serve, an origin it can't reach, unrelated history and no repository", () =>
    Effect.gen(function*() {
      const { origin } = remote()
      yield* onMachine((session) =>
        Effect.gen(function*() {
          const wc = session.workdir
          git(wc, "clone", "-q", "--branch", "try-1", "--single-branch", origin, ".")
          expect(yield* Effect.flip(run(session, { branch: "try-1", onto: "0".repeat(40) }))).toEqual(
            new SandboxTools.ToolRefused({ reason: "not_found" })
          )
          expect(yield* Effect.flip(run(session, { branch: "nope", onto: "0".repeat(40) }))).toEqual(
            new SandboxTools.ToolRefused({ reason: "not_found" })
          )
          // An orphan branch on origin shares no commit with HEAD.
          git(origin, "checkout", "-q", "--orphan", "other")
          writeFileSync(join(origin, "O"), "o\n")
          git(origin, "add", "-A")
          git(origin, "commit", "-q", "-m", "orphan")
          const orphan = git(origin, "rev-parse", "HEAD").trim()
          expect(yield* run(session, { branch: "other", onto: orphan })).toMatchObject({ _tag: "Unrelated" })
          git(wc, "remote", "set-url", "origin", "http://127.0.0.1:9/gone.git")
          expect(yield* Effect.flip(run(session, { branch: "try-1", onto: "1".repeat(40) }))).toEqual(
            new SandboxTools.ToolUnavailable({ code: "unavailable" })
          )
        }), { git: false })
      yield* onMachine((session) =>
        Effect.gen(function*() {
          expect(yield* Effect.flip(run(session, { branch: "try-1", onto: "0".repeat(40) }))).toEqual(
            new SandboxTools.ToolRefused({ reason: "not_a_repository" })
          )
        }), { git: false })
    }), slow)

  it.effect("decodes what a run answered, and only what the script prints", () =>
    Effect.gen(function*() {
      const ran = (overrides: Partial<Run>): Run => ({
        tool: "run",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        ...overrides
      })
      const decode = (overrides: Partial<Run>) => Effect.result(SandboxTools.rebased(ran(overrides)))
      expect(yield* decode({ stdout: "current t1\n" })).toMatchObject({ success: { _tag: "Current", tree: "t1" } })
      expect(yield* decode({ stdout: "unrelated t1\n" })).toMatchObject({ success: { _tag: "Unrelated" } })
      expect(yield* decode({ stdout: "conflict t1 4\n" })).toMatchObject({ success: { _tag: "Conflicted", paths: 4 } })
      expect(yield* decode({ stdout: "clean t1 r1 2\n" })).toMatchObject({
        success: { _tag: "Planned", tree: "t1", result: "r1", paths: 2 }
      })
      expect(yield* decode({ stdout: "moved t2\n" })).toMatchObject({ success: { _tag: "Moved", tree: "t2" } })
      expect(yield* decode({ stdout: "applied t1 r1 0\n" })).toMatchObject({ success: { _tag: "Applied", paths: 0 } })
      expect(yield* decode({ stdout: "merged t1\n" })).toMatchObject({ failure: { code: "unknown" } })
      expect(yield* decode({ stdout: "current\n" })).toMatchObject({ failure: { code: "unknown" } })
      expect(yield* decode({ timedOut: true, exitCode: 124 })).toMatchObject({ failure: { code: "timeout" } })
      expect(yield* decode({ exitCode: 125 })).toMatchObject({ failure: { code: "unknown", exitCode: 125 } })
      expect(
        SandboxTools.rebasePaths({ tool: "read", path: SandboxTools.REBASE_PATHS, content: "a\0b c\0a\0", bytes: 8, truncated: false })
      ).toEqual(["a", "b c"])
      const call = SandboxTools.rebaseCall({ branch: "it's", onto: "abc", expect: "t1", timeoutSeconds: 30 })
      expect(call).toMatchObject({ tool: "run", timeoutSeconds: 30 })
      expect(call.command.endsWith(`'.' 'it'\\''s' 'abc' 't1'`)).toBe(true)
      expect(SandboxTools.rebaseCall({ branch: "b", onto: "abc" })).toMatchObject({
        timeoutSeconds: SandboxTools.limits.maxTimeoutSeconds
      })
      expect(SandboxTools.rebaseCall({ branch: "b", onto: "abc" }).command.endsWith(`'abc' ''`)).toBe(true)
    }))
})

describe("SandboxTools on a failing session", () => {
  it.effect("fails ToolUnavailable with the provider's code", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const down: Sandbox.Session = {
          ...session,
          spawn: () => Effect.fail(new ProviderError({ code: "unavailable", message: "down" }))
        }
        const failed = yield* failure(exec(down, { tool: "status" }))
        expect(failed).toEqual(new SandboxTools.ToolUnavailable({ code: "unavailable" }))
        const broken: Sandbox.Session = {
          ...session,
          spawn: () =>
            Effect.succeed({
              stdout: Stream.fail(new ProviderError({ code: "timeout", message: "cut" })),
              stderr: Stream.empty,
              exitCode: Effect.succeed(0)
            })
        }
        expect(yield* failure(exec(broken, { tool: "list" }))).toMatchObject({ code: "timeout" })
        // A guest that sends more than a tool asked for is cut at the tool's own bound.
        const flooding: Sandbox.Session = {
          ...session,
          spawn: () =>
            Effect.succeed({
              stdout: Stream.make(new TextEncoder().encode(`9\n${"z".repeat(SandboxTools.limits.diffBytes + 100)}`)),
              stderr: Stream.empty,
              exitCode: Effect.succeed(0)
            })
        }
        const cut = yield* exec(flooding, { tool: "diff" }) as Effect.Effect<typeof SandboxTools.DiffResult.Type>
        expect(cut.diff.length).toBe(SandboxTools.limits.diffBytes + 64 - 2)
      }), { git: false }), slow)

  it.effect("names paths relative to a workdir at the root", () =>
    onMachine((session) =>
      Effect.gen(function*() {
        const atRoot: Sandbox.Session = { ...session, workdir: "/" }
        const read = yield* exec(atRoot, { tool: "read", path: `${session.workdir}/README.md` })
        expect(read).toMatchObject({ path: `${session.workdir.slice(1)}/README.md`, content: "hello\n" })
      })
    ), slow)
})
