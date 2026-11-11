/**
 * Runs the parts of a CI plan on declared machines and merges their results.
 *
 * `ci --remote <name>` plans locally, splits the roots across the machines an
 * `S.Remotes` entry declares (as `--shard` splits them), ships the workspace
 * tree to each machine, runs `ci` there on that machine's roots, reads its
 * `--results-file` back, and merges every part into one summary.
 *
 * A part runs as one flow action, so a machine that is lost (its provider
 * failed, or it wrote no readable results file reporting every root it was
 * given) is retried by the flow
 * engine's own retry policy, once, on a fresh session in a fresh directory. A
 * second loss reports each of the part's roots failed with the reason.
 *
 * The coordinator reaches machines only through `Sandbox.Provider`;
 * {@link providerOf} is the one place a declaration's tag picks a provider.
 *
 * @since 1.0.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import * as CommandSandbox from "@smthrs/sandbox/CommandSandbox"
import type * as Sandbox from "@smthrs/sandbox/Sandbox"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as Executor from "../Executor.ts"

/**
 * One machine's share of a run: its one-based position in `machines` and the
 * roots it runs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Part {
  readonly machine: number
  readonly roots: ReadonlyArray<string>
}

/**
 * One row of a `--results-file`, as a machine wrote it, plus the error a
 * coordinator gives a root it could not run.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Row = Schema.Struct({
  label: Schema.String,
  status: Schema.Literals(["hit", "ran", "failed", "skipped", "cancelled"]),
  key: Schema.String,
  durationMs: Schema.Finite,
  blocking: Schema.optionalKey(Schema.Boolean),
  failureDigest: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

/**
 * One results row.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

const ResultsFile = Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Row) }))

/**
 * The rows of one machine's `--results-file`.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseResults = (content: string): ReadonlyArray<Row> =>
  Schema.decodeUnknownSync(ResultsFile)(content).results

/** How bad each status is when several machines report one label: the worst wins. */
const severity: Readonly<Record<Row["status"], number>> = { hit: 0, ran: 1, skipped: 2, cancelled: 3, failed: 4 }

/**
 * Merges every part's rows into one summary.
 *
 * Rows come out in `order`, the local plan's targets, then any label the plan
 * lacks in the order the parts reported it. A label several parts ran (a
 * shared dependency) keeps its worst status and its longest duration; the
 * counts and `ok` are recomputed from the merged rows.
 *
 * @category merging
 * @since 1.0.0
 */
export const merge = (
  order: ReadonlyArray<{ readonly label: string; readonly target: string }>,
  parts: ReadonlyArray<ReadonlyArray<Row>>,
  run: { readonly pattern: string; readonly jobs: number; readonly durationMs: number }
): Executor.Summary => {
  const merged = new Map<string, Row>()
  for (const row of parts.flat()) {
    const seen = merged.get(row.label)
    const worst = seen === undefined || severity[row.status] > severity[seen.status] ? row : seen
    merged.set(row.label, { ...worst, durationMs: Math.max(row.durationMs, seen?.durationMs ?? 0) })
  }
  const targets = new Map(order.map(({ label, target }) => [label, target]))
  const labels = [...new Set([...order.map(({ label }) => label), ...merged.keys()])]
  const results = labels.flatMap((label): ReadonlyArray<Executor.TargetReport> => {
    const row = merged.get(label)
    return row === undefined ? [] : [{ ...row, target: targets.get(label) ?? "" }]
  })
  const count = (status: Row["status"]) => results.filter((row) => row.status === status).length
  const cancelled = count("cancelled")
  const counts = {
    hit: count("hit"),
    ran: count("ran"),
    failed: count("failed"),
    skipped: count("skipped"),
    ...(cancelled === 0 ? {} : { cancelled })
  }
  return { verb: "ci", ...run, counts, ok: counts.failed === 0, results }
}

/**
 * Every root of a part, failed with one error: what a coordinator reports for
 * a part it could not run.
 *
 * @category merging
 * @since 1.0.0
 */
export const failedRoots = (roots: ReadonlyArray<string>, error: string): ReadonlyArray<Row> =>
  roots.map((label) => ({ label, status: "failed", key: "", durationMs: 0, error }))

/**
 * One file to ship: its workspace-relative path, permission bits, modification
 * time and bytes.
 *
 * @category models
 * @since 1.0.0
 */
export interface TreeFile {
  readonly path: string
  readonly mode: number
  readonly mtimeMs: number
  readonly content: Uint8Array
}

