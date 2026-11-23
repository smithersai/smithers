/**
 * V8 basic-block coverage feedback adapter for `@smthrs/fuzz` on Node.js.
 *
 * Uses `node:inspector` precise block coverage (`Profiler.takePreciseCoverage`)
 * to extract exact executed bytecode intervals and AFL-style hit-count buckets
 * per fuzz evaluation. Plug into `Fuzz.run(..., { feedback: [Fuzz.spans, v8] })`
 * or enable automatically in Vitest fuzz sessions with `EFFECT_FUZZ_V8_COVERAGE=1`.
 *
 * @since 1.0.0
 */

import { Fuzz } from "@smthrs/fuzz"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as inspector from "node:inspector"

/**
 * One V8 precise-coverage bytecode range.
 *
 * @since 1.0.0
 * @category models
 */
export interface CoverageRange {
  readonly startOffset: number
  readonly endOffset: number
  readonly count: number
}

/**
 * One V8 function coverage entry returned by `Profiler.takePreciseCoverage`.
 *
 * @since 1.0.0
 * @category models
 */
export interface FunctionCoverage {
  readonly functionName: string
  readonly ranges: ReadonlyArray<CoverageRange>
  readonly isBlockCoverage: boolean
}

/**
 * One V8 script coverage entry returned by `Profiler.takePreciseCoverage`.
 *
 * @since 1.0.0
 * @category models
 */
export interface ScriptCoverage {
  readonly scriptId: string
  readonly url: string
  readonly functions: ReadonlyArray<FunctionCoverage>
}

/**
 * Minimal inspector session contract used by V8 coverage feedback.
 *
 * @since 1.0.0
 * @category models
 */
export interface InspectorSession {
  readonly connect: () => void
  readonly disconnect: () => void
  readonly post: (
    method: string,
    params?: Record<string, unknown>,
    callback?: (err: Error | null, params?: { readonly result: ReadonlyArray<ScriptCoverage> }) => void
  ) => void
}

/**
 * One executed bytecode interval after carving out zero-count child ranges.
 *
 * @since 1.0.0
 * @category models
 */
export interface ExecutedBlock {
  readonly startOffset: number
  readonly endOffset: number
  readonly count: number
}

/**
 * Configures {@link make}.
 *
 * @since 1.0.0
 * @category models
 */
export interface V8CoverageOptions {
  /**
   * Filter selecting which script URLs contribute coverage features. Accepts a
   * predicate or a list of required substrings. Defaults to excluding `node:`
   * built-ins, `node_modules/`, and the fuzzer runtime itself.
   */
  readonly include?: ((url: string) => boolean) | ReadonlyArray<string> | undefined
  /**
   * Feedback source name reported in `Fuzz.Stats.features`. Defaults to `"v8"`.
   */
  readonly name?: string | undefined
}

/**
 * Default inspector session constructor backed by `node:inspector`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const createNodeSession = (): InspectorSession => new inspector.Session() as unknown as InspectorSession

/**
 * Effect service reference supplying the V8 inspector session factory.
 * Defaults to {@link createNodeSession}; inject a faulty or scripted factory
 * in tests to exercise error paths without interfering with coverage runners.
 *
 * @since 1.0.0
 * @category services
 */
export const Inspector: Context.Reference<() => InspectorSession> = Context.Reference(
  "@smthrs/testing/FuzzV8Coverage/Inspector",
  { defaultValue: () => createNodeSession }
)

/**
 * Buckets a positive block hit count into AFL-style power-of-two tiers.
 *
 * @since 1.0.0
 * @category coverage
 */
export const hitBucket = (count: number): number => {
  if (count <= 3) return count
  if (count <= 7) return 4
  if (count <= 15) return 8
  if (count <= 31) return 16
  if (count <= 127) return 32
  return 128
}

/**
 * Extracts exact executed byte-offset intervals from V8's nested block
 * coverage ranges. Zero-count child ranges carve holes out of enclosing
 * positive-count parent ranges so distinct branches yield distinct intervals.
 *
 * @since 1.0.0
 * @category coverage
 */
export const executedBlocks = (ranges: ReadonlyArray<CoverageRange>): ReadonlyArray<ExecutedBlock> => {
  const out: Array<ExecutedBlock> = []
  const stack: Array<{ readonly end: number; readonly count: number; cursor: number }> = []
  for (const range of ranges) {
    while (stack.length > 0 && stack[stack.length - 1]!.end <= range.startOffset) {
      const top = stack.pop()!
      if (top.count > 0 && top.cursor < top.end) {
        out.push({ startOffset: top.cursor, endOffset: top.end, count: top.count })
      }
    }
    const parent = stack[stack.length - 1]
    if (parent !== undefined) {
      if (parent.count > 0 && parent.cursor < range.startOffset) {
        out.push({ startOffset: parent.cursor, endOffset: range.startOffset, count: parent.count })
      }
      parent.cursor = range.endOffset
    }
    stack.push({ end: range.endOffset, count: range.count, cursor: range.startOffset })
  }
  while (stack.length > 0) {
    const top = stack.pop()!
    if (top.count > 0 && top.cursor < top.end) {
      out.push({ startOffset: top.cursor, endOffset: top.end, count: top.count })
    }
  }
  return out
}

