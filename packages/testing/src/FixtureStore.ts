/**
 * Where a cached model reads and records its fixture.
 *
 * The store is the only part of the record-and-replay loop that touches a
 * host: `layerFile` requires filesystem and path services; `layerMemory` runs anywhere.
 *
 * @since 0.0.0
 */

import { Context, Effect, Exit, FileSystem, Layer, Option, Path, Ref, SynchronizedRef } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { decode, type Fixture, type RecordedCall } from "./Fixture.ts"
import { maximumDepth, snapshot } from "./internal/Structural.ts"

/**
 * Loads and records a recorded-model fixture.
 *
 * Neither method has an error channel. A fixture that cannot be read or decoded
 * is a broken test setup, not an outcome the code under test can handle, so it
 * is a defect; a fixture that does not exist yet is `None`, which is what a
 * first recording run sees.
 *
 * @category services
 * @since 0.0.0
 */
export interface FixtureStore {
  readonly load: () => Effect.Effect<Option.Option<Fixture>>
  readonly append: (call: RecordedCall) => Effect.Effect<void>
}

/**
 * The {@link FixtureStore} service tag.
 *
 * @category services
 * @since 0.0.0
 */
export const FixtureStore: Context.Service<FixtureStore, FixtureStore> = Context.Service(
  "flows/testing/FixtureStore"
)

/**
 * Builds a {@link FixtureStore} from an implementation of its two methods.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (implementation: FixtureStore): FixtureStore => FixtureStore.of(implementation)

const plainRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Freezes the arrays and plain records `snapshot` just built, and nothing else.
 *
 * `snapshot` recreates exactly the array and plain-record spine and passes any
 * other value through by reference, so this walk freezes only values the store
 * owns: freezing a passed-through class instance would freeze the caller's. It
 * stops at `snapshot`'s own depth boundary for the same reason, and because a
 * walk without one is the unbounded recursion the encoder was just given a cap
 * to avoid.
 */
const owned = <A>(value: A, seen: Set<object>, depth: number): A => {
  if (depth >= maximumDepth) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    for (const item of value) owned(item, seen, depth + 1)
    return Object.freeze(value)
  }
  if (!plainRecord(value)) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) owned(value[key], seen, depth + 1)
  return Object.freeze(value)
}

/**
 * The store's own immutable copy of a recorded call.
 *
 * Both boundaries used to alias the caller's values: `append` copied the calls
 * array and nothing inside it, and `load` handed those same references back.
 * A harness that reused one event object across turns, or that rewrote a tool
 * schema after the call was recorded, retroactively rewrote what the fixture
 * had already recorded, and `makeFile` then wrote the rewritten value to disk
 * on the next flush.
 *
 * The copy is frozen rather than re-copied on every `load`, because
 * `Fixture.index` memoizes its digest index on fixture identity: handing back
 * a fresh copy per load would rebuild that index on every model call.
 */
const recorded = <A>(value: A): A => owned(snapshot(value), new Set<object>(), 0)

const appended = (current: Option.Option<Fixture>, call: RecordedCall): Fixture =>
  Object.freeze({
    calls: Object.freeze([
      ...Option.match(current, { onNone: () => [], onSome: (fixture) => fixture.calls }),
      recorded(call)
    ])
  })

