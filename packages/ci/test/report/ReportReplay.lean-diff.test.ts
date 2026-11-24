/**
 * The report, the pure parts of the replay and `scripts/box-replay.mjs#sift`, each against its Lean 4 reference
 * specification (`spec/lean/report_replay`), on generated and hostile input.
 *
 * The specification is compiled to one program that answers a JSON request a line. It is started once, so every
 * generated case costs one line each way. A string travels as its UTF-16 code units, so a lone surrogate is compared
 * as it is. Each property has a fixed seed, so a failure reproduces.
 *
 * Where neither the program nor `lake` is on the machine, the cases are skipped: the suite must not fail for want of
 * Lean. Where `lake` is, the program is built first, so it is never older than the specification.
 */
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { isDeepStrictEqual } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { errorLine } from "../../src/contract/Command.vibe"
import type { Mismatch, ReplayCommit, ReplayReport, RunTotals } from "../../src/contract/ReplayReport.vibe"
import { bytesOf } from "../../src/replay/Names.ts"
import { type ProcessEntry, treeOf } from "../../src/replay/ProcessTable.ts"
import { withoutCredentials } from "../../src/replay/Summary.vibe"
import * as Format from "../../src/report/Format.vibe"
import { html, text } from "../../src/report/index.vibe"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specification = join(import.meta.dirname, "..", "..", "spec", "lean", "report_replay")
const program = join(specification, ".lake", "build", "bin", "report-replay-spec")
const elan = join(homedir(), ".elan", "bin")

/** `lake`, where this machine has it: on the path, or where elan puts it. */
const lake = [...(process.env["PATH"] ?? "").split(delimiter), elan]
  .filter((directory) => directory !== "")
  .map((directory) => join(directory, "lake"))
  .find((candidate) => existsSync(candidate))

const oracleReady = existsSync(program) || lake !== undefined

interface Sifted {
  readonly keep: ReadonlyArray<{ readonly path: string; readonly name: string; readonly bytes: number }>
  readonly drop: ReadonlyArray<{ readonly path: string; readonly why: string }>
}

const box: {
  readonly sift: (listing: string) => Sifted
  readonly kept: ReadonlyArray<string>
  readonly largest: number
} = await import(join(import.meta.dirname, "..", "..", "scripts", "box-replay.mjs"))

let child: ChildProcessWithoutNullStreams | undefined
const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = []
let asked = 0

