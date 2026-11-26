/**
 * Holds `ObservedReads.ts` against its Lean 4 reference specification (`spec/lean/observed_reads`).
 *
 * The specification is compiled to `observed-reads-spec`, which answers one JSON request a line. This file starts
 * it once, generates inputs with `effect/Arbitrary`, and asks both sides the same question. The suite is skipped
 * only where neither the binary nor `lake` exists.
 *
 * The specification states the rules `u2` (a changed file is held only as the run found it) and `u3` (a directory
 * the run looked at is held by its link count). `rules` below says which of them this build of `ObservedReads.ts`
 * has, and the oracle is asked under the same rules: the comparison is exact before and after they land.
 *
 * Where the implementation is known to differ from the specification, the test says so in `gaps` and asserts the
 * exact shape of the difference, so it passes today and still passes once the implementation is fixed.
 */
import * as A from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as S from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Reads from "../src/internal/ObservedReads.ts"

// --- The oracle ------------------------------------------------------------------------------------------------

const specDirectory = fileURLToPath(new URL("../spec/lean/observed_reads", import.meta.url))
const binary = join(specDirectory, ".lake", "build", "bin", "observed-reads-spec")

/** `lake`, found without running it: an `elan` shim can wait on the network. */
const lake = [join(homedir(), ".elan", "bin"), ...(process.env["PATH"] ?? "").split(delimiter)]
  .map((directory) => join(directory, "lake"))
  .find((candidate) => NodeFs.existsSync(candidate))

const sourcesOf = (directory: string): ReadonlyArray<string> =>
  NodeFs.existsSync(directory)
    ? NodeFs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.name === ".lake"
        ? []
        : entry.isDirectory()
        ? sourcesOf(join(directory, entry.name))
        : /\.(?:lean|toml)$|^lean-toolchain$/.test(entry.name)
        ? [join(directory, entry.name)]
        : []
    )
    : []

/** Whether the binary is there and newer than every source of the specification. */
const fresh = (): boolean => {
  if (!NodeFs.existsSync(binary)) return false
  const built = NodeFs.statSync(binary).mtimeMs
  return sourcesOf(specDirectory).every((source) => NodeFs.statSync(source).mtimeMs <= built)
}

const oracleReady = NodeFs.existsSync(binary) || (lake !== undefined && NodeFs.existsSync(specDirectory))
const check = it.skipIf(!oracleReady)

class Oracle {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly waiting: Array<{ resolve: (value: unknown) => void; reject: (cause: Error) => void }> = []
  private buffered = ""
  asked = 0

  constructor(path: string) {
    this.child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk
      for (let end = this.buffered.indexOf("\n"); end >= 0; end = this.buffered.indexOf("\n")) {
        const line = this.buffered.slice(0, end)
        this.buffered = this.buffered.slice(end + 1)
        const reply = JSON.parse(line) as { readonly r?: unknown; readonly error?: string }
        const next = this.waiting.shift()
        if (reply.error === undefined) next?.resolve(reply.r)
        else next?.reject(new Error(`observed-reads-spec: ${reply.error}`))
      }
    })
    this.child.on("exit", (code) => {
      for (const next of this.waiting.splice(0)) next.reject(new Error(`observed-reads-spec ended (${code})`))
    })
  }

  ask<T>(request: { readonly op: string; readonly [key: string]: unknown }): Promise<T> {
    this.asked += 1
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ resolve: resolve as (value: unknown) => void, reject })
      this.child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  close(): void {
    this.child.stdin.end()
  }
}

let oracle: Oracle

