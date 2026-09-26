import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as Profile from "../src/Profile.ts"
import * as Roster from "../src/Roster.ts"

export const nodeLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

export const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(nodeLayer)))

export const flip = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<E> =>
  run(Effect.flip(effect))

/** Which filesystem calls a {@link faultyLayer} fails: by method name and first path argument. */
export type Fault = (method: string, path: string) => boolean

const faultable = [
  "exists",
  "makeDirectory",
  "readDirectory",
  "readFileString",
  "realPath",
  "remove",
  "rename",
  "stat",
  "writeFileString"
] as const

/**
 * The Node filesystem with chosen calls failing, for the error paths a real
 * directory cannot provoke portably.
 */
export const faultyLayer = (fault: Fault): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
  Layer.mergeAll(
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (real) => {
        const wrapped: Record<string, unknown> = { ...real }
        for (const method of faultable) {
          const original = real[method] as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
          wrapped[method] = (...args: ReadonlyArray<unknown>) =>
            fault(method, String(args[0]))
              ? Effect.fail(
                PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method, description: "injected" })
              )
              : original(...args)
        }
        return wrapped as unknown as FileSystem.FileSystem
      })
    ).pipe(Layer.provide(NodeFileSystem.layer)),
    NodePath.layer
  )

/** Runs `effect` over {@link faultyLayer} and returns its failure. */
export const flipWith = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  fault: Fault
): Promise<E> => Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(faultyLayer(fault))))

export const exampleDir = fileURLToPath(new URL("./fixtures/org/", import.meta.url))

export const readFixture = (relative: string): string => readFileSync(join(exampleDir, relative), "utf8")

export const examplePolicy: Roster.Policy = { weeklyMeeting: true, skills: ["code-review", "debug", "research"] }

export const loadExample = (): Promise<Roster.Roster> => run(Roster.load(exampleDir))

export const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "organization-test-")))

/** A writable copy of the example organization directory. */
export const copyExample = (): string => {
  const dir = tempDir()
  cpSync(exampleDir, dir, { recursive: true })
  return dir
}

export const ok = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  return result.success
}

export const err = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`expected failure, got ${JSON.stringify(result.success)}`)
  return result.failure
}

export const profileOf = (roster: Roster.Roster, id: string): Profile.Profile => {
  const profile = roster.profiles.get(id)
  if (profile === undefined) throw new Error(`no profile ${id}`)
  return profile
}

/** Returns a copy of `profile` with `patch` applied to its grants. */
export const withGrants = (profile: Profile.Profile, patch: Partial<Profile.Grants>): Profile.Profile => ({
  ...profile,
  grants: { ...profile.grants, ...patch }
})

/** A small deterministic PRNG (mulberry32) for property-style tests. */
export const prng = (seed: number) => {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (max: number): number => Math.floor(next() * max)
  const pick = <A>(values: ReadonlyArray<A>): A => values[int(values.length)]!
  const subset = <A>(values: ReadonlyArray<A>, probability = 0.5): Array<A> => values.filter(() => next() < probability)
  return { next, int, pick, subset, chance: (probability: number) => next() < probability }
}