/** One request to the specification, and its answer. */
const ask = (request: Readonly<Record<string, unknown>>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (child === undefined) return reject(new Error("the specification is not running"))
    asked += 1
    waiting.push({ resolve, reject })
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined) {
    const built = spawnSync(lake, ["build"], {
      cwd: specification,
      encoding: "utf8",
      env: { ...process.env, PATH: [elan, process.env["PATH"] ?? ""].join(delimiter) }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specification}:\n${built.stdout}${built.stderr}`)
  }
  const started = spawn(program, [], { stdio: ["pipe", "pipe", "pipe"] })
  createInterface({ input: started.stdout }).on("line", (line) => {
    const answer = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string }
    const next = waiting.shift()
    if (next === undefined) return
    if (answer.error === undefined) next.resolve(answer.ok)
    else next.reject(new Error(`the specification refused a request: ${answer.error}`))
  })
  started.on("close", () => {
    for (const left of waiting.splice(0)) left.reject(new Error("the specification stopped before it answered"))
  })
  child = started
})

afterAll(() => {
  child?.stdin.end()
})

const differential = it.skipIf(!oracleReady)

// --- strings as code units ------------------------------------------------------------------------------------------

const unitsOf = (value: string): Array<number> => Array.from({ length: value.length }, (_, at) => value.charCodeAt(at))

const textOf = (units: unknown): string =>
  (units as ReadonlyArray<number>).map((unit) => String.fromCharCode(unit)).join("")

// --- generators -----------------------------------------------------------------------------------------------------

/** A seed from a property's name, so each property has its own and keeps it. */
const seedOf = (name: string): number =>
  [...name].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 1_000_003, 7)

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index] as A)

const boolean = Arbitrary.schema(Schema.Boolean)

const maybe = <A>(arbitrary: Arbitrary.Arbitrary<A>): Arbitrary.Arbitrary<A | undefined> =>
  Arbitrary.flatMap(
    boolean,
    (present): Arbitrary.Arbitrary<A | undefined> => present ? arbitrary : Arbitrary.Constant(undefined)
  )

/** Fragments joined: each is a word, a mark or a code unit a parser may take for another. */
const soup = (fragments: ReadonlyArray<string>, maxLength: number): Arbitrary.Arbitrary<string> =>
  Arbitrary.map(Arbitrary.array(pick(fragments), { maxLength }), (parts) => parts.join(""))

const highSurrogate = String.fromCharCode(0xd83d)
const lowSurrogate = String.fromCharCode(0xde00)

/** What ECMAScript takes for white space, and what it does not though it looks it. */
const spaces = [
  " ",
  "  ",
  "\t",
  "\n",
  "\r",
  "\r\n",
  "\v",
  "\f",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u200a",
  "\u200b",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
  "\u0085"
]

// --- the two sides, compared ----------------------------------------------------------------------------------------

interface Disagreement {
  readonly input: unknown
  readonly implementation: unknown
  readonly specification: unknown
}

/**
 * Fails unless the implementation and the specification give the same answer for every generated value, and for
 * every value of `corpus`. A failure names the shrunk value and both answers.
 */
const agree = <A>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  runs: number,
  sides: {
    readonly implementation: (value: A) => unknown
    readonly request: (value: A) => Readonly<Record<string, unknown>>
    readonly answer: (reply: unknown) => unknown
  },
  corpus: ReadonlyArray<A> = []
): void => {
  differential(name, async () => {
    let last: Disagreement | undefined
    const same = async (value: A): Promise<boolean> => {
      const implementation = sides.implementation(value)
      const specification = sides.answer(await ask(sides.request(value)))
      if (isDeepStrictEqual(implementation, specification)) return true
      last = { input: value, implementation, specification }
      return false
    }
    for (const value of corpus) {
      if (!(await same(value))) expect.fail(`the specification disagrees on a listed case:\n${JSON.stringify(last)}`)
    }
    const outcome = await Effect.runPromise(
      Arbitrary.checkEffect(arbitrary, (value) => Effect.tryPromise(() => same(value)), { runs, seed: seedOf(name) })
    )
    if (outcome._tag !== "Passed") {
      expect.fail(`${Arbitrary.formatCheckFailure(outcome)}\n${JSON.stringify(last)}`)
    }
    expect(outcome._tag).toBe("Passed")
  })
}

// --- sift: the listing of an untrusted artifact ---------------------------------------------------------------------

interface Listed {
  readonly kind: string
  readonly path: string
  readonly size: string
  readonly format: "gnu" | "bsd" | "bsd-year"
  readonly owner: string
  readonly target: string
  readonly lead: string
}

const spellingsOf = (name: string): ReadonlyArray<string> => [name, `./${name}`, `out/${name}`, `./out/${name}`]

const hostilePaths = [
  "../escape",
  "../box.txt",
  "out/../box.txt",
  "out/../../etc/passwd",
  "./../exit",
  "/etc/passwd",
  "/out/box.txt",
  "//out/exit",
  "out/out/box.txt",
  "././out/exit",
  "./out/./exit",
  "out/./exit",
  "out//exit",
  "out/evil.js",
  "out/box.txt/evil.sh",
  "out/has space.txt",
  "out/box.txt extra",
  "x out/box.txt",
  "out/caf\u00e9.txt",
  "out/\u202ebox.txt",
  "out/box.txt\u0000",
  "out/BOX.TXT",
  "out/exit.",
  "out/exit\u00a0",
  "out/",
  "out",
  "./out",
  "./out/",
  "./",
  ".",
  "",
  "-> out/box.txt",
  "out/box.txt -> /etc/passwd",
  "out/box.txt link to out/exit",
  "Jan 1 00:00 out/exit"
]

const listedPath: Arbitrary.Arbitrary<string> = Arbitrary.flatMap(
  int(0, 9),
  (roll): Arbitrary.Arbitrary<string> =>
    // Mostly a result under one of its spellings, so a listing holds something to take, and the same thing twice.
    roll < 6
      ? Arbitrary.map(Arbitrary.all([pick(box.kept), int(0, 3)]), ([name, spelling]) =>
        spellingsOf(name)[spelling] as string)
      : pick(hostilePaths)
)

const sizes = [
  "0",
  "1",
  "182",
  "007",
  String(2 ** 30 - 1),
  String(2 ** 30),
  String(2 ** 30 + 1),
  String(2 ** 40),
  String(Number.MAX_SAFE_INTEGER),
  "9".repeat(40),
  "9".repeat(400),
  "NaN",
  "Infinity",
  "-1",
  "1e3",
  "0x10",
  "1.5",
  "8,1",
  "\u0661\u0662",
  ""
]

const listed: Arbitrary.Arbitrary<Listed> = Arbitrary.all({
  kind: pick(["-", "-", "-", "-", "-", "l", "h", "d", "b", "c", "p", "s", "D", "?", "\u2212"]),
  path: listedPath,
  size: pick(sizes),
  format: pick(["gnu", "gnu", "bsd", "bsd", "bsd-year"] as const),
  owner: pick(["root", "root", "runner", "a b", "0 a b c Jan x", "0", "Jan", "1000"]),
  target: pick(["/etc/passwd", "../../.ssh/id_rsa", "out/exit", "out/box.txt"]),
  lead: pick(["", "", "", "", "", "", " ", "\t", "\u00a0", "\r"])
})

/** The line a tar prints for an entry with `-tv`. */
const lineOf = (entry: Listed): string => {
  const mode = `${entry.lead}${entry.kind}rw-r--r--`
  const shown = entry.kind === "l"
    ? `${entry.path} -> ${entry.target}`
    : entry.kind === "h"
    ? `${entry.path} link to ${entry.target}`
    : entry.path
  if (entry.format === "gnu") {
    return `${mode} ${entry.owner}/${entry.owner} ${entry.size.padStart(9)} 2026-01-01 00:00 ${shown}`
  }
  const when = entry.format === "bsd" ? "Jan  1 00:00" : "Jan  1  2026"
  return `${mode}  0 ${entry.owner.padEnd(6)} wheel ${entry.size.padStart(8)} ${when} ${shown}`
}

const siftSides = {
  implementation: (listing: string): unknown => box.sift(listing),
  request: (listing: string) => ({ op: "sift", s: unitsOf(listing) }),
  answer: (reply: unknown): unknown => {
    const { drop, keep } = reply as {
      readonly keep: ReadonlyArray<{ readonly path: unknown; readonly name: unknown; readonly bytes: number }>
      readonly drop: ReadonlyArray<{ readonly path: unknown; readonly why: string }>
    }
    return {
      keep: keep.map((entry) => ({ path: textOf(entry.path), name: textOf(entry.name), bytes: entry.bytes })),
      drop: drop.map((entry) => ({ path: textOf(entry.path), why: entry.why }))
    }
  }
}

const gnu = (kind: string, size: string | number, path: string): string =>
  `${kind}rw-r--r-- root/root ${size} 2026-01-01 00:00 ${path}`
const bsd = (kind: string, size: string | number, path: string): string =>
  `${kind}rw-r--r--  0 root   wheel ${size} Jan  1 00:00 ${path}`

const listings = [
  "",
  "\n\n",
  gnu("-", 5, "out/exit"),
  bsd("-", 5, "out/exit"),
  [gnu("d", 0, "out/"), gnu("-", 5, "out/exit"), gnu("-", 9, "out/replay.json")].join("\n"),
  // One result under two spellings is one result twice.
  [gnu("-", 5, "out/exit"), gnu("-", 5, "./exit")].join("\n"),
  [gnu("-", 5, "exit"), bsd("-", 7, "./out/exit"), gnu("-", 1, "out/box.txt")].join("\n"),
  // A link, a directory, a FIFO and a device with a result's name, beside the plain file.
  [gnu("l", 0, "out/exit -> /etc/passwd"), gnu("-", 5, "out/exit")].join("\n"),
  [gnu("h", 0, "out/exit link to out/box.txt"), gnu("-", 5, "out/box.txt")].join("\n"),
  [gnu("p", 0, "out/exit"), gnu("-", 5, "out/exit")].join("\n"),
  [gnu("c", "8,1", "out/exit"), gnu("b", "8,1", "out/box.txt"), gnu("d", 0, "out/replay.log/")].join("\n"),
  gnu("-", 2 ** 30, "out/replay.log"),
  gnu("-", 2 ** 30 + 1, "out/replay.log"),
  gnu("-", "9".repeat(30), "out/replay.log"),
  gnu("-", "NaN", "out/exit"),
  gnu("-", "", "out/exit"),
  ` ${gnu("-", 5, "out/exit")}`,
  `\t${gnu("-", 5, "out/exit")}`,
  `${gnu("-", 5, "out/exit")}\r\n${gnu("-", 6, "out/box.txt")}\r\n`,
  `${gnu("-", 5, "out/exit")} `,
  gnu("-", 5, "out/exit\u00a0"),
  gnu("-", 5, "out/../exit"),
  gnu("-", 5, "/out/exit"),
  gnu("-", 5, "out/out/exit"),
  gnu("-", 5, "././exit"),
  gnu("-", 5, "out/"),
  gnu("-", 5, "./out"),
  // A GNU line whose owner and path make it read as BSD tar's, and a BSD line whose month is none.
  "-rw-r--r-- 0 5 2026-01-01 00:00 Jan 1 00:00 out/exit",
  "-rw-r--r--  0 root   wheel 5 d\u00e9c  1 00:00 out/exit",
  "-rw-r--r--  0 root   wheel 5 JAN  1 00:00 out/exit",
  "-",
  "- - - - - out/exit",
  "-rw-r--r--\u00a0root/root\u00a05\u00a02026-01-01\u00a000:00\u00a0out/exit",
  "-rw-r--r--\u200broot/root 5 2026-01-01 00:00 out/exit"
]

describe("sift, against its specification", () => {
  agree(
    "takes from a generated listing of GNU and BSD tar what the specification takes",
    Arbitrary.map(Arbitrary.array(listed, { maxLength: 14 }), (entries) => entries.map(lineOf).join("\n")),
    500,
    siftSides,
    listings
  )

  agree(
    "takes from a listing of loose fields what the specification takes",
    Arbitrary.map(
      Arbitrary.array(
        soup(
          [
            "-rw-r--r--",
            "lrwxrwxrwx",
            "drwxr-xr-x",
            "-",
            "0",
            "5",
            "1073741824",
            "1073741825",
            "root/root",
            "root",
            "wheel",
            "Jan",
            "Ja",
            "jan",
            "2026-01-01",
            "00:00",
            "out/exit",
            "./out/exit",
            "exit",
            "box.txt",
            "out/",
            "out",
            "./",
            "..",
            "/",
            "->",
            ...spaces
          ],
          14
        ),
        { maxLength: 6 }
      ),
      (lines) => lines.join("\n")
    ),
    500,
    siftSides
  )

  differential("the specification takes a result once, and never a link beside it", async () => {
    const taken = siftSides.answer(
      await ask({
        op: "sift",
        s: unitsOf([gnu("l", 0, "out/exit -> /etc/passwd"), gnu("-", 5, "out/exit")].join("\n"))
      })
    )
    expect(taken).toEqual({
      keep: [{ path: "out/exit", name: "exit", bytes: 5 }],
      drop: [{ path: "out/exit -> /etc/passwd", why: "not a plain file" }]
    })
  })
})

// --- the report: escaping, cleaning and the numbers -----------------------------------------------------------------

const hostileText = [
  "<",
  ">",
  "&",
  "\"",
  "'",
  "&amp;",
  "&lt;",
  "&#39;",
  "&#x27;",
  "<script>alert(1)</script>",
  "</h1>",
  "<h1>",
  "\" onmouseover=\"alert(1)",
  "' onfocus='alert(1)",
  "javascript:",
  "a",
  "Z",
  " ",
  "\n",
  "\u0000",
  "\u0007",
  "\u001b[2J",
  "\u007f",
  "\u0080",
  "\u009b",
  "\u009f",
  "\u00a0",
  "\u202e",
  "\ufffd",
  "\u00e9",
  highSurrogate,
  lowSurrogate,
  `${highSurrogate}${lowSurrogate}`
]

const emptyReport: ReplayReport = {
  version: 1,
  repository: "repository",
  commits: [],
  baselineWallMs: 0,
  normalWallMs: 0,
  speedup: 0,
  mismatches: 0
}

/** What `Html.escape` gives for a text: the page's heading is the repository's name, escaped. */
const escapedByPage = (value: string): string => {
  const page = html({ ...emptyReport, repository: value })
  return page.slice(page.indexOf("<h1>") + 4, page.indexOf("</h1>"))
}

/** What `Text.clean` gives for a text: the line that says why fast mode was not measured is cleaned. */
const cleanedByTerminal = (value: string): string => {
  const printed = text({ ...emptyReport, fastNotMeasured: value })
  return printed.slice(0, printed.length - "\n\n0 commits".length)
}

describe("the report's escaping, against its specification", () => {
  agree(
    "escapes a hostile text for HTML as the specification does",
    soup(hostileText, 12),
    400,
    {
      implementation: escapedByPage,
      request: (value) => ({ op: "escape", s: unitsOf(value) }),
      answer: textOf
    },
    ["", "&&", "<<>>", "&amp;amp;", "''\"\"", highSurrogate, `${lowSurrogate}${highSurrogate}`]
  )

  agree(
    "cleans a hostile text for a terminal as the specification does",
    soup(hostileText, 12),
    400,
    {
      implementation: cleanedByTerminal,
      request: (value) => ({ op: "clean", s: unitsOf(Format.fastNotMeasured(value)) }),
      answer: textOf
    },
    ["", "\u0000", "\u001f \u0020", "\u007e\u007f\u0080", "\u009f\u00a0", "\r\n\t", lowSurrogate]
  )
})

/** A whole time in milliseconds: near where the unit changes, and anywhere. */
const milliseconds: Arbitrary.Arbitrary<number> = Arbitrary.flatMap(
  int(0, 3),
  (roll): Arbitrary.Arbitrary<number> =>
    roll === 0
      ? Arbitrary.map(
        Arbitrary.all([pick([0, 950, 1000, 59_950, 60_000, 3_599_500, 3_600_000, 86_400_000]), int(-60, 60)]),
        ([edge, by]) => Math.max(0, edge + by)
      )
      : roll === 1
      ? int(0, 70_000)
      : roll === 2
      ? int(0, 8_000_000)
      : int(0, 10 ** 12)
)

const edgesOfDuration = [
  0,
  1,
  949,
  950,
  999,
  1000,
  1049,
  1050,
  59_949,
  59_950,
  59_999,
  60_000,
  60_499,
  60_500,
  3_599_499,
  3_599_500,
  3_600_000,
  3_629_999,
  3_630_000,
  86_399_999,
  10 ** 12,
  2 ** 53 - 1
]

/** Two whole times whose quotient is what a report's ratio is. */
const quotient: Arbitrary.Arbitrary<readonly [number, number]> = Arbitrary.flatMap(
  int(0, 3),
  (roll): Arbitrary.Arbitrary<readonly [number, number]> =>
    roll === 0
      ? Arbitrary.all([int(0, 400), int(1, 400)])
      : roll === 1
      ? Arbitrary.all([int(0, 10 ** 7), int(1, 10 ** 7)])
      : roll === 2
      ? Arbitrary.all([int(1, 2000), int(1, 10 ** 11)])
      : Arbitrary.all([int(1, 10 ** 12), int(1, 2000)])
)

const edgesOfRatio: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 1],
  [1, 26],
  [19, 200],
  [95, 1000],
  [94, 1000],
  [949, 10_000],
  [951, 10_000],
  [1, 10],
  [105, 100],
  [115, 100],
  [125, 100],
  [995, 100],
  [9995, 100],
  [9949, 100],
  [100, 1],
  [1005, 10],
  [3, 4],
  [1, 3],
  [2, 3],
  [996, 100_000],
  [9951, 1_000_000],
  [1, 1_000_000],
  [1, 9_999_999],
  [1, 10 ** 9],
  [12, 10 ** 9],
  [10 ** 12, 1]
]

describe("the report's numbers, against their specification", () => {
  agree("writes a duration as the specification does", milliseconds, 500, {
    implementation: Format.duration,
    request: (ms) => ({ op: "duration", ms }),
    answer: textOf
  }, edgesOfDuration)

  agree("writes a ratio as the specification does", quotient, 500, {
    implementation: ([baseline, mode]) => Format.times(baseline / mode),
    request: ([b, m]) => ({ op: "times", b, m }),
    answer: textOf
  }, edgesOfRatio)

  agree("writes a speedup as the specification does", quotient, 500, {
    implementation: ([baseline, mode]) => Format.speedup(baseline / mode),
    request: ([b, m]) => ({ op: "speedup", b, m }),
    answer: textOf
  }, edgesOfRatio)

  agree(
    "writes the CPU time of each way, and how they compare, as the specification does",
    Arbitrary.all({ baseline: milliseconds, normal: milliseconds, fast: maybe(milliseconds) }),
    400,
    {
      implementation: ({ baseline, fast, normal }) =>
        Format.cpuTime({
          ...emptyReport,
          baselineCpuMs: baseline,
          normalCpuMs: normal,
          ...(fast === undefined ? {} : { fastCpuMs: fast })
        }),
      request: ({ baseline, fast, normal }) => ({ op: "cpuTime", b: baseline, n: normal, f: fast ?? null }),
      answer: textOf
    },
    [
      { baseline: 0, normal: 0, fast: undefined },
      { baseline: 0, normal: 5, fast: 0 },
      { baseline: 5, normal: 0, fast: 5 },
      { baseline: 1_570_000, normal: 242_000, fast: undefined },
      { baseline: 242_000, normal: 1_570_000, fast: 242_000 },
      { baseline: 1, normal: 10 ** 12, fast: 1 },
      { baseline: 10 ** 12, normal: 1, fast: 3 }
    ]
  )
})

const totals: RunTotals = { ok: true, wallMs: 1000, workMs: 1000, counts: { hit: 0, ran: 1, failed: 0, skipped: 0 } }

interface Differing {
  readonly mode: "normal" | "fast"
  readonly cause: string | undefined
}

const reportOf = (commits: ReadonlyArray<ReadonlyArray<Differing>>, declared: number | undefined): ReplayReport => ({
  ...emptyReport,
  baselineWallMs: 6000,
  normalWallMs: 1000,
  speedup: 6,
  ...(declared === undefined ? {} : { speedupCommits: declared }),
  commits: commits.map((mismatches, index): ReplayCommit => ({
    commit: `${index}`.padStart(40, "c"),
    changedFiles: 1,
    baseline: totals,
    normal: totals,
    mismatches: mismatches.map(({ cause, mode }): Mismatch => ({
      label: "//:step",
      mode,
      baseline: "pass",
      got: "fail",
      ...(cause === undefined ? {} : { cause })
    }))
  }))
})

const differing: Arbitrary.Arbitrary<Differing> = Arbitrary.all({
  mode: pick(["normal", "fast", "fast"] as const),
  cause: pick([undefined, "apply wrote this file", "apply wrote this file", "a", "\u0000"])
})

describe("the speedup's honesty, against its specification", () => {
  agree(
    "counts the commits a speedup covers as the specification does, and shows none where normal mode differs",
    Arbitrary.all({
      commits: Arbitrary.array(Arbitrary.array(differing, { maxLength: 3 }), { maxLength: 5 }),
      declared: maybe(int(0, 7))
    }),
    400,
    {
      implementation: ({ commits, declared }) => {
        const report = reportOf(commits, declared)
        const covered = Format.speedupCommits(report)
        const differs = Format.normalDiffers(report)
        // What the reader sees follows the count: a report that differs prints why it has no speedup, and no ratio.
        const printed = commits.length === 0 ? undefined : text(report).includes(Format.noSpeedupMismatch)
        const page = commits.length === 0 ? undefined : html(report).includes("no speedup: normal mode gave another")
        return { covered, differs, printed: printed ?? differs, page: page ?? differs }
      },
      request: ({ commits, declared }) => ({
        op: "speedupCommits",
        commits: commits.map((mismatches) =>
          mismatches.map(({ cause, mode }) => ({ mode, cause: cause === undefined ? null : unitsOf(cause) }))
        ),
        declared: declared ?? null
      }),
      answer: (reply) => {
        const { covered, differs } = reply as { readonly covered: number; readonly differs: boolean }
        return { covered, differs, printed: differs, page: differs }
      }
    },
    [
      { commits: [], declared: undefined },
      { commits: [], declared: 3 },
      { commits: [[]], declared: undefined },
      { commits: [[{ mode: "normal", cause: undefined }]], declared: 1 },
      { commits: [[{ mode: "normal", cause: "apply wrote this file" }]], declared: 1 },
      { commits: [[{ mode: "fast", cause: undefined }]], declared: undefined },
      { commits: [[], [{ mode: "fast", cause: undefined }, { mode: "normal", cause: undefined }]], declared: 2 }
    ]
  )
})

// --- credentials in a remote and in an error ------------------------------------------------------------------------

const urlFragments = [
  "https",
  "ssh",
  "git+ssh",
  "h",
  "H",
  "x-y.z",
  "://",
  ":/",
  ":",
  "//",
  "/",
  "@",
  "@@",
  "?",
  "#",
  "user",
  "p@ss",
  "to:ken",
  "host.example",
  "repo.git",
  "1",
  "+",
  ".",
  "-",
  "_",
  "\"",
  "'",
  "\u00e9",
  "\u212a",
  "\u017f",
  "\\",
  ...spaces
]

const remotes = [
  "",
  " ",
  "https://github.com/acme/repo.git",
  "https://user@github.com/acme/repo.git",
  "https://user:token@github.com/acme/repo.git",
  "https://user:p@ss@github.com/acme/repo.git",
  "https://user:p@ss:w@rd@@github.com/acme/repo.git",
  "  https://user:token@github.com/acme/repo.git\n",
  "\ufeffhttps://user:token@github.com/acme/repo.git\u2028",
  "HTTPS://USER:TOKEN@GITHUB.COM/ACME/REPO.GIT",
  "git+ssh://git:pw@host.example:22/acme/repo",
  "ssh://git@host.example/acme/repo",
  "git@github.com:acme/repo.git",
  "https://host.example/path@with/at",
  "https://host.example?query=a@b",
  "https://host.example#fragment@b",
  "https://user:token@host.example?query=a@b",
  "https://@host.example/",
  "https://@/",
  "https:///user@host",
  "https:/user@host/",
  "https:user@host/",
  "://user@host/",
  "1https://user@host/",
  "h://u@h",
  "x-y.z+1://u:p@h/",
  "\u212attps://user@host/",
  "https://user\n:token@host.example/",
  "https://user:token@host.example/ https://second:token@host.example/",
  "file:///home/user@host/repo",
  "https://user:token@"
]

/** How git writes a byte of a name it quotes. */
const quotedByte = (byte: number): string => {
  const letters: Readonly<Record<number, string>> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r" }
  const letter = letters[byte]
  if (letter !== undefined) return `\\${letter}`
  if (byte === 34) return "\\\""
  if (byte === 92) return "\\\\"
  if (byte < 32 || byte >= 127) return `\\${byte.toString(8).padStart(3, "0")}`
  return String.fromCharCode(byte)
}

const gitQuoted = (bytes: ReadonlyArray<number>): string => `"${bytes.map(quotedByte).join("")}"`

describe("credentials, against their specification", () => {
  // Found by this file: `errorLine` asked for a word boundary before a scheme, so a URL right after a word character
  // kept its user name, and a token is often given as one. Runs without the specification.
  it("takes a token out of a URL that follows a word character", () => {
    expect(errorLine("\u001b[31mhttps://ghp_token@host.example/acme/repo.git\u001b[0m")).toBe(
      "\u001b[31mhttps://host.example/acme/repo.git\u001b[0m"
    )
    expect(errorLine("1https://user@host/")).toBe("1https://host/")
    expect(errorLine("remote_https://user:hunter2@host.example/")).toBe("remote_https://host.example/")
    expect(errorLine("9http://user:p@ss@host/")).toBe("9http://host/")
    // A scheme longer than any real one is no scheme, from whichever letter it is read.
    expect(errorLine(`${"a".repeat(40)}://user@host/`)).toBe(`${"a".repeat(40)}://host/`)
    expect(errorLine(`a${"0".repeat(40)}://user@host/`)).toBe(`a${"0".repeat(40)}://user@host/`)
  })

  agree("takes the user name and password out of a remote as the specification does", soup(urlFragments, 12), 500, {
    implementation: withoutCredentials,
    request: (remote) => ({ op: "withoutCredentials", s: unitsOf(remote) }),
    answer: textOf
  }, remotes)

  agree(
    "takes the user name and password out of a remote with a password that holds an @",
    Arbitrary.all({
      scheme: pick(["https", "http", "ssh", "git+ssh", "HTTPS", "a", "a1+-."]),
      user: soup(["user", "x", ".", "-", "%40", "@"], 3),
      password: soup(["pass", "@", ":", "p@ss", "!", "$", "%", "@@", "="], 5),
      host: soup(["github", ".", "com", "example", ":22", "[::1]", "-"], 4),
      rest: pick(["", "/", "/acme/repo.git", "?a=b@c", "#x@y", "/a@b", "/ @"]),
      around: pick(["", "", " ", "\n", "\t", "\ufeff"])
    }),
    500,
    {
      implementation: ({ around, host, password, rest, scheme, user }) => {
        const scrubbed = withoutCredentials(`${around}${scheme}://${user}:${password}@${host}${rest}${around}`)
        // Proved of the specification: only the scheme, the host and what follows stay.
        return { scrubbed, exact: scrubbed === `${scheme}://${host}${rest}`.trim() }
      },
      request: ({ around, host, password, rest, scheme, user }) => ({
        op: "withoutCredentials",
        s: unitsOf(`${around}${scheme}://${user}:${password}@${host}${rest}${around}`)
      }),
      answer: (reply) => ({ scrubbed: textOf(reply), exact: true })
    }
  )

  agree(
    "writes an error as one line without a URL's user name and password, as the specification does",
    soup([
      ...urlFragments,
      "fatal: unable to access '",
      "https://user:token@host.example/acme/repo.git",
      "x".repeat(97)
    ], 14),
    500,
    {
      implementation: (cause: string) => errorLine(cause),
      request: (cause) => ({ op: "errorLine", s: unitsOf(cause) }),
      answer: textOf
    },
    [
      ...remotes,
      "https://user:2024/part@host/path?secret_access_key=sample&keep=x",
      "https://user:42?part@host/path?ACCESS_KEY=x#public",
      "https://user:1#part@host/path?secret_key=x",
      "fatal: unable to access 'https://user:token@host.example/acme/repo.git/': The requested URL returned error: 403",
      "remote: https://a:b@h/ and \"https://c:d@h/\" and git@github.com:acme/repo.git",
      "mailto:someone@example.com",
      "see user@host for details",
      "a:b@c d:e@f",
      "x:y://u@h",
      "9http://user:token@host/",
      "\u001b[31mhttps://ghp_token@host.example/acme/repo.git\u001b[0m",
      "\u001b[1mhttps://user:hunter2@host.example/",
      `${"a".repeat(31)}://user@host/`,
      `${"a".repeat(32)}://user@host/`,
      `${"a".repeat(33)}://user@host/`,
      `a${"0".repeat(31)}://user@host/`,
      `a${"0".repeat(32)}://user@host/`,
      `${"x.".repeat(40)}https://user@host/`,
      "_http://user:token@host/",
      "-http://user:token@host/",
      "a.http://user:token@host/",
      "http://u@ftp://a@b",
      "http://user:tok en@host/",
      "http://user:tok\"en@host/",
      "http://user:tok\u00a0en@host/",
      "http:@",
      "http:////@",
      "A:@B:@",
      "x".repeat(299),
      "x".repeat(300),
      "x".repeat(301),
      `${"x".repeat(299)}${highSurrogate}${lowSurrogate}`,
      `  ${"x ".repeat(200)}  `,
      `${"x".repeat(290)} https://user:token@host.example/acme/repo.git`,
      "\n\t line \r\n two \u2028 three \ufeff"
    ]
  )
})