const encoder = new TextEncoder()

/** One 512-byte tar header block. */
const header = (name: Uint8Array, size: number, mode: number, mtimeMs: number, type: string): Uint8Array => {
  const block = new Uint8Array(512)
  const field = (offset: number, length: number, text: string) =>
    block.set(encoder.encode(text).subarray(0, length), offset)
  const octal = (offset: number, length: number, value: number) =>
    field(offset, length, `${Math.trunc(value).toString(8).padStart(length - 1, "0")}\0`)
  block.set(name, 0)
  octal(100, 8, mode & 0o7777)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, size)
  octal(136, 12, Math.max(0, mtimeMs / 1000))
  field(148, 8, "        ")
  field(156, 1, type)
  field(257, 8, "ustar\u000000")
  const sum = block.reduce((total, byte) => total + byte, 0)
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

/** A POSIX extended-header record, `<length> path=<path>\n`, whose length counts itself. */
const paxPath = (path: string): Uint8Array => {
  const body = encoder.encode(` path=${path}\n`).length
  let length = body + String(body).length
  if (String(length).length !== String(body).length) length += 1
  return encoder.encode(`${length} path=${path}\n`)
}

const padding = (size: number): Uint8Array => new Uint8Array((512 - (size % 512)) % 512)

/**
 * Packs files into one POSIX tar archive, every file a regular member. A path
 * longer than a ustar name carries a POSIX extended header, which GNU tar,
 * BusyBox tar and bsdtar all read.
 *
 * @category packing
 * @since 1.0.0
 */
export const pack = (files: ReadonlyArray<TreeFile>): Uint8Array => {
  const blocks: Array<Uint8Array> = []
  for (const file of files) {
    const name = encoder.encode(file.path)
    if (name.length > 100) {
      const record = paxPath(file.path)
      blocks.push(header(encoder.encode("././@PaxHeader"), record.length, 0o644, file.mtimeMs, "x"), record)
      blocks.push(padding(record.length))
    }
    blocks.push(header(name.subarray(0, 100), file.content.length, file.mode, file.mtimeMs, "0"), file.content)
    blocks.push(padding(file.content.length))
  }
  blocks.push(new Uint8Array(1024))
  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    archive.set(block, offset)
    offset += block.length
  }
  return archive
}

/**
 * Quotes one word for a POSIX shell; a word of only safe characters stays bare.
 *
 * @category commands
 * @since 1.0.0
 */
export const quote = (word: string): string =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

/**
 * The machine was lost: its provider failed, or it wrote no readable results
 * file that reports every root it was given. The part action retries it once.
 *
 * @category errors
 * @since 1.0.0
 */
export class MachineLost extends Schema.TaggedError<MachineLost>()("@smthrs/build-cli/RemoteCi/MachineLost", {
  reason: Schema.String
}) {}

/** Two attempts in all: a lost machine runs its part once more, on a fresh session. */
const retryPolicy = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2, jitterRatio: 0 })

const RunPart = Action.make("smthrs/ci/RunPart", {
  payload: { machine: Schema.Int },
  success: Schema.Array(Row),
  error: MachineLost,
  retryPolicy
})

const RemotePart = Flow.make("smthrs/ci/remote-part", {
  payload: { machine: Schema.Int },
  success: Schema.Array(Row),
  error: MachineLost,
  body: ({ machine }: { readonly machine: number }) => RunPart.call({ machine })
})

/**
 * Builds the provider that reaches one declared machine, its sessions working
 * in `workdir`. This is the only place a remote's tag picks a provider.
 *
 * @category providers
 * @since 1.0.0
 */
export const providerOf = (
  remote: WorkspaceDeclaration.RemoteDeclaration,
  machine: number,
  workdir: string
): Effect.Effect<Sandbox.Provider, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return CommandSandbox.make({ spawner, prefix: remote.machines[machine - 1]!, workdir, name: `machine ${machine}` })
  })

/**
 * What {@link run} needs: the declaration, the packed tree, the parts, the
 * flags every machine's `ci` takes, where machine output goes, and how a
 * machine's provider is built.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunOptions<R> {
  readonly remote: WorkspaceDeclaration.RemoteDeclaration
  /** Names this run's directories and sessions; unique per run. */
  readonly runId: string
  readonly tree: Uint8Array
  readonly parts: ReadonlyArray<Part>
  /** Flags appended to every machine's `ci`, already split into words. */
  readonly flags: ReadonlyArray<string>
  /** Receives every line a machine prints, already prefixed with its machine. */
  readonly output: (line: string) => void
  readonly provider: (machine: number, workdir: string) => Effect.Effect<Sandbox.Provider, never, R>
}

