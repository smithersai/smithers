/**
 * `scripts/box-replay.mjs` against what a box may send back and what a command line may ask for, generated: the
 * repository in the box is not trusted, so its artifact and its report are the attacker's. Of an artifact only named
 * plain files of a sane size are taken, whatever its listing says and whichever tar wrote the listing; no command
 * line carries this machine into the box; and no report takes the run down.
 */
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { guardScript } from "../src/replay/Environment.ts"

const script = join(import.meta.dirname, "..", "scripts", "box-replay.mjs")

interface Taken {
  readonly path: string
  readonly name: string
  readonly bytes: number
}

interface Parsed {
  readonly commits: string
  readonly cpu: string
  readonly dryRun: boolean
  readonly jobs: ReadonlyArray<string>
  readonly jobId?: string
  readonly url: string
  readonly commit: string
  readonly replayFlags: ReadonlyArray<string>
}

const box: {
  readonly kept: ReadonlyArray<string>
  readonly largest: number
  readonly Refusal: new(message: string) => Error
  readonly parse: (argv: ReadonlyArray<string>) => Parsed
  readonly command: (options: Parsed, upload: string, jobId: string, output?: string, job?: string) => Array<string>
  readonly quote: (word: string) => string
  readonly tarballs: (packs: string) => ReadonlyArray<string>
  readonly collect: (out: string, cpu: string, code: number) => number
  readonly sift: (listing: string) => {
    readonly keep: ReadonlyArray<Taken>
    readonly drop: ReadonlyArray<{ readonly path: string; readonly why: string }>
  }
  readonly unpack: (artifact: string, out: string) => ReadonlyArray<Taken>
  readonly pool: <A>(tasks: ReadonlyArray<() => Promise<A>>, limit: number) => Promise<ReadonlyArray<A>>
  readonly table: (
    rows: ReadonlyArray<{ readonly job: string; readonly exit: number; readonly report?: unknown }>,
    cpu: string
  ) => ReadonlyArray<string>
  readonly summary: (report: unknown, cpu: string) => ReadonlyArray<string>
} = await import(script)

const made: Array<string> = []
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "box-replay-fuzz-"))
  made.push(directory)
  return directory
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// --- generators -----------------------------------------------------------------------------------------------------

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

const oneOf = <const A extends string | number>(values: readonly [A, ...Array<A>]): Arbitrary.Arbitrary<A> =>
  Arbitrary.schema(Schema.Literals(values)) as Arbitrary.Arbitrary<A>

const text = (fragments: readonly [string, ...Array<string>], maxLength = 8): Arbitrary.Arbitrary<string> =>
  Arbitrary.map(Arbitrary.array(oneOf(fragments), { maxLength }), (parts) => parts.join(""))

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Promise<boolean>,
  options: { readonly runs: number; readonly seed: number }
): Promise<void> => {
  const outcome = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, (value) => Effect.tryPromise(async () => property(value)), options)
  )
  if (outcome._tag !== "Passed") expect.fail(Arbitrary.formatCheckFailure(outcome))
  expect(outcome._tag).toBe("Passed")
}

/** The four ways an artifact spells a result's path. */
const spellingsOf = (name: string): ReadonlyArray<string> => [name, `./${name}`, `out/${name}`, `./out/${name}`]