// --- git's quoted names ---------------------------------------------------------------------------------------------

describe("the bytes of a name git prints, against their specification", () => {
  agree(
    "reads the bytes of a quoted name back, as the specification does and as git wrote them",
    Arbitrary.array(
      Arbitrary.flatMap(
        int(0, 3),
        (roll): Arbitrary.Arbitrary<number> =>
          roll === 0
            ? pick([0, 7, 8, 9, 10, 11, 12, 13, 27, 34, 92, 127, 128, 255])
            : roll === 1
            ? int(32, 126)
            : int(0, 255)
      ),
      { maxLength: 24 }
    ),
    400,
    {
      implementation: (bytes) => ({ bytes: [...bytesOf(gitQuoted(bytes))], quoted: gitQuoted(bytes) }),
      request: (bytes) => ({ op: "gitQuote", s: bytes }),
      // Proved of the specification: the bytes of what it quotes are the bytes it was given.
      answer: (reply) => ({ bytes: [...bytesOf(textOf(reply))], quoted: textOf(reply) })
    },
    [[], [34], [92], [0], [255], [92, 48, 48, 49], [233, 10, 34, 92, 7]]
  )

  agree(
    "reads the bytes of any text that starts as a quoted name does, as the specification does",
    Arbitrary.map(
      soup(
        [
          "\"",
          "\\",
          "\\\\",
          "\\\"",
          "0",
          "1",
          "3",
          "7",
          "8",
          "9",
          "\\351",
          "\\777",
          "\\40",
          "\\0",
          "a",
          "n",
          "t",
          "x",
          "e",
          "\\x41",
          "\\u00e9",
          " ",
          "\u00e9",
          "\u00ff",
          "\u0100",
          "\u20ac",
          highSurrogate,
          lowSurrogate
        ],
        10
      ),
      (inside) => `"${inside}`
    ),
    400,
    {
      implementation: (shown: string) => [...bytesOf(shown)],
      request: (shown) => ({ op: "bytesOf", s: unitsOf(shown) }),
      answer: (reply) => reply
    },
    [
      "\"",
      "\"\"",
      "\"\\",
      "\"\\\"",
      "\"\\7",
      "\"\\7\"",
      "\"\\77\"",
      "\"\\777\"",
      "\"\\7777\"",
      "\"\\8\"",
      "\"\\q\"",
      "\"a",
      "\"ab"
    ]
  )

  agree(
    "reads the bytes of a name that needs no quotes, as the specification does",
    soup(
      [
        "a",
        "data/",
        "caf\u00e9",
        ".txt",
        " ",
        "\\",
        "\\351",
        "'",
        "\u0000",
        "\u07ff",
        "\u0800",
        "\uffff",
        "\u20ac",
        highSurrogate,
        lowSurrogate,
        `${highSurrogate}${lowSurrogate}`,
        "x\""
      ],
      10
    ),
    300,
    {
      implementation: (shown: string) => [...bytesOf(shown)],
      request: (shown) => ({ op: "bytesOf", s: unitsOf(shown) }),
      answer: (reply) => reply
    },
    [
      "",
      "a",
      "\u007f",
      "\u0080",
      lowSurrogate,
      `${lowSurrogate}${highSurrogate}`,
      `${highSurrogate}${highSurrogate}${lowSurrogate}`
    ]
  )
})

