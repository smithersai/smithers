import { describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const root = "/workspace"
const localPort = 31200
const read = (lines: ReadonlyArray<string>) => ObservedReads.read(() => lines, root)
const v4 = (host: string, port = localPort) =>
  `{sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}`
const v6 = (host: string, port = localPort) =>
  `{sa_family=AF_INET6, sin6_port=htons(${port}), inet_pton(AF_INET6, "${host}", &sin6_addr)}`
const bind = (endpoint: string) => `100 bind(3<socket:[8]>, ${endpoint}, 28) = 0`
const connect = (endpoint: string, fd = "4<socket:[9]>") => `100 connect(${fd}, ${endpoint}, 28) = 0`
const stream = (family: string, fd: string) => `100 socket(${family}, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_IP) = ${fd}`
const server = stream("AF_INET6", "3<socket:[8]>")
const client = stream("AF_INET", "4<socket:[9]>")
const option = (value: number, result = "0") =>
  `100 setsockopt(3<socket:[8]>, SOL_IPV6, IPV6_V6ONLY, [${value}], 4) = ${result}`
const outside = [`it reached a program outside the run on local port ${localPort}`]

describe("trace socket endpoints", () => {
  it("uses a proven dual-stack TCP wildcard for both address families", () => {
    expect(read([server, option(0), bind(v6("::")), client, connect(v6("::")), connect(v4("0.0.0.0"))]).outside)
      .toEqual([])
    const actual = `100 getsockname(3<socket:[8]>, ${v6("::")}, [28]) = 0`
    const explicit = option(0).replace("SOL_IPV6", "IPPROTO_IPV6")
    expect(read([server, explicit, bind(v6("::", 0)), actual, client, connect(v4("127.0.0.1"))]).outside)
      .toEqual([])
  })

  it("uses IPv4 identity for mapped IPv6 addresses", () => {
    const mapped = connect(v6("::ffff:127.0.0.1"))
    const mappedClient = stream("AF_INET6", "4<socket:[9]>")
    expect(read([bind(v4("127.0.0.1")), mapped]).outside).toEqual([])
    expect(read([bind(v4("127.0.0.2")), mapped]).outside).toEqual(outside)
    expect(read([server, option(1), bind(v6("::")), mappedClient, mapped]).outside).toEqual(outside)
    expect(read([server, option(0), bind(v6("::")), mappedClient, mapped]).outside).toEqual([])
  })

  it("requires a known TCP client and a successful dual-stack option", () => {
    const ipv4 = connect(v4("0.0.0.0"))
    for (
      const trace of [
        [server, option(0), bind(v6("::")), ipv4],
        [server, option(0), bind(v6("::")), client, connect(v4("0.0.0.0"), "4")],
        [server, option(0, "-1 EINVAL (Invalid argument)"), bind(v6("::")), client, ipv4],
        [server, option(0), option(1), bind(v6("::")), client, ipv4],
        [option(0), bind(v6("::")), client, ipv4],
        [server, option(0), bind(v6("::1")), client, ipv4]
      ]
    ) expect(read(trace).outside).toEqual(outside)
  })

  it("refuses cross-family ownership when the trace shows competing binds or reusable ports", () => {
    const listening = [server, option(0)]
    const reaching = [client, connect(v4("0.0.0.0"))]
    const reuse = "100 setsockopt(3<socket:[8]>, SOL_SOCKET, SO_REUSEPORT, [1], 4) = 0"
    expect(read([...listening, reuse, bind(v6("::")), ...reaching]).outside).toEqual(outside)
    expect(read([...listening, bind(v6("::")), bind(v4("127.0.0.2")), ...reaching]).outside).toEqual(outside)
    expect(read([bind(v4("127.0.0.2")), connect(v4("127.0.0.1"))]).outside).toEqual(outside)
  })

  it("does not infer ownership from a later bind or reuse enabled after the bind", () => {
    const ipv4 = connect(v4("0.0.0.0"))
    const setReuse = "100 setsockopt(3<socket:[8]>, SOL_SOCKET, SO_REUSEPORT, [1], 4) = 0"
    expect(read([server, option(0), client, ipv4, bind(v6("::"))]).outside).toEqual(outside)
    expect(read([server, option(0), bind(v6("::")), client, ipv4, setReuse]).outside).toEqual(outside)
  })

  it("refuses a connection when the trace shows two different wildcard bind identities for its port", () => {
    const second = [server, option(0), bind(v6("::"))].map((line) => line.replace("socket:[8]", "socket:[12]"))
    expect(read([server, option(0), bind(v6("::")), client, connect(v4("0.0.0.0")), ...second]).outside)
      .toEqual(outside)
  })

  it("uses native dual-stack annotations only in a sealed supervisor trace", () => {
    const bindAddress = v6("::")
    const peerAddress = v4("0.0.0.0")
    const annotatedBind = bind(bindAddress + " /* smthrs: tcp dual-stack */")
    const annotatedPeer = connect(peerAddress + " /* smthrs: tcp */", "4")
    const supervised = (lines: ReadonlyArray<string>) =>
      read(["100 +++ smthrs-observe 1 +++", ...lines, "100 +++ complete +++"])
    expect(supervised([annotatedBind, annotatedPeer]).outside).toEqual([])
    expect(supervised([bind(bindAddress), annotatedPeer]).outside).toEqual(outside)
    expect(supervised([annotatedBind, connect(peerAddress, "4")]).outside).toEqual(outside)
    expect(read([annotatedBind, annotatedPeer]).outside).toEqual(outside)
  })

  it("cannot assign a chosen port to a bind whose descriptor lacked a socket identity", () => {
    const trace = read([
      `100 bind(3, ${v6("::", 0)}, 28) = 0`,
      `100 getsockname(3<socket:[8]>, ${v6("::")}, [28]) = 0`,
      connect(v6("::1"))
    ])
    expect(trace.bound).toEqual(new Set())
    expect(trace.outside).toEqual(outside)
  })

  it("rejects an Internet address with no port and ignores unrelated socket name lookups", () => {
    const missing = "{sa_family=AF_INET, sin_addr=inet_addr(\"127.0.0.1\")}"
    expect(read([connect(missing)]).outside).toEqual(["it reached a program outside the run on local port undefined"])
    expect(read(["100 getsockname() = ?"]).bound).toEqual(new Set())
    expect(read([`100 getsockname(3<socket:[8]>, {sa_family=AF_INET6, sin6_port=htons(0)}, [28]) = 0`]).bound)
      .toEqual(new Set())
  })

  it("ignores unrelated and unsuccessful socket calls", () => {
    const prelude = [
      "100 socket(AF_INET6, SOCK_STREAM, IPPROTO_IP) = -1 EINVAL (Invalid argument)",
      "100 socket(AF_INET6, SOCK_STREAM, IPPROTO_IP) = 3",
      "100 socket(AF_INET6, SOCK_STREAM) = 3<socket:[8]>",
      "100 socket(AF_UNIX, SOCK_STREAM, 0) = 3<socket:[8]>",
      "100 socket(AF_INET6, SOCK_DGRAM, IPPROTO_IP) = 3<socket:[8]>",
      "100 socket(AF_INET6, SOCK_STREAM, IPPROTO_UDP) = 3<socket:[8]>",
      "100 setsockopt(3, SOL_IPV6, IPV6_V6ONLY, [0], 4) = 0",
      "100 setsockopt(3<socket:[8]>, SOL_TCP, IPV6_V6ONLY, [0], 4) = 0",
      "100 setsockopt(3<socket:[8]>) = 0",
      "100 setsockopt(3<socket:[8]>, SOL_SOCKET, SO_REUSEPORT, [0], 4) = 0",
      "100 bind(5<socket:[10]>, {sa_family=AF_UNIX, sun_path=@\"local\"}, 12) = 0"
    ]
    expect(read([...prelude, option(0), bind(v6("::")), client, connect(v4("0.0.0.0"))]).outside).toEqual(outside)
    expect(read([server, bind(v6("::")), client, connect(v4("0.0.0.0"))]).outside).toEqual(outside)
  })
})

describe("trace process identity", () => {
  it("keeps a forked subprocess's connection separate from its locked npm parent's", () => {
    const npm =
      "100 execve(\"/usr/bin/node\", [\"node\", \"/usr/lib/node_modules/npm/bin/npm-cli.js\", \"ci\"], 0x1) = 0"
    const network = connect(v4("127.0.0.1"))
    const fork = "100 clone(child_stack=NULL, flags=SIGCHLD) = 101"
    const hook = "101 execve(\"/usr/bin/node\", [\"node\", \"postinstall.js\"], 0x1) = 0"
    const workspaceHelper = "101 execve(\"/workspace/git\", [\"git\", \"fetch\"], 0x1) = 0"
    expect(read([npm, network]).outside).toEqual([])
    for (const exec of [[], [hook], [workspaceHelper]]) {
      expect(read([npm, fork, ...exec, network.replace(/^100/, "101")]).outside).toEqual(outside)
    }
  })

  it("accounts for npm threads and a verified fetch helper without granting their descendants blanket access", () => {
    const npm = "100 execve(\"/usr/bin/npm\", [\"npm\", \"ci\"], 0x1) = 0"
    const thread = "100 clone(child_stack=0x1000, flags=CLONE_VM|CLONE_THREAD) = 101"
    const spawn = "100 clone(child_stack=NULL, flags=SIGCHLD) = 102"
    const helper = "102 execve(\"/usr/bin/git\", [\"git\", \"fetch\"], 0x1) = 0"
    const cache = "101 open(\"/home/runner/.npm/cache\", O_WRONLY|O_CREAT|O_TRUNC, 0600) = 3"
    const peer = connect(v4("127.0.0.1"))
    const trace = read([npm, thread, cache, peer.replace(/^100/, "101"), spawn, helper, peer.replace(/^100/, "102")])
    expect(trace.outside).toEqual([])
    expect(trace.fetched).toEqual(new Set(["/home/runner/.npm/cache"]))
    const descendant = "102 clone(child_stack=NULL, flags=SIGCHLD) = 103"
    expect(read([npm, spawn, helper, descendant, peer.replace(/^100/, "103")]).outside).toEqual(outside)
  })
})

describe("trace opened paths", () => {
  it("retains strace's ordinary descriptor answers separately from process-directory resolution", () => {
    const trace = read([
      "100 openat(AT_FDCWD</workspace>, \"alias\", O_RDONLY) = 4</workspace/target>",
      "100 openat(AT_FDCWD</workspace>, \"dir\", O_RDONLY|O_DIRECTORY) = 3</workspace/dir>",
      "100 openat(AT_FDCWD</workspace>, \"/proc/self/fd/3/inside\", O_RDONLY) = 5</workspace/dir/inside>"
    ])
    expect(trace.openedPaths).toContainEqual(["/workspace/alias", "/workspace/alias", "/workspace/target"])
    expect(trace.reached).toEqual([["/proc/self/fd/3/inside", "/workspace/dir/inside", "/workspace/dir/inside"]])
  })
})

it("carries opened descriptor checks from a continuing service into the next step", () => {
  const before = ["100 openat(AT_FDCWD</workspace>, \"before\", O_RDONLY) = 3</workspace/before>"]
  const after = ["100 openat(AT_FDCWD</workspace>, \"after\", O_RDONLY) = 3</workspace/after>"]
  const served = ObservedReads.servedBy(() => before, () => after, root)
  const want = [["/workspace/after", "/workspace/after", "/workspace/after"]]
  expect(served.openedPaths).toEqual(want)
  expect(ObservedReads.withServed(read([]), [served]).openedPaths).toEqual(want)
})