beforeAll(() => {
  if (!oracleReady) return
  if (!fresh() && lake !== undefined) {
    const built = spawnSync(lake, ["build"], { cwd: specDirectory, encoding: "utf8", timeout: 900_000 })
    if (built.status !== 0) throw new Error(`lake build failed (${built.status}):\n${built.stdout}\n${built.stderr}`)
  }
  oracle = new Oracle(binary)
}, 1_000_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- What this build of the implementation has -----------------------------------------------------------------

const exported = Reads as unknown as {
  readonly dirLinks?: (path: string, own: ReadonlyArray<string>, io?: Reads.Io) => number | undefined
}

/** The rules of the specification this build of `ObservedReads.ts` implements. */
const rules = {
  u2: Reads.changed({ id: "", reads: [["p", "left", "before"]], lists: [] }, "/nowhere", () => "left") !== undefined,
  u3: typeof exported.dirLinks === "function"
}

/** Inputs on which the implementation was seen to differ from the specification in a known way, by the way. */
const gaps = { supplementary: 0 }
/** Values of the right shape that are no record because `running` or `served` is not of its type. */
let refusedForPrograms = 0
/** How often each outcome was seen, so that no property passes on empty cases. */
const seen = { held: 0, changed: 0, recorded: 0, refused: 0, links: 0, loops: 0, unreadable: 0, valid: 0, invalid: 0 }
/** What `changed` said, without the names, each with how often. */
const said = new Map<string, number>()
let cases = 0

// --- Generators ------------------------------------------------------------------------------------------------

const property =
  <T>(arbitrary: A.Arbitrary<T>, seed: number, runs: number, verify: (value: T) => Promise<void>) => async () => {
    const result = await Effect.runPromise(
      A.checkEffect(arbitrary, (value) =>
        Effect.tryPromise({
          try: async () => {
            await verify(value)
            cases += 1
            return true
          },
          catch: (cause) => (cause instanceof Error ? cause.stack ?? cause.message : String(cause))
        }), { seed, runs })
    )
    if (result._tag !== "Passed") throw new Error(A.formatCheckFailure(result))
  }

const pick = <const T extends ReadonlyArray<string | number>>(values: T) => A.schema(S.Literals(values))
const int = (maximum: number) => A.schema(S.Int.check(S.isBetween({ minimum: 0, maximum })))
const flag = A.schema(S.Boolean)

/** A text without lone surrogates: the specification's texts are sequences of Unicode scalar values. */
const wellFormed = (text: string): string => text.replace(/\p{Cs}/gu, "�")
const anyText = A.map(A.schema(S.String), wellFormed)

const pieces = [
  "a",
  "b",
  "c",
  "1",
  "é",
  "猫",
  "😀",
  " ",
  "\"",
  "\\",
  "'",
  "(",
  ")",
  ",",
  "<",
  ">",
  "\n",
  "\t",
  "-",
  ".",
  "..",
  "$",
  "*",
  "~",
  " ",
  "__proto__",
  ".git"
] as const

/** A name a directory can hold: hostile, never empty, `.` or `..`, and without a slash. */
const name = A.map(A.array(pick(pieces), { minLength: 1, maxLength: 3 }), (parts) => {
  const joined = parts.join("")
  return joined === "." || joined === ".." ? `${joined}x` : joined
})
const plainName = A.map(A.array(pick(["a", "b", "c", "1"]), { minLength: 1, maxLength: 3 }), (parts) => parts.join(""))

// --- A file system in memory, and the same tree for the oracle -------------------------------------------------

type Tree =
  | { readonly f: string; readonly x: boolean }
  | { readonly d: { readonly [name: string]: Tree } }
  | { readonly l: string }
  | { readonly o: number }

const childOf = (node: Tree, part: string): Tree | undefined =>
  "d" in node && Object.prototype.hasOwnProperty.call(node.d, part) ? node.d[part] : undefined

function fail(code: string): never {
  throw Object.assign(new Error(code), { code })
}

const segmentsOf = (path: string): Array<string> => path.split("/").filter((part) => part !== "" && part !== ".")

/** Resolves a path as a POSIX kernel does: written apart from the specification, to be held against it. */
const lookup = (root: Tree, path: string, follow: boolean): Tree => {
  if (path === "") fail("ENOENT")
  const raw = path.split("/")
  const last = raw[raw.length - 1]
  const asksDirectory = raw.length > 1 && (last === "" || last === ".")
  let trail: Array<Tree> = [root]
  const queue = segmentsOf(path)
  let hops = 0
  while (queue.length > 0) {
    const here = trail[trail.length - 1]!
    if (!("d" in here)) fail("ENOTDIR")
    const part = queue.shift()!
    if (part === "..") {
      if (trail.length > 1) trail.pop()
      continue
    }
    const next = childOf(here, part) ?? fail("ENOENT")
    if ("l" in next && (queue.length > 0 || follow || asksDirectory)) {
      hops += 1
      if (hops > 40) fail("ELOOP")
      if (next.l === "") fail("ENOENT")
      if (next.l.startsWith("/")) trail = [root]
      queue.unshift(...segmentsOf(next.l))
      continue
    }
    trail.push(next)
  }
  const found = trail[trail.length - 1]!
  if (asksDirectory && !("d" in found)) fail("ENOTDIR")
  return found
}

const linksOf = (node: Tree): number =>
  "d" in node ? 2 + Object.values(node.d).filter((child) => "d" in child).length : 1

const memory = (root: Tree): Reads.Io => ({
  lstat: (path) => {
    const node = lookup(root, path, false)
    return {
      dev: 1,
      ino: 1,
      ctimeMs: 1,
      mtimeMs: 1,
      mode: "f" in node ? 0o100000 | (node.x ? 0o755 : 0o644) : "l" in node ? 0o120777 : "o" in node ? node.o : 0o40755,
      nlink: linksOf(node),
      size: "f" in node ? Buffer.byteLength(node.f) : 0,
      isFile: () => "f" in node,
      isDirectory: () => "d" in node,
      isSymbolicLink: () => "l" in node
    } as NodeFs.Stats
  },
  readlink: (path) => {
    const node = lookup(root, path, false)
    return "l" in node ? node.l : fail("EINVAL")
  },
  readdir: (path) => {
    const node = lookup(root, path, true)
    return "d" in node ? Object.keys(node.d) : fail("ENOTDIR")
  },
  readFile: (path) => {
    const node = lookup(root, path, true)
    return "f" in node ? Buffer.from(node.f) : fail("EISDIR")
  },
  head: (path, length) => {
    const node = lookup(root, path, true)
    return "f" in node ? Buffer.from(node.f).subarray(0, length) : fail("EISDIR")
  }
})

interface Step {
  readonly parent: number
  readonly name: string
  readonly kind: "f" | "d" | "l"
  readonly text: string
  readonly exec: boolean
  readonly target: number
  readonly shape: "absolute" | "sibling" | "self" | "up" | "missing" | "dot"
}

type Building = { f: string; x: boolean } | { d: Map<string, Building> } | { l: string }

const frozen = (node: Building): Tree =>
  "d" in node ? { d: Object.fromEntries([...node.d].map(([part, child]) => [part, frozen(child)])) } : node

interface World {
  readonly tree: Tree
  /** Every name in the tree, as an absolute path. */
  readonly paths: ReadonlyArray<string>
}

/** Builds a tree by adding one node a step, each under a directory already there. */
const grow = (steps: ReadonlyArray<Step>, top: ReadonlyArray<string> = []): World => {
  const root: { d: Map<string, Building> } = { d: new Map() }
  const directories: Array<{ readonly path: string; readonly node: { d: Map<string, Building> } }> = [
    { path: "", node: root }
  ]
  const paths: Array<string> = []
  for (const part of top) {
    const node = { d: new Map<string, Building>() }
    root.d.set(part, node)
    directories.push({ path: `/${part}`, node })
    paths.push(`/${part}`)
  }
  for (const step of steps) {
    const parent = directories[step.parent % directories.length]!
    if (parent.node.d.has(step.name)) continue
    const path = `${parent.path}/${step.name}`
    if (step.kind === "d") {
      const node = { d: new Map<string, Building>() }
      parent.node.d.set(step.name, node)
      directories.push({ path, node })
    } else if (step.kind === "f") parent.node.d.set(step.name, { f: step.text, x: step.exec })
    else {
      const aim = paths.length === 0 ? "/nothing" : paths[step.target % paths.length]!
      const target = step.shape === "absolute"
        ? aim
        : step.shape === "sibling"
        ? aim.slice(aim.lastIndexOf("/") + 1)
        : step.shape === "self"
        ? step.name
        : step.shape === "up"
        ? `..${aim}`
        : step.shape === "dot"
        ? `./${aim.slice(1)}`
        : "nowhere/at/all"
      parent.node.d.set(step.name, { l: target })
    }
    paths.push(path)
  }
  return { tree: frozen(root), paths }
}

const step = (names: A.Arbitrary<string>, texts: A.Arbitrary<string>): A.Arbitrary<Step> =>
  A.all({
    parent: int(40),
    name: names,
    kind: pick(["f", "f", "d", "d", "l"]),
    text: texts,
    exec: flag,
    target: int(40),
    shape: pick(["absolute", "sibling", "self", "up", "missing", "dot"])
  })

const steps = A.array(step(name, anyText), { maxLength: 14 })

/** A path to ask about: a name of the tree, as it is or with something after it. */
const asked = A.all({
  at: int(40),
  tail: pick(["", "", "", "/", "/.", "/..", "/x", "/../a", "//", "/./."]),
  bare: flag
})
const pathIn = (
  world: World,
  choice: { readonly at: number; readonly tail: string; readonly bare: boolean }
): string => {
  const base = world.paths.length === 0 ? "/x" : world.paths[choice.at % world.paths.length]!
  const path = `${base}${choice.tail}`
  return choice.bare && choice.at % 7 === 0 ? path.slice(1) : path
}

// --- Texts, digests ---------------------------------------------------------------------------------------------

describe("digests and held values", () => {
  check(
    "agrees with the specification's SHA-256 and heldAs on any text",
    property(A.all({ text: anyText, repeat: int(200) }), 9001, 200, async ({ text, repeat }) => {
      const long = text.repeat(repeat % 5 === 0 ? repeat : 1)
      expect(await oracle.ask({ op: "sha256", text: long })).toBe(createHash("sha256").update(long).digest("hex"))
      expect(await oracle.ask({ op: "heldAs", value: text })).toBe(Reads.heldAs(text))
    })
  )

  check("holds an unset variable as `-` and block boundaries of the digest", async () => {
    expect(await oracle.ask({ op: "heldAs", value: null })).toBe(Reads.heldAs(undefined))
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000]) {
      const text = "x".repeat(length)
      expect(await oracle.ask({ op: "sha256", text })).toBe(createHash("sha256").update(text).digest("hex"))
      cases += 1
    }
  })
})

// --- Trace lines ------------------------------------------------------------------------------------------------

const spaces = pick([" ", "  ", "\t", "\n", " ", " ", "﻿", "　", ""])
const lexical = A.array(
  pick([
    "\"",
    "\\",
    ",",
    ", ",
    " ",
    "<",
    ">",
    ">, ",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "= ",
    " = ",
    ") = ",
    "3",
    "07",
    "AT_FDCWD",
    "O_RDONLY",
    "a",
    "é",
    "猫",
    "😀",
    "\n",
    " ",
    "/tmp/x",
    "-1 ENOENT"
  ]),
  { maxLength: 14 }
)
const fragment = A.map(lexical, (parts) => parts.join(""))

