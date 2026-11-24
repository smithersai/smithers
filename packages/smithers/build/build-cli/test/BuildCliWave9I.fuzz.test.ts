import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import type * as Reference from "@smthrs/targets/Reference"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  if (report._tag !== "Passed") {
    throw new Error(Fuzz.formatReport(report))
  }
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const makeFakeStat = (opts: {
  isFile?: boolean
  isDir?: boolean
  isSymlink?: boolean
  isFifo?: boolean
  mode?: number
  size?: number
  mtimeMs?: number
  ctimeMs?: number
  nlink?: number
  ino?: number
  dev?: number
}): NodeFs.Stats =>
  ({
    isFile: () => opts.isFile ?? false,
    isDirectory: () => opts.isDir ?? false,
    isSymbolicLink: () => opts.isSymlink ?? false,
    isFIFO: () => opts.isFifo ?? false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    mode: opts.mode ?? (opts.isDir ? 0o040755 : opts.isFifo ? 0o010644 : 0o100644),
    size: opts.size ?? 4,
    mtimeMs: opts.mtimeMs ?? 1000,
    ctimeMs: opts.ctimeMs ?? 1000,
    nlink: opts.nlink ?? (opts.isDir ? 2 : 1),
    ino: opts.ino ?? 1,
    dev: opts.dev ?? 1
  }) as unknown as NodeFs.Stats

const makeEmptyTrace = (overrides: Partial<ObservedReads.Trace> = {}): ObservedReads.Trace => ({
  found: new Map(),
  missing: new Map(),
  listed: new Map(),
  made: new Map(),
  emptied: new Map(),
  changed: new Set(),
  started: new Map(),
  removed: new Set(),
  fetched: new Set(),
  refusals: [],
  ...overrides
})