// --- the tree of a process ------------------------------------------------------------------------------------------

const row = (pid: number, parent: number, cpuMs: number): ProcessEntry => ({ pid, parent, cpuMs })

const treeSides = {
  implementation: ({ root, table }: { readonly table: ReadonlyArray<ProcessEntry>; readonly root: number }) => {
    const tree = treeOf(table, root)
    // Proved of the specification: no process twice, each a row of the table, each leaf a process of the tree.
    const sound = new Set(tree.pids).size === tree.pids.length &&
      tree.pids.every((pid) => table.some((entry) => entry.pid === pid)) &&
      tree.leaves.every((pid) => tree.pids.includes(pid))
    return { ...tree, sound }
  },
  request: ({ root, table }: { readonly table: ReadonlyArray<ProcessEntry>; readonly root: number }) => ({
    op: "treeOf",
    table: table.map((entry) => [entry.pid, entry.parent, entry.cpuMs]),
    root
  }),
  answer: (reply: unknown) => ({ ...(reply as Record<string, unknown>), sound: true })
}

describe("the tree of a process, against its specification", () => {
  agree(
    "walks a table with rows twice, two parents and parent cycles as the specification does",
    Arbitrary.all({
      table: Arbitrary.array(
        Arbitrary.map(
          Arbitrary.all([int(0, 7), int(0, 7), int(0, 5000)]),
          ([pid, parent, cpuMs]) => row(pid, parent, cpuMs)
        ),
        { maxLength: 18 }
      ),
      root: int(0, 8)
    }),
    400,
    treeSides,
    [
      { table: [], root: 1 },
      { table: [row(1, 0, 5)], root: 1 },
      { table: [row(1, 0, 5)], root: 2 },
      { table: [row(1, 1, 5)], root: 1 },
      { table: [row(1, 2, 5), row(2, 1, 7)], root: 1 },
      { table: [row(1, 2, 5), row(2, 3, 7), row(3, 1, 11)], root: 2 },
      { table: [row(1, 0, 5), row(2, 1, 7), row(2, 1, 9), row(2, 3, 13), row(3, 1, 1)], root: 1 },
      { table: [row(1, 0, 1), row(2, 1, 1), row(3, 1, 1), row(4, 2, 1), row(4, 3, 1), row(5, 4, 1)], root: 1 }
    ]
  )

  agree(
    "walks a tree as wide and as deep as a build's as the specification does",
    Arbitrary.map(
      Arbitrary.array(Arbitrary.all([int(0, 100), int(0, 10 ** 6)]), { maxLength: 60 }),
      (rows) => ({
        table: rows.map(([back, cpuMs], index) =>
          row(index + 1, Math.max(0, index + 1 - 1 - (back % (index + 1))), cpuMs)
        ),
        root: 1
      })
    ),
    300,
    treeSides
  )
})

// --- nothing was skipped --------------------------------------------------------------------------------------------

describe("the specification", () => {
  differential("answered every case of this file", () => {
    expect(asked).toBeGreaterThanOrEqual(6000)
    expect(waiting).toEqual([])
  })
})
