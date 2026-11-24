/**
 * Differential tests of `src/generate` and `src/apply` against their Lean 4 reference specification
 * (`spec/lean/generate_apply`): generated paths, target labels, YAML mappings and Smithers build's refusal line.
 *
 * The specification is a program that answers one JSON request a line (`Main.lean`). It is started once, and every
 * case asks it what the implementation should give. A string crosses as its UTF-16 code units, which is what the
 * rules read and what JSON text cannot hold when a surrogate has no pair.
 *
 * Without the built program and without `lake` to build it, every case is skipped: a machine with no Lean still runs
 * the rest of the suite.
 */
import * as Arbitrary from "effect/Arbitrary"
import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseDocument } from "yaml"
import { check } from "../../src/apply/Check.vibe"
import { refusalOf, refusedTargets } from "../../src/apply/Planned.vibe"
import { errorLine } from "../../src/contract/Command.vibe"
import type { Ci } from "../../src/contract/Inventory.vibe"
import { shardOf } from "../../src/contract/Shard.vibe"
import { files } from "../../src/generate/index.vibe"
import { workflowPath } from "../../src/generate/Render.ts"
import { planSteps } from "../../src/generate/Steps.vibe"
import * as Yaml from "../../src/generate/Yaml.vibe"
import { evaluate, value, whole } from "../../src/inventory/Expression.ts"
import { generatedMark } from "../../src/native/Workspace.vibe"

const specDir = fileURLToPath(new URL("../../spec/lean/generate_apply", import.meta.url))
const binary = join(specDir, ".lake", "build", "bin", "generate-apply-spec")
const lake = [
  ...(process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, "lake")),
  join(homedir(), ".elan", "bin", "lake")
].find((file) => existsSync(file))
const oracleReady = existsSync(join(specDir, "lakefile.toml")) && (existsSync(binary) || lake !== undefined)

/** True when the program is not built, or a source of the specification is newer than it. */
const stale = (): boolean => {
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  const sources = [
    "lakefile.toml",
    "lean-toolchain",
    "Main.lean",
    "GenerateApplySpec.lean",
    ...readdirSync(join(specDir, "GenerateApplySpec")).map((file) => join("GenerateApplySpec", file))
  ]
  return sources.some((file) => statSync(join(specDir, file)).mtimeMs > built)
}

type Units = ReadonlyArray<number>

const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

const textOf = (value: unknown): string => (value as Units).map((unit) => String.fromCharCode(unit)).join("")

interface Waiting {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: Error) => void
}

let oracle: ChildProcessWithoutNullStreams | undefined
const waiting: Array<Waiting> = []

/** Asks the specification one question. Answers come back in the order the questions were asked. */
const ask = (request: Readonly<Record<string, unknown>>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (oracle === undefined) {
      reject(new Error("the Lean oracle is not running"))
      return
    }
    waiting.push({ resolve, reject })
    oracle.stdin.write(`${JSON.stringify(request)}\n`)
  })

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && stale()) {
    const built = spawnSync(lake, ["build"], { cwd: specDir, encoding: "utf8", timeout: 1_500_000 })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  let buffered = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const reply = JSON.parse(buffered.slice(0, end)) as { readonly ok?: unknown; readonly error?: string }
      buffered = buffered.slice(end + 1)
      const next = waiting.shift()
      if (reply.error === undefined) next?.resolve(reply.ok)
      else next?.reject(new Error(`the Lean oracle refused a request: ${reply.error}`))
    }
  })
  child.on("close", () => {
    for (const one of waiting.splice(0)) one.reject(new Error("the Lean oracle stopped"))
  })
  oracle = child
}, 1_800_000)

afterAll(() => {
  oracle?.stdin.end()
})

/** A case the implementation and the specification disagree on, with the assertion's own words. */
class Refuted extends Data.TaggedError("Refuted")<{ readonly message: string }> {}

/** Checks `verify` for `runs` generated inputs and gives how many it saw. A failure names the shrunk input. */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  seed: number,
  runs: number,
  verify: (input: A) => Promise<void>
): Promise<number> => {
  let cases = 0
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(
      arbitrary,
      (input) =>
        Effect.tryPromise({
          try: async () => {
            cases += 1
            await verify(input)
            return true
          },
          catch: (cause) => new Refuted({ message: cause instanceof Error ? cause.message : String(cause) })
        }),
      { runs, seed }
    )
  )
  if (result._tag !== "Passed") expect.fail(Arbitrary.formatCheckFailure(result) ?? result._tag)
  return cases
}

const oneOf = <const Values extends readonly [string | number, ...Array<string | number>]>(values: Values) =>
  Arbitrary.schema(Schema.Literals(values))

const anyText = Arbitrary.schema(Schema.String)

// ---------------------------------------------------------------------------------------------------------------
// Generated paths: Check.vibe
// ---------------------------------------------------------------------------------------------------------------

const noop = FileSystem.makeNoop({})

const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  size: ByteSize.bytes(0),
  mode: 0,
  dev: 0n,
  uid: Option.none(),
  gid: Option.none(),
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  ino: Option.none(),
  nlink: Option.none(),
  rdev: Option.none(),
  blksize: Option.none(),
  blocks: Option.none()
})

const inspect = (root: string, path: string, content: string, fs: FileSystem.FileSystem) =>
  Effect.runSync(
    Effect.result(check(root, [{ path, content }])).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(Path.layer)
    )
  )

interface PlaceAnswer {
  readonly place: "absent" | "present" | "refused"
  readonly why?: Units
}

