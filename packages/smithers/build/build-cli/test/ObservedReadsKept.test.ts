/**
 * What the build reads of a program a step left running: the step's own lines and what its recorder wrote after
 * them, as strace and `smthrs-observe --keep` write them, in real files.
 */
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const made: Array<string> = []
afterEach(() => {
  for (const directory of made.splice(0)) NodeFs.rmSync(directory, { recursive: true, force: true })
})
const directory = (): string => {
  const made_ = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "observed-kept-"))
  made.push(made_)
  return made_
}

describe("the lines of a trace a recorder still writes", () => {
  it("are its whole lines, from and to a byte, read again at each call", () => {
    const file = Path.join(directory(), "trace")
    expect([...ObservedReads.wholeLinesOf(file)()]).toEqual([])
    expect(ObservedReads.wholeLength(file)).toBe(0)
    NodeFs.writeFileSync(file, "1 a\n2 b\n3 cut sh")
    expect(ObservedReads.wholeLength(file)).toBe(8)
    const lines = ObservedReads.wholeLinesOf(file)
    expect([...lines()]).toEqual(["1 a", "2 b"])
    expect([...ObservedReads.wholeLinesOf(file, 4)()]).toEqual(["2 b"])
    expect([...ObservedReads.wholeLinesOf(file, 0, 4)()]).toEqual(["1 a"])
    expect([...ObservedReads.wholeLinesOf(file, 8)()]).toEqual([])
    NodeFs.appendFileSync(file, "ort\n")
    expect([...lines()]).toEqual(["1 a", "2 b", "3 cut short"])
  })

  it("end for the step at the line where its shell opens the status file to write it", () => {
    const file = Path.join(directory(), "trace")
    expect(ObservedReads.stepLength(file)).toBe(0)
    const opened = `9 openat(AT_FDCWD, "${file}.status", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`
    const text = [`9 execve("/bin/sh", ["/bin/sh", "-c", "x", "${file}.status"], 0x1) = 0`, opened, "12 later"].join(
      "\n"
    )
    NodeFs.writeFileSync(file, `${text}\n`)
    expect(ObservedReads.stepLength(file)).toBe(text.indexOf("12 later"))
    // Before the status is written, the step's lines are every whole line.
    NodeFs.writeFileSync(file, "9 one\n9 tw")
    expect(ObservedReads.stepLength(file)).toBe(6)
    NodeFs.writeFileSync(file, `9 one\n${opened}`)
    expect(ObservedReads.stepLength(file)).toBe(6)
  })
})

describe("what a program a step left read while the steps after it ran", () => {
  const server = (root: string): ReadonlyArray<string> => [
    "20 +++ smthrs-observe 1 +++",
    `20 openat(AT_FDCWD, "${root}/tool.py", O_RDONLY) = 3`,
    `20 bind(3, {sa_family=AF_INET, sin_port=htons(8767), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`,
    "20 +++ complete +++"
  ]

  it("is the paths found, missing and listed after the step's own lines, and the sockets it listens on", () => {
    const root = directory()
    const after = [
      `20 openat(AT_FDCWD, "${root}/tool.py", O_RDONLY) = 3`,
      `20 openat(AT_FDCWD, "${root}/site/x.txt", O_RDONLY) = 4`,
      `20 newfstatat(AT_FDCWD, "${root}/site/gone.txt", 0x1, 0) = -1 ENOENT (No such file or directory)`
    ]
    const served = ObservedReads.servedBy(() => server(root), () => after, root)
    expect([...served.found.keys()]).toEqual([`${root}/site/x.txt`])
    expect([...served.missing.keys()]).toEqual([`${root}/site/gone.txt`])
    expect([...served.bound]).toEqual(["inet:8767:127.0.0.1"])
    expect(served.refusals).toEqual([])
    // A step that talks to it on its port reaches its job, not outside the run.
    const asked = ObservedReads.read(
      () => [
        "30 +++ smthrs-observe 1 +++",
        `30 connect(3, {sa_family=AF_INET, sin_port=htons(8767), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`,
        `30 openat(AT_FDCWD, "${root}/got.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`,
        "30 +++ complete +++"
      ],
      root,
      [],
      served.bound
    )
    expect(asked.refusals).toEqual([])
    const alone = ObservedReads.read(() => [
      "30 +++ smthrs-observe 1 +++",
      `30 connect(3, {sa_family=AF_INET, sin_port=htons(8767), sin_addr=inet_addr("127.0.0.1")}, 16) = 0`,
      "30 +++ complete +++"
    ], root)
    expect(alone.refusals).toEqual(["it reached a program outside the run on local port 8767"])
    // Joined, the program's reads are the step's, after its own lines: a path the step made stays its own.
    const joined = ObservedReads.withServed(asked, [served])
    expect([...joined.found.keys()]).toEqual([`${root}/site/x.txt`])
    // The step's own trace is four lines long.
    expect(joined.found.get(`${root}/site/x.txt`)! > 4).toBe(true)
    expect([...joined.missing.keys()]).toEqual([`${root}/site/gone.txt`])
    expect(joined.refusals).toEqual([])
    // What it did that cannot be recorded is the step's too.
    const unseen = ObservedReads.servedBy(
      () => server(root),
      () => ["20 +++ unrecorded: it read through io_uring +++"],
      root
    )
    expect(unseen.refusals).toEqual(["it read through io_uring"])
    expect(ObservedReads.withServed(asked, [unseen]).refusals).toEqual(["it read through io_uring"])
  })

  it("reads a trace that was not sealed, as strace writes it", () => {
    const root = directory()
    const served = ObservedReads.servedBy(
      () => [`20 openat(AT_FDCWD, "${root}/a", O_RDONLY) = 3`],
      () => [`20 openat(AT_FDCWD, "${root}/b", O_RDONLY) = 3`],
      root
    )
    expect([...served.found.keys()]).toEqual([`${root}/b`])
  })
})

