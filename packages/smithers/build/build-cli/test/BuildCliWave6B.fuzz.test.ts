import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fastExecs = Math.max(12, Math.min(executions, 40))
const fsExecs = Math.max(4, Math.min(executions, 10))

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
    await Machine.remove(dir)
  }
}

const makeElfWithInterp = (interpPath: string): Buffer => {
  const buf = Buffer.alloc(256, 0)
  // 64-bit little-endian ELF magic
  buf.writeUInt32BE(0x7f454c46, 0)
  buf[4] = 2 // ELFCLASS64
  buf[5] = 1 // ELFDATA2LSB
  buf.writeBigUInt64LE(64n, 0x20) // e_phoff = 64
  buf.writeUInt16LE(56, 0x36) // e_phentsize = 56
  buf.writeUInt16LE(1, 0x38) // e_phnum = 1
  // Program header 0 at offset 64: PT_INTERP (type = 3)
  buf.writeUInt32LE(3, 64)
  buf.writeBigUInt64LE(128n, 64 + 8) // p_offset = 128
  const interpBytes = Buffer.from(`${interpPath}\0`, "latin1")
  buf.writeBigUInt64LE(BigInt(interpBytes.length), 64 + 0x20) // p_filesz
  interpBytes.copy(buf, 128)
  return buf
}

const makeVirtualIo = (
  files: Map<string, string | Buffer>,
  dirs: Map<string, Array<string>>,
  links: Map<string, string> = new Map(),
  mounts: ReadonlyArray<readonly [at: string, from: string]> = []
): ObservedReads.Io => {
  const mkStat = (kind: "file" | "dir" | "link", size: number, nlink = 1): NodeFs.Stats =>
    ({
      isFile: () => kind === "file",
      isDirectory: () => kind === "dir",
      isSymbolicLink: () => kind === "link",
      size,
      nlink,
      mtimeMs: 1000,
      ctimeMs: 1000,
      ino: 1,
      dev: 1,
      mode: kind === "dir" ? 0o40755 : kind === "link" ? 0o120777 : 0o100644
    }) as unknown as NodeFs.Stats

  const resolve = (p: string): string => {
    for (const [at, from] of mounts) {
      if (p === at || p.startsWith(`${at}/`)) return from + p.slice(at.length)
    }
    return p
  }

  const readBuf = (p: string): Buffer => {
    const rp = resolve(p)
    const val = files.get(rp)
    if (val === undefined) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    }
    return Buffer.isBuffer(val) ? val : Buffer.from(val)
  }

  return {
    lstat: (p) => {
      const rp = resolve(p)
      if (links.has(rp)) return mkStat("link", links.get(rp)!.length)
      if (files.has(rp)) {
        const v = files.get(rp)!
        return mkStat("file", Buffer.isBuffer(v) ? v.length : Buffer.byteLength(v))
      }
      if (dirs.has(rp)) {
        const children = dirs.get(rp)!
        let subdirs = 0
        for (const c of children) {
          if (dirs.has(`${rp}/${c}`)) subdirs += 1
        }
        return mkStat("dir", 0, 2 + subdirs)
      }
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    },
    readFile: readBuf,
    head: (p, len) => readBuf(p).subarray(0, len),
    readlink: (p) => {
      const rp = resolve(p)
      const t = links.get(rp)
      if (t === undefined) {
        const err = new Error(`EINVAL: ${p}`) as NodeJS.ErrnoException
        err.code = "EINVAL"
        throw err
      }
      return t
    },
    readdir: (p) => {
      const rp = resolve(p)
      const list = dirs.get(rp)
      if (list === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        err.code = "ENOENT"
        throw err
      }
      return [...list]
    },
    mounts: () => mounts
  }
}

