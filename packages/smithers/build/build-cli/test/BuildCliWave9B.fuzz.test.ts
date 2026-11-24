import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as EffectRes from "../src/effect-resolution.js"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fastExecutions = Math.max(20, Math.min(executions, 250))

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

interface FakeEntry {
  readonly kind: "file" | "dir" | "link" | "error"
  readonly data?: Buffer
  readonly target?: string
  readonly children?: ReadonlyArray<string>
  readonly errorCode?: string
  readonly readErrorCode?: string
}

const makeFakeIo = (entries: Map<string, FakeEntry>): ObservedReads.Io => {
  const mkErr = (code: string) => Object.assign(new Error(code), { code })
  const makeStat = (e: FakeEntry): NodeFs.Stats =>
    ({
      isFile: () => e.kind === "file",
      isDirectory: () => e.kind === "dir",
      isSymbolicLink: () => e.kind === "link",
      size: e.kind === "file" ? (e.data?.length ?? 0) : e.kind === "link" ? Buffer.byteLength(e.target ?? "") : 0,
      mode: e.kind === "dir" ? 0o040755 : e.kind === "link" ? 0o120777 : 0o100644,
      nlink: 2,
      dev: 1,
      ino: 1
    }) as unknown as NodeFs.Stats

  return {
    lstat: (p) => {
      const e = entries.get(p)
      if (!e) throw mkErr("ENOENT")
      if (e.kind === "error") throw mkErr(e.errorCode ?? "EACCES")
      return makeStat(e)
    },
    readlink: (p) => {
      const e = entries.get(p)
      if (!e || e.kind !== "link") throw mkErr("EINVAL")
      return e.target ?? ""
    },
    readdir: (p) => {
      const e = entries.get(p)
      if (!e) throw mkErr("ENOENT")
      if (e.kind === "error") throw mkErr(e.errorCode ?? "EACCES")
      if (e.kind !== "dir") throw mkErr("ENOTDIR")
      if (e.readErrorCode) throw mkErr(e.readErrorCode)
      return e.children ?? []
    },
    readFile: (p) => {
      const e = entries.get(p)
      if (!e) throw mkErr("ENOENT")
      if (e.kind === "error") throw mkErr(e.errorCode ?? "EACCES")
      if (e.readErrorCode) throw mkErr(e.readErrorCode)
      return e.data ?? Buffer.alloc(0)
    },
    head: (p, len) => {
      const e = entries.get(p)
      if (!e) throw mkErr("ENOENT")
      if (e.readErrorCode) throw mkErr(e.readErrorCode)
      return (e.data ?? Buffer.alloc(0)).subarray(0, len)
    }
  }
}