/** A path as `sift` names it: without `./` and `out/`. */
const nameOf = (path: string): string => path.trim().replace(/^\.\//, "").replace(/^out\//, "")

// --- sift: a listing, as GNU tar and as macOS BSD tar print it ----------------------------------------------------

type Kind = "-" | "l" | "h" | "d" | "b" | "c" | "p" | "s"

interface Listed {
  readonly kind: Kind
  readonly path: string
  readonly bytes: number
  readonly format: "gnu" | "bsd" | "bsd-year"
  readonly owner: string
  readonly target: string
}

const hostilePaths = [
  "../escape",
  "../box.txt",
  "out/../box.txt",
  "out/../../etc/passwd",
  "/etc/passwd",
  "/abs/out/box.txt",
  "/out/box.txt",
  "out/out/box.txt",
  "out/evil.js",
  "out/run.sh",
  "out/box-replay.mjs",
  "out/lib.so",
  "out/.env",
  "out/report.json.sh",
  "out/replay.json.sh",
  "out/box.txt.sh",
  "out/box.txt/evil.sh",
  "out/has space.txt",
  "out/box.txt extra",
  "x out/box.txt",
  "out/café.txt",
  "out/‮box.txt",
  "out/box.txt\u0000.sh",
  "out/BOX.TXT",
  "out/exit.",
  "out/",
  "out",
  "-> out/box.txt",
  "out/box.txt -> /etc/passwd",
  "out/box.txt link to out/exit",
  "node_modules/.bin/smithers-ci"
] as const

const listedPath: Arbitrary.Arbitrary<string> = Arbitrary.flatMap(
  int(0, 9),
  (pick): Arbitrary.Arbitrary<string> =>
    // Mostly a result under one of its spellings, so the listing holds something to take and something to refuse.
    pick < 6
      ? Arbitrary.map(Arbitrary.all([oneOf(box.kept as [string, ...Array<string>]), int(0, 3)]), ([name, spelling]) =>
        spellingsOf(name)[spelling] as string)
      : oneOf(hostilePaths)
)

const listed: Arbitrary.Arbitrary<Listed> = Arbitrary.map(
  Arbitrary.all({
    kind: oneOf(["-", "-", "-", "-", "l", "h", "d", "b", "c", "p", "s"]),
    path: listedPath,
    bytes: oneOf([0, 1, 2, 182, 5269, 2 ** 30, 2 ** 30 + 1, 2 ** 40, Number.MAX_SAFE_INTEGER]),
    format: oneOf(["gnu", "bsd", "bsd-year"]),
    owner: oneOf(["root", "root", "root", "runner", "a b", "0 a b c Jan x", "0", "Jan"]),
    target: oneOf(["/etc/passwd", "../../.ssh/id_rsa", "out/exit", "out/box.txt"])
  }),
  (entry): Listed => entry
)

/** The line a tar prints for an entry with `-tv`. */
const lineOf = (entry: Listed): string => {
  const mode = `${entry.kind}rw-r--r--`
  const shown = entry.kind === "l"
    ? `${entry.path} -> ${entry.target}`
    : entry.kind === "h"
    ? `${entry.path} link to ${entry.target}`
    : entry.path
  const size = entry.kind === "b" || entry.kind === "c" ? "8,1" : String(entry.bytes)
  if (entry.format === "gnu") {
    return `${mode} ${entry.owner}/${entry.owner} ${size.padStart(9)} 2026-01-01 00:00 ${shown}`
  }
  const when = entry.format === "bsd" ? "Jan  1 00:00" : "Jan  1  2026"
  return `${mode}  0 ${entry.owner.padEnd(6)} wheel ${size.padStart(8)} ${when} ${shown}`
}

/** True for an owner a tar prints as one word, so the fields of its line stand where they do. */
const oneWord = (owner: string): boolean => !owner.includes(" ")

describe("sift, on generated listings of both tars", () => {
  it("keeps only plain files named as results, of a sane size, each once", async () => {
    await holds(Arbitrary.array(listed, { maxLength: 14 }), (entries) => {
      const { drop, keep } = box.sift(entries.map(lineOf).join("\n"))
      for (const taken of keep) {
        // The name is one of the results, and the path one of its four spellings: no `..`, no root, no link.
        if (!box.kept.includes(taken.name)) return false
        if (!spellingsOf(taken.name).includes(taken.path)) return false
        if (taken.path.includes("..") || taken.path.startsWith("/") || taken.path.includes(" ")) return false
        if (!Number.isSafeInteger(taken.bytes) || taken.bytes < 0 || taken.bytes > box.largest) return false
        // It is a line of the listing that starts as a plain file's does, with this size.
        const from = entries.filter((entry) =>
          entry.kind === "-" && nameOf(entry.path) === taken.name && entry.bytes === taken.bytes
        )
        if (from.length === 0) return false
      }
      // A result is taken once.
      if (new Set(keep.map((taken) => taken.name)).size !== keep.length) return false
      // Nothing is lost between the two lists: what is not taken says why.
      return drop.every((entry) => entry.why !== "") && keep.length + drop.length <= entries.length
    }, { runs: 400, seed: 20261122 })
  })

  it("takes every honest result, from a GNU listing and from a BSD one", async () => {
    await holds(Arbitrary.array(listed, { maxLength: 10 }), (entries) => {
      const { keep } = box.sift(entries.map(lineOf).join("\n"))
      const plain = entries.filter((entry) => entry.kind === "-" && box.kept.includes(nameOf(entry.path)))
      for (const entry of plain) {
        const alone = plain.filter((other) => nameOf(other.path) === nameOf(entry.path)).length === 1
        if (!alone || !oneWord(entry.owner) || entry.bytes > box.largest) continue
        // A BSD line is told from a GNU one by its link count and month, which an owner named "Jan" would move.
        if (entry.owner === "Jan" || entry.owner === "0") continue
        const taken = keep.find((each) => each.name === nameOf(entry.path))
        if (taken === undefined || taken.path !== entry.path || taken.bytes !== entry.bytes) return false
      }
      return true
    }, { runs: 400, seed: 7 })
  })

  it("never takes a link, a device, a pipe, a directory or a file listed twice", async () => {
    await holds(Arbitrary.array(listed, { minLength: 1, maxLength: 12 }), (entries) => {
      const { keep } = box.sift(entries.map(lineOf).join("\n"))
      for (const entry of entries) {
        const name = nameOf(entry.path)
        const plain = entries.filter((other) => other.kind === "-" && nameOf(other.path) === name)
        // No plain file of that name is listed: a link, a device, a pipe or a directory of it is never taken.
        if (plain.length === 0 && keep.some((taken) => taken.name === name)) return false
        // Listed twice as a plain file, it is nobody's. An owner of several words moves the fields of its line, so
        // the listing does not show that one as a result: `unpack` then finds more bytes than one file's.
        const shown = plain.filter((other) => oneWord(other.owner) && other.owner !== "Jan" && other.owner !== "0")
        if (shown.length > 1 && keep.some((taken) => taken.name === name)) return false
        // Past the size a result holds, it stays in the artifact.
        if (entry.kind === "-" && entry.bytes > box.largest && keep.some((taken) => taken.bytes === entry.bytes)) {
          return false
        }
      }
      return true
    }, { runs: 400, seed: 99 })
  })

  it("reads any text without failing, and takes nothing from a line that is no plain file's", async () => {
    const fragments = [
      "-rw-r--r--",
      "lrwxrwxrwx",
      " ",
      "  ",
      "\t",
      "\n",
      "\r\n",
      "root/root",
      "0",
      "12",
      "Jan",
      "1",
      "00:00",
      "2026-01-01",
      "out/box.txt",
      "./out/exit",
      "replay.json",
      " -> ",
      "/etc/passwd",
      "..",
      "\u0000",
      "é",
      "-",
      "NaN",
      "1e3",
      "0x10",
      "-5"
    ] as const
    await holds(text(fragments, 40), (listing) => {
      const { keep } = box.sift(listing)
      const lines = listing.split("\n")
      return keep.every((taken) =>
        box.kept.includes(taken.name) && Number.isSafeInteger(taken.bytes) && taken.bytes >= 0 &&
        lines.some((line) => line.startsWith("-") && line.trim().endsWith(taken.path))
      )
    }, { runs: 400, seed: 3 })
  })

  it("holds for the listings that got through before", () => {
    // A plain result and then a link of the same name: tar extracts both, and the link is what is left.
    const twice = [
      "-rw-rw-r-- lane/lane         6 2026-11-23 05:08 out/replay.log",
      "-rw-rw-r-- lane/lane         6 2026-11-23 05:08 ./out/replay.log"
    ].join("\n")
    expect(box.sift(twice)).toEqual({
      keep: [],
      drop: [
        { path: "out/replay.log", why: "listed more than once" },
        { path: "./out/replay.log", why: "listed more than once" }
      ]
    })
    // A size no file has, and a size past what a result holds.
    expect(box.sift("-rw-r--r-- root/root NaN 2026-01-01 00:00 out/exit").keep).toEqual([])
    expect(box.sift("-rw-r--r-- root/root 1e3 2026-01-01 00:00 out/exit").keep).toEqual([])
    expect(box.sift(`-rw-r--r-- root/root ${box.largest + 1} 2026-01-01 00:00 out/replay.log`)).toEqual({
      keep: [],
      drop: [{ path: "out/replay.log", why: "larger than a result is" }]
    })
    expect(box.sift(`-rw-r--r-- root/root ${box.largest} 2026-01-01 00:00 out/replay.log`).keep).toHaveLength(1)
    // macOS BSD tar prints a year in place of the time for an old file.
    expect(box.sift("-rw-r--r--  0 root   wheel     123 Jan  1  2026 out/box.txt").keep).toEqual([
      { path: "out/box.txt", name: "box.txt", bytes: 123 }
    ])
  })
})

// --- unpack: real archives, written byte by byte so that they can hold what no honest tar writes ------------------

interface Member {
  readonly path: string
  readonly kind: "file" | "symlink" | "hardlink" | "directory" | "char" | "fifo"
  readonly data: string
  readonly owner: string
  readonly target: string
}

const typeflags = { file: "0", hardlink: "1", symlink: "2", char: "3", directory: "5", fifo: "6" } as const

/** One member as a ustar archive holds it: its header, and its bytes filled up to a block. */
const blocksOf = (member: Member): Buffer => {
  const data = member.kind === "file" ? Buffer.from(member.data) : Buffer.alloc(0)
  const header = Buffer.alloc(512)
  header.write(member.path, 0, 100, "utf8")
  header.write("0000644\0", 100)
  header.write("0000000\0", 108)
  header.write("0000000\0", 116)
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124)
  header.write("15112000000\0", 136)
  header.write("        ", 148)
  header.write(typeflags[member.kind], 156)
  if (member.kind === "symlink" || member.kind === "hardlink") header.write(member.target, 157, 100, "utf8")
  header.write("ustar\0" + "00", 257)
  header.write(member.owner, 265, 32, "utf8")
  header.write(member.owner, 297, 32, "utf8")
  header.write("0000000\0", 329)
  header.write("0000000\0", 337)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

/** A gzipped archive of these members, in this order, at `file`. */
const archive = (members: ReadonlyArray<Member>, file: string): string => {
  writeFileSync(file, gzipSync(Buffer.concat([...members.map(blocksOf), Buffer.alloc(1024)])))
  return file
}

const memberPaths = [
  "out/box.txt",
  "out/box.txt",
  "./out/box.txt",
  "box.txt",
  "out/exit",
  "out/replay.json",
  "out/replay.log",
  "out/replay.log",
  "out/NOT-REPRODUCED.txt",
  "out/report.html",
  "out/",
  "out/box.txt/evil.sh",
  "out/replay.log/authorized_keys",
  "out/box.txt ",
  "../box.txt",
  "out/../../box.txt",
  "/tmp/box-replay-fuzz-absolute/box.txt",
  "out/out/exit",
  "out/evil.sh",
  "out/report.json.sh",
  "out/café.txt",
  "out/re\nplay.log"
] as const

const member = (victim: string): Arbitrary.Arbitrary<Member> =>
  Arbitrary.map(
    Arbitrary.all({
      path: oneOf(memberPaths),
      kind: oneOf(["file", "file", "file", "symlink", "hardlink", "directory", "char", "fifo"]),
      data: text(["", "a", "plain\n", "{}", "0\n", "#!/bin/sh\nrm -rf ~\n", "\u0000", "x".repeat(600)], 3),
      owner: oneOf(["root", "root", "root", "a b", "0 a b c Jan x"]),
      target: oneOf(["victim", "/etc/passwd", "../../victim/secret", "out/exit", "out/box.txt", "."])
    }),
    (drawn): Member => ({ ...drawn, target: drawn.target === "victim" ? join(victim, "secret") : drawn.target })
  )

describe("unpack, on generated archives", () => {
  it("leaves in the results folder only plain files named as results, and writes nowhere else", async () => {
    const root = temporary()
    const victim = join(root, "victim")
    mkdirSync(victim)
    writeFileSync(join(victim, "secret"), "this machine's own")
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    let run = 0
    await holds(Arbitrary.array(member(victim), { minLength: 1, maxLength: 7 }), (members) => {
      const out = join(root, `out-${run++}`)
      mkdirSync(out)
      const taken = box.unpack(archive(members, join(out, "result.tgz")), out)
      const found = readdirSync(out)
      // What is there is what was said to be taken, and the artifact is gone.
      if (found.slice().sort().join("\n") !== taken.map((entry) => entry.name).sort().join("\n")) return false
      for (const name of found) {
        if (!box.kept.includes(name)) return false
        const info = lstatSync(join(out, name))
        // A plain file with one name: no link to a file of this machine, no directory with a program in it.
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false
        // Its bytes are those of one plain member the archive holds under that name.
        const held = readFileSync(join(out, name), "utf8")
        const plain = members.filter((each) => each.kind === "file" && nameOf(each.path) === name)
        if (!plain.some((each) => each.data === held)) return false
      }
      // Nothing of this machine was written, and nothing was written beside the results folder.
      if (readFileSync(join(victim, "secret"), "utf8") !== "this machine's own") return false
      if (readdirSync(victim).join() !== "secret") return false
      if (existsSync(join(root, "box.txt")) || existsSync("/tmp/box-replay-fuzz-absolute")) return false
      rmSync(out, { recursive: true })
      return readdirSync(root).join() === "victim"
    }, { runs: 40, seed: 20261123 })
  })

  it("takes every result of an honest archive, whole", async () => {
    const root = temporary()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const honest = Arbitrary.array(
      Arbitrary.all({
        name: oneOf(box.kept as [string, ...Array<string>]),
        spelling: int(0, 3),
        data: text(["", "a", "line\n", "{\"speedup\": 3}", "é", "x".repeat(700), "\r\n", " "], 4)
      }),
      { maxLength: 5 }
    )
    let run = 0
    await holds(honest, (files) => {
      const once = files.filter((file, index) => files.findIndex((other) => other.name === file.name) === index)
      const members: Array<Member> = [
        { path: "out/", kind: "directory", data: "", owner: "runner", target: "" },
        ...once.map((file): Member => ({
          path: spellingsOf(file.name)[file.spelling] as string,
          kind: "file",
          data: file.data,
          owner: "runner",
          target: ""
        })),
        { path: "out/node_modules.tgz", kind: "file", data: "the repository's code", owner: "runner", target: "" }
      ]
      const out = join(root, `out-${run++}`)
      mkdirSync(out)
      const taken = box.unpack(archive(members, join(out, "result.tgz")), out)
      const whole = once.every((file) =>
        readFileSync(join(out, file.name), "utf8") === file.data &&
        taken.some((entry) => entry.name === file.name && entry.bytes === Buffer.byteLength(file.data))
      )
      const only = readdirSync(out).length === once.length
      rmSync(out, { recursive: true })
      return whole && only
    }, { runs: 12, seed: 5 })
  })

  it("refuses the archives that got a link and a directory through before", () => {
    const root = temporary()
    const said: Array<string> = []
    vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line))
    const file = (path: string, data: string): Member => ({ path, kind: "file", data, owner: "root", target: "" })
    // A plain result, then a link of its name to a file of this machine. tar lists a plain file, extracts both
    // members, and leaves the link: the results folder then held a link to /etc/hostname.
    const linked = join(root, "linked")
    mkdirSync(linked)
    const link: Member = { path: "out/replay.log", kind: "symlink", data: "", owner: "root", target: "/etc/hostname" }
    expect(box.unpack(archive([file("out/replay.log", "plain\n"), link], join(linked, "result.tgz")), linked)).toEqual([
      { path: "out/replay.log", name: "replay.log", bytes: 6 }
    ])
    expect(lstatSync(join(linked, "replay.log")).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(linked, "replay.log"), "utf8")).toBe("plain\n")
    // A plain result, then a directory of its name with a program in it: tar extracts what is under a name too.
    const filled = join(root, "filled")
    mkdirSync(filled)
    const under = [
      file("out/box.txt", "plain\n"),
      { path: "out/box.txt/", kind: "directory", data: "", owner: "root", target: "" } as const,
      file("out/box.txt/evil.sh", "#!/bin/sh\n")
    ]
    const brought = box.unpack(archive(under, join(filled, "result.tgz")), filled)
    for (const name of readdirSync(filled)) expect(lstatSync(join(filled, name)).isFile()).toBe(true)
    expect(brought.every((entry) => readFileSync(join(filled, entry.name), "utf8") === "plain\n")).toBe(true)
    expect(existsSync(join(filled, "box.txt", "evil.sh"))).toBe(false)
    // The same result twice, the second under an owner whose name moves the fields of its line: the listing shows
    // one, and tar prints both.
    const doubled = join(root, "doubled")
    mkdirSync(doubled)
    const second: Member = { ...file("out/exit", "1\n"), owner: "a b" }
    expect(box.unpack(archive([file("out/exit", "0\n"), second], join(doubled, "result.tgz")), doubled)).toEqual([])
    expect(readdirSync(doubled)).toEqual([])
    expect(said.join("\n")).toMatch(/out\/exit \(not the one plain file of 2 bytes it is listed as\)/)
  })
})

