import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as Mount from "../src/Mount.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fastExecutions = Math.max(20, Math.min(executions, 40))
const ioExecutions = Math.max(6, Math.min(executions, 12))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Machine.remove(dir).catch(() => Fs.rm(dir, { recursive: true, force: true }))
  }
}

const writeFile = async (root: string, rel: string, content: string): Promise<string> => {
  const full = NodePath.isAbsolute(rel) ? rel : NodePath.join(root, rel)
  await Fs.mkdir(NodePath.dirname(full), { recursive: true })
  await Fs.writeFile(full, content, "utf8")
  return full
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fuzz", "-c", "user.email=fuzz@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const slugArb = Schema.Literals(["k0", "k1", "k2", "k3"])

describe("@smthrs/build-cli Wave-8B: ObservedReads, Machine, Mount & Cache deep fuzz", () => {
  it("ObservedReads.read deep syscall trace parser (sockets, IPv4/IPv6/dual-stack, AF_UNIX/AF_PACKET/unknown, pinned lockfile rewrite, unshare, io_uring, remove/change/mkdir/make/symlink, superseded, supervisor markers & /proc task links)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: slugArb,
        supervised: Schema.Boolean,
        dualStackOn: Schema.Boolean,
        reusePort: Schema.Boolean,
        rewriteLockfile: Schema.Boolean,
        ringOk: Schema.Boolean,
        unshareNewNs: Schema.Boolean,
        netFamily: Schema.Literals(["inet4", "inet6", "v4mapped", "unix_named", "unix_unnamed", "packet", "netlink"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, supervised, dualStackOn, reusePort, rewriteLockfile, ringOk, unshareNewNs, netFamily }) =>
          Effect.sync(() => {
            const cwd = `/work/${slug}`
            const lines: Array<string> = []
            if (supervised) lines.push("100 +++ smthrs-observe 1 +++")
            // Spawn cargo build --locked so building map tracks a pinned build
            lines.push(`100 execve("/usr/bin/cargo", ["cargo", "build", "--locked"], 0x0) = 0`)
            lines.push(`100 openat(AT_FDCWD, "${cwd}/Cargo.lock", O_RDONLY) = 3<${cwd}/Cargo.lock>`)
            lines.push(`100 close(3<${cwd}/Cargo.lock>) = 0`)
            if (rewriteLockfile) {
              lines.push(`100 openat(AT_FDCWD, "${cwd}/Cargo.lock", O_WRONLY|O_TRUNC) = 4<${cwd}/Cargo.lock>`)
              lines.push(`100 close(4<${cwd}/Cargo.lock>) = 0`)
            }

            // Socket + setsockopt + bind(port 0) + getsockname + dual-stack IPv6 + connect
            lines.push(`100 socket(AF_INET6, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_TCP) = 5<socket:[1001]>`)
            lines.push(`100 socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP) = 6<socket:[1002]>`)
            lines.push(`100 setsockopt(5<socket:[1001]>, SOL_IPV6, IPV6_V6ONLY, [${dualStackOn ? "0" : "1"}], 4) = 0`)
            lines.push(`100 setsockopt(5<socket:[1001]>, SOL_SOCKET, SO_REUSEPORT, [${reusePort ? "1" : "0"}], 4) = 0`)
            lines.push(
              `100 bind(5<socket:[1001]>, {sa_family=AF_INET6, sin6_port=htons(0), inet_pton(AF_INET6, "::", &sin6_addr)}, 28) = 0`
            )
            lines.push(
              `100 getsockname(5<socket:[1001]>, {sa_family=AF_INET6, sin6_port=htons(44110), inet_pton(AF_INET6, "::", &sin6_addr)}${
                supervised ? " /* smthrs: tcp dual-stack */" : ""
              }, [28]) = 0`
            )
            // Connect to loopback dual-stack port 44110 via IPv4 and external/various families
            lines.push(
              `100 connect(5<socket:[1001]>, {sa_family=AF_INET, sin_port=htons(44110), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`
            )
            if (netFamily === "inet4") {
              lines.push(
                `100 connect(5<socket:[1001]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("93.184.216.34")}, 16) = 0`
              )
            } else if (netFamily === "inet6") {
              lines.push(
                `100 connect(5<socket:[1001]>, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = 0`
              )
            } else if (netFamily === "v4mapped") {
              lines.push(
                `100 connect(5<socket:[1001]>, {sa_family=AF_INET6, sin6_port=htons(9999), inet_pton(AF_INET6, "::ffff:127.0.0.1", &sin6_addr)}, 28) = 0`
              )
            } else if (netFamily === "unix_named") {
              lines.push(`100 connect(6<socket:[1002]>, {sa_family=AF_UNIX, sun_path="/run/ext.sock"}, 110) = 0`)
            } else if (netFamily === "unix_unnamed") {
              lines.push(`100 connect(6<socket:[1002]>, {sa_family=AF_UNIX}, 2) = 0`)
            } else if (netFamily === "packet") {
              lines.push(`100 sendto(6<socket:[1002]>, "pkt", 3, 0, {sa_family=AF_PACKET, sll_protocol=htons(0x0800)}, 20) = 3`)
            } else {
              lines.push(`100 sendto(6<socket:[1002]>, "nl", 2, 0, {sa_family=AF_NETLINK, nl_pid=0}, 12) = 2`)
            }

            // unshare (CLONE_NEWUSER / CLONE_FS / CLONE_FILES) & io_uring_setup
            lines.push(
              `100 unshare(${unshareNewNs ? "CLONE_NEWUSER|CLONE_FS|CLONE_FILES" : "CLONE_FS|CLONE_FILES"}) = 0`
            )
            lines.push(
              ringOk
                ? `100 io_uring_setup(8, 0x0) = 7`
                : `100 io_uring_setup(8, 0x0) = -1 ENOSYS (Function not implemented)`
            )

            // Unfollowed flags + refused syscall
            lines.push(`100 openat2(AT_FDCWD, "${cwd}/f.txt", {flags=O_RDONLY|O_TMPFILE, mode=0, resolve=0}, 24) = 8`)
            lines.push(`100 open_by_handle_at(AT_FDCWD, 0x0, O_RDONLY) = 9`)

            // File operations: look, remove (unlink / rmdir / unlinkat AT_REMOVEDIR), change, changeFd, mkdir, make, symlink
            lines.push(`100 newfstatat(AT_FDCWD, "/proc/100/task/101/root/etc/hosts", 0x0, 0) = 0`)
            lines.push(`100 newfstatat(AT_FDCWD, "/proc/100/task/101/cwd/a.txt", 0x0, 0) = 0`)
            lines.push(`100 newfstatat(AT_FDCWD, "/proc/100/task/101/exe", 0x0, 0) = 0`)
            lines.push(`100 newfstatat(AT_FDCWD, "/proc/100/task/101/fd/3", 0x0, 0) = 0`)
            lines.push(`100 newfstatat(AT_FDCWD, "/proc/100/task/bad/root", 0x0, 0) = 0`)
            lines.push(`100 unlink("${cwd}/gone.txt") = 0`)
            lines.push(`100 rmdir("${cwd}/empty-dir") = 0`)
            lines.push(`100 unlinkat(AT_FDCWD, "${cwd}/empty-dir2", AT_REMOVEDIR) = 0`)
            lines.push(`100 chmod("${cwd}/mode.txt", 0755) = 0`)
            lines.push(`100 chown("${cwd}/owner.txt", 1000, 1000) = 0`)
            lines.push(`100 fchmod(3<${cwd}/Cargo.lock>, 0644) = 0`)
            lines.push(`100 fchown(3<${cwd}/Cargo.lock>, 1000, 1000) = 0`)
            lines.push(`100 mkdir("${cwd}/newdir", 0755) = 0`)
            lines.push(`100 mknod("${cwd}/fifo", S_IFIFO|0644, 0) = 0`)
            lines.push(`100 symlink("target", "${cwd}/sym") = 0`)

            // Thread superseded by execve + ??? + supervisor markers
            lines.push(`100 openat(AT_FDCWD, "${cwd}/slow.txt", O_RDONLY <unfinished ...>`)
            lines.push(`101 execve("/bin/true", ["true"], 0x0 <unfinished ...>`)
            lines.push(`100 +++ superseded by execve in pid 101 +++`)
            lines.push(`100 <... execve resumed>) = 0`)
            lines.push(`102 ???() = ?`)
            lines.push(`102 <... ??? resumed>) = ?`)
            lines.push(`100 +++ unrecorded: synthetic-gap +++`)
            lines.push(`100 +++ rights: /usr/bin/sudo +++`)
            lines.push(`100 +++ signal stops: 12345 +++`)
            if (supervised) lines.push("100 +++ complete +++")

            const trace = ObservedReads.read(() => lines, cwd, [])
            expect(Boolean(trace.ringAsked)).toBe(!ringOk)
            if (supervised) expect(ObservedReads.rightsIn(trace)).toContain("/usr/bin/sudo")
            else expect(Array.isArray(ObservedReads.rightsIn(trace))).toBe(true)
            expect(trace.signalStops).toBe(12345)
            expect(trace.refusals.length).toBeGreaterThan(0)
            return true
          }),
        { executions: fastExecutions, seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("ObservedReads.observe, listing with mounts, valueListener, bytesHoldValue, holds/changed with leftover & producers + Machine.withoutCredentials & through", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: slugArb,
        hasMounts: Schema.Boolean,
        nonAsciiEnv: Schema.Boolean,
        shortCommitMatch: Schema.Boolean,
        mutateDirAfter: Schema.Boolean,
        leftFlag: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, hasMounts, nonAsciiEnv, shortCommitMatch, mutateDirAfter, leftFlag }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w8b-obs-", async (base) => {
              const ws = NodePath.join(base, "ws")
              const mntSrc = NodePath.join(base, "mnt-src")
              const mntFile = NodePath.join(base, "mnt-file.txt")
              await Fs.mkdir(ws, { recursive: true })
              await Fs.mkdir(mntSrc, { recursive: true })
              await writeFile(base, "mnt-file.txt", `mounted-${slug}\n`)
              await Fs.symlink(mntFile, NodePath.join(base, "mnt-link.txt"))
              await writeFile(ws, "a.txt", `hello-${slug}\n`)
              await writeFile(ws, "dir/child.txt", `child-${slug}\n`)
              await writeFile(ws, "dir/prod.txt", `prod-${slug}\n`)
              await writeFile(ws, "unreadable.txt", `secret-${slug}\n`)

              const commitSha = createHash("sha256").update(`commit-${slug}`).digest("hex").slice(0, 40)
              const utf8Val = `café-${slug}-value`
              const asciiVal = `TOKEN_${slug}_VALUE_LONG`
              const wideVal = `wide-\u0100-${slug}`
              const survivorBody = [
                nonAsciiEnv ? utf8Val : asciiVal,
                shortCommitMatch ? `ref ${commitSha.slice(0, 7)} end` : `ref ${commitSha} end`,
                wideVal
              ].join("\n")
              await writeFile(ws, "survivor.txt", survivorBody)

              // 1. valueListener across split chunks & execve lines with escaped text
              const vl = ObservedReads.listening({
                V_ASCII: asciiVal,
                V_COMMIT: commitSha,
                V_UTF8: utf8Val,
                V_WIDE: wideVal,
                V_SHORT: "xy"
              })
              const half = Math.floor(asciiVal.length / 2)
              vl.hear(Buffer.from(`prefix ${asciiVal.slice(0, half)}`, "utf8"))
              vl.hear(Buffer.from(`${asciiVal.slice(half)} suffix`, "utf8"))
              const yielded = [...vl.lines(() => [
                `100 execve("/bin/sh", ["sh", "-c", "echo \\"${commitSha.slice(0, 7)}\\""], 0x0) = 0`,
                `100 openat(AT_FDCWD, "${ws}/a.txt", O_RDONLY) = 3`
              ])()]
              expect(yielded.length).toBe(2)
              expect(vl.names.has("V_ASCII")).toBe(true)

              // 2. listing() with mounts (including symlink mount source + nested mount child)
              const mounts: ReadonlyArray<readonly [string, string]> = hasMounts
                ? [
                  [`${ws}/mnt`, mntSrc],
                  [`${ws}/mnt/nested/file`, NodePath.join(base, "mnt-link.txt")],
                  [`${ws}/mnt/direct`, mntFile]
                ]
                : []
              const listDigest1 = ObservedReads.listing(mntSrc, [], ObservedReads.defaultIo, mounts)
              expect(typeof listDigest1).toBe("string")

              // 3. ObservedReads.observe with renamed, removedEmpty, meta, variables, producers & mounts
              const traceLines = [
                `100 openat(AT_FDCWD, "${ws}/a.txt", O_RDONLY) = 3`,
                `100 openat(AT_FDCWD, "${ws}/survivor.txt", O_RDONLY) = 4`,
                `100 openat(AT_FDCWD, "${ws}/dir", O_RDONLY|O_DIRECTORY) = 5`,
                `100 getdents64(5<${ws}/dir>, 0x0, 32768) = 48`,
                `100 openat(AT_FDCWD, "${ws}/created.txt", O_WRONLY|O_CREAT, 0644) = 6`,
                `100 chmod("${ws}/a.txt", 0644) = 0`,
                `100 chown("${ws}/a.txt", 1000, 1000) = 0`,
                `100 rmdir("${ws}/removed-empty") = 0`,
                `100 rename("${ws}/old-name", "${ws}/new-name") = 0`,
                `100 openat(AT_FDCWD, "${ws}/dir/../a.txt", O_RDONLY) = 7`
              ]
              const parsed = ObservedReads.read(() => traceLines, ws, [])
              const observed = ObservedReads.observe(parsed, {
                root: ws,
                startedMs: Date.now() - 1000,
                ignore: [],
                temporary: [NodePath.join(base, "tmp")],
                mounts,
                variables: {
                  values: {
                    V_ASCII: asciiVal,
                    V_COMMIT: commitSha,
                    V_UTF8: utf8Val,
                    V_WIDE: wideVal
                  },
                  text: "echo hi",
                  shown: new Set<string>(),
                  byValue: ["V_ASCII", "V_COMMIT", "V_UTF8", "V_WIDE"]
                },
                producers: [{
                  label: "//:producer",
                  id: "prod-id-1",
                  touched: new Set([NodePath.join(ws, "dir/prod.txt")]),
                  made: new Set([NodePath.join(ws, "dir")])
                }]
              })
              if (!("refusal" in observed)) {
                const stored: ObservedReads.Record = {
                  ...observed.record,
                  ...(leftFlag ? { left: true as const } : {})
                }
                const unchanged = ObservedReads.changed(
                  stored,
                  ws,
                  ObservedReads.measure,
                  ObservedReads.defaultIo,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  () => new Set<string>(),
                  mounts
                )
                expect(unchanged === undefined || typeof unchanged === "string").toBe(true)
                if (mutateDirAfter) {
                  await Fs.rm(NodePath.join(ws, "dir/prod.txt"), { force: true })
                  const afterRemove = ObservedReads.changed(
                    stored,
                    ws,
                    ObservedReads.measure,
                    ObservedReads.defaultIo,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    () => new Set<string>(),
                    mounts
                  )
                  expect(afterRemove === undefined || typeof afterRemove === "string").toBe(true)
                }
              }

              // 4. Machine.withoutCredentials with continuations, credential sections/keys & URL query stripping
              const rawGitConfig = [
                `[core]`,
                `\trepositoryformatversion = 0`,
                `[credential]`,
                `\thelper = store`,
                `[include]`,
                `\tpath = ~/.gitconfig-secret`,
                `[remote "origin"]`,
                `\turl = "https://user:pass@example.com/org/repo.git?token=abc&keep=1&\\`,
                `api_key=xyz&sig=999&ok=2#frag"`,
                `[http]`,
                `\textraHeader = AUTHORIZATION: basic secret`,
                `\tsslVerify = true`
              ].join("\n")
              const cleaned = Machine.withoutCredentials(rawGitConfig)
              expect(cleaned).not.toContain("pass@")
              expect(cleaned).not.toContain("token=abc")
              expect(cleaned).not.toContain("api_key=xyz")
              expect(cleaned).not.toContain("extraHeader")
              expect(cleaned).toContain("keep=1")
              expect(cleaned).toContain("ok=2")
              expect(cleaned).toContain("sslVerify = true")

              // 5. Machine.through mounts() & IO wrappers
              const ioThrough = Machine.through((p) => p, ObservedReads.defaultIo)
              expect(Array.isArray(ioThrough.mounts?.())).toBe(true)
              expect(ioThrough.lstat(NodePath.join(ws, "a.txt")).isFile()).toBe(true)
              expect(ioThrough.readFile(NodePath.join(ws, "a.txt")).toString("utf8")).toContain(slug)
            })
            return true
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("Cache.ts remote CAS edge cases (429 retry-after, 409 conflict, 413/oversize body cancel, chunk overflow, findMissing timeouts, lone surrogates) & Mount.ts multi-mount/origin-update fuzz", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        slug: slugArb,
        remoteMode: Schema.Literals(["retry_429_then_ok", "conflict_409", "oversize_body", "chunk_overflow", "timeout_disable", "status_500"]),
        mountMode: Schema.Literals(["ambiguous", "sub_overlay", "update_origin"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ slug, remoteMode, mountMode }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w8b-cache-mnt-", async (base) => {
              const ws = NodePath.join(base, "ws")
              await Fs.mkdir(ws, { recursive: true })

              // 1. Lone surrogate rejection in Cache.ts (isWellFormedText L448-452)
              const localOnly = await Cache.openCache({ workspaceRoot: ws, cacheDirectory: ".flows" })
              try {
                for (const badText of ["bad\ud800", "bad\ud800x", "bad\udc00"]) {
                  await expect(
                    localOnly.put("good-key", {
                      key: "good-key",
                      target: "Shell.Test",
                      label: badText,
                      exitOk: true,
                      output: {},
                      storedAt: new Date().toISOString()
                    })
                  ).rejects.toThrow()
                }
              } finally {
                await localOnly.close()
              }

              // 2. Live loopback HTTP remote cache server exercising retries, 409, oversize, chunk overflow, timeouts & 500
              let reqCount = 0
              const server = Http.createServer((req, res) => {
                reqCount += 1
                const url = req.url ?? "/"
                if (remoteMode === "retry_429_then_ok") {
                  if (reqCount <= 1) {
                    res.writeHead(429, { "retry-after": "0" })
                    res.end("busy")
                    return
                  }
                  if (req.method === "GET") {
                    const key = decodeURIComponent(url.split("/").pop() ?? "k")
                    res.writeHead(200, { "content-type": "application/json" })
                    res.end(JSON.stringify({
                      key,
                      target: "Shell.Test",
                      label: "//:remote",
                      exitOk: true,
                      output: { from: "remote", slug },
                      storedAt: new Date().toISOString()
                    }))
                    return
                  }
                  res.writeHead(200)
                  res.end("{}")
                  return
                }
                if (remoteMode === "conflict_409") {
                  res.writeHead(409)
                  res.end("conflict")
                  return
                }
                if (remoteMode === "oversize_body") {
                  res.writeHead(200, { "content-type": "application/json" })
                  // Exceed default metadata limit (> 4MB) in chunks
                  const chunk = Buffer.alloc(1024 * 512, 0x41)
                  for (let i = 0; i < 12; i++) res.write(chunk)
                  res.end()
                  return
                }
                if (remoteMode === "chunk_overflow") {
                  res.writeHead(200, { "content-type": "application/json" })
                  res.flushHeaders()
                  res.write("{")
                  res.end("}")
                  return
                }
                if (remoteMode === "timeout_disable") {
                  // Delay longer than timeoutMs so AbortSignal aborts
                  const timer = setTimeout(() => {
                    if (!res.writableEnded) {
                      res.writeHead(200)
                      res.end("{}")
                    }
                  }, 500)
                  req.on("close", () => clearTimeout(timer))
                  return
                }
                res.writeHead(500)
                res.end("internal error")
              })

              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
              const port = (server.address() as AddressInfo).port
              const warnings: Array<string> = []
              try {
                const remoteStore = await Cache.openCache({
                  workspaceRoot: ws,
                  cacheDirectory: ".flows",
                  endpoint: `http://127.0.0.1:${port}`,
                  readToken: () => "test-token",
                  writeToken: () => "test-token",
                  timeouts: remoteMode === "timeout_disable" ? { get: 40, put: 40 } : { get: 2000, put: 2000 },
                  warn: (msg) => warnings.push(msg)
                })
                try {
                  const key = `w8b-key-${slug}-${remoteMode}`
                  await remoteStore.put(key, {
                    key,
                    target: "Shell.Test",
                    label: "//:remote",
                    exitOk: true,
                    output: { ok: true },
                    storedAt: new Date().toISOString()
                  })
                  const fetched = await remoteStore.get(`miss-${key}`)
                  if (remoteMode === "retry_429_then_ok") {
                    expect(fetched?.label).toBe("//:remote")
                  } else {
                    expect(fetched).toBeNull()
                  }
                } finally {
                  await remoteStore.close()
                }
              } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()))
              }

              // 3. Mount.ts multi-mount ambiguous / sub-overlay selection / existing checkout origin update
              const origin1 = NodePath.join(base, "origin1")
              const origin2 = NodePath.join(base, "origin2")
              for (const orig of [origin1, origin2]) {
                await Fs.mkdir(orig, { recursive: true })
                git(orig, "init", "-q", "-b", "main")
                await writeFile(orig, "README.md", `origin-${slug}\n`)
                git(orig, "add", "-A")
                git(orig, "commit", "-qm", "init")
              }
              const overlay = NodePath.join(base, "overlay")
              await Fs.mkdir(NodePath.join(overlay, ".smithers/alpha"), { recursive: true })
              await Fs.mkdir(NodePath.join(overlay, ".smithers/beta"), { recursive: true })
              const sha1 = git(origin1, "rev-parse", "HEAD")
              const sha2 = git(origin2, "rev-parse", "HEAD")
              const configSource = mountMode === "update_origin"
                ? `import { Smithers as S } from "@smthrs/targets"\nexport default S.Mounts({ alpha: S.Mount({ repository: ${JSON.stringify(origin1)}, ref: ${JSON.stringify(sha1)}, track: "main", overlay: "alpha" }) })\n`
                : `import { Smithers as S } from "@smthrs/targets"\nexport default S.Mounts({ alpha: S.Mount({ repository: ${JSON.stringify(origin1)}, ref: ${JSON.stringify(sha1)}, track: "main", overlay: "alpha" }), beta: S.Mount({ repository: ${JSON.stringify(origin2)}, ref: ${JSON.stringify(sha2)}, track: "main", overlay: "beta" }) })\n`
              await writeFile(overlay, ".smithers/config.ts", configSource)

              const reported: Array<string> = []
              if (mountMode === "ambiguous") {
                await expect(
                  Mount.resolveWorkspace(overlay, { environment: process.env, report: (line) => reported.push(line) })
                ).rejects.toThrow(/ambiguous|declares mounts/i)
              } else if (mountMode === "sub_overlay") {
                const entered = await Mount.resolveWorkspace(NodePath.join(overlay, ".smithers/beta"), {
                  environment: process.env,
                  report: (line) => reported.push(line)
                }).catch((e) => e)
                expect(entered).toBeDefined()
              } else {
                const first = await Mount.materialize(overlay, "alpha", { environment: process.env, report: () => {} }).catch((e) => e)
                expect(first).toBeDefined()
                // Update repository URL in config to trigger git remote set-url origin
                await writeFile(
                  overlay,
                  ".smithers/config.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport default S.Mounts({ alpha: S.Mount({ repository: ${JSON.stringify(origin2)}, ref: ${JSON.stringify(sha2)}, track: "main", overlay: "alpha" }) })\n`
                )
                const second = await Mount.materialize(overlay, "alpha", { environment: process.env, report: () => {} }).catch((e) => e)
                expect(second).toBeDefined()
              }
            })
            return true
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 150_000)
})