describe("reading a line of a trace", () => {
  check(
    "splits a line into its process id and the rest as the specification does",
    property(
      A.all({
        digits: A.array(pick(["0", "1", "7", "9", "42", "00"]), { maxLength: 9 }),
        gap: A.array(spaces, { maxLength: 3 }),
        rest: fragment,
        any: anyText,
        whole: flag
      }),
      9101,
      300,
      async ({ digits, gap, rest, any, whole }) => {
        const line = whole ? any : `${digits.join("")}${gap.join("")}${rest}`
        const expected = await oracle.ask<{ readonly pid: string; readonly rest: string } | null>({ op: "pidOf", line })
        const actual = Reads.pidOf(line)
        if (expected === null) expect(actual).toBeUndefined()
        // A process id is a number below 2^22. `pidOf` reads longer digits as a double: the nearest one is asked for.
        else expect(actual).toEqual({ pid: Number(expected.pid), rest: expected.rest })
      }
    )
  )

  check(
    "reads a call's name, arguments and answer as the specification does",
    property(
      A.all({
        name: pick(["openat", "stat", "a_1", "", "é", "open at", "9", "_"]),
        body: fragment,
        gap: A.array(spaces, { maxLength: 2 }),
        answer: fragment,
        cut: int(60),
        shape: pick(["call", "call", "cut", "bare", "noAnswer", "text"]),
        any: anyText
      }),
      9102,
      400,
      async ({ name, body, gap, answer, cut, shape, any }) => {
        const call = `${name}(${body})${gap.join("")}= ${answer}`
        const text = shape === "call"
          ? call
          : shape === "cut"
          ? call.slice(0, cut)
          : shape === "bare"
          ? `${name}${body}`
          : shape === "noAnswer"
          ? `${name}(${body})`
          : any
        const expected = await oracle.ask<{ readonly name: string } | null>({ op: "callOf", text: wellFormed(text) })
        expect(Reads.callOf(wellFormed(text)) ?? null).toEqual(expected)
      }
    )
  )

  check(
    "splits a call's arguments as the specification does",
    property(A.all({ body: fragment, any: anyText, whole: flag }), 9103, 400, async ({ body, any, whole }) => {
      const text = whole ? any : body
      expect(Reads.split(text)).toEqual(await oracle.ask({ op: "split", text }))
    })
  )

  check("splits the arguments of calls a tracer prints", async () => {
    for (
      const text of [
        "",
        " ",
        ",",
        "AT_FDCWD, \"a,b\", O_RDONLY",
        "3</tmp/a, b>, \"x\"",
        "3</tmp/a>b>",
        "3</tmp/a>,b>, 1",
        "AT_FDCWD</work>, \"f\\\"\\\\\", {st_mode=S_IFREG|0644, st_size=3}, 0",
        "\"unterminated, text",
        "\"a\\\\\", \"b\"",
        "x<1, 2>, 3",
        "[\"a,b\", \"c)\"], []",
        "), 1, (2",
        "3< , >, x>, y"
      ]
    ) {
      expect(Reads.split(text), JSON.stringify(text)).toEqual(await oracle.ask({ op: "split", text }))
      cases += 1
    }
  })

  const root = "/work"
  const header = "1 +++ smthrs-observe 1 +++"
  const seal = "1 +++ complete +++"
  type Seen =
    | { readonly found: string }
    | { readonly missing: string }
    | { readonly unreadable: string }
    | { readonly other: true }
  /** What `read` made of one line: the path it found or found missing, or the refusal it gave. */
  const seenBy = (lines: ReadonlyArray<string>): Seen | { readonly refused: string } => {
    const trace = Reads.read(() => lines, root)
    if (trace.refusals.length > 0) return { refused: trace.refusals[0]! }
    const found = [...trace.found.keys()]
    const missing = [...trace.missing.keys()]
    if (found.length === 1 && missing.length === 0) return { found: found[0]! }
    if (found.length === 0 && missing.length === 1) return { missing: missing[0]! }
    return { other: true }
  }
  const encodings = ["raw", "raw", "octal", "hex", "short", "letter"] as const
  /** A character as a tracer may print it inside a quoted string. */
  const printed = (character: string, how: typeof encodings[number]): string => {
    const bytes = [...Buffer.from(character)]
    if (how === "octal") return bytes.map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("")
    if (how === "hex") return bytes.map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("")
    if (how === "short") return bytes.map((byte) => `\\${byte.toString(8)}`).join("")
    if (character === "\"" || character === "\\") return `\\${character}`
    if (how === "letter" && character === "\n") return "\\n"
    if (how === "letter" && character === "\t") return "\\t"
    return character
  }
  const supplementary = /[\u{10000}-\u{10FFFF}]/u

  check(
    "reads the path of an open, however the tracer escaped it, as the specification does",
    property(
      A.all({
        parts: A.array(
          A.all({
            text: pick([...pieces, "/", "/", "//", "/./", "/../", "x", "7", "\u0001", "\u007f", "ÿ"]),
            how: pick(encodings)
          }),
          { maxLength: 8 }
        ),
        absolute: flag,
        answer: pick(["3", "3", "-1 ENOENT (No such file or directory)", "-1 ENOTDIR (Not a directory)"]),
        spoil: pick(["", "", "", "", "\\", "\\q", "\\x4", "\\9", "\\u0041"])
      }),
      9104,
      500,
      async ({ parts, absolute, answer, spoil }) => {
        const body = parts.map(({ text, how }) => [...text].map((character) => printed(character, how)).join("")).join(
          ""
        )
        // A digit after a short octal escape would be read into it: such a text names another path, on both sides.
        const quoted = `"${absolute ? "/q" : ""}${body}${spoil}"`
        const call = `1 openat(AT_FDCWD, ${quoted}, O_RDONLY) = ${answer}`
        const expected = await oracle.ask<Seen>({ op: "openLine", cwd: root, line: call })
        if ("found" in expected && /^\/(?:proc|sys|dev)(?:\/|$)/.test(expected.found)) return
        if ("missing" in expected && /^\/(?:proc|sys|dev)(?:\/|$)/.test(expected.missing)) return
        for (const lines of [[call], [header, call, seal]]) {
          const actual = seenBy(lines)
          if ("unreadable" in expected) {
            seen.unreadable += 1
            expect(actual).toEqual({
              refused: `its trace holds a path that cannot be read: ${expected.unreadable.slice(0, 80)}`
            })
            continue
          }
          if (supplementary.test(quoted) && quoted.slice(1, -1).includes("\\") && !("other" in expected)) {
            // Known difference (deferred in ObservedReads.fuzz.test.ts, "keeps an unescaped supplementary character
            // beside an escape"): `unquote` decodes a string that holds an escape one UTF-16 code unit at a time, so
            // a character above U+FFFF that the tracer left unescaped becomes two U+FFFD. The specification keeps it.
            const broken = await oracle.ask<Seen>({
              op: "openLine",
              cwd: root,
              line: call.replace(/[\u{10000}-\u{10FFFF}]/gu, "��")
            })
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              gaps.supplementary += 1
              expect(actual).toEqual(broken)
            }
            continue
          }
          expect(actual, JSON.stringify(call)).toEqual(expected)
        }
      }
    )
  )

  check(
    "writes a path in one spelling as the specification does",
    property(
      A.array(pick(["/", "/", ".", "..", "a", "é", "\n", "\r", " ", " ", "//", "/./", "/."]), { maxLength: 9 }),
      9105,
      300,
      async (parts) => {
        // `spelled` is not exported: an open of an absolute path shows it.
        const path = `/q${parts.join("")}`
        const call = `1 openat(AT_FDCWD, ${JSON.stringify(path).replace(/\\u2028/g, " ")}, O_RDONLY) = 3`
        const expected = await oracle.ask<string>({ op: "spelled", path })
        // JSON.stringify writes a line end as `\n` or `\r`, which are the tracer's escapes too.
        expect(seenBy([call])).toEqual({ found: expected })
      }
    )
  )
})

// --- Records ----------------------------------------------------------------------------------------------------

/** A JSON value as both sides are given it: through its text, with every string well formed. */
const throughJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, part: unknown) => typeof part === "string" ? wellFormed(part) : part) ?? "null")

const fullRecord = (label: string, path: string) => {
  const body = {
    reads: [[path, "state", "-"], [`${path}2`, "d"]],
    lists: [["dir", "digest", ["own"], [["entry", 0, "f"]]], ["other", "digest", []]],
    links: [["dir", 3, ["own"], [["entry", 0]]], ["other", 2, []]],
    from: [[label, "prior"]],
    given: [[path, "state", 0], [path, "changed", 0, "prior"]],
    left: true,
    made: [path],
    served: [[label, "service"]],
    running: true,
    variables: [["VAR", "-"]],
    kept: { archive: "a".repeat(64), gone: [path], outside: [["/outside", "state"]] }
  } as const
  return { ...body, id: Reads.idOf(body as unknown as Reads.Record) }
}

interface Shape {
  readonly shape: boolean
  readonly programs: boolean
  readonly record: boolean
}