// --- collect and table: what the box says of itself ----------------------------------------------------------------

const counts = { hit: 1, ran: 2, failed: 0, skipped: 0 }
const sound = {
  baselineWallMs: 30_000,
  normalWallMs: 10_000,
  mismatches: 0,
  speedup: 3,
  commits: [{
    commit: "a5a7dc0",
    changedFiles: 1,
    baseline: { wallMs: 1 },
    normal: { wallMs: 1, counts },
    mismatches: []
  }]
}

/** Reports a repository's code could make its box write. */
const reports: ReadonlyArray<unknown> = [
  sound,
  undefined,
  null,
  {},
  [],
  0,
  "report",
  true,
  { commits: null },
  { commits: [null] },
  { commits: [{}] },
  { commits: [{ normal: {} }] },
  { commits: [{ normal: { counts: {} } }] },
  { ...sound, baselineWallMs: "30000" },
  { ...sound, normalWallMs: null },
  { ...sound, mismatches: "none" },
  { ...sound, mismatches: Number.NaN },
  { ...sound, baselineWallMs: Number.POSITIVE_INFINITY },
  { ...sound, commits: [{ normal: { counts: { ...counts, hit: "1" } } }] },
  { ...sound, commits: { map: "not a function" } },
  { ...sound, commits: [], jobs: null, recorder: null }
]