/** What `check` gives for one generated file when `placeOf` gives `place` and nothing else is in the repository. */
const expectPlace = (outcome: unknown, answer: unknown, path: string): void => {
  const place = answer as PlaceAnswer
  if (place.place === "refused") {
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { code: "unsupported", part: "generate", message: textOf(place.why) }
    })
  } else {
    expect(outcome).toMatchObject({
      _tag: "Success",
      success: { former: [], changes: place.place === "absent" ? [{ path, change: "missing" }] : [] }
    })
  }
}

// The paths `check` also looks at for every repository: a generated path under one of them is another case.
const alsoRead = (path: string): boolean => /^(?:\.smithers|PACKAGE\.ts|PACKAGE\.vibe)(?:\/|$)/.test(path)

const pathPieces = [
  "a",
  "b",
  "dir",
  ".",
  "..",
  "...",
  "/",
  "//",
  "\\",
  "\0",
  "C:",
  "c:",
  "z:/",
  ":",
  " ",
  "\n",
  "\t",
  "é",
  "\ud800",
  "\udc00",
  "😀",
  ".git",
  "..a",
  "a..",
  "~",
  "%2e%2e",
  "CON",
  "-",
  "\u2028",
  "\""
] as const

const hostilePath = Arbitrary.map(
  Arbitrary.all({
    pieces: Arbitrary.array(oneOf(pathPieces), { maxLength: 8 }),
    any: anyText,
    which: oneOf([0, 0, 0, 1])
  }),
  ({ any, pieces, which }) => which === 1 ? any : pieces.join("")
)

const pathCorpus = [
  "",
  ".",
  "..",
  "/",
  "a",
  "a/b",
  "a/b/c.txt",
  "/a",
  "a/",
  "a//b",
  "a/./b",
  "a/../b",
  "./a",
  "../a",
  "a/..",
  "a/.",
  "...",
  "a/.../b",
  ".a",
  "a.",
  "..a",
  "a..",
  "C:",
  "C:a",
  "C:/a",
  "c:\\a",
  "1:a",
  "é:a",
  "a/C:b",
  "aC:",
  "a\\b",
  "\\\\server\\share",
  "a\0",
  "\0",
  "a\nb",
  "a b",
  " ",
  "a/ /b",
  "\ud800",
  "a/\udc00/b",
  "😀/é",
  "a\"b",
  ".github/workflows/smithers-ci.yml",
  "x".repeat(300),
  `${"d/".repeat(40)}f`
] as const

type Reply = { readonly ok: string } | { readonly failed: PlatformError.SystemErrorTag }

interface DiskNode {
  readonly prefix: string
  readonly real: Reply
  readonly link: Reply
  readonly kind: "file" | "directory" | "other"
}

const replyOf = (reply: Reply | undefined, method: string): Effect.Effect<string, PlatformError.PlatformError> =>
  reply !== undefined && "ok" in reply
    ? Effect.succeed(reply.ok)
    : Effect.fail(PlatformError.systemError({ _tag: reply?.failed ?? "NotFound", module: "FileSystem", method }))

const leanReply = (reply: Reply): Readonly<Record<string, Units>> =>
  "ok" in reply ? { ok: units(reply.ok) } : { failed: units(reply.failed) }

/** A file system that answers for the prefixes of `nodes` under `root` and finds nothing anywhere else. */
const diskOf = (root: string, realRoot: string | undefined, nodes: ReadonlyArray<DiskNode>, content: string) => {
  const base = root.endsWith("/") ? root : `${root}/`
  const byPrefix = new Map(nodes.map((node) => [node.prefix, node]))
  const nodeAt = (at: string): DiskNode | undefined =>
    at.startsWith(base) ? byPrefix.get(at.slice(base.length)) : undefined
  return FileSystem.makeNoop({
    realPath: (at) =>
      at === root
        ? (realRoot === undefined ? noop.realPath(at) : Effect.succeed(realRoot))
        : replyOf(nodeAt(at)?.real, "realPath"),
    readLink: (at) => replyOf(nodeAt(at)?.link, "readLink"),
    stat: (at) => {
      const node = nodeAt(at)
      if (node === undefined) return noop.stat(at)
      if (node.kind === "other") {
        return node.prefix.length % 2 === 0
          ? Effect.succeed(info("SymbolicLink"))
          : Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "stat" }))
      }
      return Effect.succeed(info(node.kind === "file" ? "File" : "Directory"))
    },
    readFileString: () => Effect.succeed(content),
    readFile: () => Effect.succeed(new TextEncoder().encode(content))
  })
}

const walkCase = Arbitrary.all({
  segments: Arbitrary.array(oneOf(["a", "b", "dir", "é", "x y", ".hidden", "a.b", "😀"]), {
    minLength: 1,
    maxLength: 4
  }),
  suffix: oneOf(["", "", "", "", "", "/", "/..", "\\x"]),
  root: oneOf(["/repo", "/", "/a/b"]),
  realRoot: oneOf(["same", "same", "/private/repo", "/", "/repo/", "missing"]),
  nodes: Arbitrary.array(
    Arbitrary.all({
      real: oneOf([
        "natural",
        "natural",
        "natural",
        "natural",
        "natural",
        "root",
        "sibling",
        "outside",
        "under-sibling",
        "shorter",
        "NotFound",
        "PermissionDenied",
        "Unknown"
      ]),
      link: oneOf(["NotFound", "NotFound", "gone", "Busy"]),
      kind: oneOf(["expected", "expected", "expected", "expected", "file", "directory", "other"])
    }),
    { minLength: 4, maxLength: 4 }
  )
})