const decoded = async (input: unknown): Promise<void> => {
  const value = throughJson(input)
  const expected = await oracle.ask<Shape>({ op: "isRecord", rules, value })
  const actual = Reads.asRecord(value)
  // `asRecord` makes the test the specification calls `isRecord`: the shape of the paths, and `running` and
  // `served` held to their types, which `changed` and `idOf` read.
  expect(expected.record).toBe(expected.shape && expected.programs)
  expect(actual !== undefined, JSON.stringify(value)).toBe(expected.record)
  seen[actual === undefined ? "invalid" : "valid"] += 1
  if (expected.shape && !expected.programs) refusedForPrograms += 1
  if (actual === undefined) return
  expect(Reads.pathsOf(actual)).toBe(await oracle.ask({ op: "pathsOf", rules, value }))
  expect(Reads.idOf(actual)).toBe(await oracle.ask({ op: "idOf", rules, value }))
}

const recordField = pick([
  "reads",
  "lists",
  "links",
  "id",
  "given",
  "from",
  "made",
  "left",
  "variables",
  "kept",
  "running",
  "served",
  "__proto__"
])

describe("records read back from disk", () => {
  check(
    "accepts exactly the shapes the specification accepts, with the same count of paths and the same id",
    property(
      A.all({ value: A.schema(S.Json), label: anyText, path: name, field: recordField, other: recordField }),
      9201,
      300,
      async ({ value, label, path, field, other }) => {
        const base = fullRecord(label, path)
        await decoded(base)
        await decoded(value)
        await decoded({ ...base, [field]: value })
        await decoded({ ...base, [field]: undefined, [other]: [value] })
        await decoded({ ...base, [field]: [[value, value, value]] })
      }
    )
  )

  check("agrees on each corner of the shape", async () => {
    const base = fullRecord("//:step", "src/a.c")
    const corners: ReadonlyArray<unknown> = [
      null,
      [],
      "record",
      0,
      {},
      { id: "", reads: [], lists: [] },
      { id: "", reads: [], lists: [], running: false },
      { id: "", reads: [], lists: [], running: true },
      { id: "", reads: [], lists: [], served: 0 },
      { id: "", reads: [], lists: [], served: [["a"]] },
      { id: "", reads: [], lists: [], served: [["a", "b"]] },
      { id: "", reads: [], lists: [], links: 0 },
      { id: "", reads: [], lists: [], links: [["d", 1.5, []]] },
      { id: "", reads: [], lists: [], links: [["d", -1, []]] },
      { id: "", reads: [], lists: [], links: [["d", "1", []]] },
      { id: "", reads: [], lists: [], links: [["d", 1, [], [["n", 0]]]] },
      { id: "", reads: null, lists: [] },
      { id: 1, reads: [], lists: [] },
      { ...base, left: false },
      { ...base, left: null },
      { ...base, from: null },
      { ...base, made: null },
      { ...base, kept: null },
      { ...base, kept: [] },
      { ...base, kept: { ...base.kept, archive: "A".repeat(64) } },
      { ...base, kept: { ...base.kept, archive: `${"a".repeat(64)}\n` } },
      { ...base, kept: { ...base.kept, archive: "a".repeat(63) } },
      { ...base, kept: { ...base.kept, outside: [["p"]] } },
      { ...base, kept: { ...base.kept, gone: [1] } },
      { ...base, reads: [["p"]] },
      { ...base, reads: [["p", "s", "o", "x"]] },
      { ...base, reads: [["p", 1]] },
      { ...base, given: [["p", "s", 0, "?", "extra"]] },
      { ...base, given: [["p", "s", 0, null]] },
      { ...base, lists: [["p", "d", [], [], []]] },
      { ...base, lists: [["p", "d", [], null]] },
      { ...base, lists: [["p", "d", [1]]] },
      ...[-1, 0, 0.5, 1, 1e21, -0, "0", null, true].flatMap((place) => [
        { ...base, given: [["p", "s", place]] },
        { ...base, given: [["p", "s", place, "prior"]] },
        { ...base, lists: [["p", "d", [], [["n", place]]]] },
        { ...base, links: [["p", 1, [], [["n", place]]]] }
      ])
    ]
    for (const corner of corners) {
      await decoded(corner)
      cases += 1
    }
    // A `running` and a `served` of another type are among the corners, and neither is a record.
    expect(refusedForPrograms).toBeGreaterThan(0)
  })

  interface StoredShape {
    readonly kind: string
    readonly format: string
    readonly ids: ReadonlyArray<string>
    readonly paths: ReadonlyArray<number>
    readonly kept: ReadonlyArray<string | null>
  }

  check(
    "stores a history as the specification does: newest first, one record an id, at most four",
    property(
      A.array(A.all({ id: int(6), reads: int(3), given: int(2) }), { minLength: 1, maxLength: 12 }),
      9202,
      300,
      async (rows) => {
        let stored: ReadonlyArray<Reads.Record> = []
        for (const [index, row] of rows.entries()) {
          const added: Reads.Record = {
            id: `id-${row.id}`,
            reads: Array.from({ length: row.reads }, (_, at) => [`r${at}`, "-"] as const),
            lists: [["d", "digest", []]],
            from: [["step", "s"]],
            given: Array.from({ length: row.given }, (_, at) => [`g${at}`, "-", 0] as const),
            kept: { archive: index.toString(16).padStart(64, "0"), gone: [], outside: [] }
          }
          const expected = await oracle.ask<StoredShape | null>({ op: "store", rules, added, earlier: stored })
          const actual = Reads.store(added, stored)
          expect(actual === undefined).toBe(expected === null)
          if (actual === undefined || expected === null) return
          expect({
            kind: actual.kind,
            format: actual.format,
            ids: actual.records.map((record) => record.id),
            paths: actual.records.map(Reads.pathsOf),
            kept: actual.records.map((record) => record.kept?.archive ?? null)
          }).toEqual(expected)
          // The theorems of Record.lean, on this history: the new record first, at most four, each id once.
          expect(actual.records[0]).toBe(added)
          expect(actual.records.length).toBeLessThanOrEqual(Reads.maximumRecords)
          expect(new Set(expected.ids).size).toBe(expected.ids.length)
          for (const record of actual.records.slice(1)) expect(stored).toContain(record)
          stored = actual.records
        }
      }
    )
  )

  check("refuses a record over the bound of paths exactly where the specification does", async () => {
    const rows = Array<readonly [string, string]>(Reads.maximumPaths - 1).fill(["a", "s"])
    const within: Reads.Record = { id: "big", reads: rows, lists: [["d", "digest", []]] }
    const over: Reads.Record = { ...within, from: [["step", "s"]], given: [["g", "s", 0]] }
    expect(Reads.pathsOf(within)).toBe(Reads.maximumPaths)
    for (const added of [within, over]) {
      const expected = await oracle.ask<StoredShape | null>({ op: "store", rules, added, earlier: [] })
      expect(Reads.store(added, []) === undefined).toBe(expected === null)
      expect(await oracle.ask({ op: "pathsOf", rules, value: added })).toBe(Reads.pathsOf(added))
      cases += 1
    }
    expect(Reads.store(over, [])).toBeUndefined()
  })
})

// --- measure, listing, dirLinks ---------------------------------------------------------------------------------

/**
 * `dirLinks` as `u3` defines it, for a build of the implementation that does not have it yet: a directory's link
 * count less the directories among `own` in it.
 */
const dirLinksOf = (path: string, own: ReadonlyArray<string>, io: Reads.Io): number | undefined => {
  if (exported.dirLinks !== undefined) return exported.dirLinks(path, own, io)
  try {
    const stats = io.lstat(path)
    if (!stats.isDirectory()) return undefined
    let extra = 0
    for (const part of new Set(own)) {
      try {
        if (io.lstat(path === "/" ? `/${part}` : `${path}/${part}`).isDirectory()) extra += 1
      } catch {
        // Nothing is there.
      }
    }
    return stats.nlink - extra
  } catch {
    return undefined
  }
}

/** Symbolic links one path may pass through in the specification (`maximumLinks`, Linux's `MAXSYMLINKS`). */
const maximumLinks = 40

/** A chain of `length` links to a file, then the same chain closed into a cycle. */
const chain = (length: number): { readonly open: Tree; readonly closed: Tree } => {
  const links = Object.fromEntries(
    Array.from({ length }, (_, at) => [`s${at}`, { l: at + 1 === length ? "leaf" : `s${at + 1}` }] as const)
  )
  return {
    open: { d: { ...links, leaf: { f: "leaf", x: false } } },
    closed: { d: { ...links, [`s${length - 1}`]: { l: "s0" }, leaf: { f: "leaf", x: false } } }
  }
}