describe("what a box reports", () => {
  it("never takes the table of the jobs away, whatever one job's report holds", async () => {
    const row = Arbitrary.all({
      job: text(["build", "test", " ", "é", "lint (22)"], 3),
      exit: int(0, 255),
      report: int(0, reports.length - 1)
    })
    await holds(Arbitrary.array(row, { maxLength: 6 }), (rows) => {
      const lines = box.table(rows.map((each) => ({ ...each, report: reports[each.report] })), "4")
      // One line for the heading, one for each job, one for the sum: and no number that is none.
      if (lines.length !== rows.length + 2) return false
      if (lines.some((line) => /NaN|Infinity|undefined|null/.test(line))) return false
      // Two of the reports are sound: the whole one, and one of no commit.
      const read = rows.filter((each) => each.report === 0 || each.report === reports.length - 1).length
      return lines.at(-1) ===
        `job seconds, each job alone in a 4 vCPU box: baseline ${read * 30} s, normal ${read * 10} s`
    }, { runs: 300, seed: 11 })
  })

  it("gives an exit code a program can exit with, the replay's own only when the box wrote one", async () => {
    const root = temporary()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const wrote = text(["0", "1", "2", "5", "9", "\n", " ", "-", ".", "e", "x", "0x", "NaN", "Infinity", "\u0000"], 5)
    const replay = oneOf([
      "{}",
      "",
      " ",
      "null",
      "[]",
      "not json",
      "{\"commits\":null}",
      "{\"commits\":[{}]}",
      JSON.stringify(sound)
    ])
    let run = 0
    await holds(Arbitrary.all([wrote, replay, int(0, 255)]), ([exit, report, code]) => {
      const out = join(root, `out-${run++}`)
      mkdirSync(out)
      archive([
        { path: "out/exit", kind: "file", data: exit, owner: "root", target: "" },
        { path: "out/replay.json", kind: "file", data: report, owner: "root", target: "" }
      ], join(out, "result.tgz"))
      const got = box.collect(out, "4", code)
      rmSync(out, { recursive: true })
      const own = /^\d{1,3}$/.test(exit.trim()) && Number(exit.trim()) <= 255
      return Number.isInteger(got) && got >= 0 && got <= 255 && got === (own ? Number(exit.trim()) : code)
    }, { runs: 20, seed: 13 })
  })

  it("reads an exit file the box was stopped while writing as no exit code, not as a pass", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    for (
      const [wrote, expected] of [["", 137], ["\n", 137], ["abc", 137], ["1e3", 137], ["-1", 137], ["256", 137], [
        "0",
        0
      ], ["2\n", 2]] as const
    ) {
      const out = temporary()
      archive([{ path: "out/exit", kind: "file", data: wrote, owner: "root", target: "" }], join(out, "result.tgz"))
      expect([wrote, box.collect(out, "4", 137)]).toEqual([wrote, expected])
    }
  })

  it("sums a sound report up, and says a report of another shape is none", () => {
    expect(box.summary(sound, "2")).toEqual([
      "box: 2 vCPU",
      "jobs replayed: -",
      "mismatches: 0",
      "speedup: 3 (baseline 30 s, normal 10 s)",
      "a5a7dc0: 1 files, baseline 0 s, normal 0 s, reused 1 of 3, 0 mismatches"
    ])
    const said: Array<string> = []
    vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line))
    const out = temporary()
    archive(
      [{ path: "out/replay.json", kind: "file", data: "{\"commits\":7}", owner: "root", target: "" }],
      join(out, "result.tgz")
    )
    expect(box.collect(out, "4", 3)).toBe(3)
    expect(said.join("\n")).toMatch(/replay\.json is not a report/)
  })
})