// ---------------------------------------------------------------------------------------------------------------
// Target labels: Steps.vibe
// ---------------------------------------------------------------------------------------------------------------

/** The label `uniqueLabel` tries first for a step with no matrix whose plain label is taken. */
const hashedLabelOf = (id: string, attempt = 0): string => {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "-")
  const base = /^[A-Za-z_]/.test(cleaned) ? cleaned : `s-${cleaned}`
  const identity = attempt === 0 ? `${id}\n[]` : `${id}\n[]\n${attempt}`
  return `${base}-${shardOf(identity, 0x1_0000_0000).toString(16)}`
}

const stepIds = [
  "build",
  "Build",
  "BUILD",
  "bUILD",
  "__proto__",
  "__PROTO__",
  "__Proto__",
  "_repository",
  "_REPOSITORY",
  "_Repository",
  "a b",
  "a-b",
  "a/b",
  "a  b",
  "a\tb",
  "A B",
  "a\u00e9b",
  "1abc",
  "s-1abc",
  "S-1ABC",
  "-x",
  "s--x",
  "_x",
  ".x",
  "é",
  "éé",
  "s-",
  "S-",
  "\ud800",
  "\udc00",
  "😀",
  "lint.fix",
  "lint_fix",
  "lint:fix",
  "lint fix",
  "toString",
  "constructor",
  "a".repeat(520),
  `${"a".repeat(520)}b`,
  "A".repeat(520),
  `${"a".repeat(519)}/`,
  "x".repeat(509),
  "x".repeat(510),
  "X".repeat(509),
  `${"y".repeat(505)}/z`,
  `${"y".repeat(505)} z`,
  `${"y".repeat(505)}:Z`
] as const

const variantValues = [
  "ubuntu",
  "Ubuntu",
  "mac os",
  "mac-os",
  "a/b",
  "",
  "é",
  "--",
  "\ud800",
  "x".repeat(300),
  "20",
  "20.x"
] as const

const labelBatch = Arbitrary.all({
  jobs: Arbitrary.array(
    Arbitrary.all({
      source: oneOf(["github-actions", "github-actions", "justfile"]),
      steps: Arbitrary.array(
        Arbitrary.all({
          pool: oneOf(stepIds),
          any: Arbitrary.schema(Schema.NonEmptyString),
          which: oneOf([0, 0, 0, 0, 1]),
          echo: oneOf([0, 0, 0, 1, 2])
        }),
        { minLength: 1, maxLength: 7 }
      ),
      matrix: Arbitrary.array(
        Arbitrary.all({
          os: oneOf(variantValues),
          node: oneOf(variantValues),
          keys: oneOf(["os", "node", "both", "b a"])
        }),
        { maxLength: 3 }
      )
    }),
    { minLength: 1, maxLength: 3 }
  )
})

type LabelBatch = typeof labelBatch extends Arbitrary.Arbitrary<infer A> ? A : never

/** A CI of the batch's jobs: every step id once, each step with a command of its own so no two do the same work. */
const ciOf = (batch: LabelBatch): Ci => {
  const seen = new Set<string>()
  let commands = 0
  const jobs = batch.jobs.map((job, index) => ({
    id: `job-${index}`,
    source: job.source,
    file: ".github/workflows/ci.yml",
    name: `Job ${index}`,
    needs: [],
    triggers: ["push"],
    matrix: job.matrix.map(({ keys, node, os }): Record<string, string> =>
      keys === "os" ? { os } : keys === "node" ? { node } : keys === "both" ? { os, node } : { "b a": os, B: node }
    ),
    steps: job.steps
      .flatMap((step) => {
        const id = step.which === 1 ? step.any : step.pool
        // An id written to equal the hashed label of another step makes that step hash again.
        return step.echo === 0 ? [id] : [hashedLabelOf(id), ...(step.echo === 2 ? [hashedLabelOf(id, 1)] : []), id]
      })
      .filter((id) => !seen.has(id) && seen.add(id) !== undefined)
      .map((id) => ({ id, command: `echo ${commands++}`, cwd: "", env: {}, secrets: [] })),
    unsupported: []
  }))
  return {
    version: 1,
    repository: "fixture",
    commit: "0".repeat(40),
    toolchains: [],
    jobs: jobs.filter((job) => job.steps.length > 0)
  } as unknown as Ci
}

/** Compares the labels `planSteps` gives a CI with the labels the specification gives the same steps. */
const expectLabels = async (inventory: Ci): Promise<number> => {
  const planned = planSteps(inventory)
  if (planned._tag !== "Success") {
    expect(inventory.jobs).toEqual([])
    return 0
  }
  const targets = planned.success.targets
  const expected = await ask({
    op: "labels",
    batch: targets.map((target) => ({
      id: units(target.step),
      variant: Object.entries(target.variant).map(([name, value]) => [units(name), units(value)])
    }))
  })
  expect(expected).not.toBeNull()
  const labels = targets.map((target) => target.label)
  expect(labels).toEqual((expected as ReadonlyArray<Units>).map(textOf))
  // What the specification proves of its own labels, seen on the implementation's.
  expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(labels.length)
  for (const label of labels) {
    expect(label.length).toBeLessThanOrEqual(509)
    expect(label.toLowerCase()).not.toBe("__proto__")
    expect(label.toLowerCase()).not.toBe("_repository")
    expect(label).toMatch(/^[A-Za-z0-9._-]+$/)
  }
  return labels.length
}