describe("@smthrs/build-cli Wave-6B: ObservedReads & Machine deep fuzz invariants", () => {
  it("ObservedReads.read, servedBy, withServed & socket/procfs/symlink/rename/unlink/continuation parsing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        netKind: Schema.Literals([
          "loopback_v4",
          "wildcard_v4",
          "loopback_v6",
          "v4_mapped_v6",
          "external_v4",
          "sendto_quoted"
        ]),
        procKind: Schema.Literals([
          "self_cwd",
          "thread_self_exe",
          "outside_pid",
          "proc_up",
          "supervised_outside",
          "fd_open"
        ]),
        fsOp: Schema.Literals([
          "symlink_rename",
          "unlink_mkdir",
          "linkat_statx",
          "dir_walk",
          "clone_chdir",
          "io_uring_refuse"
        ]),
        contError: Schema.Boolean,
        sealed: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ netKind, procKind, fsOp, contError, sealed }) =>
          Effect.sync(() => {
            const cwd = "/ws"
            const netLine = netKind === "loopback_v4"
              ? "100 connect(4, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr(\"127.0.0.1\")}, 16) = 0"
              : netKind === "wildcard_v4"
              ? "100 bind(4, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr(\"0.0.0.0\")}, 16) = 0"
              : netKind === "loopback_v6"
              ? "100 connect(4, {sa_family=AF_INET6, sin6_port=htons(9090), sin6_addr=inet_pton(AF_INET6, \"::1\")}, 28) = 0"
              : netKind === "v4_mapped_v6"
              ? "100 connect(4, {sa_family=AF_INET6, sin6_port=htons(8081), sin6_addr=inet_pton(AF_INET6, \"::ffff:127.0.0.1\")}, 28) = 0"
              : netKind === "external_v4"
              ? "100 connect(4, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"93.184.216.34\")}, 16) = 0"
              : "100 sendto(4, \"hello \\\" {sa_family=fake}\", 24, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr(\"1.1.1.1\")}, 16) = 24"

            const procLines: Array<string> = procKind === "self_cwd"
              ? ["100 openat(AT_FDCWD, \"/proc/self/cwd/a.txt\", O_RDONLY) = 3"]
              : procKind === "thread_self_exe"
              ? ["100 readlinkat(AT_FDCWD, \"/proc/thread-self/exe\", \"/usr/bin/node\", 4096) = 13"]
              : procKind === "outside_pid"
              ? ["100 openat(AT_FDCWD, \"/proc/999999/fd/3\", O_RDONLY) = 3"]
              : procKind === "proc_up"
              ? ["100 openat(AT_FDCWD, \"/proc/self/cwd/../a.txt\", O_RDONLY) = 3"]
              : procKind === "supervised_outside"
              ? ["smthrs-observe/1", "100 openat(AT_FDCWD, \"/proc/888888/fd/1\", O_RDONLY) = 3"]
              : [
                "100 openat(AT_FDCWD, \"/ws/sub\", O_RDONLY|O_DIRECTORY) = 5",
                "100 openat(5, \"inner.txt\", O_RDONLY) = 6",
                "100 dup2(5, 7) = 7",
                "100 openat(7, \"dup.txt\", O_RDONLY) = 8",
                "100 close(5) = 0",
                "100 close(7) = 0"
              ]

            const fsLines: Array<string> = fsOp === "symlink_rename"
              ? [
                "100 symlinkat(\"target.txt\", AT_FDCWD, \"/ws/link.txt\") = 0",
                "100 renameat2(AT_FDCWD, \"/ws/link.txt\", AT_FDCWD, \"/ws/moved.txt\", 0) = 0",
                "100 openat(AT_FDCWD, \"/ws/moved.txt\", O_RDONLY) = 3"
              ]
              : fsOp === "unlink_mkdir"
              ? [
                "100 mkdirat(AT_FDCWD, \"/ws/newdir\", 0755) = 0",
                "100 openat(AT_FDCWD, \"/ws/newdir/tmp.txt\", O_WRONLY|O_CREAT|O_EXCL, 0644) = 3",
                "100 unlinkat(AT_FDCWD, \"/ws/newdir/tmp.txt\", 0) = 0"
              ]
              : fsOp === "linkat_statx"
              ? [
                "100 openat(AT_FDCWD, \"/ws/src.txt\", O_RDONLY) = 3",
                "100 linkat(AT_FDCWD, \"/ws/src.txt\", AT_FDCWD, \"/ws/hard.txt\", 0) = 0",
                "100 statx(AT_FDCWD, \"/ws/hard.txt\", AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS, {}) = 0",
                "100 newfstatat(AT_FDCWD, \"/ws/missing.txt\", {}, 0) = -1 ENOENT (No such file or directory)"
              ]
              : fsOp === "dir_walk"
              ? [
                "100 openat(AT_FDCWD, \"/ws/dir\", O_RDONLY|O_DIRECTORY) = 5",
                "100 getdents64(5</ws/dir>, /* 3 entries */, 32768) = 96",
                "100 close(5) = 0"
              ]
              : fsOp === "clone_chdir"
              ? [
                "100 clone(child_stack=NULL, flags=CLONE_VM|SIGCHLD) = 101",
                "101 chdir(\"/ws/child\") = 0",
                "101 openat(AT_FDCWD, \"file.txt\", O_RDONLY) = 3",
                "101 execve(\"/usr/bin/env\", [\"env\"], 0x0) = 0"
              ]
              : [
                "100 io_uring_setup(32, {}) = 9"
              ]

            const stepLines = [
              "100 execve(\"/usr/bin/node\", [\"node\", \"app.js\"], 0x0) = 0",
              ...procLines,
              ...fsLines,
              netLine,
              ...(sealed ? ["# smthrs-observe-end 1"] : [])
            ]
            const afterLines = [
              "100 openat(AT_FDCWD, \"/ws/after-read.txt\", O_RDONLY) = 3",
              "100 openat(AT_FDCWD, \"/ws/after-write.txt\", O_WRONLY|O_CREAT|O_EXCL, 0644) = 4",
              "100 unlinkat(AT_FDCWD, \"/ws/after-gone.txt\", 0) = 0",
              "100 openat(AT_FDCWD, \"/ws/after-miss.txt\", O_RDONLY) = -1 ENOENT (No such file or directory)"
            ]

            const ownTrace = ObservedReads.read(() => stepLines, cwd)
            if (fsOp === "io_uring_refuse") {
              expect(ownTrace.refusals.some((r) => r.includes("io_uring"))).toBe(true)
            }
            if (procKind === "outside_pid" || procKind === "proc_up" || procKind === "supervised_outside") {
              expect(ownTrace.refusals.length, JSON.stringify({ procKind, refusals: ownTrace.refusals }))
                .toBeGreaterThan(0)
            }
            if (netKind === "external_v4" || netKind === "sendto_quoted") {
              expect((ownTrace.reached?.length ?? 0) + ownTrace.refusals.length).toBeGreaterThan(0)
            }

            const served = ObservedReads.servedBy(
              () => stepLines,
              () => {
                if (contError) throw new Error("read failure")
                return afterLines
              },
              cwd
            )
            if (!contError) {
              expect(served.found.has("/ws/after-read.txt"), "served.found=" + JSON.stringify([...served.found.keys()]))
                .toBe(true)
              expect(served.made.has("/ws/after-write.txt")).toBe(true)
              expect(
                served.missing.has("/ws/after-miss.txt"),
                "served.missing=" + JSON.stringify([...served.missing.keys()])
              ).toBe(true)
            }

            const combined = ObservedReads.withServed(ownTrace, [served])
            if (!contError) expect(combined.found.has("/ws/after-read.txt")).toBe(true)

            return true
          }),
        { seed: 20261310, executions: fastExecs }
      )
    )
    assertPassed(report)
  })

  it("ObservedReads.observe, record, interpreters (shebang+ELF), changed, mounts (placedBy/mountView), given/links/made & digests", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mutation: Schema.Literals([
          "none",
          "var_changed",
          "read_modified",
          "read_deleted",
          "missing_created",
          "made_committed",
          "from_changed",
          "given_missing_not_again",
          "given_changed",
          "dir_subdir_added",
          "list_changed",
          "outside_changed",
          "served_changed"
        ]),
        withMount: Schema.Boolean,
        withElf: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mutation, withMount, withElf }) =>
          Effect.sync(() => {
            const root = "/ws"
            const files = new Map<string, string | Buffer>([
              ["/ws/a.txt", "alpha"],
              ["/ws/given.txt", "from-step"],
              ["/ws/dir/f.txt", "dirfile"],
              ["/mnt-src/m.txt", "mounted-bytes"],
              ["/ext/tool.cfg", "cfg-v1"],
              ["/usr/bin/script.sh", "#!/usr/bin/myelf\necho hi\n"],
              ["/usr/bin/myelf", withElf ? makeElfWithInterp("/lib64/ld-linux.so.2") : "plain"],
              ["/lib64/ld-linux.so.2", "loader-v1"]
            ])
            const dirs = new Map<string, Array<string>>([
              ["/ws", ["a.txt", "given.txt", "dir"]],
              ["/ws/dir", ["f.txt", "sub"]],
              ["/ws/dir/sub", []],
              ["/mnt-src", ["m.txt"]],
              ["/ext", ["tool.cfg"]],
              ["/usr/bin", ["script.sh", "myelf"]],
              ["/lib64", ["ld-linux.so.2"]]
            ])
            const mounts: ReadonlyArray<readonly [string, string]> = withMount
              ? [["/ws/mounted", "/mnt-src"]]
              : []
            if (withMount) {
              dirs.set("/ws", ["a.txt", "given.txt", "dir", "mounted"])
            }
            const io = makeVirtualIo(files, dirs, new Map(), mounts)

            const trace = ObservedReads.read(
              () => [
                "100 execve(\"/usr/bin/script.sh\", [\"script.sh\"], 0x0) = 0",
                "100 openat(AT_FDCWD, \"/ws/a.txt\", O_RDONLY) = 3",
                "100 openat(AT_FDCWD, \"/ws/given.txt\", O_RDONLY) = 3",
                "100 openat(AT_FDCWD, \"/ws/absent.txt\", O_RDONLY) = -1 ENOENT (No such file or directory)",
                "100 openat(AT_FDCWD, \"/ws/dir\", O_RDONLY|O_DIRECTORY) = 4",
                "100 getdents64(4</ws/dir>, /* 2 entries */, 32768) = 64",
                "100 close(4) = 0",
                "100 openat(AT_FDCWD, \"/ws/created.txt\", O_WRONLY|O_CREAT|O_EXCL, 0644) = 5",
                "100 openat(AT_FDCWD, \"/ext/tool.cfg\", O_RDONLY) = 6",
                ...(withMount ? ["100 openat(AT_FDCWD, \"/ws/mounted/m.txt\", O_RDONLY) = 7"] : [])
              ],
              root
            )
            // Materialize created.txt in virtual FS after trace
            files.set("/ws/created.txt", "new-output")
            dirs.set("/ws", [...dirs.get("/ws")!, "created.txt"])

            const obs = ObservedReads.observe(trace, {
              root,
              ignore: [],
              startedMs: 2000,
              io,
              mounts,
              producers: [{ label: "//:dep", id: "dep-id-1", made: new Set(["/ws/given.txt"]), touched: new Set() }],
              served: [["//:srv", "srv-id-1"]],
              held: () => new Set(["a.txt", "dir"]),
              variables: { values: { MODE: "release-val" }, text: "MODE" }
            })
            if ("refusal" in obs) throw new Error("unexpected refusal: " + obs.refusal)

            const rec = {
              ...obs.record,
              from: [["//:dep", "dep-id-1"]] as const,
              given: [["given.txt", ObservedReads.measure("/ws/given.txt", io), 0]] as const
            }
            if ((rec.id ?? "").length === 0) return false

            // Also exercise listing + dirLinks directly with mounts
            const listDigest = ObservedReads.listing("/ws/dir", [], io)
            if (listDigest === undefined) return false
            if (withMount) {
              const mDigest = ObservedReads.listing("/ws/mounted", [], io)
              if (mDigest === undefined) return false
            }

            // Apply requested mutation
            let envVals: Record<string, string | undefined> = { MODE: "release-val" }
            let holdsFn = (_names: ReadonlyArray<string>): ReadonlySet<string> | undefined => new Set()
            let answeredFn = (label: string): ReadonlySet<string> | undefined =>
              label === "//:dep" ? new Set(["dep-id-1"]) : undefined
            let servedFn = (label: string): ReadonlySet<string> | undefined =>
              label === "//:srv" ? new Set(["srv-id-1"]) : undefined

            if (mutation === "var_changed") {
              envVals = { MODE: "debug-val" }
            } else if (mutation === "read_modified") {
              files.set("/ws/a.txt", "beta")
            } else if (mutation === "read_deleted") {
              files.delete("/ws/a.txt")
            } else if (mutation === "missing_created") {
              files.set("/ws/absent.txt", "appeared")
            } else if (mutation === "made_committed") {
              holdsFn = (names) => new Set(names.filter((n) => n === "created.txt"))
            } else if (mutation === "from_changed") {
              answeredFn = () => new Set(["dep-id-2"])
            } else if (mutation === "given_missing_not_again") {
              files.delete("/ws/given.txt")
              answeredFn = () => undefined
            } else if (mutation === "given_changed") {
              files.set("/ws/given.txt", "tampered")
            } else if (mutation === "dir_subdir_added") {
              dirs.set("/ws/dir/sub2", [])
              dirs.set("/ws/dir", ["f.txt", "sub", "sub2"])
            } else if (mutation === "list_changed") {
              files.set("/ws/dir/new.txt", "x")
              dirs.set("/ws/dir", ["f.txt", "sub", "new.txt"])
            } else if (mutation === "outside_changed") {
              files.set("/ext/tool.cfg", "cfg-v2")
            } else if (mutation === "served_changed") {
              servedFn = () => new Set(["srv-id-2"])
            }

            const measuredFn = (p: string) => ObservedReads.measure(p, io)
            const reason = ObservedReads.changed(
              rec,
              root,
              measuredFn,
              io,
              answeredFn,
              envVals,
              () => false,
              servedFn,
              holdsFn,
              mounts
            )
            const outsideReason = ObservedReads.outsideChanged(rec, measuredFn)

            if (mutation === "none") {
              expect(reason).toBeUndefined()
              expect(outsideReason).toBeUndefined()
            } else if (mutation === "outside_changed") {
              expect(outsideReason ?? reason).toBeDefined()
            } else if (mutation === "var_changed") {
              if (rec.variables !== undefined && rec.variables.length > 0) expect(reason).toBeDefined()
            } else {
              expect(reason, "mutation=" + mutation).toBeDefined()
            }

            const times = ObservedReads.putBackTimes([10n, 20n], 15n, 30n)
            expect(times.length).toBe(2)
            expect(ObservedReads.keptName(".git/HEAD", [])).toBe(false)
            expect(ObservedReads.holdsValue("token=secret1234", "secret1234")).toBe(true)
            const finder = ObservedReads.heldNames(["MY_SECRET_VAR"])
            expect(finder("use $MY_SECRET_VAR here")).toContain("MY_SECRET_VAR")
            const stored = ObservedReads.store(rec, [rec])
            expect(stored?.records.length).toBeGreaterThan(0)
            const withFrom = {
              ...rec,
              from: [["//:dep", "dep-id-1"]] as const,
              given: [["given.txt", ObservedReads.measure("/ws/given.txt", io), 0]] as const
            }
            expect(ObservedReads.anchored(withFrom, () => "dep-id-1")).toBeUndefined()
            const reanchored = ObservedReads.anchored(withFrom, () => "dep-id-new")
            expect(reanchored?.from?.[0]?.[1]).toBe("dep-id-new")
            const mem = ObservedReads.remembering(io, Date.now, new Map())
            expect(mem("/ws/a.txt")).toBe(ObservedReads.measure("/ws/a.txt", io))
            return true
          }),
        { seed: 20261311, executions: fastExecs }
      )
    )
    assertPassed(report)
  })

  it(
    "Machine.unmade virtual FS, hold/unstale/socket locking, mounting/through/recorded, toKeep & remove invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          keepInput: Schema.Literals(["empty", "valid", "bad_json", "not_object", "relative_dir", "bad_name"]),
          withTemplate: Schema.Boolean,
          withHeld: Schema.Boolean,
          staleLock: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ keepInput, withTemplate, withHeld, staleLock }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6b-mach-", async (base) => {
                const root = NodePath.join(base, "ws")
                const kept = NodePath.join(base, "kept")
                const tpl = NodePath.join(base, "home-tpl")
                const linkTarget = NodePath.join(base, "link-target")
                const roDir = NodePath.join(base, "ro-tree")
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                await Fs.mkdir(kept, { recursive: true })
                await Fs.mkdir(NodePath.join(tpl, "cfg"), { recursive: true })
                await Fs.mkdir(linkTarget, { recursive: true })
                await Fs.mkdir(NodePath.join(roDir, "sub"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "src", "a.ts"), "export const a = 1\n")
                await Fs.writeFile(NodePath.join(root, "untracked.txt"), "skip\n")
                await Fs.writeFile(NodePath.join(tpl, "cfg", "t.txt"), "tpl\n")
                await Fs.writeFile(NodePath.join(linkTarget, "k.txt"), "linked\n")
                await Fs.writeFile(NodePath.join(roDir, "sub", "locked.txt"), "ro\n")
                await Fs.chmod(NodePath.join(roDir, "sub", "locked.txt"), 0o444)
                await Fs.chmod(NodePath.join(roDir, "sub"), 0o555)

                // 1. Machine.toKeep validation
                const keepEnv: Record<string, string | undefined> = keepInput === "empty"
                  ? {}
                  : keepInput === "valid"
                  ? { [Machine.keepVariable]: JSON.stringify({ ci: NodePath.join(base, "keep-ci") }) }
                  : keepInput === "bad_json"
                  ? { [Machine.keepVariable]: "{broken" }
                  : keepInput === "not_object"
                  ? { [Machine.keepVariable]: "[]" }
                  : keepInput === "relative_dir"
                  ? { [Machine.keepVariable]: JSON.stringify({ ci: "rel/path" }) }
                  : { [Machine.keepVariable]: JSON.stringify({ ci: 123 }) }
                const parsedKeep = Machine.toKeep(keepEnv)
                if (keepInput === "empty" || keepInput === "valid") {
                  expect("problem" in parsedKeep).toBe(false)
                } else {
                  expect("problem" in parsedKeep).toBe(true)
                }

                // 2. Machine.unmade virtual filesystem
                const start: Machine.Start = {
                  root,
                  kept,
                  cacheDirectory: ".flows",
                  held: withHeld ? { files: new Set(["src/a.ts"]), directories: new Set(["src"]) } : undefined,
                  homeTemplate: withTemplate ? tpl : undefined,
                  links: Machine.homeLinks([
                    { path: "home/.config/tool", target: linkTarget }
                  ])
                }
                const view = Machine.unmade(
                  start,
                  (p) => ObservedReads.measure(p),
                  ObservedReads.defaultIo
                )
                const machDir = NodePath.join(kept, "ci")
                expect([...view.io.readdir(machDir)].sort()).toEqual(["home", "tmp", "w"])
                expect(view.measured(NodePath.join(machDir, "tmp"))).toBe("d")
                expect(view.measured(NodePath.join(machDir, "tmp", "missing"))).toBe("-")
                expect(view.io.readdir(NodePath.join(machDir, "w"))).toEqual([NodePath.basename(root)])
                expect(view.io.lstat(NodePath.join(machDir, "home", ".config", "tool")).isSymbolicLink()).toBe(true)
                expect(view.io.readdir(NodePath.join(machDir, "home", ".config", "tool"))).toContain("k.txt")
                expect(view.measured(NodePath.join(machDir, "home", ".config", "tool", "k.txt"))).not.toBe("-")
                expect(view.io.lstat(NodePath.join(machDir, "home")).isDirectory()).toBe(true)
                expect(view.io.lstat(root).isDirectory()).toBe(true)
                expect(view.io.readdir(root)).toContain("src")
                if (withHeld) {
                  expect(view.io.readdir(root)).not.toContain("untracked.txt")
                }
                if (withTemplate) {
                  expect(view.measured(NodePath.join(machDir, "home", "cfg", "t.txt"))).not.toBe("-")
                }
                let missingThrew = false
                try {
                  view.io.lstat(NodePath.join(machDir, "w", "nope"))
                } catch {
                  missingThrew = true
                }
                expect(missingThrew).toBe(true)

                // 3. Machine.hold + unstale + socket lock contention & release
                const holdKept = NodePath.join(base, "hold-kept")
                await Fs.mkdir(holdKept, { recursive: true })
                const holdEnv = { [Machine.holdingVariable]: holdKept }
                const actualKept = Machine.holding(root, holdEnv)
                if (staleLock) {
                  const stalePath = Machine.holdPath(actualKept)
                  await Fs.mkdir(NodePath.dirname(stalePath), { recursive: true })
                  await Fs.writeFile(stalePath, "stale")
                  await Machine.unstale(stalePath)
                }
                let waited = false
                const held1 = await Machine.hold(root, holdEnv, () => {})
                let secondAcquired = false
                const secondPromise = Machine.hold(root, holdEnv, () => {
                  waited = true
                }).then((h2) => {
                  secondAcquired = true
                  return h2
                })
                await new Promise((r) => setTimeout(r, 40))
                expect(secondAcquired).toBe(false)
                await held1.release()
                const held2 = await secondPromise
                expect(secondAcquired).toBe(true)
                expect(waited).toBe(true)
                await held2.release()

                // 4. Machine.remove cleans read-only directories & ignores ENOENT
                await Machine.remove(roDir)
                expect(NodeFs.existsSync(roDir)).toBe(false)
                await Machine.remove(NodePath.join(base, "does-not-exist"))

                // 5. Machine.named / tmpBinds / inSight / neutral / actual / own / listening
                const machine = Machine.named(kept, root, "ci")
                const binds = Machine.tmpBinds(machine, ["/usr/bin"])
                expect(binds.length).toBeGreaterThan(0)
                const sight = Machine.inSight(["/tmp/tool/bin", "/usr/bin"])
                expect(Array.isArray(sight)).toBe(true)
                const neutral = Machine.neutral(machine)
                const actual = Machine.actual(machine)
                expect(actual(neutral(machine.home))).toBe(machine.home)
                expect(Machine.own(`${Machine.anchor}/home/x`)).toBe(true)

                const sockDir = NodePath.join(base, "sock")
                await Fs.mkdir(sockDir, { recursive: true })
                const srv = NodeNet.createServer()
                await new Promise<void>((res) => srv.listen(NodePath.join(sockDir, "ready.sock"), res))
                try {
                  const ok = await Machine.listening(
                    sockDir,
                    "ready.sock",
                    { exitCode: null, killed: false } as never,
                    200
                  )
                  expect(ok).toBe(true)
                } finally {
                  await new Promise<void>((res) => srv.close(() => res()))
                }
              })
              return true
            }),
          { seed: 20261312, executions: fsExecs }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