// --- parse: what a command line may ask for ------------------------------------------------------------------------

const carriers = ["--env", "--env-pass", "--cache", "--cache-key", "--with-deps", "--add", "--via"] as const
const fixed = ["--commits", "--job", "--json", "--out", "--cache"] as const

const words = [
  ...carriers,
  "--env=GH_TOKEN",
  "--env-pass=AWS_SECRET_ACCESS_KEY",
  "--cache=x",
  "--packs",
  "--commits",
  "--cpu",
  "--out",
  "--job-id",
  "--job",
  "--dry-run",
  "--",
  "--json",
  "--jobs",
  "--no-trial",
  "-e",
  "-",
  "packs",
  "1",
  "2",
  "3",
  "4",
  "0",
  "-1",
  "4.5",
  "t-1",
  "a b",
  "build",
  "GH_TOKEN",
  "A=b",
  "https://github.com/tj/commander.js",
  "https://me:secret@github.com/x/y",
  "https://token@github.com/x/y",
  "HTTPS://GITHUB.COM/x/y",
  "http://github.com/x/y",
  "ssh://git@github.com/x/y",
  "git@github.com:x/y",
  "file:///etc",
  "/etc",
  "./repo",
  "~/repo",
  "..",
  "a5a7dc0",
  "A5A7DC0A5A7DC0A5A7DC0A5A7DC0A5A7DC0A5A7D",
  "a5a7dc",
  "main",
  "a5a7dc0; rm -rf ~",
  "$(id)",
  ""
] as const