// ---------------------------------------------------------------------------------------------------------------
// YAML mappings: Yaml.vibe
// ---------------------------------------------------------------------------------------------------------------

/** Whether both YAML versions read `value`, written plain, as that same string: the parser's part of `isPlain`. */
const readsBack = (value: string): boolean => {
  try {
    return (["1.2", "1.1"] as const).every((version) =>
      parseDocument(value, { version, logLevel: "silent" }).toJS() === value
    )
  } catch {
    return false
  }
}

type Tree =
  | string
  | number
  | boolean
  | {
    readonly entries: ReadonlyArray<
      { readonly key: string; readonly value: Tree; readonly comments: ReadonlyArray<string> }
    >
  }
  | { readonly items: ReadonlyArray<{ readonly value: Tree; readonly comments: ReadonlyArray<string> }> }

const yamlOf = (tree: Tree): Yaml.Value =>
  typeof tree !== "object"
    ? tree
    : "entries" in tree
    ? Yaml.mapping(tree.entries.map((one) => Yaml.entry(one.key, yamlOf(one.value), one.comments)))
    : Yaml.sequence(tree.items.map((one) => Yaml.item(yamlOf(one.value), one.comments)))

const leanOf = (tree: Tree): Readonly<Record<string, unknown>> =>
  typeof tree === "string"
    ? { string: units(tree), readsBack: readsBack(tree) }
    : typeof tree === "number"
    ? { int: tree }
    : typeof tree === "boolean"
    ? { bool: tree }
    : "entries" in tree
    ? { mapping: leanEntries(tree.entries) }
    : { sequence: tree.items.map((one) => ({ value: leanOf(one.value), comments: one.comments.map(units) })) }

const leanEntries = (
  entries: ReadonlyArray<{ readonly key: string; readonly value: Tree; readonly comments: ReadonlyArray<string> }>
): ReadonlyArray<unknown> =>
  entries.map((one) => ({
    key: units(one.key),
    readsBack: readsBack(one.key),
    value: leanOf(one.value),
    comments: one.comments.map(units)
  }))

const yamlKeys = [
  "name",
  "runs-on",
  "on",
  "On",
  "ON",
  "yes",
  "Yes",
  "y",
  "Y",
  "n",
  "no",
  "NO",
  "off",
  "true",
  "True",
  "false",
  "null",
  "Null",
  "~",
  "a b",
  "a: b",
  "a:b",
  "k:",
  "-x",
  "- x",
  "-",
  "?",
  "? x",
  "?x",
  ":",
  ":x",
  "x #y",
  "x#y",
  " lead",
  "trail ",
  "",
  "a\nb",
  "a\tb",
  "\u0007",
  "é",
  "\u00a0",
  "x\u00a0y",
  "\u2028",
  "\ud800",
  "😀",
  "123",
  "1.5",
  "0x1f",
  "1e3",
  "0o7",
  "1_000",
  ".inf",
  ".nan",
  "2024-01-01",
  "a,b",
  "[x]",
  "{x}",
  "*a",
  "&a",
  "!t",
  "|",
  "|x",
  ">",
  ">x",
  "%d",
  "@a",
  "`a",
  "'q'",
  "\"q\"",
  "it's",
  "key-1",
  "_k",
  "-k",
  "k.v",
  "__proto__",
  "<<",
  "=",
  "with space and: colon",
  "x".repeat(1024),
  "x".repeat(1025),
  "x y ".repeat(300),
  "\"".repeat(600),
  "é".repeat(1025),
  `${"x".repeat(1030)}:`
] as const

const yamlTexts = [
  "",
  "plain",
  "two words",
  " lead",
  "trail ",
  "multi\nline",
  "multi\nline\n",
  "trail\n\n\n",
  "\nlead",
  " lead\nx",
  "x \ny",
  "\n",
  "\n\n",
  " \n ",
  "a\n\n\nb",
  "  indented\nline",
  "\n  indented first",
  "${{ matrix.os }}",
  "word ".repeat(40).trim(),
  `run \${{ a b c }} ${"x ".repeat(60)}end`,
  `\${{ ${"very long expression ".repeat(8)}}} tail`,
  `}} \${{ ${"z".repeat(90)} y`,
  "a".repeat(100),
  `${"a".repeat(100)} b`,
  "a  b   c",
  "tab\there",
  "bell\u0007",
  "nbsp\u00a0x",
  "x\u2028y\nz",
  "#comment",
  "a #b",
  "a: b",
  "yes",
  "null",
  "1",
  "1.0",
  "'",
  "''",
  "it's",
  "it's\nmulti",
  "\"q\"",
  "- item",
  "-",
  "? q",
  ": c",
  "end:",
  "[a]",
  "{a: b}",
  "*alias",
  "\ud800",
  "😀 ok",
  "é\nü"
] as const

const yamlComments = [
  "",
  " ",
  "note",
  "a  b\tc",
  "long ".repeat(40),
  "x".repeat(100),
  "#",
  "é ü",
  "\u00a0nbsp",
  "nel\u0085next",
  "a\u0000b\u2028c\u2029d\u007fe\u009ff"
] as const

const scalarTree: Arbitrary.Arbitrary<Tree> = Arbitrary.map(
  Arbitrary.all({
    kind: oneOf(["text", "text", "text", "any", "int", "bool"]),
    text: oneOf(yamlTexts),
    any: anyText,
    int: oneOf([0, 1, -1, 42, -7, 1_000_000]),
    bool: oneOf([0, 1])
  }),
  (one): Tree =>
    one.kind === "text" ? one.text : one.kind === "any" ? one.any : one.kind === "int" ? one.int : one.bool === 1
)