describe("BuildCliWave9B ObservedReads, Machine, and effect-resolution coverage", () => {
  it("ObservedReads trace parser, lockedInstall, openat2 walks, observe, and changed branches", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      variant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 19 }))),
      pid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 10, maximum: 500 }))),
      name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(10)))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, pid, name }) =>
          Effect.sync(() => {
            const safe = name.replace(/[^a-z0-9_]/gi, "a") || "a"
            const root = "/work"

            expect(ObservedReads.reaped(["echo", safe], undefined)).toEqual(["echo", safe])
            expect(ObservedReads.reaped(["echo", safe], "/bin/reaper")).toEqual([
              "/bin/reaper",
              "--reap",
              "--",
              "echo",
              safe
            ])
            const unrec = ObservedReads.unrecordedStep("//pkg:t")
            expect(unrec.cwd).toBe("/")
            expect(unrec.step()).toEqual([])
            expect(unrec.after()).toEqual([])

            expect(ObservedReads.lockedInstall(["npm", "--prefix=web", "ci"], root)).toBe(true)
            expect(ObservedReads.lockedInstall(["npm", "--prefix", "web", "clean-install"], root)).toBe(true)
            expect(ObservedReads.lockedInstall(["npm", "--unknown-flag", "ci"], root)).toBe(false)
            expect(ObservedReads.lockedInstall(["npm", "install-clean"], root)).toBe(true)
            expect(ObservedReads.lockedInstall(["npm", "ic"], root)).toBe(true)

            const cases: ReadonlyArray<ReadonlyArray<string>> = [
              [`1 openat(AT_FDCWD, "/proc/self/fd/3/../foo", O_RDONLY) = 4`],
              [`1 openat(AT_FDCWD, "/proc/self/fd/3/${safe}", O_RDONLY) = 4</work/${safe} (deleted)>`],
              [`1 connect(3<socket:[1]>, {sa_family=AF_NETLINK, nl_pid=0}, 12) = 0`],
              [
                `1 openat(AT_FDCWD, "${safe}", O_WRONLY|O_TRUNC) = 3</work/${safe}>`,
                `1 openat(AT_FDCWD, "${safe}2", O_WRONLY) = 4</work/${safe}2>`,
                `1 openat(AT_FDCWD, "${safe}3", O_WRONLY|O_CREAT, 0644) = 5</work/${safe}3>`
              ],
              [
                `1 openat(AT_FDCWD, 0x7fff1234, O_RDONLY) = -1 EFAULT (Bad address)`,
                `1 openat(99, "${safe}", O_RDONLY) = 3`
              ],
              [
                `1 syscall_0x1ff(0) = -1 ENOSYS`,
                `1 fanotify_init(0, 0) = -1 EPERM`,
                `1 io_uring_setup(8, 0x1) = -1 EPERM`
              ],
              [`1 openat(AT_FDCWD, "/work", O_RDWR|O_TMPFILE, 0600) = 3`],
              [
                `1 utimensat(3</work/${safe}>, NULL, NULL, 0) = 0`,
                `1 utimensat(AT_FDCWD, "${safe}", NULL, AT_SYMLINK_NOFOLLOW) = 0`
              ],
              [
                `1 clone(flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND) = ${pid}`,
                `${pid} execve("/bin/true", ["true"], []) = 1`
              ],
              [
                `1 clone(flags=CLONE_FS|CLONE_VM) = ${pid}`,
                `1 openat(AT_FDCWD, "${safe}", O_RDONLY <unfinished ...>`,
                `${pid} chdir("/tmp") = 0`,
                `1 <... openat resumed>) = 3</work/${safe}>`
              ],
              [
                `1 execve("/usr/bin/npm", ["npm", "ci"], []) = 0`,
                `1 clone(flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND) = ${pid}`,
                `1 clone(flags=SIGCHLD) = ${pid + 1}`,
                `${pid} openat(AT_FDCWD, "${safe}", O_RDONLY <unfinished ...>`,
                `1 clone(flags=SIGCHLD) = ${pid}`,
                `${pid + 1} openat(AT_FDCWD, "${safe}", O_RDONLY <detached ...>`
              ],
              [
                `1 execve("/usr/bin/cargo", ["cargo", "build"], []) = 0`,
                `1 mkdirat(AT_FDCWD, "target", 0755) = 0`,
                `1 openat(AT_FDCWD, "target/${safe}", O_WRONLY|O_CREAT, 0644) = 3</work/target/${safe}>`
              ],
              [
                `1 openat2(3</work>, "sub/../${safe}", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</work/${safe}>`,
                `1 openat2(3</work>, "../escape", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = -1 EXDEV`,
                `1 openat2(3</work>, "/abs", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = -1 EXDEV`,
                `1 openat2(3</work>, "link", {flags=O_RDONLY, resolve=RESOLVE_NO_SYMLINKS}, 24) = -1 ELOOP`
              ],
              [
                `1 openat(AT_FDCWD, "tmp-${safe}", O_WRONLY|O_CREAT, 0644) = 3</work/tmp-${safe}>`,
                `1 openat(AT_FDCWD, "dst-${safe}", O_WRONLY|O_CREAT, 0644) = 4</work/dst-${safe}>`,
                `1 renameat(AT_FDCWD, "tmp-${safe}", AT_FDCWD, "dst-${safe}") = 0`
              ],
              [
                `1 socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP) = 3<TCPv6:[10]>`,
                `1 bind(3<TCPv6:[10]>, {sa_family=AF_INET6, sin6_port=htons(8080), sin6_addr=inet_pton(AF_INET6, "::")}, 28) = 0`,
                `1 connect(4<TCP:[11]>, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`
              ],
              [`1 openat(AT_FDCWD, "/proc/self/fd/3", O_RDONLY) = 4</work/${safe}>`],
              [`1 openat2(3</>, "proc/self/status", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</proc/self/status>`],
              [`1 openat2(3</work>, "${"a/".repeat(2100)}f", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 ENAMETOOLONG`],
              [`1 openat(AT_FDCWD, "${"a/".repeat(2100)}f", O_RDONLY) = -1 ENAMETOOLONG`],
              [`1 openat(AT_FDCWD, "loop1", O_RDONLY) = 3</work/loop1>`]
            ]

            const trace = ObservedReads.read(() => cases[variant % cases.length]!, root)
            expect(trace).toBeDefined()
            return true
          }),
        { executions: fastExecutions, seed: 9201 }
      )
    )
    assertPassed(report)

    const root = "/work"
    const sha40 = "0123456789abcdef0123456789abcdef01234567"
    const makeBaseEntries = () =>
      new Map<string, FakeEntry>([
        [
          root,
          {
            kind: "dir",
            children: [
              "a.txt",
              "b.txt",
              "utf.txt",
              "hex.txt",
              "badhex.txt",
              "unreadable.txt",
              "empty",
              "sub",
              "data",
              "link-abs",
              "link-rel",
              "link-loop",
              "long"
            ]
          }
        ],
        [`${root}/a.txt`, { kind: "file", data: Buffer.from(`hello ${sha40.slice(0, 7)} world`) }],
        [`${root}/b.txt`, { kind: "file", data: Buffer.from(`full ${sha40} here`) }],
        [`${root}/utf.txt`, { kind: "file", data: Buffer.from("value café 日本") }],
        [`${root}/hex.txt`, { kind: "file", data: Buffer.from(`prefix${sha40.slice(0, 7)}f suffix`) }],
        [`${root}/badhex.txt`, { kind: "file", data: Buffer.from("no match here") }],
        [`${root}/unreadable.txt`, { kind: "file", data: Buffer.from("secret"), readErrorCode: "EACCES" }],
        [`${root}/empty`, { kind: "dir", children: [] }],
        [`${root}/sub`, { kind: "dir", children: ["child"] }],
        [`${root}/sub/child`, { kind: "file", data: Buffer.from("c") }],
        [`${root}/data`, { kind: "dir", children: ["d.txt"] }],
        [`${root}/data/d.txt`, { kind: "file", data: Buffer.from("data") }],
        [`${root}/link-abs`, { kind: "link", target: `${root}/a.txt` }],
        [`${root}/link-rel`, { kind: "link", target: "b.txt" }],
        [`${root}/link-loop`, { kind: "link", target: "link-loop" }],
        [`${root}/long`, { kind: "error", errorCode: "ENAMETOOLONG" }]
      ])

    const io = makeFakeIo(makeBaseEntries())
    const baseOpts = (customIo: ObservedReads.Io = io) => ({
      root,
      ignore: [] as ReadonlyArray<string>,
      startedMs: 0,
      io: customIo
    })

    const walkTrace = ObservedReads.read(
      () => [
        `1 openat2(3</work>, "../a.txt", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</work/a.txt>`,
        `1 openat2(3</work>, "link-abs", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 5</work/a.txt>`,
        `1 openat2(3</work>, "link-rel", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 6</work/b.txt>`,
        `1 openat2(3</work>, "missing-file", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 ENOENT`,
        `1 openat2(3</work>, "../out", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = -1 EXDEV`,
        `1 openat2(3</work>, "link-abs", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = -1 EXDEV`,
        `1 openat2(3</work>, "link-loop", {flags=O_RDONLY, resolve=RESOLVE_NO_SYMLINKS}, 24) = -1 ELOOP`,
        `1 openat2(3</work>, "link-loop", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 ELOOP`,
        `1 openat(AT_FDCWD, "a.txt", O_RDONLY) = 7</work/a.txt>`,
        `1 openat(AT_FDCWD, "b.txt", O_RDONLY) = 8</work/b.txt>`,
        `1 openat(AT_FDCWD, "utf.txt", O_RDONLY) = 9</work/utf.txt>`,
        `1 openat(AT_FDCWD, "hex.txt", O_RDONLY) = 10</work/hex.txt>`,
        `1 openat(AT_FDCWD, "badhex.txt", O_RDONLY) = 11</work/badhex.txt>`,
        `1 openat(AT_FDCWD, "data/d.txt", O_RDONLY) = 12</work/data/d.txt>`,
        `1 openat(AT_FDCWD, "empty", O_RDONLY|O_DIRECTORY) = 13</work/empty>`,
        `1 getdents64(13</work/empty>, 0x1, 1024) = 0`
      ],
      root
    )
    const obs1 = ObservedReads.record(walkTrace, {
      ...baseOpts(),
      variables: {
        text: "COMMIT UTF ASCII WIDE",
        values: {
          COMMIT: sha40,
          UTF: "café 日本",
          ASCII: "world",
          WIDE: "😀"
        },
        searchFirstAbove: 1,
        readAsData: ["data"],
        ignored: () => new Set<string>()
      }
    })
    expect(obs1).toBeDefined()

    const longTrace = ObservedReads.read(
      () => [`1 openat(AT_FDCWD, "long", O_RDONLY) = 3</work/long>`],
      root
    )
    expect("refusal" in ObservedReads.record(longTrace, baseOpts())).toBe(true)

    const mismatchWalk = ObservedReads.read(
      () => [`1 openat2(3</work>, "a.txt", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</work/b.txt>`],
      root
    )
    expect("refusal" in ObservedReads.record(mismatchWalk, baseOpts())).toBe(true)

    const procWalk = ObservedReads.read(
      () => [`1 openat2(3</>, "proc/self/status", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</proc/self/status>`],
      root
    )
    expect("refusal" in ObservedReads.record(procWalk, baseOpts())).toBe(true)

    const tooLongTrace = ObservedReads.read(
      () => [
        `1 openat2(3</work>, "${"x/".repeat(2100)}f", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 ENAMETOOLONG`,
        `1 openat(AT_FDCWD, "${"y/".repeat(2100)}f", O_RDONLY) = -1 ENAMETOOLONG`
      ],
      root
    )
    expect("refusal" in ObservedReads.record(tooLongTrace, baseOpts())).toBe(true)

    const brokenEntries = makeBaseEntries()
    brokenEntries.set(`${root}/bad-dir`, { kind: "dir", children: ["ghost"] })
    brokenEntries.set(`${root}/cant-list`, { kind: "dir", readErrorCode: "EACCES" })
    const brokenIo = makeFakeIo(brokenEntries)
    const badDirTrace = ObservedReads.read(
      () => [
        `1 openat(AT_FDCWD, "bad-dir", O_RDONLY|O_DIRECTORY) = 3</work/bad-dir>`,
        `1 getdents64(3</work/bad-dir>, 0x1, 1024) = 24`
      ],
      root
    )
    expect("refusal" in ObservedReads.record(badDirTrace, baseOpts(brokenIo))).toBe(true)

    const cantListTrace = ObservedReads.read(
      () => [
        `1 openat(AT_FDCWD, "cant-list", O_RDONLY|O_DIRECTORY) = 3</work/cant-list>`,
        `1 getdents64(3</work/cant-list>, 0x1, 1024) = 24`
      ],
      root
    )
    expect("refusal" in ObservedReads.record(cantListTrace, baseOpts(brokenIo))).toBe(true)

    const repTrace = ObservedReads.read(
      () => [
        `1 openat(AT_FDCWD, "sub/child", O_RDONLY) = 3</work/sub/child>`,
        `1 renameat(AT_FDCWD, "sub", AT_FDCWD, "sub2") = 0`
      ],
      root
    )
    expect(ObservedReads.record(repTrace, baseOpts())).toBeDefined()

    const verifyBody: Omit<ObservedReads.Record, "id"> = {
      reads: [["made.txt", "f:1:abc", "-"]],
      lists: [],
      from: [["//pkg:a", "id1"]],
      links: [["sub", 5, [], [["gone-child", 0]]]],
      made: ["made.txt"],
      left: true,
      kept: { archive: "a".repeat(64), gone: [], outside: [["/ext/file", "state1"]] }
    }
    const verifyRec: ObservedReads.Record = { ...verifyBody, id: ObservedReads.idOf(verifyBody) }
    expect(ObservedReads.outsideChanged(verifyRec, () => "state2")).toBe("/ext/file")
    expect(ObservedReads.outsideChanged(verifyRec, () => "state1")).toBeUndefined()

    const vEntries = makeBaseEntries()
    vEntries.set(`${root}/made.txt`, { kind: "file", data: Buffer.from("different") })
    const vIo = makeFakeIo(vEntries)
    const measureV = (p: string) => ObservedReads.measure(p, vIo)
    const vReason1 = ObservedReads.changed(
      verifyRec,
      root,
      measureV,
      vIo,
      () => new Set(),
      {},
      () => false,
      () => new Set(),
      () => new Set(["made.txt"])
    )
    expect(vReason1).toContain("is in the commit now")

    const linksBody: Omit<ObservedReads.Record, "id"> = {
      reads: [],
      lists: [],
      from: [["//pkg:a", "id1"]],
      links: [["sub", 99, [], [["missing-sub", 0]]]]
    }
    const linksRec: ObservedReads.Record = { ...linksBody, id: ObservedReads.idOf(linksBody) }
    expect(
      ObservedReads.changed(linksRec, root, measureV, vIo, () => new Set(["id1"]))
    ).toContain("subdirectory")

    const linksGoneBody: Omit<ObservedReads.Record, "id"> = {
      reads: [],
      lists: [],
      from: [["//pkg:a", "id1"]],
      links: [["sub", 2, [], [["missing-sub", 0]]]]
    }
    const linksGoneRec: ObservedReads.Record = { ...linksGoneBody, id: ObservedReads.idOf(linksGoneBody) }
    expect(
      ObservedReads.changed(linksGoneRec, root, measureV, vIo, () => undefined)
    ).toContain("is gone")

    await withTempDir("wave9b-obs-", async (dir) => {
      const fakeObs = NodePath.join(dir, "fake-obs")
      await writeExecutable(fakeObs, "#!/bin/sh\necho /bin/sh\nexit 0\n")
      expect(ObservedReads.askingRights(["/bin/sh"], fakeObs)).toEqual(["/bin/sh"])

      const badStrace = NodePath.join(dir, "bad-strace")
      await writeExecutable(badStrace, "#!/bin/sh\necho 'strace denied' >&2\nexit 1\n")
      const res1 = ObservedReads.observer({
        platform: "linux",
        executable: (name) => (name === "strace" ? badStrace : undefined)
      })
      expect("reason" in res1).toBe(true)
    })
  }, 60_000)

  it("Machine TurnFilesystem, holdPath, skippedPart, discard, homeTemplate, unmade, through", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      variant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 7 }))),
      name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(12)))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, name }) =>
          Effect.sync(() => {
            const safe = name.replace(/[^a-z0-9_-]/gi, "a") || "a"
            const heldDir = Machine.holding(`/tmp/ws-${safe}`, {})
            expect(heldDir.length).toBeGreaterThan(0)

            const longKept = `/tmp/${"a".repeat(120)}/${safe}`
            expect(Machine.holdPath(longKept, "linux").startsWith("\0smthrs-machines-")).toBe(true)
            expect(() => Machine.holdPath(longKept, "darwin")).toThrow()

            const baseEntries = new Map<string, FakeEntry>([
              ["/work", { kind: "dir", children: ["a"] }],
              ["/dst", { kind: "dir", children: [] }],
              ["/kept", { kind: "dir", children: [] }]
            ])
            const unm = Machine.unmade(
              {
                root: "/work",
                cacheDirectory: ".cache",
                held: undefined,
                kept: "/kept",
                links: [{ path: "lnk", target: "/dst" }]
              },
              undefined,
              makeFakeIo(baseEntries)
            )
            const st = unm.io.lstat(NodePath.join(Machine.named("/kept", "/work", "m").home, "lnk"))
            expect(st.isSymbolicLink()).toBe(true)
            expect(st.isFile()).toBe(false)
            expect(st.isDirectory()).toBe(false)
            expect(variant).toBeGreaterThanOrEqual(0)
            return true
          }),
        { executions: fastExecutions, seed: 9202 }
      )
    )
    assertPassed(report)

    await withTempDir("wave9b-mach-", async (dir) => {
      await expect(
        Machine.hold(dir, { [Machine.holdingVariable]: NodePath.join(dir, "node_modules", "m") }, () => {})
      ).rejects.toThrow()

      const sockPath = NodePath.join(dir, "hold.sock")
      const makeTurnFs = (overrides: Partial<Machine.TurnFilesystem>): Machine.TurnFilesystem => ({
        mkdir: Fs.mkdir,
        writeFile: Fs.writeFile,
        rename: Fs.rename,
        unlink: Fs.unlink,
        rmdir: Fs.rmdir,
        rm: Fs.rm,
        lstat: Fs.lstat,
        readdir: (p) => Fs.readdir(p),
        ...overrides
      })

      let renameAttempts = 0
      await expect(
        Machine.unstale(
          sockPath,
          undefined,
          "darwin",
          makeTurnFs({
            rename: async () => {
              renameAttempts += 1
              throw Object.assign(new Error("exists"), { code: "EEXIST" })
            },
            readdir: async () => ["not-a-valid-owner"]
          })
        )
      ).rejects.toThrow()
      expect(renameAttempts).toBeGreaterThan(0)

      let step = 0
      let lstatCount = 0
      await Machine.unstale(
        sockPath,
        undefined,
        "darwin",
        makeTurnFs({
          rename: async (src, dst) => {
            step += 1
            if (step === 1) throw Object.assign(new Error("enotdir"), { code: "ENOTDIR" })
            return Fs.rename(src, dst)
          },
          lstat: async () => {
            lstatCount += 1
            return {
              isFile: () => lstatCount === 1,
              isDirectory: () => lstatCount !== 1,
              mtimeMs: 0
            } as unknown as NodeFs.Stats
          },
          unlink: async (p) => {
            if (String(p).endsWith(".turn")) {
              throw Object.assign(new Error("eisdir"), { code: "EISDIR" })
            }
            return Fs.unlink(p)
          }
        })
      )

      await expect(
        Machine.unstale(
          sockPath,
          undefined,
          "darwin",
          makeTurnFs({
            rename: async () => {
              throw Object.assign(new Error("enotdir"), { code: "ENOTDIR" })
            },
            lstat: async () => ({ isFile: () => true, isDirectory: () => false, mtimeMs: 0 }) as unknown as NodeFs.Stats,
            unlink: async () => {
              throw Object.assign(new Error("eacces"), { code: "EACCES" })
            }
          })
        )
      ).rejects.toThrow()

      await expect(
        Machine.unstale(
          sockPath,
          undefined,
          "darwin",
          makeTurnFs({
            rename: async () => {
              throw Object.assign(new Error("eperm"), { code: "EPERM" })
            }
          })
        )
      ).rejects.toThrow()

      const ac = new AbortController()
      const holdEnv = { [Machine.holdingVariable]: NodePath.join(dir, "live-kept") }
      const first = await Machine.hold(dir, holdEnv, () => {})
      try {
        let waited = false
        setTimeout(() => ac.abort(new Error("aborted-wait")), 80)
        await expect(
          Machine.hold(
            dir,
            holdEnv,
            () => {
              waited = true
            },
            ac.signal
          )
        ).rejects.toThrow()
        expect(waited).toBe(true)
      } finally {
        await first.release()
      }

      const tpl = NodePath.join(dir, "home-tpl")
      await Fs.mkdir(tpl, { recursive: true })
      await Fs.writeFile(NodePath.join(tpl, ".profile"), "export X=1\n")
      const wsRoot = NodePath.join(dir, "ws-src")
      await Fs.mkdir(wsRoot, { recursive: true })
      const mach = Machine.named(NodePath.join(dir, "mkept"), wsRoot, "m1")
      await Machine.make({ machine: mach, root: wsRoot, cacheDirectory: ".cache", held: undefined, kept: NodePath.join(dir, "mkept"), homeTemplate: tpl, links: [] })
      expect(await Fs.readFile(NodePath.join(mach.home, ".profile"), "utf8")).toContain("X=1")

      const dTarget = NodePath.join(dir, "to-discard")
      await Fs.mkdir(dTarget, { recursive: true })
      await Machine.discard(dTarget)
      await Machine.discard(NodePath.join(dir, "missing-discard"))
    })
  }, 60_000)

  it("effect-resolution.js revision hooks, buildModuleUrl, and importDeclarationModule", async () => {
    await withTempDir("wave9b-effres-", async (dir) => {
      const subPath = NodePath.join(dir, "helper.ts")
      const modPath = NodePath.join(dir, "sample.ts")
      await Fs.writeFile(modPath, `export const value = 1\n`)
      const url = pathToFileURL(modPath).href
      expect(EffectRes.buildModuleUrl(url)).toBeTruthy()
      const loaded = await EffectRes.importDeclarationModule(
        url,
        import.meta.url,
        undefined,
        {
          changed: new Set([modPath, subPath]),
          texts: new Map([
            [subPath, `export const helper = 42\n`],
            [modPath, `import { helper } from "./helper.js"\nexport const value = helper\n`]
          ])
        }
      )
      expect((loaded as { readonly value: number }).value).toBe(42)

      // Missing changed file -> ERR_MODULE_NOT_FOUND
      const gonePath = NodePath.join(dir, "gone.ts")
      await Fs.writeFile(gonePath, `export const x = 1\n`)
      await expect(
        EffectRes.importDeclarationModule(
          pathToFileURL(gonePath).href,
          import.meta.url,
          undefined,
          { changed: new Set([gonePath]), texts: new Map() }
        )
      ).rejects.toThrow()
    })
  }, 60_000)
})