describe("parse, on generated command lines", () => {
  it("refuses, or gives options that carry nothing of this machine into the box", async () => {
    await holds(Arbitrary.array(oneOf(words), { maxLength: 12 }), (argv) => {
      let options: Parsed
      try {
        options = box.parse(argv)
      } catch (error) {
        // Its own refusal, with its reason: never another fault.
        return error instanceof box.Refusal && error.message !== ""
      }
      const split = argv.indexOf("--")
      const own = split === -1 ? argv : argv.slice(0, split)
      // No flag that carries a variable, a cache or a file of this machine was among its own.
      if (own.some((word) => (carriers as ReadonlyArray<string>).includes(word))) return false
      const url = new URL(options.url)
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false
      if (!/^[0-9a-f]{7,40}$/.test(options.commit)) return false
      if (!["1", "2", "4"].includes(options.cpu) || !/^[1-9]\d*$|^0+[1-9]\d*$/.test(options.commits)) return false
      if (options.jobId !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(options.jobId)) return false
      // The replay in the box is not told to write outside it, to share a cache or to run other commits.
      if (options.replayFlags.some((flag) => (fixed as ReadonlyArray<string>).includes(flag.split("=")[0] as string))) {
        return false
      }
      // cfbox's own flags are the fixed ones: everything the command line gave stands after `--`, as the box's
      // command, or is one of the four values checked above.
      const line = box.command(
        options,
        "/work/upload",
        options.jobId ?? "box-replay-1",
        "/work/result.tgz",
        options.jobs[0]
      )
      const before = line.slice(0, line.indexOf("--"))
      return before.join(" ") ===
        `run --cpu ${options.cpu} --image node --job-id ${
          options.jobId ?? "box-replay-1"
        } --artifact out --output /work/result.tgz /work/upload`
    }, { runs: 600, seed: 17 })
  })

  it("refuses every flag that carries this machine into the box, wherever it stands among its own", async () => {
    const sound = ["https://github.com/tj/commander.js", "a5a7dc0", "--packs", "packs", "--cpu", "2", "--job", "build"]
    await holds(
      Arbitrary.all([oneOf(carriers), int(0, sound.length), oneOf(["", "GH_TOKEN", "A=b", "--dry-run"])]),
      ([flag, at, value]) => {
        const argv = [...sound.slice(0, at), flag, ...(value === "" ? [] : [value]), ...sound.slice(at)]
        try {
          box.parse(argv)
          return false
        } catch (error) {
          return error instanceof box.Refusal
        }
      },
      { runs: 200, seed: 19 }
    )
  })

  it("refuses the replay flags the box sets itself, with a value or without", async () => {
    const sound = ["https://github.com/tj/commander.js", "a5a7dc0", "--packs", "packs", "--"]
    const more = Arbitrary.array(oneOf(["--jobs", "2", "--no-trial", "--stall", "5"]), { maxLength: 4 })
    await holds(
      Arbitrary.all([oneOf(fixed), oneOf(["", "=x", "=/etc/cron.d/x", "=https://cache.example"]), more, more]),
      ([flag, value, before, after]) => {
        try {
          box.parse([...sound, ...before, `${flag}${value}`, ...after])
          return false
        } catch (error) {
          return error instanceof box.Refusal && error.message.includes(`replay flag ${flag} is refused`)
        }
      },
      { runs: 200, seed: 23 }
    )
  })

  it("quotes any word so that a shell reads the word back", async () => {
    const pieces = [
      "a",
      "B",
      "0",
      " ",
      "'",
      "\"",
      "\\",
      "$",
      "`",
      "*",
      "?",
      "~",
      ";",
      "&",
      "|",
      "<",
      ">",
      "(",
      ")",
      "{",
      "}",
      "!",
      "#",
      "\n",
      "\t",
      "-",
      "=",
      "/",
      ".",
      ":",
      "é",
      "\u{1f600}",
      "$(id)",
      "''",
      "'\"'\"'"
    ] as const
    await holds(Arbitrary.array(text(pieces, 6), { minLength: 1, maxLength: 14 }), (given) => {
      const line = `printf '%s\\0' ${given.map(box.quote).join(" ")}`
      const read = spawnSync("sh", ["-c", line], { encoding: "utf8" })
      return read.status === 0 && read.stderr === "" && read.stdout === given.map((word) => `${word}\0`).join("")
    }, { runs: 50, seed: 29 })
  })
})