const yamlKey = Arbitrary.map(
  Arbitrary.all({ pool: oneOf(yamlKeys), any: anyText, which: oneOf([0, 0, 0, 1]) }),
  (one) => one.which === 1 ? one.any : one.pool
)

const commentsOf = Arbitrary.array(oneOf(yamlComments), { maxLength: 2 })

const treeOf = (depth: number): Arbitrary.Arbitrary<Tree> =>
  depth === 0 ? scalarTree : Arbitrary.map(
    Arbitrary.all({
      kind: oneOf(["scalar", "scalar", "mapping", "sequence"]),
      scalar: scalarTree,
      entries: Arbitrary.array(Arbitrary.all({ key: yamlKey, value: treeOf(depth - 1), comments: commentsOf }), {
        maxLength: 3
      }),
      items: Arbitrary.array(Arbitrary.all({ value: treeOf(depth - 1), comments: commentsOf }), { maxLength: 3 })
    }),
    (one): Tree =>
      one.kind === "scalar" ? one.scalar : one.kind === "mapping" ? { entries: one.entries } : { items: one.items }
  )

const yamlDocument = Arbitrary.all({
  entries: Arbitrary.array(Arbitrary.all({ key: yamlKey, value: treeOf(2), comments: commentsOf }), { maxLength: 4 }),
  header: commentsOf
})

// ---------------------------------------------------------------------------------------------------------------
// Smithers build's refusal: Planned.vibe
// ---------------------------------------------------------------------------------------------------------------

const printed = [
  "",
  " ",
  "\t",
  "\r",
  "error: boom",
  "fatal: could not plan //:lint",
  "(node:42) ExperimentalWarning: fixture {metadata}",
  "(node:7)\tDeprecationWarning: old",
  "(node:1)  Warning: bare",
  "(node:) Warning: none",
  "(node:12)Warning: tight",
  "(node:12) Warning x",
  "(node:12) MyWarning:",
  "(node:12) Warning :",
  "(node:12) WarningX: more",
  "(node:12) Warning_: more",
  "(node:12) A Warning: two words",
  " (node:9) Warning: indented",
  "(node:9) warning: lower",
  "(node:9) éWarning: accent",
  "(node:9)\u00a0Warning: nbsp",
  "x (node:9) Warning: not first",
  "(Use `node --trace-warnings ...` to show where the warning was created)",
  "(Use `node --trace-warnings",
  "(Use `node --trace-warnings ",
  "\u001b[31m",
  "\u001b[0m",
  "\u001b[1;31m",
  "\u001b[?25l",
  "\u001b[ q",
  "\u001b[",
  "\u001b",
  "\u001b\u001b[m[31m",
  "\u001b[31",
  "\u001b]0;title\u0007",
  "\u001b[\u001b[0m",
  "\u001b[1;\u001b[2m3m",
  "[0m",
  "{",
  "}",
  "{}",
  "{{",
  "}}",
  "\"",
  "\\",
  "\\\"",
  "'",
  "[",
  "]",
  ",",
  ":",
  "{\"message\":\"plain\"}",
  "{\"message\": \"spaced\" }",
  "{\"message\":\"first\",\"message\":\"second\"}",
  "{\"message\":\"x\",\"message\":1}",
  "{\"message\":1}",
  "{\"message\":null}",
  "{\"message\":\"\"}",
  "{\"message\":\"  \"}",
  "{\"message\":\"\\u001b[31mred\\u001b[0m\"}",
  "{\"message\":\"\\u001b\\u001b[m[31m still red?\"}",
  "{\"message\":\"brace } in { string\"}",
  "{\"message\":\"esc \\\" quote\"}",
  "{\"mess\\u0061ge\":\"escaped key\"}",
  "{\"detail\":{\"message\":\"inner\"},\"message\":\"outer\"}",
  "{\"detail\":{\"message\":\"inner only\"}}",
  "{\"a\":[1,2,{\"message\":\"in array\"}],\"message\":\"after array\"}",
  "{\"n\":01,\"message\":\"bad number\"}",
  "{\"n\":-0.5e+3,\"message\":\"good number\"}",
  "{\"n\":1.,\"message\":\"bad fraction\"}",
  "{\"n\":-,\"message\":\"bad sign\"}",
  "{\"n\":1E5,\"m\":0e0,\"message\":\"exponents\"}",
  "{\"message\":\"trailing comma\",}",
  "{\"message\":\"x\" \"y\"}",
  "{'message':'single'}",
  "{\"message\":\"tab\there\"}",
  "{\"message\":\"\\x\"}",
  "{\"message\":\"\\u12\"}",
  "{\"message\":\"\\ud83d\\ude00 pair \\ud800 lone\"}",
  "{\"message\":\"https://user:secret@example.org/a b\"}",
  "{\"message\":true,\"other\":\"x\"}",
  "{\"message\":\"nested\",\"more\":[[],{},[{}]]}",
  "{\"message\":\"array end\",\"more\":[1,]}",
  "{\"message\":\"",
  "\"}",
  "{\"message\":\"unterminated",
  "{\"t\":true,\"f\":false,\"n\":null,\"message\":\"literals\"}",
  "{\"t\":tru,\"message\":\"bad literal\"}",
  "{\"t\":truex,\"message\":\"long literal\"}",
  "{ \"message\" : \"ws\" }",
  "{\u00a0\"message\":\"nbsp is no JSON space\"}",
  "{\n  \"message\": \"pretty\"\n}",
  `{"message":"${"long ".repeat(80)}"}`,
  "{\"message\":{\"message\":\"deep\"}}",
  "{\"__proto__\":{\"message\":\"proto\"}}",
  "{\"message\":\"m\"}{\"message\":\"adjacent\"}",
  "https://user:secret@example.org/path",
  "ssh://git@host:repo",
  "mailto:a@b",
  "x:y@z w:@",
  "a-b+c.d://///u@h",
  "é:x@y",
  "_a:b@c",
  "1a:b@c",
  "A:B@C\"D:E@F",
  "a:b@c@d e",
  "word a:@",
  "::@",
  "a:\"@",
  "a:/",
  "@",
  "\u00a0",
  "\u2028",
  "\ufeff",
  "\ud800",
  "é",
  "😀",
  "x".repeat(310),
  `${"x".repeat(299)} y z`,
  "tail"
] as const