describe("measuring a file system", () => {
  check(
    "measures, lists and counts the links of any path of any tree as the specification does",
    property(
      A.all({
        steps,
        asks: A.array(asked, { minLength: 1, maxLength: 6 }),
        own: A.array(name, { maxLength: 4 }),
        pickOwn: int(40)
      }),
      9301,
      400,
      async ({ steps, asks, own, pickOwn }) => {
        const world = grow(steps)
        const io = memory(world.tree)
        for (const choice of asks) {
          const path = pathIn(world, choice)
          expect(Reads.measure(path, io), JSON.stringify(path)).toBe(
            await oracle.ask({ op: "measure", fs: world.tree, path })
          )
          let entries: ReadonlyArray<string> = []
          try {
            entries = io.readdir(path)
          } catch {
            // Not a directory.
          }
          const names = [...own, ...entries.filter((_, at) => (at + pickOwn) % 3 === 0), "..", "."]
          expect(Reads.listing(path, names, io) ?? null).toBe(
            await oracle.ask({ op: "listing", fs: world.tree, path, own: names })
          )
          expect(dirLinksOf(path, names, io) ?? null).toBe(
            await oracle.ask({ op: "dirLinks", fs: world.tree, path, own: names })
          )
        }
      }
    )
  )

  check("distinguishes FIFO, socket, character device and block device entries", async () => {
    const digests = new Set<string>()
    for (const mode of [0o010000, 0o140000, 0o020000, 0o060000]) {
      const fs: Tree = { d: { child: { o: mode } } }
      const digest = Reads.listing("/", [], memory(fs))!
      expect(digest).toBe(await oracle.ask({ op: "listing", fs, path: "/", own: [] }))
      digests.add(digest)
      cases += 1
    }
    expect(digests.size).toBe(4)
  })

  check("includes entry types and visible direct and nested mounts in the listing", async () => {
    const fs: Tree = {
      d: {
        private: { d: { leaf: { l: "elsewhere" }, hidden: { f: "stub", x: false } } },
        sources: { d: { tool: { f: "tool", x: true }, alias: { l: "tool" }, dir: { d: {} } } }
      }
    }
    const parent = ["/tmp", "/private"] as const
    const direct = ["/tmp/hidden", "/sources/tool"] as const
    const nested = ["/tmp/nested/path", "/sources/dir"] as const
    const digests = new Set<string>()
    for (const mounts of [[parent], [parent, direct], [parent, nested], [parent, direct, nested]]) {
      const digest = Reads.listing("/private", [], memory(fs), mounts)
      expect(digest).toBeDefined()
      expect(await oracle.ask({ op: "listing", fs, path: "/private", own: [], mounts })).toBe(digest)
      digests.add(digest!)
      cases += 1
    }
    expect(digests.size).toBe(4)
    const viaLink = [parent, ["/tmp/hidden", "/sources/alias"] as const]
    const digest = Reads.listing("/private", [], memory(fs), viaLink)
    expect(digest).toBe(Reads.listing("/private", [], memory(fs), [parent, direct]))
    expect(await oracle.ask({ op: "listing", fs, path: "/private", own: [], mounts: viaLink })).toBe(digest)
    cases += 1
  })

  check("holds a directory listing against the current outer mount, even without child mounts", async () => {
    const tree: Tree = { d: { tmp: { d: {} }, original: { d: { sub: { d: {} } } }, replacement: { d: {} } } }
    const io = memory(tree)
    const original = [["/tmp", "/original"]] as const
    const replacement = [["/tmp", "/replacement"]] as const
    const shadowed = [["/tmp/sub", "/replacement"], ...original] as const
    const casesOf = [
      { path: "/original", before: original, after: original, changed: false },
      { path: "/original", before: original, after: [], changed: true },
      { path: "/original", before: original, after: replacement, changed: true },
      { path: "/tmp", before: [], after: original, changed: true },
      { path: "/original/sub", before: original, after: shadowed, changed: true }
    ] as const
    for (const { after, before, changed, path } of casesOf) {
      const digest = Reads.listing(path, [], io, before)!
      const record = { id: "", reads: [], lists: [[path, digest, []]] } as const
      const measured = (name: string) => Reads.measure(name, io)
      const actual = Reads.changed(record, "/", measured, { ...io, mounts: () => after }) ?? null
      const expected = await oracle.ask({ op: "changed", rules, record, world: { fs: tree, root: "/", mounts: after } })
      expect(actual).toBe(expected)
      expect(actual !== null).toBe(changed)
      cases += 1
    }
  })

  check("follows 40 symbolic links and no more, and ends on a cycle", async () => {
    for (const length of [1, 2, 39, 40, 41, 42, 60]) {
      const { closed, open } = chain(length)
      for (
        const [tree, path] of [[open, "/s0"], [open, "/s0/"], [open, "/s0/x"], [closed, "/s0/x"], [
          closed,
          "/s0/"
        ]] as const
      ) {
        const expected = await oracle.ask<string>({ op: "measure", fs: tree, path })
        expect(Reads.measure(path, memory(tree)), `${length} ${path}`).toBe(expected)
        cases += 1
      }
      // A name followed through the chain: found up to 40 links, `ELOOP` beyond, and always on a cycle.
      expect(await oracle.ask({ op: "measure", fs: open, path: "/s0/" })).toBe(length <= 40 ? "-" : "!ELOOP")
      expect(await oracle.ask({ op: "measure", fs: closed, path: "/s0/x" })).toBe("!ELOOP")
      expect(await oracle.ask({ op: "listing", fs: closed, path: "/s0", own: [] })).toBe(null)
    }
  })

  // The specification's file system is held against the host's: the same trees, made on disk.
  const realName = A.map(
    A.array(pick(["a", "b", "é", "猫", "😀", " ", "\"", "\\", "'", "\n", "-", ".", "..", "$"]), {
      minLength: 1,
      maxLength: 3
    }),
    (parts) => `zq${parts.join("")}`
  )
  const realSteps = A.array(step(realName, anyText), { maxLength: 10 })
  let scratch = ""
  /**
   * Whether the host's file system counts a directory's links as POSIX file systems do: 2 and one a directory in it.
   * A file in it adds none; APFS counts it as well.
   */
  let countsLinks = false
  /** The most symbolic links one path on this host may pass through: 40 on Linux, 31 on Darwin. */
  let hostLinks = 0
  beforeAll(() => {
    if (!oracleReady) return
    scratch = NodeFs.realpathSync(NodeFs.mkdtempSync(join(tmpdir(), "lean-diff-")))
    NodeFs.mkdirSync(join(scratch, "probe", "inner"), { recursive: true })
    NodeFs.writeFileSync(join(scratch, "probe", "file"), "")
    countsLinks = NodeFs.lstatSync(join(scratch, "probe")).nlink === 3
    const follows = (length: number): boolean => {
      const base = join(scratch, `links${length}`)
      onDisk(base, chain(length).open)
      return Reads.measure(`${base}/s0/`) !== "!ELOOP"
    }
    let low = 1
    let high = 128
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (follows(middle)) low = middle
      else high = middle - 1
    }
    hostLinks = low
  })
  afterAll(() => {
    if (scratch !== "") NodeFs.rmSync(scratch, { recursive: true, force: true })
  })
  /** Makes a tree on disk under `base`, an absolute link target read from `base`. Answers the tree as it is from `/`. */
  const onDisk = (base: string, tree: Tree): Tree => {
    const make = (path: string, node: Tree): Tree => {
      if ("d" in node) {
        NodeFs.mkdirSync(path, { recursive: true })
        return {
          d: Object.fromEntries(Object.entries(node.d).map(([part, child]) => [part, make(`${path}/${part}`, child)]))
        }
      }
      if ("l" in node) {
        const target = node.l.startsWith("/") ? `${base}${node.l}` : node.l
        NodeFs.symlinkSync(target, path)
        return { l: target }
      }
      if ("o" in node) return fail("ENOTSUP")
      NodeFs.writeFileSync(path, node.f, { mode: node.x ? 0o755 : 0o644 })
      NodeFs.chmodSync(path, node.x ? 0o755 : 0o644)
      return node
    }
    const made = make(base, tree)
    return base.split("/").filter((part) => part !== "").reduceRight<Tree>(
      (inner, part) => ({ d: { [part]: inner } }),
      made
    )
  }
  let made = 0

  check(
    "agrees with the kernel of this host on the same trees made on disk",
    property(
      A.all({ steps: realSteps, asks: A.array(asked, { minLength: 1, maxLength: 5 }), pickOwn: int(40) }),
      9302,
      200,
      async ({ steps, asks, pickOwn }) => {
        const world = grow(steps)
        const base = join(scratch, `t${made += 1}`)
        const fs = onDisk(base, world.tree)
        for (const choice of asks) {
          const local = pathIn(world, { ...choice, bare: false })
          // A path that climbs out of the tree would read this host's own directories.
          if (local.includes("..") && local.split("/").filter((part) => part === "..").length > 1) continue
          const path = `${base}${local}`
          expect(await oracle.ask({ op: "measure", fs, path }), JSON.stringify(local)).toBe(Reads.measure(path))
          let entries: ReadonlyArray<string> = []
          try {
            entries = NodeFs.readdirSync(path)
          } catch {
            // Not a directory.
          }
          const own = entries.filter((_, at) => (at + pickOwn) % 2 === 0)
          expect(await oracle.ask({ op: "listing", fs, path, own })).toBe(Reads.listing(path, own) ?? null)
          if (countsLinks) {
            expect(await oracle.ask({ op: "dirLinks", fs, path, own })).toBe(
              dirLinksOf(path, own, Reads.defaultIo) ?? null
            )
          }
        }
        NodeFs.rmSync(base, { recursive: true, force: true })
      }
    )
  )

  check("agrees with the kernel of this host on chains and cycles of links", async () => {
    expect(hostLinks).toBeGreaterThan(0)
    for (const length of [1, 39, 40, 41, 45]) {
      const { closed, open } = chain(length)
      // The specification follows 40 links; a host with another limit is held to it only where the two agree.
      const sameLimit = (length <= maximumLinks) === (length <= hostLinks)
      for (
        const [tree, local] of [[open, "/s0/"], [open, "/s0/x"], [open, "/s0"], [closed, "/s0/x"], [
          closed,
          "/s0/"
        ]] as const
      ) {
        if (tree === open && !sameLimit) continue
        const base = join(scratch, `c${made += 1}`)
        const fs = onDisk(base, tree)
        expect(await oracle.ask({ op: "measure", fs, path: `${base}${local}` }), `${length} ${local}`).toBe(
          Reads.measure(`${base}${local}`)
        )
        cases += 1
      }
    }
  })
})

