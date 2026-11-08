/**
 * Fuzz registration adapted from smithersai/effect packages/vitest/src/internal/internal.ts
 * at fc84e193be6b202f34a7351cdfb693629c95a38c. The peer runner retains its own test services;
 * the simulation re-provides Clock and Scheduler inside them, as the fork does.
 * @since 0.1.0
 */

import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Clock, Effect, Layer, Scheduler, type Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { it as vitestIt, type TestAPI, type TestContext, type TestOptions } from "vitest"
import * as InternalFuzz from "./fuzz.ts"

/**
 * Configures a Vitest fuzz session and its corpus identity.
 * @since 0.1.0
 * @category models
 */
export interface FuzzOptions extends TestOptions {
  readonly id?: string | undefined
  readonly revision?: string | undefined
  readonly fuzz?: Fuzz.Options | undefined
}
type Value<T> = T extends Schema.Schema<infer A> ? A : T extends Arbitrary.Arbitrary<infer A> ? A : never
type Values<T> = { [K in keyof T]: Value<T[K]> }
/**
 * Registers an Effect property over Schema or Arbitrary inputs.
 * @since 0.1.0
 * @category models
 */
export interface EffectFuzz {
  <const Arbs extends InternalFuzz.Arbitraries, A, E>(
    name: string,
    inputs: Arbs,
    body: (values: Values<Arbs>, context: TestContext) => Effect.Effect<A, E>,
    options?: FuzzOptions
  ): void
}
/**
 * Registers a pure property over Schema or Arbitrary inputs.
 * @since 0.1.0
 * @category models
 */
export interface SyncFuzz {
  <const Arbs extends InternalFuzz.Arbitraries>(
    name: string,
    inputs: Arbs,
    body: (values: Values<Arbs>, context: TestContext) => boolean | void,
    options?: FuzzOptions
  ): void
}

const makeArbitrary = (inputs: InternalFuzz.Arbitraries): Arbitrary.Arbitrary<any> => {
  const compile = (input: InternalFuzz.ArbitraryInput) => Arbitrary.isArbitrary(input) ? input : Arbitrary.schema(input)
  return Arbitrary.all(
    Array.isArray(inputs)
      ? inputs.map(compile)
      : Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, compile(v)]))
  )
}

/**
 * Builds fresh registrars without mutating the shared peer runner.
 * @since 0.1.0
 * @category constructors
 */
export const makeMethods = (test: TestAPI = vitestIt) => {
  const register = (
    name: string,
    inputs: InternalFuzz.Arbitraries,
    property: (values: any, ctx: TestContext) => boolean | Effect.Effect<boolean, unknown>,
    options?: FuzzOptions
  ) => {
    const { fuzz, id, revision, ...vitestOptions } = options ?? {}
    const session = InternalFuzz.session(process.env, name)
    const timeout = session === undefined || vitestOptions.timeout !== undefined
      ? vitestOptions :
      { ...vitestOptions, timeout: InternalFuzz.sessionTimeout({ ...fuzz, ...session }) }
    test(name, timeout, (ctx) => {
      const values = (value: any) => property(value, ctx)
      const target = InternalFuzz.makeTarget(inputs, values, {
        id: id ?? ctx.task.fullTestName,
        revision: revision ?? "1"
      })
      const store = InternalFuzz.fileCorpus(InternalFuzz.corpusDirectories(ctx.task.file.filepath, process.cwd()))
      const fuzzed = InternalFuzz.runFuzz(target, store, fuzz, session, (message) => Effect.logInfo(message))
      const smoke = Fuzz.run(makeArbitrary(inputs), values, { executions: 100, execution: fuzz?.execution }).pipe(
        Effect.flatMap((report) => {
          const failure = Fuzz.formatReport(report)
          return failure === undefined ? Effect.void : Effect.die(new Error(failure))
        })
      )
      return Effect.runPromise(Effect.scoped(session === undefined ? Effect.andThen(fuzzed, smoke) : fuzzed), {
        signal: ctx.signal
      })
    })
  }
  const effectFuzz: EffectFuzz = (name, inputs, body, options) =>
    register(name, inputs, (values, ctx) =>
      Effect.withFiber((fiber) => {
        const evaluation = Effect.suspend(() => body(values, ctx))
        const owned = options?.fuzz?.execution === undefined ? evaluation : evaluation.pipe(
          Effect.provideService(Clock.Clock, fiber.getRef(Clock.Clock)),
          Effect.provideService(Scheduler.Scheduler, fiber.getRef(Scheduler.Scheduler))
        )
        return Effect.map(Effect.provide(owned, Layer.mergeAll(TestClock.layer(), TestConsole.layer)), (value) =>
          (value as unknown) !== false)
      }), options)
  const fuzz: SyncFuzz = (name, inputs, body, options) =>
    register(name, inputs, (values, ctx) => {
      const result = body(values, ctx)
      if (result !== undefined && typeof result !== "boolean") {
        throw new TypeError("it.fuzz callbacks must return boolean or void. Use it.effect.fuzz for Effect callbacks.")
      }
      return result !== false
    }, options)
  return { fuzz, effect: { fuzz: effectFuzz } }
}