const stream = Arbitrary.map(
  Arbitrary.array(
    Arbitrary.all({
      pool: oneOf(printed),
      any: anyText,
      which: oneOf([0, 0, 0, 0, 0, 1]),
      separator: oneOf(["", "", " ", "\n", "\n", "\n", "\r\n", "\n\n"])
    }),
    { minLength: 1, maxLength: 12 }
  ),
  (parts) => parts.map((part) => (part.which === 1 ? part.any : part.pool) + part.separator).join("")
)

const refusalCorpus = [
  JSON.stringify({ message: "https://user:2024#part@host/path?secret_key=sample" }),
  "",
  " \n\t",
  "real error\n\n(node:42) ExperimentalWarning: fixture",
  "(node:42) ExperimentalWarning: fixture\n(Use `node --trace-warnings ...` to show where the warning was created)",
  "{\"message\":\"first\"}\n{\"message\":\"last\"}",
  "truncated {\n{\"message\":\"after an open brace\"}",
  "{\"message\":\"before\"}\ntruncated {",
  "{\"detail\":{\"message\":\"inner\"},\"message\":\"\"}\nfallback",
  "\u001b[31m{\"message\":\"colored record\"}\u001b[0m",
  "{\n(node:1) Warning: between the lines\n\"message\": \"split by a warning\"\n}",
  "\u001b\u001b[m[31mboom",
  "\u001b[\u001b[0m1mboom",
  "{\"message\":\"\\u001b\\u001b[m[31mboom\"}",
  "{\"message\":\"a\\nb\\tc   d\"}",
  "{\"message\":\"\\\"}\"}",
  "\"{\"}\"",
  "\"a\nb{\"message\":\"after a quote that never closes\"}",
  "}{\"message\":\"after a stray brace\"}",
  "{{{{{{{{{{\"message\":\"deep\"}}}}}}}}}}",
  "{\"a\":{\"b\":?},\"message\":\"child is no JSON\"}",
  "{\"a\":{},\"message\":\"empty child\"}",
  "{\"a\":{ },\"message\":\"spaced child\"}",
  "{\"message\":\"x\"} trailing words",
  "https://token@example.org/repo.git failed",
  "x".repeat(400)
] as const