// --- changed and observe ----------------------------------------------------------------------------------------

const workspace = "/w"
const inside = (path: string): string =>
  path === workspace ? "." : path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1) : path
const quietText = A.map(A.array(pick(["a", "b", "1", " ", "é", "\n"]), { maxLength: 6 }), (parts) => parts.join(""))
const workspaceSteps = A.array(step(name, quietText), { maxLength: 12 })
const stateChoice = pick(["actual", "actual", "actual", "-", "d", "l:x", "zeros", "?"])
const stateFrom = (choice: string, actual: string): string =>
  choice === "actual" ? actual : choice === "zeros" ? `f:${"0".repeat(64)}` : choice
const label = pick(["//:a", "//:b", "c", "__proto__"])
const recordId = pick(["i1", "i2"])
const answers = A.array(A.all({ label, ids: A.array(recordId, { maxLength: 2 }) }), { maxLength: 3 })
const answersOf = (rows: ReadonlyArray<{ readonly label: string; readonly ids: ReadonlyArray<string> }>) => {
  const byLabel = new Map(rows.map((row) => [row.label, row.ids] as const))
  return {
    ask: (asked: string): ReadonlySet<string> | undefined =>
      byLabel.has(asked) ? new Set(byLabel.get(asked)) : undefined,
    json: Object.fromEntries(byLabel)
  }
}
const placeIn = A.all({ at: int(40), tail: pick(["", "", "", "/x", "/"]) })
const directoryRow = A.all({
  place: placeIn,
  ownPick: int(5),
  extra: A.array(name, { maxLength: 2 }),
  held: pick(["actual", "actual", "actual", "bogus"]),
  added: A.array(A.all({ name, place: int(3) }), { maxLength: 2 }),
  hasAdded: flag
})

const changedCase = A.all({
  steps: workspaceSteps,
  reads: A.array(
    A.all({ place: placeIn, state: stateChoice, other: pick(["none", "none", "actual", "-", "?", "zeros", "state"]) }),
    { maxLength: 5 }
  ),
  lists: A.array(directoryRow, { maxLength: 3 }),
  links: A.array(directoryRow, { maxLength: 3 }),
  from: A.array(A.all({ label, id: recordId }), { maxLength: 3 }),
  given: A.array(
    A.all({
      place: placeIn,
      state: stateChoice,
      from: int(3),
      prior: pick(["none", "none", "actual", "?", "*", "f:*", "-"])
    }),
    { maxLength: 3 }
  ),
  left: flag,
  answered: answers,
  programs: A.array(A.all({ label, id: recordId }), { maxLength: 2 }),
  served: answers,
  made: A.array(placeIn, { maxLength: 3 }),
  hasMade: flag,
  holds: pick(["unknown", "nothing", "everything", "first"]),
  variables: A.array(
    A.all({
      name: pick(["A", "B", "C"]),
      value: pick(["v1", "v2", "unset"]),
      held: pick(["actual", "actual", "-", "x"])
    }),
    { maxLength: 3 }
  ),
  own: A.array(int(40), { maxLength: 3 }),
  // Which part of the record may differ from the file system: with all of them free, the first one always answers.
  noise: pick(["all", "programs", "variables", "reads", "made", "from", "given", "links", "lists", "none", "none"])
})

