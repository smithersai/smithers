import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fastExecutions = Math.max(20, Math.min(executions, 200))

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

describe("BuildCliWave9G ObservedReads deep parser, bytesHoldValue, openat2, emptyBefore, and keptStep", () => {
  it("ObservedReads remaining parser branches: /proc up, supervised, AF_PACKET, openat2 writes/errors, syscall_0x, unfollowed flags, clone states", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      variant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 15 }))),
      name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8)))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, name }) =>
          Effect.sync(() => {
            const safe = name.replace(/[^a-z0-9]/gi, "a") || "a"
            const root = "/work"
            const header = "1 +++ smthrs-observe 1 +++"
            const seal = "1 +++ complete +++"

            const traces: ReadonlyArray<ReadonlyArray<string>> = [
              // 0: /proc/self/.. -> link === "up" (L1779-1780)
              [`1 openat(AT_FDCWD, "/proc/self/..", O_RDONLY) = 3</proc>`],
              // 1: supervised mode /proc/self/fd/3 -> L1791
              [header, `1 openat(AT_FDCWD, "/proc/self/fd/3", O_RDONLY) = 4</work/${safe}>`, seal],
              // 2: supervised mode foreign pid -> outside process refusal
              [header, `1 openat(AT_FDCWD, "/proc/999999/cwd/a", O_RDONLY) = 4</work/a>`, seal],
              // 3: AF_PACKET socket family -> L1889
              [`1 connect(3<socket:[1]>, {sa_family=AF_PACKET, sll_protocol=htons(0x0003)}, 20) = 0`],
              // 4: openat2 unreadable path (L2052) + missing dirfd (L2059)
              [
                `1 openat2(3</work>, 0x7fff1234, {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 EFAULT`,
                `1 openat2(99, "${safe}", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</work/${safe}>`
              ],
              // 5: openat2 writes: O_WRONLY|O_TRUNC (emptied, L2093-2094) + O_WRONLY (changed, L2095-2096) + O_CREAT|O_EXCL EEXIST
              [
                `1 openat2(3</work>, "w1-${safe}", {flags=O_WRONLY|O_TRUNC, resolve=RESOLVE_IN_ROOT}, 24) = 4</work/w1-${safe}>`,
                `1 openat2(3</work>, "w2-${safe}", {flags=O_WRONLY, resolve=RESOLVE_IN_ROOT}, 24) = 5</work/w2-${safe}>`,
                `1 openat2(3</work>, "w3-${safe}", {flags=O_WRONLY|O_CREAT|O_EXCL, resolve=RESOLVE_IN_ROOT}, 24) = -1 EEXIST`
              ],
              // 6: syscall_0x known unfollowed syscall number (e.g. io_uring_setup = 0x1a9 = 425, open_by_handle_at = 0x130 = 304) -> L2108
              [
                `1 syscall_0x130(0, 0, 0) = -1 EPERM`,
                `1 syscall_0x1a9(0, 0) = -1 EPERM`
              ],
              // 7: unfollowed openat flag (e.g. O_PATH on openat or RESOLVE_CACHED) -> L2159
              [
                `1 openat2(3</work>, "${safe}", {flags=O_RDONLY, resolve=RESOLVE_CACHED}, 24) = -1 EAGAIN`,
                `1 openat(AT_FDCWD, "${safe}", O_RDONLY|O_TMPFILE, 0600) = 3</work/${safe}>`
              ],
              // 8: lockedBuild (cargo/go/tsc) + clone building/noting propagation (L2200, L2626, L2629)
              [
                `1 execve("/usr/bin/cargo", ["cargo", "build", "--locked"], []) = 0`,
                `1 clone(flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND) = 20`,
                `20 openat(AT_FDCWD, "target/${safe}", O_WRONLY|O_CREAT, 0644) = 3</work/target/${safe}>`
              ],
              // 9: lockedInstall execve in thread -> installed.add(pid) (L2255)
              [
                `1 clone(flags=CLONE_VM|CLONE_THREAD|CLONE_SIGHAND) = 30`,
                `30 execve("/usr/bin/npm", ["npm", "ci"], []) = 0`,
                `30 openat(AT_FDCWD, "node_modules/${safe}", O_WRONLY|O_CREAT, 0644) = 3</work/node_modules/${safe}>`
              ],
              // 10: /proc/self/fd/3 symlink loop >40 hops (L1814-1815)
              [
                `1 openat(AT_FDCWD, "/proc/self/fd/3", O_RDONLY) = 3</proc/self/fd/3>`,
                `1 openat(AT_FDCWD, "/proc/self/fd/3/sub", O_RDONLY) = 4</work/${safe}>`
              ],
              // 11: dual-stack IPv6 :: listening on port 9090, IPv4 127.0.0.1 connecting to 9090 (L2670)
              [
                `1 socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP) = 3<TCPv6:[100]>`,
                `1 bind(3<TCPv6:[100]>, {sa_family=AF_INET6, sin6_port=htons(9090), sin6_addr=inet_pton(AF_INET6, "::")}, 28) = 0`,
                `1 listen(3<TCPv6:[100]>, 128) = 0`,
                `1 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 4<TCP:[101]>`,
                `1 connect(4<TCP:[101]>, {sa_family=AF_INET, sin_port=htons(9090), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`
              ],
              // 12: rmdir / unlinkat AT_REMOVEDIR for removedEmpty -> emptyBefore (L4605-4621)
              [
                `1 unlinkat(AT_FDCWD, "empty-dir", AT_REMOVEDIR) = 0`,
                `1 openat(AT_FDCWD, "empty-dir", O_RDONLY|O_DIRECTORY) = -1 ENOENT`
              ],
              // 13: rename over made file + commit holding file
              [
                `1 openat(AT_FDCWD, "a.tmp", O_WRONLY|O_CREAT, 0644) = 3</work/a.tmp>`,
                `1 openat(AT_FDCWD, "b.out", O_WRONLY|O_CREAT, 0644) = 4</work/b.out>`,
                `1 renameat(AT_FDCWD, "a.tmp", AT_FDCWD, "b.out") = 0`
              ],
              // 14: openat2 walking nested sub/deep/../a.txt (depth > 0 -> L4352-4354)
              [
                `1 openat2(3</work>, "sub/deep/../a.txt", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 4</work/sub/a.txt>`
              ],
              // 15: utimensat touching metadata of file (L4544-4545)
              [
                `1 openat(AT_FDCWD, "a.txt", O_RDONLY) = 3</work/a.txt>`,
                `1 utimensat(AT_FDCWD, "a.txt", NULL, 0) = 0`
              ]
            ]

            const t = ObservedReads.read(() => traces[variant % traces.length]!, root)
            expect(t).toBeDefined()
            return true
          }),
        { executions: fastExecutions, seed: 9701 }
      )
    )
    assertPassed(report)

    // Deep observe() exercising:
    // - bytesHoldValue (L3616-3645): UTF-8 match, latin1 match, >0xff non-match, 40-hex full match, 7-hex short match, hex-adjacent non-match
    // - naming map (L4101-4103) + holding (L3895-3896) + toldBefore (L4702) + unreadable survivor (L4925)
    // - emptyBefore (L4605-4621) + knownEmpty dir listing (L4774) + renamedOver made (L4654-4655)
    // - openat2 nested ".." (L4352-4354) + replaced component during walk (L4358-4359) + tooLong walk & read (L4464, L4510)
    // - utimensat meta (L4544-4545)
    const root = "/work"
    const sha40 = "0123456789abcdef0123456789abcdef01234567"
    const entries = new Map<string, FakeEntry>([
      [
        root,
        {
          kind: "dir",
          children: [
            "src.ts",
            "out-short.txt",
            "out-full.txt",
            "out-utf.txt",
            "out-adj.txt",
            "out-none.txt",
            "out-unreadable.txt",
            "out-ascii.txt",
            "sub",
            "data",
            "renamed.out",
            "loop-a",
            "loop-b",
            "broken-link"
          ]
        }
      ],
      // File read by run that names variables BY_NAME and BY_VAL_VAR (populates naming map L4101-4103!)
      [`${root}/src.ts`, { kind: "file", data: Buffer.from("const a = process.env.BY_NAME; const b = process.env.BY_VAL_VAR;\n") }],
      // Files WRITTEN by run (survivors!) scanned by bytesHoldValue (L3616-3645, L4916-4929)
      [`${root}/out-short.txt`, { kind: "file", data: Buffer.from(`commit=${sha40.slice(0, 7)} end`) }],
      [`${root}/out-full.txt`, { kind: "file", data: Buffer.from(`commit=${sha40} end`) }],
      [`${root}/out-utf.txt`, { kind: "file", data: Buffer.from("hello café 日本 world") }],
      [`${root}/out-adj.txt`, { kind: "file", data: Buffer.from(`x${sha40.slice(0, 7)}a and b${sha40.slice(0, 7)}y`) }],
      [`${root}/out-none.txt`, { kind: "file", data: Buffer.from("plain text without any match whatsoever") }],
      [`${root}/out-ascii.txt`, { kind: "file", data: Buffer.from("has ASCII_SECRET_VAL inside") }],
      [`${root}/out-unreadable.txt`, { kind: "file", data: Buffer.from("secret"), readErrorCode: "EACCES" }],
      [`${root}/sub`, { kind: "dir", children: ["deep", "a.txt"] }],
      [`${root}/sub/deep`, { kind: "dir", children: [] }],
      [`${root}/sub/a.txt`, { kind: "file", data: Buffer.from("a") }],
      [`${root}/data`, { kind: "dir", children: ["d.txt"] }],
      [`${root}/data/d.txt`, { kind: "file", data: Buffer.from("BY_NAME in data") }],
      [`${root}/renamed.out`, { kind: "file", data: Buffer.from("r") }],
      [`${root}/loop-a`, { kind: "link", target: "loop-b" }],
      [`${root}/loop-b`, { kind: "link", target: "loop-a" }],
      [`${root}/broken-link`, { kind: "link", target: "missing-target" }]
    ])
    const io = makeFakeIo(entries)

    // Trace 1: full variable scan (bytesHoldValue all arms + naming + toldBefore + readAsData)
    const varTrace = ObservedReads.read(
      () => [
        `1 openat(AT_FDCWD, "src.ts", O_RDONLY) = 3</work/src.ts>`,
        `1 openat(AT_FDCWD, "data/d.txt", O_RDONLY) = 4</work/data/d.txt>`,
        `1 openat(AT_FDCWD, "out-short.txt", O_WRONLY|O_CREAT, 0644) = 5</work/out-short.txt>`,
        `1 openat(AT_FDCWD, "out-full.txt", O_WRONLY|O_CREAT, 0644) = 6</work/out-full.txt>`,
        `1 openat(AT_FDCWD, "out-utf.txt", O_WRONLY|O_CREAT, 0644) = 7</work/out-utf.txt>`,
        `1 openat(AT_FDCWD, "out-adj.txt", O_WRONLY|O_CREAT, 0644) = 8</work/out-adj.txt>`,
        `1 openat(AT_FDCWD, "out-none.txt", O_WRONLY|O_CREAT, 0644) = 9</work/out-none.txt>`,
        `1 openat(AT_FDCWD, "out-ascii.txt", O_WRONLY|O_CREAT, 0644) = 10</work/out-ascii.txt>`,
        `1 openat2(3</work>, "sub/deep/../a.txt", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 11</work/sub/a.txt>`,
        `1 utimensat(AT_FDCWD, "sub/a.txt", NULL, 0) = 0`
      ],
      root
    )
    const obsVar = ObservedReads.observe(varTrace, {
      root,
      ignore: [],
      startedMs: 0,
      io,
      variables: {
        text: "",
        shown: new Set<string>(),
        byValue: ["BY_VAL_VAR"],
        readAsData: ["data"],
        searchFirstAbove: 1,
        ignored: () => new Set<string>(),
        values: {
          BY_NAME: "short",
          BY_VAL_VAR: "ASCII_SECRET_VAL",
          COMMIT_SHORT: sha40,
          COMMIT_FULL: "abcdef0123456789abcdef0123456789abcdef01",
          UTF_VAL: "café 日本",
          WIDE_MISS: "😀😁😂😃😄😅",
          NO_MATCH: "zzzzzzzzzzzz"
        }
      }
    })
    expect("refusal" in obsVar).toBe(false)

    // Trace 2: unreadable survivor triggers L4925 fallback (adds all sought names)
    const unregTrace = ObservedReads.read(
      () => [`1 openat(AT_FDCWD, "out-unreadable.txt", O_WRONLY|O_CREAT, 0644) = 5</work/out-unreadable.txt>`],
      root
    )
    const obsUnreg = ObservedReads.observe(unregTrace, {
      root,
      ignore: [],
      startedMs: 0,
      io,
      variables: {
        text: "",
        values: { SECRET_X: "longer-than-min-val" },
        ignored: () => new Set<string>()
      }
    })
    expect("refusal" in obsUnreg).toBe(false)

    // Trace 3: emptyBefore (rmdir on empty-dir) + renamedOver made file + commit holding file
    const emptyTrace = ObservedReads.read(
      () => [
        `1 unlinkat(AT_FDCWD, "removed-empty", AT_REMOVEDIR) = 0`,
        `1 openat(AT_FDCWD, "tmp.f", O_WRONLY|O_CREAT, 0644) = 3</work/tmp.f>`,
        `1 openat(AT_FDCWD, "renamed.out", O_WRONLY|O_CREAT, 0644) = 4</work/renamed.out>`,
        `1 renameat(AT_FDCWD, "tmp.f", AT_FDCWD, "renamed.out") = 0`
      ],
      root
    )
    const obsEmpty = ObservedReads.observe(emptyTrace, {
      root,
      ignore: [],
      startedMs: 0,
      io,
      held: () => new Set(["renamed.out"])
    })
    expect(obsEmpty).toBeDefined()

    // Trace 4: replaced component during openat2 walk (L4358-4359) & regular path (L4229-4230)
    const repWalkTrace = ObservedReads.read(
      () => [
        `1 openat2(3</work>, "sub/deep/x", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 ENOENT`,
        `1 renameat(AT_FDCWD, "sub/deep", AT_FDCWD, "sub/deep2") = 0`
      ],
      root
    )
    expect(ObservedReads.observe(repWalkTrace, { root, ignore: [], startedMs: 0, io })).toBeDefined()

    // Trace 5: listed directory containing symlink loop & broken link (hits L3276, L3286-3289, L4822!)
    const loopListTrace = ObservedReads.read(
      () => [
        `1 openat(AT_FDCWD, ".", O_RDONLY|O_DIRECTORY) = 3</work>`,
        `1 getdents64(3</work>, 0x1, 1024) = 128`
      ],
      root
    )
    expect(ObservedReads.observe(loopListTrace, { root, ignore: [], startedMs: 0, io })).toBeDefined()

    // Trace 6: unrecordedStep flush + observer guard refusal (L531) + keptStep readError (L2919)
    expect(await ObservedReads.unrecordedStep("//pkg:t").flush()).toBe(true)
    await withTempDir("wave9g-obs-", async (dir) => {
      const okStrace = NodePath.join(dir, "ok-strace")
      await writeExecutable(okStrace, "#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in *bad-guard*) echo \"guard failed\" >&2; exit 1;; esac; done\nexit 0\n")
      const badGuard = NodePath.join(dir, "bad-guard")
      await writeExecutable(badGuard, "#!/bin/sh\necho 'guard failed' >&2\nexit 1\n")
      const resGuard = ObservedReads.observer({
        platform: "linux",
        executable: (n) => (n === "strace" ? okStrace : undefined),
        guard: badGuard
      })
      expect("reason" in resGuard).toBe(true)

      // servedBy with replaced/missing trace file -> readError (L2919) & TraceRangeError (L5696)
      const srvRes = ObservedReads.servedBy(() => { throw Object.assign(new Error("boom"), { code: "EIO" }) }, () => [], root)
      expect(srvRes).toBeDefined()
    })
  }, 60_000)
})