describe("generate and apply against the Lean 4 reference specification", () => {
  it.skipIf(!oracleReady)(
    "gives only a default branch outside a PR the write token, also when either secret is empty",
    async () => {
      const ci = ciOf({
        jobs: [{ source: "github-actions", matrix: [], steps: [{ pool: "check", any: "", which: 0, echo: 0 }] }]
      })
      const workflow = Effect.runSync(files(ci)).find((entry) => entry.path === workflowPath)!
      const steps = parseDocument(workflow.content).toJS().jobs.ci.steps as Array<
        { env?: { SMITHERS_CACHE_TOKEN?: string } }
      >
      const expression = whole(steps.find((step) => step.env?.SMITHERS_CACHE_TOKEN)?.env?.SMITHERS_CACHE_TOKEN ?? "")
      expect(expression).toBeDefined()
      for (const event of ["pull_request", "push", "workflow_dispatch"]) {
        for (const refType of ["branch", "tag"]) {
          for (const name of ["main", "topic"]) {
            for (const read of ["", "read"]) {
              for (const write of ["", "write"]) {
                const github = value({
                  event_name: event,
                  ref_type: refType,
                  ref_name: name,
                  event: { repository: { default_branch: "main" } }
                })
                const secrets = value({ SMITHERS_CACHE_READ_TOKEN: read, SMITHERS_CACHE_TOKEN: write })
                const observed = evaluate(expression!, { context: (context) => ({ github, secrets })[context] })
                const expected = await ask({
                  op: "cacheToken",
                  pullRequest: event === "pull_request",
                  branch: refType === "branch",
                  defaultName: name === "main",
                  read,
                  write
                })
                expect(observed).toEqual({ kind: "ok", residual: { kind: "literal", value: expected } })
              }
            }
          }
        }
      }
    }
  )

  it.skipIf(!oracleReady)("refuses the same generated path names, with the same words", async () => {
    const compare = async (path: string): Promise<void> => {
      if (alsoRead(path)) return
      const answer = await ask({ op: "place", realRoot: units("/repo"), path: units(path), disk: [] })
      expectPlace(inspect("/repo", path, "", noop), answer, path)
      // The name alone decides: a name the specification calls portable is never refused for its spelling.
      const portable = await ask({ op: "portable", path: units(path) })
      expect((answer as PlaceAnswer).place === "absent").toBe(portable)
    }
    for (const path of pathCorpus) await compare(path)
    expect(await holds(hostilePath, 3101, 500, compare)).toBeGreaterThanOrEqual(500)
  })

  it.skipIf(!oracleReady)(
    "walks the prefixes of a path and confines each real location as the specification does",
    async () => {
      const content = `${generatedMark}\nbody`
      const cases = await holds(walkCase, 3102, 500, async (input) => {
        const path = input.segments.join("/") + input.suffix
        const realRoot = input.realRoot === "missing"
          ? undefined
          : input.realRoot === "same"
          ? input.root
          : input.realRoot
        const actualRoot = realRoot ?? input.root
        const below = actualRoot.endsWith("/") ? actualRoot : `${actualRoot}/`
        const nodes = input.segments.map((_, index): DiskNode => {
          const prefix = input.segments.slice(0, index + 1).join("/")
          const shape = input.nodes[index]!
          const last = index === input.segments.length - 1 && input.suffix === ""
          const real: Reply = shape.real === "natural"
            ? { ok: below + prefix }
            : shape.real === "root"
            ? { ok: actualRoot }
            : shape.real === "sibling"
            ? { ok: `${actualRoot}-evil` }
            : shape.real === "outside"
            ? { ok: `/elsewhere/${prefix}` }
            : shape.real === "under-sibling"
            ? { ok: `${actualRoot}-evil/${prefix}` }
            : shape.real === "shorter"
            ? { ok: actualRoot.slice(0, -1) }
            : { failed: shape.real }
          const link: Reply = shape.link === "gone" ? { ok: "gone" } : { failed: shape.link }
          const kind = shape.kind === "expected" ? (last ? "file" : "directory") : shape.kind
          return { prefix, real, link, kind }
        })
        const answer = await ask({
          op: "place",
          realRoot: units(actualRoot),
          path: units(path),
          disk: nodes.map((node) => ({
            prefix: units(node.prefix),
            real: leanReply(node.real),
            link: leanReply(node.link),
            kind: node.kind
          }))
        })
        expectPlace(inspect(input.root, path, content, diskOf(input.root, realRoot, nodes, content)), answer, path)
      })
      expect(cases).toBeGreaterThanOrEqual(500)
    }
  )

  it.skipIf(!oracleReady)(
    "keeps a real location inside the repository exactly when the specification does",
    async () => {
      const content = `${generatedMark}\nbody`
      const roots = ["/repo", "/", "/repo/", "/a/b", "/répo", "/repo-evil", "/r", "//"] as const
      const reals = (root: string): ReadonlyArray<string> => [
        root,
        `${root}/out`,
        `${root}out`,
        `${root}-evil`,
        `${root}-evil/out`,
        `${root}/../out`,
        `${root}//out`,
        root.slice(0, -1),
        root.toUpperCase(),
        "/out",
        "/",
        "",
        "out",
        `${root}\\out`
      ]
      let cases = 0
      for (const root of roots) {
        for (const real of reals(root)) {
          const nodes: ReadonlyArray<DiskNode> = [{
            prefix: "out",
            real: { ok: real },
            link: { failed: "NotFound" },
            kind: "file"
          }]
          const within = await ask({ op: "within", realRoot: units(root), real: units(real) })
          const outcome = inspect("/work", "out", content, diskOf("/work", root, nodes, content))
          expect(outcome._tag === "Success", `${real} within ${root}`).toBe(within)
          cases += 1
        }
      }
      expect(await ask({ op: "within", realRoot: units("/repo"), real: units("/repo-evil") })).toBe(false)
      expect(await ask({ op: "within", realRoot: units("/"), real: units("/out") })).toBe(true)
      expect(cases).toBe(roots.length * 14)
    }
  )

  it.skipIf(!oracleReady)("gives every step of a hostile batch the label the specification gives it", async () => {
    let labels = 0
    const cases = await holds(labelBatch, 3103, 400, async (batch) => {
      labels += await expectLabels(ciOf(batch))
    })
    expect(cases).toBeGreaterThanOrEqual(400)
    expect(labels).toBeGreaterThan(1_500)
  })

  it.skipIf(!oracleReady)("hashes a taken label again until one is free, and cuts a long one to fit", async () => {
    const one = (ids: ReadonlyArray<string>, matrix: ReadonlyArray<Record<string, string>> = []): Ci =>
      ({
        version: 1,
        repository: "fixture",
        commit: "0".repeat(40),
        toolchains: [],
        jobs: [{
          id: "job",
          source: "github-actions",
          file: ".github/workflows/ci.yml",
          name: "Job",
          needs: [],
          triggers: ["push"],
          matrix,
          steps: ids.map((id, index) => ({ id, command: `echo ${index}`, cwd: "", env: {}, secrets: [] })),
          unsupported: []
        }]
      }) as unknown as Ci
    // `a/b` finds `a-b` taken, then its first hashed label, then its second: it is given the third.
    const twice = one(["a b", hashedLabelOf("a/b"), hashedLabelOf("a/b", 1), "a/b"])
    expect(await expectLabels(twice)).toBe(4)
    const planned = planSteps(twice)
    expect(planned._tag === "Success" && planned.success.targets.map((target) => target.label)).toEqual([
      "a-b",
      hashedLabelOf("a/b"),
      hashedLabelOf("a/b", 1),
      hashedLabelOf("a/b", 2)
    ])
    for (
      const ids of [
        ["__proto__", "__PROTO__", "__Proto__", "_repository", "_Repository"],
        ["Build", "build", "BUILD", "bUILD"],
        ["x".repeat(509), "x".repeat(510), "X".repeat(509), "x".repeat(600), "X".repeat(600)],
        ["1", "s-1", "S-1", "-1", "s--1"],
        ["\ud800", "\udc00", "é", "😀", "-", "s--"],
        stepIds
      ]
    ) expect(await expectLabels(one(ids))).toBe(ids.length)
    const variants = [{ os: "mac os", node: "20" }, { os: "mac-os", node: "20" }, { os: "MAC/OS", node: "20" }, {
      node: "20"
    }]
    expect(await expectLabels(one(["test", "Test", "x".repeat(505)], variants))).toBe(12)
  })

  it.skipIf(!oracleReady)("writes every mapping, key and scalar as the specification writes it", async () => {
    let keys = 0
    const cases = await holds(yamlDocument, 3104, 400, async ({ entries, header }) => {
      keys += entries.length
      const expected = await ask({ op: "document", entries: leanEntries(entries), header: header.map(units) })
      expect(
        Yaml.document(Yaml.mapping(entries.map((one) => Yaml.entry(one.key, yamlOf(one.value), one.comments))), header)
      )
        .toBe(textOf(expected))
    })
    expect(cases).toBeGreaterThanOrEqual(400)
    expect(keys).toBeGreaterThan(300)
  })

  it.skipIf(!oracleReady)(
    "quotes a key, or writes it as an explicit key, exactly when the specification does",
    async () => {
      let cases = 0
      for (const key of yamlKeys) {
        for (const value of ["v", 7, true, "two\nlines", ""] as const) {
          const tree = { entries: [{ key, value, comments: [] }] }
          const expected = textOf(await ask({ op: "document", entries: leanEntries(tree.entries), header: [] }))
          const written = Yaml.document(Yaml.mapping([Yaml.entry(key, value)]))
          expect(written).toBe(expected)
          // The key is one key: both YAML versions read the mapping back with it, whatever its spelling. The writer
          // makes one exception itself: a root `on` is GitHub's keyword and stays plain, which YAML 1.1 reads as true.
          // A string with a surrogate that has no pair is not a string YAML holds.
          if (key.isWellFormed()) {
            for (const version of ["1.2", "1.1"] as const) {
              if (key === "on" && version === "1.1") continue
              const read = parseDocument(written, { version, logLevel: "silent" })
              expect(read.errors.map((error) => error.message), JSON.stringify(key)).toEqual([])
              expect([...(read.toJS({ mapAsMap: true }) as Map<unknown, unknown>).entries()]).toEqual([[key, value]])
            }
          }
          cases += 1
        }
        // Under a list item the head of the first entry follows the dash.
        const nested = {
          entries: [{
            key: "jobs",
            value: { items: [{ value: { entries: [{ key, value: "v", comments: ["c"] }] }, comments: [] }] },
            comments: []
          }]
        }
        expect(Yaml.document(yamlOf(nested) as Yaml.Mapping)).toBe(
          textOf(await ask({ op: "document", entries: leanEntries(nested.entries), header: [] }))
        )
        cases += 1
      }
      expect(cases).toBe(yamlKeys.length * 6)
    }
  )

  it.skipIf(!oracleReady)("classifies the full planner diagnostic before shortening it for display", async () => {
    for (const message of ["target refused", "ENOSPC", "xENOSPC", "ENOSPC2", "out of MEMORY", "metadata"]) {
      const printed = JSON.stringify({ message: "x".repeat(320) + " " + message })
      const expected = await ask({ op: "refusedTargets", text: units(printed) })
      expect(refusedTargets(printed)).toBe(expected === null ? undefined : textOf(expected))
    }
  })

  it.skipIf(!oracleReady)("reduces what Smithers build printed to the line the specification gives", async () => {
    const compare = async (text: string): Promise<void> => {
      const line = refusalOf(text)
      expect(line).toBe(textOf(await ask({ op: "refusal", text: units(text) })))
      // No escape character is left, so the line starts no terminal control sequence.
      expect(line).not.toContain("\u001b")
    }
    for (const text of refusalCorpus) await compare(text)
    for (const text of printed) await compare(text)
    expect(await holds(stream, 3105, 500, compare)).toBeGreaterThanOrEqual(500)
  })

  it.skipIf(!oracleReady)(
    "removes credentials, joins white space and cuts a line as the specification does",
    async () => {
      const compare = async (text: string): Promise<void> => {
        expect(errorLine(text)).toBe(textOf(await ask({ op: "errorLine", text: units(text) })))
      }
      for (const text of printed) await compare(text)
      expect(await holds(stream, 3106, 400, compare)).toBeGreaterThanOrEqual(400)
    }
  )

  it.skipIf(!oracleReady)("removes every control sequence, and removing them twice changes nothing", () => {
    // Before the fix an escape character before a sequence left a new sequence behind when the sequence went.
    expect(refusalOf("\u001b\u001b[m[31mboom")).toBe("[31mboom")
    expect(refusalOf("{\"message\":\"\\u001b\\u001b[m[31mboom\"}")).toBe("[31mboom")
    expect(refusalOf("plain \u001b[1;31mred\u001b[0m text\u001b")).toBe("plain red text")
    for (const text of printed) expect(refusalOf(refusalOf(text))).not.toContain("\u001b")
  })
})