describe("a step that left a program running, as the steps after it read it", () => {
  it("is read from the trace smthrs-observe sealed and the lines it kept after, once it answers", async () => {
    const root = directory()
    const trace = Path.join(root, "trace")
    NodeFs.writeFileSync(trace, "20 +++ smthrs-observe 1 +++\n20 +++ complete +++\n")
    NodeFs.writeFileSync(`${trace}.kept`, `20 openat(AT_FDCWD, "${root}/x", O_RDONLY) = 3\n`)
    const kept = ObservedReads.keptStep("//:serve", "id", root, trace, true)
    expect([...kept.step()]).toEqual(["20 +++ smthrs-observe 1 +++", "20 +++ complete +++"])
    expect([...kept.after()]).toEqual([`20 openat(AT_FDCWD, "${root}/x", O_RDONLY) = 3`])
    // The recorder answers a request once every line it holds is written.
    const answering = setTimeout(() => NodeFs.writeFileSync(`${trace}.answered`, "1\n"), 20)
    expect(await kept.flush()).toBe(true)
    clearTimeout(answering)
    expect(await ObservedReads.askFlush(trace, 30)).toBe(false)
    NodeFs.writeFileSync(`${trace}.answered`, "9223372036854775807\n")
    expect(await ObservedReads.askFlush(trace, 30)).toBe(true)
  })

  it("is read from strace's trace, split where the step's own lines end", async () => {
    const root = directory()
    const trace = Path.join(root, "trace")
    NodeFs.writeFileSync(trace, "1 own\n2 after\n")
    const kept = ObservedReads.keptStep("//:serve", undefined, root, trace, false, 6)
    expect([...kept.step()]).toEqual(["1 own"])
    expect([...kept.after()]).toEqual(["2 after"])
    expect(await kept.flush()).toBe(true)
    const none = ObservedReads.unrecordedStep("//:plain")
    expect([none.id, [...none.step()], [...none.after()], await none.flush()]).toEqual([undefined, [], [], true])
  })

  it("wrote nothing a step after it reads as its, where its reads could not be known", () => {
    expect(ObservedReads.wrote({ refusal: "x" })).toEqual({ made: new Set(), touched: new Set() })
  })
})

describe("a run that asks a server of its own before the server listens", () => {
  it("reaches nothing outside the run, on a port or a socket it binds later; one it never binds is outside", () => {
    const lines = (address: string, bound: boolean): Array<string> => [
      "10 +++ smthrs-observe 1 +++",
      `11 connect(3, ${address}, 16) = -1 EINPROGRESS (Operation now in progress)`,
      ...(bound ? [`12 bind(4, ${address}, 16) = 0`] : []),
      `11 connect(5, ${address}, 16) = 0`,
      "10 +++ complete +++"
    ]
    const port = "{sa_family=AF_INET, sin_port=htons(8768), sin_addr=inet_addr(\"127.0.0.1\")}"
    const socket = "{sa_family=AF_UNIX, sun_path=\"/tmp/s.sock\"}"
    for (const address of [port, socket]) {
      expect(ObservedReads.read(() => lines(address, true), "/w").refusals).toEqual([])
    }
    expect(ObservedReads.read(() => lines(port, false), "/w").refusals).toEqual([
      "it reached a program outside the run on local port 8768"
    ])
    expect(ObservedReads.read(() => lines(socket, false), "/w").refusals).toEqual([
      "it reached a program outside the run through the socket \"/tmp/s.sock\""
    ])
  })
})