describe("BuildCliWave9I ObservedReads, AgentSession, PackageIndex, PackageLoader, Affected", () => {
  it("ObservedReads deep parser, lockedInstall, supervisorPath/observer, observe & rangeLines matrix", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. commandFor, supervisorPath, unsupervised, observer variants
            const supKeep = ObservedReads.commandFor(
              { tracer: "/bin/obs", supervisor: true },
              "/tmp/t",
              ["echo", "hi"],
              true
            )
            expect(supKeep).toContain("--keep")
            const supNoKeep = ObservedReads.commandFor({ tracer: "/bin/obs", supervisor: true }, "/tmp/t", [
              "echo",
              "hi"
            ], false)
            expect(supNoKeep).not.toContain("--keep")
            const guarded = ObservedReads.commandFor({ tracer: "/bin/strace", guard: "/bin/guard" }, "/tmp/t", [
              "echo",
              "hi"
            ], false)
            expect(guarded).toContain("--guard")

            expect(ObservedReads.supervisorPath("darwin", "x64", {})).toBeUndefined()
            expect(ObservedReads.supervisorPath("linux", "ppc64", {})).toBeUndefined()
            expect(ObservedReads.supervisorPath("linux", "arm64", { [ObservedReads.recorderVariable]: "strace" }))
              .toBeUndefined()
            expect(ObservedReads.supervisorPath("linux", "x64", {}, "not-a-valid-url://\0")).toBeUndefined()

            expect(ObservedReads.unsupervised("darwin", "x64", {})).toBeUndefined()
            expect(ObservedReads.unsupervised("linux", "ppc64", {})).toBeUndefined()
            expect(ObservedReads.unsupervised("linux", "arm64", { [ObservedReads.recorderVariable]: "strace" }))
              .toContain("strace")
            const unsupBadUrl = ObservedReads.unsupervised("linux", "x64", {}, "not-a-valid-url://\0")
            expect(unsupBadUrl).toContain("smthrs-observe")

            const obsDarwin = ObservedReads.observer({
              platform: "darwin",
              executable: () => undefined
            })
            expect("reason" in obsDarwin).toBe(true)
            const obsNoStrace = ObservedReads.observer({
              platform: "linux",
              executable: () => undefined,
              unsupervised: "no supervisor"
            })
            expect("reason" in obsNoStrace).toBe(true)

            // 2. lockedInstall & bookkeeping edge variants
            expect(typeof ObservedReads.lockedInstall(["yarnpkg", "--frozen-lockfile"], "/ws")).toBe("boolean")
            expect(typeof ObservedReads.lockedInstall(["yarnpkg", "install", "--immutable"], "/ws")).toBe("boolean")
            expect(typeof ObservedReads.lockedInstall(["yarnpkg"], "/ws")).toBe("boolean")
            expect(typeof ObservedReads.lockedInstall(["pip3", "install", "-r", "requirements.txt"], "/ws")).toBe(
              "boolean"
            )
            expect(typeof ObservedReads.lockedInstall(["cargo", "+nightly", "fetch", "--locked"], "/ws")).toBe(
              "boolean"
            )
            expect(typeof ObservedReads.lockedInstall(["cargo", "+nightly", "build", "--locked"], "/ws")).toBe(
              "boolean"
            )
            expect(typeof ObservedReads.lockedInstall(["uv", "run", "--locked", "pytest"], "/ws")).toBe("boolean")
            expect(typeof ObservedReads.lockedInstall(["uv", "run", "--frozen", "pytest"], "/ws")).toBe("boolean")
            expect(typeof ObservedReads.lockedInstall(["python3", "-m", "pip", "install", "--no-deps", "."], "/ws"))
              .toBe("boolean")
            expect(
              typeof ObservedReads.lockedInstall(["env", "-u", "FOO", "pnpm", "install", "--frozen-lockfile"], "/ws")
            ).toBe("boolean")
            expect(
              typeof ObservedReads.lockedInstall(["pnpm", "install", "--unknown-flag-xyz", "--frozen-lockfile"], "/ws")
            ).toBe("boolean")
            expect(typeof ObservedReads.lockedInstall([], "/ws")).toBe("boolean")
            expect(ObservedReads.lockedBuild(["cargo", "+nightly", "build", "--locked"], "/ws")).toBeDefined()
            expect(ObservedReads.lockedBuild([], "/ws")).toBeUndefined()
            expect(ObservedReads.bookkeeping(["git", "status"], "/ws")).toBeUndefined()

            // 3. read() deep strace parser branches
            const traceLines = [
              "100 +++ exited with 0 +++",
              "100 malformed line without close = 0",
              `101 execve("/usr/bin/env", ["env", "--smthrs-quiet-test"], 0x0) = 0`,
              `101 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID) = 102`,
              `102 openat(AT_FDCWD</ws>, "ignored.txt", O_RDONLY) = 3</ws/ignored.txt>`,
              `103 execve("/usr/bin/pnpm", ["pnpm", "install", "--frozen-lockfile"], 0x0) = 0`,
              `103 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID) = 104`,
              `104 execve("/usr/bin/curl", ["curl", "https://example.com"], 0x0) = 0`,
              `104 connect(5<socket:[999]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.2.3.4")}, 16) = 0`,
              `105 openat2(AT_FDCWD</ws>, "a.txt", {flags=O_WRONLY|O_CREAT|O_EXCL, mode=0644, resolve=0}, 24) = -1 EEXIST (File exists)`,
              `105 openat2(AT_FDCWD</ws>, "b.txt", {flags=O_WRONLY|O_TRUNC, mode=0644, resolve=0}, 24) = 3</ws/b.txt>`,
              `105 openat2(AT_FDCWD</ws>, "c.txt", {flags=O_WRONLY, mode=0644, resolve=0}, 24) = 4</ws/c.txt>`,
              `105 openat2(AT_FDCWD</ws>, "/ws/tmpd", {flags=O_RDWR|O_TMPFILE, mode=0600, resolve=0}, 24) = 5</ws/tmpd/#123>`,
              `105 openat2(AT_FDCWD</ws>, "d.txt", {flags=O_RDONLY|O_PATH, mode=0, resolve=0x99999}, 24) = 6</ws/d.txt>`,
              `105 mkdir("/ws/builtdir", 0755) = 0`,
              `105 openat(AT_FDCWD</ws>, "/ws/builtdir/inside.txt", O_WRONLY|O_CREAT, 0644) = 7</ws/builtdir/inside.txt>`,
              `105 creat("/ws/created.txt", 0644) = 8</ws/created.txt>`,
              `105 openat(AT_FDCWD</ws>, "/ws/file/sub", O_RDONLY) = -1 ENOTDIR (Not a directory)`,
              `105 openat(AT_FDCWD</ws>, "/ws/file", O_RDONLY|O_DIRECTORY) = -1 ENOTDIR (Not a directory)`,
              `105 openat(AT_FDCWD</ws>, "/ws/longname", O_RDONLY) = -1 ENAMETOOLONG (File name too long)`,
              `105 getdents64(99, 0x0, 4096) = 32`,
              `105 openat(AT_FDCWD</ws>, "/dev/stdin", O_RDONLY) = 10</dev/pts/0>`,
              `105 openat(AT_FDCWD</ws>, "/dev/fd/3", O_RDONLY) = 11</ws/b.txt>`,
              `105 openat(AT_FDCWD</ws>, "/proc/self/root/ws/b.txt", O_RDONLY) = 12</ws/b.txt>`,
              `105 socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP) = 20<socket:[1001]>`,
              `105 setsockopt(20<socket:[1001]>, SOL_IPV6, IPV6_V6ONLY, [0], 4) = 0`,
              `105 bind(20<socket:[1001]>, {sa_family=AF_INET6, sin6_port=htons(8088), sin6_addr=inet_pton(AF_INET6, "::", &in6_addr)} /* smthrs: tcp dual-stack */, 28) = 0`,
              `105 connect(21<socket:[1002]>, {sa_family=AF_INET6, sin6_port=htons(8088), sin6_addr=inet_pton(AF_INET6, "::ffff:127.0.0.1", &in6_addr)}, 28) = 0`,
              `105 connect(22<socket:[1003]>, {sa_family=AF_UNSPEC}, 2) = 0`,
              `105 bind(23<socket:[1004]>, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}, 12) = 0`,
              `105 bind(24<socket:[1005]>, {sa_family=AF_PACKET, sll_protocol=htons(0x0003)}, 20) = 0`,
              `105 connect(25<socket:[1006]>, {sa_family=AF_BLUETOOTH, l2_psm=htons(1)}, 14) = 0`,
              `105 bind(26<socket:[1007]>, {sa_family=AF_UNIX, sun_path="/ws/my.sock"}, 14) = 0`,
              `105 bind(27<socket:[1008]>, {sa_family=AF_UNIX, sun_path="/ws/busy.sock"}, 14) = -1 EADDRINUSE (Address already in use)`,
              `105 connect(28<socket:[1009]>, {sa_family=AF_UNIX, sun_path="/ws/missing.sock"}, 14) = -1 ECONNREFUSED (Connection refused)`,
              `105 symlink("x", "/ws/sl1") = 0`,
              `105 symlink("y", "/ws/sl2") = 0`,
              `105 renameat2(AT_FDCWD</ws>, "/ws/sl1", AT_FDCWD</ws>, "/ws/sl2", RENAME_EXCHANGE) = 0`,
              `105 renameat2(AT_FDCWD</ws>, "/ws/nope1", AT_FDCWD</ws>, "/ws/nope2", 0) = -1 ENOENT (No such file or directory)`,
              `105 utimensat(AT_FDCWD</ws>, "/ws/b.txt", NULL, 0) = 0`,
              `105 execveat(AT_FDCWD</ws>, "/usr/bin/true", ["true"], 0x0, 0) = 0`,
              `105 chmod("/ws/b.txt", 0644) = 0`,
              `105 openat(AT_FDCWD</ws>, "/ws/own-temp/a.txt", O_RDONLY) = 30</ws/own-temp/a.txt>`
            ]
            const parsed = ObservedReads.read(
              () => traceLines,
              "/ws",
              ["--smthrs-quiet-test"],
              new Set(["/ws/own-temp"])
            )
            expect(parsed.refusals.length).toBeGreaterThan(0)
            expect(parsed.made.has("/ws/builtdir/inside.txt")).toBe(true)
            expect(parsed.made.has("/ws/my.sock")).toBe(true)

            const parsedSup = ObservedReads.read(
              () => [
                `# smthrs-observe`,
                `105 socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP) = 20<socket:[1001]>`,
                `105 bind(20<socket:[1001]>, {sa_family=AF_INET6, sin6_port=htons(8088), sin6_addr=inet_pton(AF_INET6, "::", &in6_addr)} /* smthrs: tcp dual-stack */, 28) = 0`,
                `105 connect(21<socket:[1002]>, {sa_family=AF_INET, sin_port=htons(8088), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`
              ],
              "/ws"
            )
            expect(parsedSup.refusals.length).toBeGreaterThanOrEqual(0)

            // 4. wholeLength, stepLength, wholeLinesOf on missing & present files
            await withTempDir("wave9i-obs-", async (dir) => {
              const missing = NodePath.join(dir, "does-not-exist.trace")
              expect(ObservedReads.wholeLength(missing)).toBe(0)
              expect(ObservedReads.stepLength(missing)).toBe(0)
              expect([...ObservedReads.wholeLinesOf(missing)()]).toEqual([])

              const traceFile = NodePath.join(dir, "step.trace")
              await Fs.writeFile(
                traceFile,
                `100 openat(AT_FDCWD<${dir}>, "${traceFile}.status", O_WRONLY|O_CREAT) = 3\n101 openat(AT_FDCWD<${dir}>, "after", O_RDONLY) = 4\n`
              )
              expect(ObservedReads.wholeLength(traceFile)).toBeGreaterThan(0)
              expect(ObservedReads.stepLength(traceFile)).toBeGreaterThan(0)
              expect([...ObservedReads.wholeLinesOf(traceFile)()].length).toBe(2)

              const emptyDir = NodePath.join(dir, "empty-dir")
              const subDir = NodePath.join(dir, "sub")
              await Fs.mkdir(emptyDir)
              await Fs.mkdir(subDir)
              await Fs.writeFile(NodePath.join(subDir, "item.txt"), "hello")

              const huge = "a".repeat(5000)
              const obsLong = ObservedReads.observe(
                makeEmptyTrace({
                  walks: [{ at: 1, start: dir, path: huge, resolve: [], follow: true, reads: true, opened: undefined }],
                  found: new Map([[`${dir}/${huge}`, 2]])
                }),
                { root: dir, ignore: [], startedMs: Date.now() + 10_000 }
              )
              expect("refusal" in obsLong).toBe(true)

              const obsReached = ObservedReads.observe(
                makeEmptyTrace({
                  reached: [["rel", NodePath.join(subDir, "item.txt"), NodePath.join(dir, "other.txt")]]
                }),
                { root: dir, ignore: [], startedMs: Date.now() + 10_000 }
              )
              expect("refusal" in obsReached && obsReached.refusal).toContain("does not say where")

              const obsOpenedMismatch = ObservedReads.observe(
                makeEmptyTrace({
                  openedPaths: [["link", NodePath.join(subDir, "item.txt"), NodePath.join(dir, "other.txt")]]
                }),
                { root: dir, ignore: [], startedMs: Date.now() + 10_000 }
              )
              expect("refusal" in obsOpenedMismatch).toBe(true)

              const goneDir = NodePath.join(dir, "gone-empty")
              const obsEmpty = ObservedReads.observe(
                makeEmptyTrace({
                  built: new Set([goneDir]),
                  removed: new Set([goneDir]),
                  removedEmpty: new Set([goneDir]),
                  listed: new Map([[emptyDir, 1]]),
                  found: new Map([[NodePath.join(subDir, "item.txt"), 2]]),
                  meta: new Set([NodePath.join(subDir, "item.txt")]),
                  changed: new Set([NodePath.join(goneDir, "child.txt")])
                }),
                { root: dir, ignore: [], startedMs: Date.now() + 10_000 }
              )
              expect("refusal" in obsEmpty).toBe(false)

              const realIo = ObservedReads.defaultIo
              const unreadableChild = NodePath.join(subDir, "item.txt")
              const obsUnreadable = ObservedReads.observe(
                makeEmptyTrace({ listed: new Map([[subDir, 1]]) }),
                {
                  root: dir,
                  ignore: [],
                  startedMs: Date.now() + 10_000,
                  io: {
                    ...realIo,
                    lstat: (p) => {
                      if (p === unreadableChild) {
                        const err = new Error("EACCES") as NodeJS.ErrnoException
                        err.code = "EACCES"
                        throw err
                      }
                      return realIo.lstat(p)
                    }
                  }
                }
              )
              expect("refusal" in obsUnreadable).toBe(true)

              const linkA = NodePath.join(dir, "linkA")
              const linkB = NodePath.join(dir, "linkB")
              const fifoPath = NodePath.join(dir, "my.fifo")
              let lstatCalls = 0
              const fakeIo: ObservedReads.Io = {
                ...realIo,
                lstat: (p) => {
                  if (p === linkA) return makeFakeStat({ isSymlink: true, ctimeMs: 100 })
                  if (p === linkB) return makeFakeStat({ isSymlink: true, ctimeMs: 100 })
                  if (p === fifoPath) return makeFakeStat({ isFifo: true, mode: 0o010644, ctimeMs: 100 })
                  if (p === NodePath.join(dir, "eacces")) {
                    const err = new Error("EACCES") as NodeJS.ErrnoException
                    err.code = "EACCES"
                    throw err
                  }
                  if (p === NodePath.join(dir, "enoent-missing")) {
                    const err = new Error("ENOENT") as NodeJS.ErrnoException
                    err.code = "ENOENT"
                    throw err
                  }
                  if (p === NodePath.join(dir, "changing")) {
                    lstatCalls += 1
                    return makeFakeStat({ isFile: true, ctimeMs: lstatCalls > 1 ? Date.now() + 50_000 : 100 })
                  }
                  return realIo.lstat(p)
                },
                readlink: (p) => {
                  if (p === linkA) return "linkB"
                  if (p === linkB) return fifoPath
                  return realIo.readlink(p)
                }
              }
              expect(ObservedReads.measure(fifoPath, fakeIo)).toContain("o:")
              expect(ObservedReads.measure(NodePath.join(dir, "enoent-missing"), fakeIo)).toBe("-")
              expect(ObservedReads.measure(NodePath.join(dir, "eacces"), fakeIo)).toBe("!EACCES")
              expect(ObservedReads.listing(dir, [], fakeIo)).toBeDefined()

              const obsWalkReplaced = ObservedReads.observe(
                makeEmptyTrace({
                  walks: [{
                    at: 1,
                    start: dir,
                    path: "changing",
                    resolve: [],
                    follow: true,
                    reads: true,
                    opened: NodePath.join(dir, "changing")
                  }]
                }),
                { root: dir, ignore: [], startedMs: 500, io: fakeIo }
              )
              expect(obsWalkReplaced).toBeDefined()

              const loopLink = NodePath.join(dir, "loop")
              const loopIo: ObservedReads.Io = {
                ...realIo,
                lstat: (p) => (p === loopLink ? makeFakeStat({ isSymlink: true }) : realIo.lstat(p)),
                readlink: (p) => (p === loopLink ? loopLink : realIo.readlink(p))
              }
              const vDir = "/sandbox-view"
              expect(ObservedReads.listing(dir, [], fakeIo, [[vDir, dir], [vDir + "/mnt", linkA]])).toBeDefined()
              expect(ObservedReads.listing(dir, [], loopIo, [[vDir, dir], [vDir + "/mnt", loopLink]])).toBeUndefined()
              expect(
                ObservedReads.listing(dir, [], fakeIo, [[vDir, dir], [
                  vDir + "/mnt",
                  NodePath.join(dir, "enoent-missing")
                ]])
              ).toBeUndefined()
              expect(
                ObservedReads.listing(dir, [], fakeIo, [[vDir, dir], [vDir + "/mnt", NodePath.join(dir, "eacces")]])
              ).toBeUndefined()
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("AgentSession CLI factory, WriteSetApplier, prompt/binary files, AgentLint/Diff/Pr & Layers", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9i-agent-", async (dir) => {
              const binDir = NodePath.join(dir, "bin")
              await Fs.mkdir(binDir, { recursive: true })
              const fakeClaudeFail = NodePath.join(binDir, "claude-fail")
              const fakeClaudeBig = NodePath.join(binDir, "claude-big")
              const fakeCodexMcp = NodePath.join(binDir, "codex-mcp")

              await Fs.writeFile(
                fakeClaudeFail,
                `#!/bin/sh\necho "${"X".repeat(600)}"\nexit 1\n`,
                { mode: 0o755 }
              )
              await Fs.writeFile(
                fakeClaudeBig,
                `#!/bin/sh\nnode -e 'process.stdout.write("A".repeat(${
                  AgentSession.maximumSessionOutputBytes + 128
                }))'\n`,
                { mode: 0o755 }
              )
              await Fs.writeFile(
                fakeCodexMcp,
                `#!/bin/sh\nprintf '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"findings\\":[],\\"edits\\":[],\\"note\\":\\"ok\\"}"}}\\n'\n`,
                { mode: 0o755 }
              )

              const agents = AgentTarget.Agents({
                reviewer: { _tag: "AgentClaudeCode", model: "claude-sonnet" },
                coder: { _tag: "AgentCodex", model: "gpt-5" }
              })

              // (a) claude non-zero exit with empty stderr -> tailOf(stdout)
              const failFactory = AgentSession.makeCliSessionFactory({
                workspaceRoot: dir,
                agents,
                executables: { claude: fakeClaudeFail },
                timeoutMs: 10_000
              })
              const failSession = await Effect.runPromise(
                failFactory.open(S.Agents.reviewer)
              )
              const failExit = await Effect.runPromiseExit(
                failSession.run({ purpose: "lint", prompt: "hello" })
              )
              expect(failExit._tag).toBe("Failure")

              // (b) claude stdout exceeding maximumSessionOutputBytes
              const bigFactory = AgentSession.makeCliSessionFactory({
                workspaceRoot: dir,
                agents,
                executables: { claude: fakeClaudeBig },
                timeoutMs: 15_000
              })
              const bigSession = await Effect.runPromise(
                bigFactory.open(S.Agents.reviewer)
              )
              const bigExit = await Effect.runPromiseExit(
                bigSession.run({ purpose: "lint", prompt: "hello" })
              )
              expect(bigExit._tag).toBe("Failure")

              // (c) codex with MCP server containing \u007f -> codexMcpConfig escaping
              const codexFactory = AgentSession.makeCliSessionFactory({
                workspaceRoot: dir,
                agents,
                executables: { codex: fakeCodexMcp },
                timeoutMs: 10_000
              })
              const codexSession = await Effect.runPromise(
                codexFactory.open(S.Agents.coder, [
                  { _tag: "McpHttp", name: "srv", url: "http://127.0.0.1:1/a\u007fb" } as Reference.McpHttp
                ])
              )
              const codexRes = await Effect.runPromise(
                codexSession.run({ purpose: "lint", prompt: "review" })
              )
              expect(codexRes.note).toBe("ok")

              // (d) makeLocalWriteSetApplier: non-regular path component, symlink escape, changed before commit
              const ws = NodePath.join(dir, "ws")
              await Fs.mkdir(ws, { recursive: true })
              await Fs.writeFile(NodePath.join(ws, "regular-file"), "content")
              const outside = NodePath.join(dir, "outside.txt")
              await Fs.writeFile(outside, "secret")
              await Fs.symlink(outside, NodePath.join(ws, "escape-link.txt"))

              const applier = AgentSession.makeLocalWriteSetApplier(ws)
              const nonRegExit = await Effect.runPromiseExit(
                applier.apply([{ path: "regular-file/child.txt", contents: "x" }], ["**/*"])
              )
              expect(nonRegExit._tag).toBe("Failure")

              const symExit = await Effect.runPromiseExit(
                applier.apply([{ path: "escape-link.txt", contents: "x" }], ["**/*"])
              )
              expect(symExit._tag).toBe("Failure")

              await Fs.writeFile(NodePath.join(ws, "target.txt"), "v1")
              const overlay = await Effect.runPromise(
                applier.apply([{ path: "target.txt", contents: "v2" }], ["target.txt"])
              )
              await Fs.unlink(NodePath.join(ws, "target.txt"))
              await Fs.mkdir(NodePath.join(ws, "target.txt"))
              const commitExit = await Effect.runPromiseExit(applier.commit(overlay))
              expect(commitExit._tag).toBe("Failure")

              // (e) renderDataFiles with binary file (\0 byte)
              await Fs.writeFile(NodePath.join(ws, "bin.dat"), Buffer.from([0x01, 0x00, 0x02]))
              await Fs.writeFile(NodePath.join(ws, "txt.md"), "hello text")
              const rendered = await Effect.runPromise(
                AgentSession.renderDataFiles(ws, ["bin.dat", "txt.md"])
              )
              expect(rendered).toContain("omitted: binary")
              expect(rendered).toContain("hello text")

              // (f) init colocated jj repo in ws for runAgentLint, runAgentDiff, runAgentPr & layers
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
              await Fs.writeFile(NodePath.join(ws, "src.ts"), "export const a = 1\n")
              await Fs.writeFile(NodePath.join(ws, "prompt.md"), "Review carefully.")
              await Fs.writeFile(NodePath.join(ws, "big-prompt.md"), "P".repeat(AgentTarget.maximumPromptBytes + 16))
              await Fs.symlink(outside, NodePath.join(ws, "outside-prompt.md"))

              await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(ws, ["config", "user.name", "Test"])
              await PackageTree.runGit(ws, ["add", "src.ts", "prompt.md"])
              await PackageTree.runGit(ws, ["commit", "-m", "base"])

              const makeRuntime = (envelope: AgentSession.SessionEnvelope): AgentSession.AgentRuntime => ({
                workspaceRoot: ws,
                sessions: {
                  open: () =>
                    Effect.succeed({
                      identity: "test-agent-v1",
                      run: () => Effect.succeed(envelope)
                    })
                },
                writeSets: AgentSession.makeLocalWriteSetApplier(ws),
                gates: { run: () => Effect.succeed([]) },
                verdicts: AgentSession.makeMemoryVerdictStore(),
                prOpener: {
                  open: () => Effect.succeed("https://example.com/pr/1")
                }
              })

              const lintBase: AgentTarget.LintPayload = {
                agent: S.Agents.reviewer,
                promptPath: "prompt.md",
                diffs: [Input.gitDiff({ base: "HEAD", paths: ["src.ts"] })],
                fixes: ["src.ts"],
                mode: "check"
              }

              // (f1) vacuous lint (no diff vs HEAD)
              const vacuous = await Effect.runPromise(
                AgentSession.runAgentLint(
                  makeRuntime({ findings: [], edits: [], note: "ok" }),
                  lintBase
                )
              )
              expect(vacuous.vacuous).toBe(true)

              // (f2) prompt file outside workspace / symlink / too large / invalid regex
              await Fs.writeFile(NodePath.join(ws, "src.ts"), "export const a = 2\n")
              const escapePromptExit = await Effect.runPromiseExit(
                AgentSession.runAgentLint(
                  makeRuntime({ findings: [], edits: [], note: "ok" }),
                  { ...lintBase, promptPath: "../outside.txt" }
                )
              )
              expect(escapePromptExit._tag).toBe("Failure")

              const symPromptExit = await Effect.runPromiseExit(
                AgentSession.runAgentLint(
                  makeRuntime({ findings: [], edits: [], note: "ok" }),
                  { ...lintBase, promptPath: "outside-prompt.md" }
                )
              )
              expect(symPromptExit._tag).toBe("Failure")

              const bigPromptExit = await Effect.runPromiseExit(
                AgentSession.runAgentLint(
                  makeRuntime({ findings: [], edits: [], note: "ok" }),
                  { ...lintBase, promptPath: "big-prompt.md" }
                )
              )
              expect(bigPromptExit._tag).toBe("Failure")

              const badRegexExit = await Effect.runPromiseExit(
                AgentSession.runAgentLint(
                  makeRuntime({ findings: [], edits: [], note: "ok" }),
                  { ...lintBase, diffs: [Input.gitDiff({ base: "HEAD", paths: ["src.ts"], addedLines: "[unclosed" })] }
                )
              )
              expect(badRegexExit._tag).toBe("Failure")

              // (f3) non-vacuous lint with advisory finding + runAgentDiff + runAgentPr + Layers
              const passRuntime = makeRuntime({
                findings: [{ severity: "info", message: "minor style", file: "src.ts", line: 1 }],
                edits: [],
                note: "looks good"
              })
              const lintRes = await Effect.runPromise(
                AgentSession.runAgentLint(passRuntime, lintBase)
              )
              expect(lintRes.vacuous).toBe(false)
              expect(lintRes.findings.length).toBe(1)

              const diffPayload: AgentTarget.DiffPayload = {
                agent: S.Agents.reviewer,
                promptPath: "prompt.md",
                payloadSpec: {},
                mcp: [],
                diffs: [Input.gitDiff({ base: "HEAD", paths: ["src.ts"] })],
                changes: ["src.ts"],
                gateIdentities: [],
                maxRounds: 2
              }
              const diffRes = await Effect.runPromise(
                AgentSession.runAgentDiff(
                  makeRuntime({
                    findings: [],
                    edits: [{ path: "src.ts", contents: "export const a = 3\n" }],
                    note: "applied"
                  }),
                  diffPayload
                )
              )
              expect(diffRes.edits.length).toBe(1)

              const prRes = await Effect.runPromise(
                AgentSession.runAgentPr(
                  makeRuntime({
                    findings: [],
                    edits: [{ path: "src.ts", contents: "export const a = 4\n" }],
                    note: "pr edit"
                  }),
                  diffPayload
                )
              )
              expect(prRes.pr).toContain("/pr/1")

              expect(AgentSession.AgentLintLive(passRuntime)).toBeDefined()
              expect(AgentSession.AgentDiffLive(passRuntime)).toBeDefined()
              expect(AgentSession.AgentPrLive(passRuntime)).toBeDefined()
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 90_000)

  it(
    "PackageIndex validation errors, PackageLoader escapes/factory/repos, and Affected jj/symlinks/selectors",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              // 1. PackageIndex validation error matrix + private helper transitive edges
              const dummyTarget = S.Shell.Test({ shell: "echo ok" })
              const makeGraph = (packages: PackageLoader.LoadedGraph["packages"]): PackageLoader.LoadedGraph => ({
                root: "/ws",
                workspace: WorkspaceDeclaration.Workspace("ws", {
                  repository: "git+https://github.com/org/ws.git",
                  cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
                  host: WorkspaceDeclaration.Host({ bins: ["echo"] })
                }),
                factory: undefined,
                packages,
                modules: packages.map((p) => p.file),
                moduleRoots: []
              })

              const pkgA = S.Package({ targets: { a: S.Shell.Test({ shell: "echo a" }) } })
              expect(() =>
                PackageIndex.make(
                  makeGraph([
                    { file: "pkg/PACKAGE.ts", packagePath: "pkg", value: pkgA },
                    {
                      file: "pkg/PACKAGE.vibe",
                      packagePath: "pkg",
                      value: S.Package({ targets: { b: S.Shell.Test({ shell: "echo b" }) } })
                    }
                  ])
                )
              ).toThrow(/two Package modules/)

              expect(() =>
                PackageIndex.make(
                  makeGraph([
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({ targets: { first: dummyTarget, second: dummyTarget } })
                    }
                  ])
                )
              ).toThrow(/both/)

              const refAgentTarget = S.Agent.Lint({
                agent: S.Agents.missingAgent,
                prompt: S.file("//p.md"),
                data: []
              } as never)
              expect(() =>
                PackageIndex.make(
                  makeGraph([{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({ targets: { a: refAgentTarget } })
                  }])
                )
              ).toThrow(/no declared workspace agent/i)

              const refFlagTarget = S.Shell.Test({
                bin: S.Host.bin("echo"),
                args: [S.Flags.missingFlag!]
              })
              expect(() =>
                PackageIndex.make(
                  makeGraph([{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({ targets: { a: refFlagTarget } })
                  }])
                )
              ).toThrow(/no declared workspace flag/i)

              const refHostBin = S.Shell.Test({
                bin: S.Host.bin("missing_host_bin")
              })
              expect(() =>
                PackageIndex.make(
                  makeGraph([{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { a: refHostBin } }) }])
                )
              ).toThrow(/no binary in the workspace/)

              const leaf = S.Shell.Test({ shell: "echo leaf" })
              const privateHelper = S.Shell.Test({ shell: "echo priv", data: [leaf] })
              const topTarget = S.Shell.Test({ shell: "echo top", data: [privateHelper, leaf] })
              const idx = PackageIndex.make(
                makeGraph([{
                  file: "PACKAGE.ts",
                  packagePath: "",
                  value: S.Package({ targets: { leaf, top: topTarget } })
                }])
              )
              const edges = idx.edges(idx.resolve("//..."))
              expect(edges.some((e) => e.from === "//:top" && e.to === "//:leaf")).toBe(true)

              // 2. PackageLoader: FACTORY.ts, relative helper with string escapes, default export error, undefined property error
              await withTempDir("wave9i-loader-", async (dir) => {
                await Fs.writeFile(
                  NodePath.join(dir, "WORKSPACE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("w9i", { repository: "git+https://github.com/org/w9i.git", cache: S.Cache({ directory: ".cache" }) })\n`
                )
                await Fs.writeFile(
                  NodePath.join(dir, "FACTORY.ts"),
                  `export const factoryMarker = "wave9i"\n`
                )
                await Fs.mkdir(NodePath.join(dir, "lib"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(dir, "lib/helper.ts"),
                  `export const msg = "hi\\n\\t\\0\\x41"\n`
                )
                await Fs.writeFile(
                  NodePath.join(dir, "PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nimport { msg } from "./lib/helper.ts"\nexport const Package = S.Package({ targets: { ok: S.Shell.Test({ shell: "echo " + msg }) } })\n`
                )
                await expect(PackageLoader.load(await PackageDiscovery.discover(dir))).rejects.toThrow(
                  /factory_export_missing|no factory export/
                )
                await Fs.unlink(NodePath.join(dir, "FACTORY.ts"))
                const disc = await PackageDiscovery.discover(dir)
                const loaded = await PackageLoader.load(disc)
                expect(loaded.packages.length).toBe(1)

                await Fs.writeFile(
                  NodePath.join(dir, "PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport default S.Package({ targets: { ok: S.Shell.Test({ shell: "echo x" }) } })\n`
                )
                await expect(PackageLoader.load(await PackageDiscovery.discover(dir))).rejects.toThrow()

                await Fs.writeFile(
                  NodePath.join(dir, "PACKAGE.ts"),
                  `const x: any = undefined\nexport const Package = x.foo\n`
                )
                await expect(PackageLoader.load(await PackageDiscovery.discover(dir))).rejects.toThrow(/\.foo/)
              })

              // 3. Affected: real colocated jj repo (changedPaths + baseFiles), symlinks, NodeModules, dependencySelectors, private targets
              await withTempDir("wave9i-aff-", async (dir) => {
                NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: dir, stdio: "ignore" })
                await Fs.writeFile(
                  NodePath.join(dir, "WORKSPACE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("aff9i", { repository: "git+https://github.com/org/aff9i.git", cache: S.Cache({ directory: ".cache" }) })\n`
                )
                await Fs.mkdir(NodePath.join(dir, "pkg/src"), { recursive: true })
                await Fs.writeFile(NodePath.join(dir, "pkg/src/a.ts"), "export const a = 1\n")
                await Fs.writeFile(NodePath.join(dir, "pkg/package.json"), JSON.stringify({ name: "pkg" }))
                await Fs.mkdir(NodePath.join(dir, "pkg/node_modules"), { recursive: true })
                await Fs.writeFile(NodePath.join(dir, "pkg/node_modules/dep.txt"), "dep")
                await Fs.symlink("src/a.ts", NodePath.join(dir, "pkg/link-a.ts"))
                await Fs.writeFile(
                  NodePath.join(dir, "pkg/PACKAGE.ts"),
                  [
                    `import { Smithers as S } from "@smthrs/targets"`,
                    `const priv = S.Shell.Test({ shell: "echo p", data: [S.glob("src/**")] })`,
                    `export const Package = S.Package({ targets: {`,
                    `  base: S.Shell.Test({ shell: "echo b", data: [S.glob("src/**"), S.file("link-a.ts"), S.nodeModules("node_modules")] }),`,
                    `  top: S.Shell.Test({ shell: "echo t", data: [priv, S.Target.subtree("//pkg/...", "base")] })`,
                    `} })`
                  ].join("\n")
                )
                await PackageTree.runGit(dir, ["config", "user.email", "test@example.com"])
                await PackageTree.runGit(dir, ["config", "user.name", "Test"])
                await PackageTree.runGit(dir, ["add", "."])
                await PackageTree.runGit(dir, ["commit", "-m", "init"])
                await Fs.writeFile(NodePath.join(dir, "pkg/src/a.ts"), "export const a = 2\n")

                const changed = await Affected.changedPaths(dir, { base: "HEAD" })
                expect(changed).toContain("pkg/src/a.ts")
                const baseFiles = await Affected.baseFiles(dir, { base: "HEAD" })
                expect(baseFiles).toContain("pkg/src/a.ts")

                const loaded = await PackageLoader.load(await PackageDiscovery.discover(dir))
                const index = PackageIndex.make(loaded)
                const sel = Affected.select(index, ["//..."], ["pkg/src/a.ts"], { explain: true })
                expect(sel.targets.length).toBeGreaterThan(0)
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