describe("holding a record against a file system", () => {
  check(
    "says what changed, in the same words, as the specification does",
    property(changedCase, 9401, 500, async (input) => {
      const world = grow(input.steps, ["w"])
      const io = memory(world.tree)
      const at = (place: { readonly at: number; readonly tail: string }): string =>
        `${world.paths[place.at % world.paths.length]!}${place.tail}`
      const measured = (path: string): string => Reads.measure(path, io)
      const free = (part: string): boolean => input.noise === "all" || input.noise === part
      const from = input.from.map(({ id, label }) => [label, id] as const)
      const places = from.length
      const directory = (row: typeof input.lists[number]) => {
        const path = at(row.place)
        let entries: ReadonlyArray<string> = []
        try {
          entries = io.readdir(path)
        } catch {
          // Not a directory.
        }
        const own = [...entries.filter((_, index) => index % 5 < row.ownPick), ...row.extra]
        const added = row.hasAdded && places > 0
          ? row.added.map((entry) => [entry.name, entry.place % places] as const)
          : undefined
        return { path, own, added, all: [...own, ...(added ?? []).map(([part]) => part)] }
      }
      const values = Object.fromEntries(
        input.variables.map((row) => [row.name, row.value === "unset" ? undefined : row.value])
      )
      const made = input.made.map((place) => inside(at(place)))
      const record = {
        id: "record",
        ...(input.left ? { left: true } : {}),
        reads: input.reads.map((row) => {
          const actual = measured(at(row.place))
          const state = free("reads") ? stateFrom(row.state, actual) : actual
          return row.other === "none" || !free("reads")
            ? [inside(at(row.place)), state] as const
            : [inside(at(row.place)), state, row.other === "state" ? state : stateFrom(row.other, actual)] as const
        }),
        lists: input.lists.map((row) => {
          const { added, all, own, path } = directory(row)
          const digest = row.held === "actual" || !free("lists")
            ? Reads.listing(path, all, io) ?? "none"
            : "0".repeat(64)
          return added === undefined
            ? [inside(path), digest, own] as const
            : [inside(path), digest, own, added.map(([name, place]) => [name, place, "f"] as const)] as const
        }),
        links: input.links.map((row) => {
          const { added, all, own, path } = directory(row)
          const count = (dirLinksOf(path, all, io) ?? 7) + (row.held === "actual" || !free("links") ? 0 : 1)
          return added === undefined ? [inside(path), count, own] as const : [inside(path), count, own, added] as const
        }),
        ...(places === 0 ? {} : {
          from,
          given: input.given.map((row) =>
            [
              inside(at(row.place)),
              free("given") ? stateFrom(row.state, measured(at(row.place))) : measured(at(row.place)),
              row.from % places,
              ...(free("given") && row.prior !== "none"
                ? [row.prior === "actual" ? measured(at(row.place)) : row.prior]
                : [])
            ] as const
          )
        }),
        ...(input.hasMade && free("made") ? { made } : {}),
        variables: input.variables.map((row) =>
          [row.name, row.held === "actual" || !free("variables") ? Reads.heldAs(values[row.name]) : row.held] as const
        ),
        served: free("programs") ? input.programs.map(({ id, label }) => [label, id] as const) : []
      }
      expect(Reads.asRecord(record)).toBeDefined()
      const answered = answersOf(free("from") || free("given") || free("lists") ? input.answered : [])
      const served = answersOf(input.served)
      const committed = input.holds === "unknown"
        ? null
        : input.holds === "nothing"
        ? []
        : input.holds === "everything"
        ? made
        : made.slice(0, 1)
      const own = input.own.map((index) => inside(world.paths[index % world.paths.length]!))
      const actual = Reads.changed(
        record as unknown as Reads.Record,
        workspace,
        measured,
        io,
        answered.ask,
        values,
        (path) => own.includes(path),
        served.ask,
        (names) => committed === null ? undefined : new Set(names.filter((part) => committed.includes(part)))
      )
      const expected = await oracle.ask<string | null>({
        op: "changed",
        rules,
        record,
        world: {
          fs: world.tree,
          root: workspace,
          values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null])),
          answered: answered.json,
          served: served.json,
          holds: committed,
          own
        }
      })
      expect(actual ?? null, JSON.stringify(record)).toBe(expected)
      seen[expected === null ? "held" : "changed"] += 1
      const words = expected === null
        ? "holds"
        : expected.replace(/^.*?(?=(?: is| now| changed| gained|, which| has)\b)/s, "…")
      said.set(
        words.startsWith("the ") ? words.replace(/ (?:\S+) (started|has)/, " … $1") : words,
        (said.get(words) ?? 0) + 1
      )
    })
  )

  check("holds a changed file as the specification's rule says", async () => {
    const tree: Tree = { d: { w: { d: { f: { f: "left", x: false }, d: { d: { sub: { d: {} } } } } } } }
    const io = memory(tree)
    const left = Reads.measure("/w/f", io)
    const ask = (record: object, holds?: ReadonlyArray<string>) =>
      oracle.ask<string | null>({
        op: "changed",
        rules,
        record,
        world: { fs: tree, root: workspace, values: {}, holds }
      })
    const hold = (record: object, holds?: ReadonlyArray<string>) =>
      Reads.changed(
        record as Reads.Record,
        workspace,
        (path) => Reads.measure(path, io),
        io,
        undefined,
        undefined,
        undefined,
        undefined,
        () => holds === undefined ? undefined : new Set(holds)
      ) ?? null
    const made = { id: "", reads: [["d", "d", "-"]], lists: [], made: ["d"], left: true } as const
    for (
      const [holds, expected] of [
        [["d"], "d, which the run made, is in the commit now"],
        [[], null],
        [undefined, "d changed"]
      ] as const
    ) {
      expect(hold(made, holds)).toBe(expected)
      expect(await ask(made, holds)).toBe(expected)
      cases += 1
    }
    for (
      const record of [
        { id: "", reads: [["f", left]], lists: [] },
        { id: "", reads: [["f", left, left]], lists: [] },
        // The file as the run left it, where the run found other bytes: a hit before `u2`, a miss under it.
        { id: "", reads: [["f", left, `f:${"0".repeat(64)}`]], lists: [] },
        { id: "", reads: [["f", `f:${"0".repeat(64)}`, left]], lists: [] },
        { id: "", reads: [["f", left, "?"]], lists: [] },
        { id: "", reads: [["f", left, "-"]], lists: [] },
        { id: "", reads: [["f", left, "-"]], lists: [], left: true },
        { id: "", reads: [["/w/f", left, "-"]], lists: [], left: true },
        { id: "", reads: [["gone", left, "-"]], lists: [] },
        { id: "", reads: [["gone", "-", left]], lists: [] },
        // A path the run found and removed, where something else is now: other, not new.
        { id: "", reads: [["f", "-", `f:${"0".repeat(64)}`]], lists: [] },
        { id: "", reads: [["f", "-", left]], lists: [] },
        // A name the run took away unseen: any name that is no directory holds, and nothing else.
        { id: "", reads: [["f", "-", "*"]], lists: [] },
        { id: "", reads: [["d", "-", "*"]], lists: [] },
        { id: "", reads: [["gone", "-", "*"]], lists: [] },
        // A state that says only that the path could not be read holds nothing, itself included.
        { id: "", reads: [["f", "!EACCES"]], lists: [] },
        { id: "", reads: [["f", left, "!EIO"]], lists: [] },
        { id: "", reads: [["f", "!EIO", "-"]], lists: [] },
        { id: "", reads: [["gone", "!EIO", "-"]], lists: [] },
        { id: "", reads: [["gone", "!ENOENT"]], lists: [] },
        { id: "", reads: [], lists: [], from: [["//:a", "1"]], given: [["f", "!EIO", 0]] },
        ...[left, "?", "*", "f:*", "-"].flatMap((prior) =>
          ["f", "d", "gone"].map((path) => ({
            id: "",
            reads: [],
            lists: [],
            from: [["//:a", "1"]],
            given: [[path, left, 0, prior]]
          }))
        ),
        // A directory made in a directory the run only looked at: a hit before `u3`, a miss under it.
        { id: "", reads: [["d", "d"]], lists: [], links: [["d", 3, []]] },
        { id: "", reads: [["d", "d"]], lists: [], links: [["d", 2, []]] },
        { id: "", reads: [["d", "d"]], lists: [], links: [["d", 2, ["sub"]]] }
      ]
    ) {
      expect(hold(record), JSON.stringify(record)).toBe(await ask(record))
      cases += 1
    }
    // What the rules say, whichever this build has: Theorem 5 and Theorem 6 of Soundness.lean.
    const stale = { id: "", reads: [["f", left, `f:${"0".repeat(64)}`]], lists: [] }
    expect(
      await oracle.ask({
        op: "changed",
        rules: { ...rules, u2: true },
        record: stale,
        world: { fs: tree, root: workspace, values: {} }
      })
    ).toBe("f changed")
    expect(
      await oracle.ask({
        op: "changed",
        rules: { ...rules, u2: false },
        record: stale,
        world: { fs: tree, root: workspace, values: {} }
      })
    ).toBe(null)
    const grown = { id: "", reads: [], lists: [], links: [["d", 2, []]] }
    expect(
      await oracle.ask({
        op: "changed",
        rules: { ...rules, u3: true },
        record: grown,
        world: { fs: tree, root: workspace, values: {} }
      })
    ).toBe("d gained or lost a subdirectory")
    expect(hold(stale)).toBe(rules.u2 ? "f changed" : null)
    expect(hold(grown)).toBe(rules.u3 ? "d gained or lost a subdirectory" : null)
  })

  check("refuses a listed producer entry whose kind changes after its producer reruns", async () => {
    const fs: Tree = { d: { w: { d: { generated: { d: {} } } } } }
    const io = memory(fs)
    const record = {
      id: "listing",
      reads: [],
      from: [["build", "1"]],
      lists: [[".", Reads.listing("/w", ["generated"], io)!, [], [["generated", 0, "f"]]]]
    } as const
    const changed = Reads.changed(record, "/w", undefined, io)
    expect(changed).toBe("generated changed type")
    expect(await oracle.ask({ op: "changed", rules, record, world: { fs, root: "/w" } })).toBe(changed)
    cases += 1
  })

  check("refuses a read below a renamed directory reached through a stable link", async () => {
    const fs: Tree = { d: { w: { d: { dir: { d: { data: { f: "", x: false } } }, link: { l: "dir" } } } } }
    const trace = {
      ...Reads.read(() => ["10 open(\"/w/link/data\", O_RDONLY) = 3"], "/w"),
      renamed: new Set(["/w/dir"])
    }
    const actual = Reads.observe(trace, { root: "/w", ignore: [], startedMs: Infinity, io: memory(fs) })
    expect(actual).toEqual({ refusal: "/w/dir was replaced while it was used" })
    expect(
      await oracle.ask({
        op: "observe",
        rules,
        fs,
        trace: { found: [...trace.found], renamed: [...trace.renamed] },
        options: { root: "/w" }
      })
    ).toEqual(actual)
    cases += 1
  })

  check("records emptiness proved by rmdir before recreating a directory", async () => {
    const tree: Tree = { d: { w: { d: { dir: { d: {} } } } } }
    const io = memory(tree)
    const options = { root: workspace, ignore: [], startedMs: Infinity, io, held: () => new Set<string>() }
    const trace = Reads.read(() => [
      "10 rmdir(\"dir\") = 0",
      "10 mkdir(\"dir\", 0777) = 0"
    ], workspace)
    const actual = Reads.observe(trace, options)
    expect(actual).toMatchObject({
      record: { reads: [["dir", "d", "d"]], lists: [["dir", Reads.listing("/w/dir", [], io), []]] }
    })
    expect("refusal" in actual ? actual : { record: actual.record }).toEqual(
      await oracle.ask({
        op: "observe",
        rules,
        fs: tree,
        trace: {
          unfollowed: [...trace.unfollowed ?? []],
          made: [...trace.made],
          changed: [...trace.changed],
          removed: [...trace.removed],
          removedEmpty: [...trace.removedEmpty ?? []],
          built: [...trace.built ?? []]
        },
        options: { root: workspace, held: [] }
      })
    )
    cases += 1
  })

  const event = A.all({
    kind: pick([
      "found",
      "found",
      "found",
      "missing",
      "listed",
      "listed",
      "made",
      "emptied",
      "required",
      "changed",
      "changed"
    ]),
    at: int(40),
    tail: pick(["", "", "", "", "/new", "/..", "/../new", "/new/deep"]),
    tie: flag
  })
  const observeCase = A.all({
    steps: workspaceSteps,
    events: A.array(event, { maxLength: 10 }),
    found: A.array(A.all({ at: int(40), state: stateChoice }), { maxLength: 3 }),
    held: pick(["unknown", "nothing", "some"]),
    heldPick: int(3),
    variables: A.array(
      A.all({ name: pick(["QXZ1", "QXZ2", "QXZ3"]), value: pick(["v1", "v2", "unset"]), shown: flag }),
      { maxLength: 3 }
    ),
    loop: flag
  })

  check(
    "makes of a trace the record the specification makes, or refuses it in the same words",
    property(observeCase, 9402, 500, async (input) => {
      const loops: ReadonlyArray<Step> = input.loop
        ? [
          { parent: 1, name: "ring", kind: "l", text: "", exec: false, target: 0, shape: "self" },
          { parent: 1, name: "far", kind: "l", text: "", exec: false, target: 0, shape: "missing" }
        ]
        : []
      const world = grow([...input.steps, ...loops], ["w"])
      const io = memory(world.tree)
      const maps = {
        found: new Map<string, number>(),
        missing: new Map<string, number>(),
        listed: new Map<string, number>(),
        made: new Map<string, number>(),
        emptied: new Map<string, number>(),
        required: new Map<string, number>()
      }
      const changed = new Set<string>()
      let line = 0
      for (const row of input.events) {
        if (!row.tie || line === 0) line += 1
        const raw = `${world.paths[row.at % world.paths.length]!}${row.tail}`
        if (row.kind === "changed") changed.add(raw)
        else if (!maps[row.kind].has(raw)) maps[row.kind].set(raw, line)
      }
      const exclusive = new Map([...maps.made].filter((_, i) => i % 2 === 0))
      // Every other path the run changed, it removed: what it found and left gone is part of what it left.
      const removed = new Set([...changed].filter((_, index) => index % 2 === 0))
      // Every other of those it took away unseen: such a name is held as any name that is no directory.
      const unlinked = new Set([...removed].filter((_, index) => index % 2 === 0))
      const before = new Map<string, string>()
      for (const row of input.found) {
        const path = world.paths[row.at % world.paths.length]!
        if (!before.has(path)) before.set(path, stateFrom(row.state, Reads.measure(path, io)))
      }
      const values = Object.fromEntries(
        input.variables.map((row) => [row.name, row.value === "unset" ? undefined : row.value])
      )
      const shown = input.variables.filter((row) => row.shown).map((row) => row.name)
      const committed = input.held === "unknown"
        ? null
        : input.held === "nothing"
        ? []
        : world.paths.filter((_, index) => index % 3 === input.heldPick).map(inside)
      const options = {
        root: workspace,
        ignore: [],
        startedMs: 10,
        io,
        found: before,
        held: (names: ReadonlyArray<string>) =>
          committed === null ? undefined : new Set(names.filter((part) => committed.includes(part))),
        variables: { values, text: "", shown: new Set(shown), ignored: () => new Set<string>() }
      }
      const observed = Reads.observe(
        { ...maps, exclusive, changed, started: new Map(), removed, unlinked, fetched: new Set(), refusals: [] },
        options
      )
      const expected = await oracle.ask<{ readonly refusal: string } | { readonly record: Reads.Record }>({
        op: "observe",
        rules,
        fs: world.tree,
        trace: {
          found: [...maps.found],
          missing: [...maps.missing],
          listed: [...maps.listed],
          made: [...maps.made],
          emptied: [...maps.emptied],
          required: [...maps.required],
          exclusive: [...exclusive],
          changed: [...changed],
          removed: [...removed],
          unlinked: [...unlinked]
        },
        options: {
          root: workspace,
          found: [...before],
          values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null])),
          shown,
          held: committed
        }
      })
      if ("refusal" in observed) {
        expect({ refusal: observed.refusal }).toEqual(expected)
        seen.refused += 1
        if (observed.refusal.endsWith("too many symbolic links")) seen.loops += 1
        return
      }
      expect({ record: observed.record }).toEqual(expected)
      seen.recorded += 1
      if (observed.record.reads.some(([, state]) => state.startsWith("l:"))) seen.links += 1
      // Theorem 1 of Observe.lean, on this run: the record holds on the file system it was made on, unless the run
      // changed a file it did not leave as it found it (`u2`), or found missing a path that is there and not its own.
      const record = observed.record
      const settled = record.reads.every(([path, state, other]) => {
        const now = Reads.measure(path === "." ? workspace : path.startsWith("/") ? path : `${workspace}/${path}`, io)
        if (other === undefined) return state !== "-" || now === "-"
        if (!rules.u2 || other !== "-") return !rules.u2 || other === state
        return now === "-" || (record.left && (path.startsWith("/") || options.held([path])?.has(path) === false))
      })
      const held = Reads.changed(
        record,
        workspace,
        (path) => Reads.measure(path, io),
        io,
        undefined,
        values,
        undefined,
        undefined,
        options.held
      )
      if (settled) expect(held).toBeUndefined()
    })
  )
})

describe("the differential suite", () => {
  check("ran every case against the oracle, and saw the known differences only where they are known", () => {
    expect(cases).toBeGreaterThanOrEqual(3000)
    expect(oracle.asked).toBeGreaterThanOrEqual(cases)
    // The known difference cannot appear once the implementation is fixed; it may be zero then.
    expect(gaps.supplementary).toBeGreaterThanOrEqual(0)
    for (const [outcome, count] of Object.entries(seen)) expect(count, outcome).toBeGreaterThan(10)
    if (process.env["LEAN_DIFF_REPORT"] !== undefined) {
      NodeFs.writeFileSync(
        process.env["LEAN_DIFF_REPORT"],
        JSON.stringify({ rules, cases, asked: oracle.asked, gaps, seen, said: Object.fromEntries(said) })
      )
    }
  })
})
