import * as Arbitrary from "effect/Arbitrary"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { Fuzz } from "@smthrs/fuzz"
import * as Schema from "effect/Schema"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** @internal */
export type ArbitraryInput = Schema.Schema<any> | Arbitrary.Arbitrary<unknown>

/** @internal */
export type Arbitraries = Array<ArbitraryInput> | { [K in string]: ArbitraryInput }

/**
 * Reads the fuzz session switch for one test. Without `EFFECT_FUZZ`, or when the test name does not contain it, the
 * test only replays saved failures. `EFFECT_FUZZ=1` selects every fuzz test.
 *
 * @internal
 */
export const session = (
  env: Readonly<Record<string, string | undefined>>,
  name: string
): Fuzz.Options | undefined => {
  const selector = env.EFFECT_FUZZ
  if (selector === undefined || selector === "" || (selector !== "1" && !name.includes(selector))) return undefined
  const executions = env.EFFECT_FUZZ_EXECUTIONS
  const seed = env.EFFECT_FUZZ_SEED
  return {
    ...(env.EFFECT_FUZZ_DURATION === undefined ? {} : { duration: env.EFFECT_FUZZ_DURATION as Duration.Input }),
    ...(executions === undefined ? {} : { executions: Number(executions) }),
    ...(seed === undefined ? {} : { seed: /^\d+$/.test(seed) ? Number(seed) : seed })
  }
}

/**
 * The Vitest timeout for a fuzz session: the duration budget plus 30 seconds for shrinking and cleanup, or none when
 * the session is bounded only by executions or plateau.
 *
 * @internal
 */
export const sessionTimeout = (options: Fuzz.Options): number =>
  options.duration === undefined && (options.executions !== undefined || options.plateau !== undefined)
    ? 0
    : Duration.toMillis(Duration.fromInputUnsafe(options.duration ?? "10 seconds")) + 30_000

/**
 * The directory name of a target: a readable prefix of its id, then a hash of the whole id. The prefix alone merges
 * ids such as "parse: x" and "parse x", and could be "", "." or "..".
 *
 * @internal
 */
export const segment = (id: string): string =>
  `${id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64)}-${
    crypto.createHash("sha256").update(id).digest("hex").slice(0, 16)
  }`

/**
 * A corpus store over `node:fs`. Failures go to `failures/<segment>/<key>`, the directory to commit; inputs go to
 * `inputs/<segment>/<key>`, a cache, where the segment is {@link segment} of the target id. Files are written to a temporary name and renamed, so a crash never leaves half an
 * entry.
 *
 * @internal
 */
export const fileCorpus = (directories: { readonly failures: string; readonly inputs: string }): Fuzz.Store => {
  const directory = (kind: Fuzz.StoredEntry["kind"], target: string) =>
    path.join(kind === "Failure" ? directories.failures : directories.inputs, segment(target))
  const attempt = <A>(message: string, f: () => A) =>
    Effect.try({
      try: f,
      catch: (cause) => new Fuzz.FuzzError({ reason: "Corpus", message: `${message}: ${String(cause)}`, cause })
    })
  return {
    load: (target) =>
      attempt(`cannot read the corpus of ${target}`, () => {
        const out: Array<Fuzz.StoredEntry> = []
        for (const kind of ["Failure", "Input"] as const) {
          const dir = directory(kind, target)
          if (!fs.existsSync(dir)) continue
          for (const key of fs.readdirSync(dir).sort()) {
            if (key.endsWith(".tmp")) continue
            out.push({ kind, key, text: fs.readFileSync(path.join(dir, key), "utf8") })
          }
        }
        return out
      }),
    save: (target, entry) =>
      attempt(`cannot save ${entry.kind} ${entry.key} of ${target}`, () => {
        const dir = directory(entry.kind, target)
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, entry.key)
        fs.writeFileSync(`${file}.tmp`, entry.text)
        fs.renameSync(`${file}.tmp`, file)
      })
  }
}

/**
 * The corpus directories of a test file: failures beside it in `__fuzz__/<file name>`, inputs in
 * `node_modules/.cache/effect-fuzz/<file path>` under the working directory.
 *
 * @internal
 */
export const corpusDirectories = (testFile: string, cwd: string) => ({
  failures: path.join(path.dirname(testFile), "__fuzz__", path.basename(testFile)),
  inputs: path.join(cwd, "node_modules", ".cache", "effect-fuzz", path.relative(cwd, testFile))
})

const isSchemaInput = (input: ArbitraryInput): input is Schema.Schema<any> => !Arbitrary.isArbitrary(input)

/**
 * Builds the fuzz target of a test. When every input is a Schema, failures are saved as values through the Schema's
 * JSON codec, so encodable values survive generator changes. Unencodable values or inputs without a codec are saved
 * as tapes tied to `revision`.
 *
 * @internal
 */
export const makeTarget = <A, E = never, R = never>(
  arbitraries: Arbitraries,
  property: (values: A) => boolean | Effect.Effect<boolean, E, R>,
  options: { readonly id: string; readonly revision: string }
): Fuzz.Target<A, E, R> => {
  const inputs = Array.isArray(arbitraries) ? arbitraries : Object.values(arbitraries)
  if (inputs.every(isSchemaInput)) {
    const schema = Array.isArray(arbitraries)
      ? Schema.Tuple(arbitraries as Array<Schema.Schema<any>>)
      : Schema.Struct(arbitraries as Record<string, Schema.Schema<any>>)
    return Fuzz.target(schema as any, property as any, options) as Fuzz.Target<A, E, R>
  }
  const compile = (input: ArbitraryInput) => isSchemaInput(input) ? Arbitrary.schema(input) : input
  const arbitrary = Array.isArray(arbitraries)
    ? Arbitrary.all(arbitraries.map(compile))
    : Arbitrary.all(Object.fromEntries(Object.entries(arbitraries).map(([key, input]) => [key, compile(input)])))
  return Fuzz.target(arbitrary as Arbitrary.Arbitrary<any>, property, options)
}

/**
 * Runs one fuzz test. Without a session it replays saved failures (`executions: 0`) and writes nothing; with one it
 * searches and saves. Any finding fails the test with the formatted report.
 *
 * @internal
 */
export const runFuzz = <A, E, R>(
  target: Fuzz.Target<A, E, R>,
  store: Fuzz.Store,
  options: Fuzz.Options | undefined,
  sessionOptions: Fuzz.Options | undefined,
  log: (message: string) => Effect.Effect<void>
): Effect.Effect<void, Fuzz.FuzzError | Error, R> =>
  Effect.flatMap(
    // A plain run replays only, but under the same execution driver: a saved schedule race needs the simulation.
    Fuzz.runTarget(
      target,
      sessionOptions === undefined
        ? { executions: 0, execution: options?.execution }
        : { ...options, ...sessionOptions }
    ).pipe(
      Effect.provideService(Fuzz.Corpus, store)
    ),
    (report) => {
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) return Effect.fail(new Error(failure))
      const stats = report.stats
      if (sessionOptions !== undefined) {
        return log(
          `Fuzzed ${target.id}: ${stats.executions} execution(s), ${stats.corpus} corpus input(s), features ${
            JSON.stringify(stats.features)
          }, stopped by ${stats.stoppedBy}`
        )
      }
      return stats.regressions + stats.stale > 0
        ? log(`Replayed ${stats.regressions} saved failure(s) of ${target.id}; skipped ${stats.stale} stale tape(s)`)
        : Effect.void
    }
  )