/**
 * Default URL filter excluding Node built-ins, installed dependencies, and the
 * fuzzing harness internals so feedback tracks only code under test.
 *
 * @since 1.0.0
 * @category coverage
 */
export const defaultInclude = (url: string): boolean =>
  url.length > 0 &&
  !url.startsWith("node:") &&
  !url.includes("/node_modules/") &&
  !url.includes("\\node_modules\\") &&
  !url.includes("/packages/fuzz/src/") &&
  !url.includes("/packages/testing/src/FuzzV8Coverage.ts") &&
  !url.includes("/packages/testing/src/internal/fuzz.ts") &&
  !url.includes("/packages/testing/src/internal/FuzzRegistration.ts")

const toFilter = (include: V8CoverageOptions["include"]): (url: string) => boolean => {
  if (include === undefined) return defaultInclude
  if (typeof include === "function") return include
  const patterns = include
  return (url) => defaultInclude(url) && patterns.some((pattern) => url.includes(pattern))
}

const postSync = (
  session: InspectorSession,
  method: string,
  params: Record<string, unknown> = {}
): ReadonlyArray<ScriptCoverage> => {
  let failure: Error | null = null
  let result: ReadonlyArray<ScriptCoverage> = []
  session.post(method, params, (err, response) => {
    failure = err
    if (response !== undefined) result = response.result
  })
  if (failure !== null) throw failure
  return result
}

const wrapFailure = (message: string, cause: unknown): Fuzz.FuzzError =>
  new Fuzz.FuzzError({ reason: "Feedback", message: `${message}: ${String(cause)}`, cause })

const reportScripts = (
  scripts: ReadonlyArray<ScriptCoverage>,
  include: (url: string) => boolean,
  sink: Fuzz.Sink
): void => {
  for (const script of scripts) {
    if (!include(script.url)) continue
    for (const fn of script.functions) {
      for (const block of executedBlocks(fn.ranges)) {
        sink.feature(`${script.url}:${block.startOffset}:${block.endOffset}#${hitBucket(block.count)}`)
      }
    }
  }
}

/**
 * Acquires a scoped Node V8 precise-coverage {@link Fuzz.Feedback} source.
 *
 * Connects an inspector session, starts precise block coverage with call
 * counts, drains counters before each property evaluation, and reports newly
 * executed basic-block intervals and hit-count buckets after each evaluation
 * (including when the property fails or dies). Stops coverage and disconnects
 * when the scope closes.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = (
  options?: V8CoverageOptions
): Effect.Effect<Fuzz.Feedback, Fuzz.FuzzError, Scope.Scope> =>
  Effect.gen(function*() {
    const name = options?.name ?? "v8"
    const include = toFilter(options?.include)
    const createSession = yield* Inspector
    const session = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const active = createSession()
          active.connect()
          try {
            postSync(active, "Profiler.enable")
            postSync(active, "Profiler.startPreciseCoverage", { callCount: true, detailed: true })
          } catch (cause) {
            active.disconnect()
            throw cause
          }
          return active
        },
        catch: (cause) => wrapFailure("cannot start V8 coverage feedback", cause)
      }),
      (active) =>
        Effect.sync(() => {
          try {
            postSync(active, "Profiler.stopPreciseCoverage")
          } catch {
            // Best-effort cleanup during scope teardown.
          } finally {
            active.disconnect()
          }
        })
    )
    return {
      name,
      measure: <A, E, R>(self: Effect.Effect<A, E, R>, sink: Fuzz.Sink): Effect.Effect<A, E, R> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.flatMap(
            Effect.sync(() => {
              postSync(session, "Profiler.takePreciseCoverage")
            }),
            () =>
              Effect.onExit(restore(self), () =>
                Effect.sync(() => {
                  const scripts = postSync(session, "Profiler.takePreciseCoverage")
                  reportScripts(scripts, include, sink)
                }))
          )
        )
    }
  })

/**
 * Parses `EFFECT_FUZZ_V8_COVERAGE` from an environment record. Returns
 * `undefined` when disabled, `{}` when `"1"` or `"true"`, or a substring filter
 * list when set to a comma-separated list of path fragments.
 *
 * @since 1.0.0
 * @category configuration
 */
export const fromEnv = (
  env: Readonly<Record<string, string | undefined>>
): V8CoverageOptions | undefined => {
  const raw = env.EFFECT_FUZZ_V8_COVERAGE?.trim()
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") return undefined
  if (raw === "1" || raw === "true") return {}
  const include = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
  return include.length === 0 ? {} : { include }
}