/**
 * Builds a store that keeps the fixture in memory.
 *
 * `load` reports `None` until the first call is recorded, so an empty memory
 * store behaves exactly like a file that does not exist yet.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeMemory = (initial?: Fixture): Effect.Effect<FixtureStore> =>
  Effect.gen(function*() {
    const state = yield* Ref.make(Option.map(Option.fromUndefinedOr(initial), recorded))
    return make({
      load: () => Ref.get(state),
      append: (call) => Ref.update(state, (current) => Option.some(appended(current, call)))
    })
  })

/**
 * Provides {@link makeMemory}.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerMemory = (initial?: Fixture): Layer.Layer<FixtureStore> =>
  Layer.effect(FixtureStore)(makeMemory(initial))

const fileError = (path: string, cause: unknown): Error =>
  new Error(`Fixture file ${path}: ${String(cause)}`, { cause })

const parse = (path: string, text: string): Effect.Effect<unknown> =>
  Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => fileError(path, cause) }).pipe(Effect.orDie)

const decodeFile = (path: string, value: unknown): Effect.Effect<Fixture> =>
  decode(value).pipe(Effect.mapError((cause) => fileError(path, cause)), Effect.orDie)

/**
 * Builds a store over a JSON file and an append-only journal using the injected
 * filesystem and path services from the library catalog.
 *
 * Each append asynchronously persists only the new call. Call `flush` to
 * atomically publish the complete JSON and release the path's writer lock.
 * `layerFile` does this on scope close. One store may record at a path until
 * it flushes; competing stores fail with a path-naming defect. After a killed
 * process, remove the abandoned `.lock` directory before reopening. Completed
 * journal lines are recovered, and an incomplete last line is discarded.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeFile = (path: string): Effect.Effect<
  FixtureStore & {
    readonly flush: () => Effect.Effect<void>
  },
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const root = paths.resolve()
    path = paths.resolve(path)
    const io = <A, E, R>(file: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
      effect.pipe(Effect.mapError((cause) => fileError(file, cause)), Effect.orDie)
    const optional = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
      effect.pipe(Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(undefined)))

    // Unsupported hosts reject noFollow with BadArgument. Only that rejection
    // falls back to inspecting the entry and comparing the opened handle.
    const withJournal = <A>(
      file: string,
      mode: "read" | "append" | "truncate",
      use: (handle: FileSystem.File) => Effect.Effect<A, PlatformError>
    ) =>
      Effect.scoped(Effect.gen(function*() {
        const entry = yield* (mode === "append" ? optional(fs.lstat(file)) : fs.lstat(file))
        if (entry !== undefined && entry.type !== "File") {
          return yield* Effect.die(fileError(file, new Error(`refusing non-regular journal ${file}`)))
        }
        const flag = mode === "read" ? "r" : mode === "truncate" ? "r+" : entry === undefined ? "ax" : "a"
        const handle = yield* fs.open(file, { flag, noFollow: true }).pipe(
          Effect.catchIf((error) => error.reason._tag === "BadArgument", () => fs.open(file, { flag }))
        )
        const actual = yield* handle.stat
        if (
          actual.type !== "File" ||
          (entry !== undefined &&
            (entry.dev !== actual.dev || Option.getOrUndefined(entry.ino) !== Option.getOrUndefined(actual.ino)))
        ) {
          return yield* Effect.die(fileError(file, new Error(`journal changed while opening ${file}`)))
        }
        return yield* use(handle)
      }))

    const readOptional = (file: string, journal = false): Effect.Effect<string | undefined> =>
      io(
        file,
        optional(
          journal
            ? withJournal(file, "read", (handle) =>
              Effect.gen(function*() {
                const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
                let text = ""
                while (true) {
                  const chunk = yield* handle.readAlloc(64 * 1024)
                  if (Option.isNone(chunk)) return text + decoder.decode()
                  text += decoder.decode(chunk.value, { stream: true })
                }
              }))
            : fs.readFile(file).pipe(Effect.map((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)))
        )
      )

    // Only directories below the injected working root have a trusted anchor.
    const refuseSymlinkedDirs = Effect.gen(function*() {
      const rel = paths.relative(root, paths.dirname(path))
      if (rel === "" || rel === ".." || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel)) return
      let current = root
      for (const part of rel.split(paths.sep)) {
        current = paths.join(current, part)
        const stat = yield* optional(fs.lstat(current))
        if (stat === undefined) return
        if (stat.type === "SymbolicLink") {
          return yield* Effect.die(fileError(path, new Error(`refusing to record through symbolic link ${current}`)))
        }
      }
    })

    // Called only while holding the path lock. Publication can precede journal
    // cleanup when a writer dies, so skip already-published indexes.
    const readFixture = (): Effect.Effect<Option.Option<Fixture>> =>
      Effect.gen(function*() {
        const text = yield* readOptional(path)
        const initial = text === undefined ? undefined : yield* decodeFile(path, yield* parse(path, text))
        const calls = [...(initial?.calls ?? [])]
        const journalPath = `${path}.journal`
        const journal = yield* readOptional(journalPath, true)
        if (journal !== undefined) {
          const end = journal.lastIndexOf("\n") + 1
          const complete = journal.slice(0, end)
          let previous: number | undefined
          for (const line of complete.split("\n").slice(0, -1)) {
            const value = yield* parse(journalPath, line)
            const entry = value as { index?: unknown; call?: unknown } | null
            const index = entry?.index
            if (
              typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > calls.length ||
              (previous !== undefined && index !== previous + 1)
            ) {
              return yield* Effect.die(fileError(journalPath, new Error("Invalid journal call index")))
            }
            const decoded = yield* decodeFile(journalPath, { calls: [entry!.call] })
            if (index === calls.length) calls.push(decoded.calls[0]!)
            previous = index
          }
          if (end !== journal.length) {
            yield* io(
              journalPath,
              withJournal(
                journalPath,
                "truncate",
                (handle) => handle.truncate(new TextEncoder().encode(complete).byteLength)
              )
            )
          }
        }
        return initial === undefined && calls.length === 0
          ? Option.none()
          : Option.some(recorded({ calls }))
      })

    const writeFixture = (fixture: Fixture): Effect.Effect<void> =>
      io(
        path,
        Effect.scoped(Effect.gen(function*() {
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: paths.dirname(path),
            prefix: `${paths.basename(path)}.`
          })
          const staging = paths.join(directory, "fixture.tmp")
          yield* fs.writeFileString(staging, `${JSON.stringify(fixture, undefined, 2)}\n`, { flag: "wx" })
          yield* fs.rename(staging, path)
          yield* fs.remove(`${path}.journal`, { force: true })
        }))
      )

    const lockPath = `${path}.lock`
    let locked = false
    const acquire = io(
      path,
      Effect.gen(function*() {
        yield* refuseSymlinkedDirs
        yield* fs.makeDirectory(paths.dirname(path), { recursive: true })
        yield* fs.makeDirectory(lockPath)
        locked = true
      })
    )
    const release = Effect.suspend(() =>
      locked
        ? io(
          path,
          Effect.gen(function*() {
            yield* fs.remove(lockPath, { recursive: true })
            locked = false
          })
        )
        : Effect.void
    )
    const initial = yield* Effect.acquireUseRelease(acquire, readFixture, () => release)
    const state = yield* SynchronizedRef.make(initial)
    const current = (value: Option.Option<Fixture>) =>
      locked ? Effect.succeed(value) : acquire.pipe(Effect.andThen(readFixture))
    return {
      ...make({
        load: () => SynchronizedRef.get(state),
        append: (call) =>
          SynchronizedRef.updateEffect(state, (value) =>
            Effect.gen(function*() {
              const next = appended(yield* current(value), call)
              const index = next.calls.length - 1
              const journalPath = `${path}.journal`
              const line = JSON.stringify({ index, call: next.calls[index] })
              // Persist only what reloads: JSON changes non-finite numbers to null.
              yield* decodeFile(journalPath, { calls: [(JSON.parse(line) as { readonly call: unknown }).call] })
              yield* io(
                journalPath,
                withJournal(journalPath, "append", (handle) => handle.writeAll(new TextEncoder().encode(`${line}\n`)))
              )
              return Option.some(next)
            }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? release : Effect.void))).pipe(Effect.uninterruptible)
      }),
      flush: () =>
        SynchronizedRef.updateEffect(state, (value) =>
          Effect.gen(function*() {
            const latest = yield* current(value)
            if (Option.isSome(latest) && (yield* readOptional(`${path}.journal`, true)) !== undefined) {
              yield* writeFixture(latest.value)
            }
            return latest
          }).pipe(Effect.ensuring(release))).pipe(Effect.uninterruptible)
    }
  }).pipe(Effect.uninterruptible)

/**
 * Provides {@link makeFile}, flushing the JSON fixture on scope close.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerFile = (path: string): Layer.Layer<FixtureStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(FixtureStore)(Effect.acquireRelease(makeFile(path), (store) => store.flush()))