/** Runs one shell command in the session, forwarding its output line by line, and answers its exit code. */
const command = (
  session: Sandbox.Session,
  script: string,
  cwd: string,
  output: (line: string) => void
) =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(script, { cwd })
    const forward = (stream: typeof process.stdout) =>
      stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach((line) => Effect.sync(() => output(line))))
    yield* Effect.all([forward(process.stdout), forward(process.stderr)], { concurrency: 2, discard: true })
    return yield* process.exitCode
  }))

/** One attempt at one part on a fresh session in a fresh directory. */
const attempt = <R>(options: RunOptions<R>, part: Part, number: number) =>
  Effect.scoped(Effect.gen(function*() {
    const { cli, setup, workdir } = options.remote
    const directory = `${workdir.replace(/\/+$/, "")}/${options.runId}/machine-${part.machine}-${number}`
    const tree = `${directory}/tree`
    const output = (line: string) => options.output(`machine ${part.machine}: ${line}`)
    const provider = yield* options.provider(part.machine, directory)
    const session = yield* provider.acquire(`smthrs-ci-${options.runId}-${part.machine}-${number}`)
    yield* Effect.addFinalizer(() =>
      Effect.ignore(
        command(
          session,
          `rm -rf ${quote(directory)}; rmdir ${quote(`${workdir}/${options.runId}`)} 2>/dev/null; true`,
          directory,
          output
        )
      )
    )
    yield* session.writeFile(`${directory}/tree.tar`, options.tree)
    const unpacked = yield* command(session, "mkdir tree && tar -xf tree.tar -C tree && rm tree.tar", directory, output)
    if (unpacked !== 0) {
      return yield* new MachineLost({ reason: `the tree could not be unpacked (tar exited ${unpacked})` })
    }
    for (const step of setup) {
      const code = yield* command(session, step, tree, output)
      if (code !== 0) return failedRoots(part.roots, `setup \`${step}\` exited ${code} on machine ${part.machine}`)
    }
    const results = `${directory}/results.json`
    const ci = [...cli, "ci", ...part.roots, "--results-file", results, ...options.flags].map(quote).join(" ")
    const code = yield* command(session, ci, tree, output)
    const content = yield* session.readFile(results).pipe(
      Effect.mapError(() => new MachineLost({ reason: `\`ci\` exited ${code} and wrote no results file` }))
    )
    const rows = yield* Effect.try({
      try: () => parseResults(new TextDecoder().decode(content)),
      catch: () => new MachineLost({ reason: `\`ci\` exited ${code} and its results file is not readable` })
    })
    // A run that failed before planning still writes an empty results file; it reported nothing it was given.
    const missing = part.roots.filter((root) => !rows.some((row) => row.label === root))
    if (missing.length > 0) {
      return yield* new MachineLost({
        reason: `\`ci\` exited ${code} and its results file does not report ${missing.join(", ")}`
      })
    }
    return rows
  })).pipe(
    Effect.mapError((error) => error instanceof MachineLost ? error : new MachineLost({ reason: error.message }))
  )

/**
 * Runs every non-empty part at once and answers each part's rows. A part
 * whose machine was lost twice answers its roots failed with the reason.
 * Interrupting the run closes every session.
 *
 * @category execution
 * @since 1.0.0
 */
export const run = <R>(options: RunOptions<R>): Effect.Effect<ReadonlyArray<ReadonlyArray<Row>>, never, R> =>
  Effect.forEach(
    options.parts.filter((part) => part.roots.length > 0),
    (part) => {
      const implementation = RunPart.toLayer(() =>
        Effect.gen(function*() {
          return yield* attempt(options, part, yield* Action.CurrentAttempt)
        })
      )
      const layer = Layer.mergeAll(implementation, Interpreter.layer(RemotePart)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
      return RemotePart.execute({ machine: part.machine }, { executionId: `${options.runId}-${part.machine}` }).pipe(
        Effect.catchTag(
          "@smthrs/build-cli/RemoteCi/MachineLost",
          (lost) => Effect.succeed(failedRoots(part.roots, `machine ${part.machine} was lost: ${lost.reason}`))
        ),
        // The in-memory engine's own failures (a store, an identity conflict) are wiring defects, not a lost machine.
        Effect.orDie,
        Effect.provide(layer)
      )
    },
    { concurrency: "unbounded" }
  )