describe("the tarballs that go into a box", () => {
  it("are files of the packs directory itself, whatever its manifest lists", async () => {
    const outside = temporary()
    writeFileSync(join(outside, "id_rsa"), "this machine's key")
    const names = [
      "smithers-ci-1.0.0.tgz",
      "smthrs-cli-1.0.0.tgz",
      "../id_rsa",
      "sub/smithers-ci-2.tgz",
      "/etc/hostname",
      ".",
      "..",
      "",
      "smithers-ci-../../id_rsa"
    ] as const
    await holds(Arbitrary.array(oneOf(names), { minLength: 1, maxLength: 4 }), (listed) => {
      const root = mkdtempSync(join(outside, "packs-"))
      const packs = join(root, "packs")
      mkdirSync(join(packs, "sub"), { recursive: true })
      writeFileSync(join(root, "id_rsa"), "this machine's key")
      writeFileSync(
        join(packs, "manifest.json"),
        JSON.stringify(listed.map((filename) => ({ name: "smithers-ci", filename })))
      )
      for (const name of listed) {
        if (name.endsWith(".tgz") && !name.includes("..")) writeFileSync(join(packs, name), "tarball")
      }
      rmSync(join(packs, "sub"), { recursive: true, force: true })
      try {
        return box.tarballs(packs).every((name) => name !== "" && !name.includes("/") && name !== "." && name !== "..")
      } catch (error) {
        return error instanceof box.Refusal
      }
    }, { runs: 120, seed: 31 })
  })
})

describe("pool", () => {
  it("runs every task once, in order of result, with no more under way than its limit", async () => {
    await holds(Arbitrary.all([Arbitrary.array(int(0, 3), { maxLength: 12 }), int(1, 6)]), async ([delays, limit]) => {
      let under = 0
      let most = 0
      const results = await box.pool(
        delays.map((delay, index) => async () => {
          under += 1
          most = Math.max(most, under)
          for (let turn = 0; turn < delay; turn++) await Promise.resolve()
          under -= 1
          return index
        }),
        limit
      )
      return most <= limit && results.join() === delays.map((_, index) => index).join()
    }, { runs: 200, seed: 37 })
  })
})

// --- the stand-in a step finds for sudo and docker, which is a shell script and so needs a shell ------------------

describe("the stand-in for a guarded program", () => {
  it("says what it was asked to run on one line and runs none of it", async () => {
    const root = temporary()
    const guard = join(root, "sudo")
    writeFileSync(guard, guardScript("sudo"))
    chmodSync(guard, 0o755)
    const work = join(root, "work")
    mkdirSync(work)
    const pieces = [
      "rm",
      "-rf",
      "~",
      "*",
      "$(touch made)",
      "`touch made`",
      "; touch made",
      "| touch made",
      "> made",
      "&&",
      "a b",
      "\n",
      "\t",
      "'",
      "\"",
      "\\",
      "$HOME",
      "%s",
      "\\n",
      "-n",
      "-e",
      "--",
      "é"
    ] as const
    await holds(Arbitrary.array(text(pieces, 3), { maxLength: 5 }), (args) => {
      const ran = spawnSync(guard, args, { cwd: work, encoding: "utf8" })
      const said = ran.stderr.split("\n")
      return ran.status === 1 && ran.stdout === "" && said.length === 2 && said[1] === "" &&
        (said[0] as string).startsWith("smithers-ci does not run sudo: ") && readdirSync(work).length === 0
    }, { runs: 40, seed: 41 })
  })
})
