/**
 * The poison layers are what every purity claim rests on, so each poisoned
 * member is exercised here rather than assumed. Nothing in the suite used to
 * execute the proxy body at all, which is how a proxy that answered every
 * property with a function survived review.
 */
import * as Kernel from "@smthrs/kernel"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as Path from "effect/Path"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Random from "effect/Random"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vitest"
import { ModelLike } from "../src/ModelLike.vibe"
import { CapabilityContractError } from "../src/TestingError.vibe"
import * as TestLayers from "../src/TestLayers.vibe"

const raised = <A, E>(effect: Effect.Effect<A, E, never>): Promise<unknown> =>
  Effect.runPromiseExit(effect).then((exit) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

/** Reads one property inside an effect, so the synchronous throw is captured. */
const read = <A>(service: Effect.Effect<A, never, never>, property: (value: A) => unknown) =>
  raised(Effect.gen(function*() {
    return property(yield* service)
  }))

describe("TestLayers.poisoned rejects every host capability", () => {
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(TestLayers.poisoned))

  it.each(
    [
      ["filesystem", (fs: FileSystem.FileSystem) => fs.readFile("/x"), FileSystem.FileSystem],
      ["path", (path: Path.Path) => path.sep, Path.Path],
      ["path", (path: Path.Path) => path.normalize("/x"), Path.Path]
    ] as const
  )("rejects a %s read", async (capability, use, tag) => {
    const error = await read(provided(tag as never) as Effect.Effect<never>, use as (value: never) => unknown)
    expect(error).toBeInstanceOf(CapabilityContractError)
    expect((error as CapabilityContractError).capability).toBe(capability)
  })

  it("rejects the spawner, jj, and http transport", async () => {
    const spawner = await read(
      provided(ChildProcessSpawner.ChildProcessSpawner) as Effect.Effect<
        ChildProcessSpawner.ChildProcessSpawner["Service"]
      >,
      (service) => service.spawn
    )
    expect((spawner as CapabilityContractError).capability).toBe("shell")
    const http = await read(
      provided(HttpClient.HttpClient) as Effect.Effect<HttpClient.HttpClient>,
      (service) => service.execute
    )
    expect((http as CapabilityContractError).capability).toBe("httpTransport")
    const jj = await read(provided(Kernel.Jj.Jj) as Effect.Effect<Kernel.Jj.Jj>, (service) => service.status)
    expect((jj as CapabilityContractError).capability).toBe("jj")
  })

  it("answers undefined to the probes a runtime uses to classify a value", async () => {
    const probe = await Effect.runPromise(
      provided(Effect.gen(function*() {
        const path = yield* Path.Path
        return (path as unknown as Record<string, unknown>).then
      })) as Effect.Effect<unknown>
    )
    expect(probe).toBeUndefined()
  })

  it("dies rather than fails when a stream reaches the model", async () => {
    const error = await raised(
      provided(Effect.gen(function*() {
        const model = yield* ModelLike
        return yield* Stream.runCollect(model.stream({} as never))
      })) as Effect.Effect<unknown>
    )
    expect(error).toBeInstanceOf(CapabilityContractError)
    expect((error as CapabilityContractError).capability).toBe("model")
  })
})

describe("TestLayers.poisonedClockAndRandom rejects ambient time and randomness", () => {
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(TestLayers.poisonedClockAndRandom))

  it.each([
    ["currentTimeMillis", Clock.currentTimeMillis as Effect.Effect<unknown>],
    ["currentTimeNanos", Clock.currentTimeNanos as Effect.Effect<unknown>],
    ["sleep", Effect.sleep("1 milli") as Effect.Effect<unknown>],
    ["random", Random.next as Effect.Effect<unknown>]
  ])("dies on %s", async (_name, effect) => {
    expect(await raised(provided(effect) as Effect.Effect<unknown>)).toBeInstanceOf(CapabilityContractError)
  })

  it.each(
    [
      ["currentTimeMillisUnsafe", (clock: Clock.Clock) => clock.currentTimeMillisUnsafe()],
      ["currentTimeNanosUnsafe", (clock: Clock.Clock) => clock.currentTimeNanosUnsafe()],
      ["monotonicTimeNanosUnsafe", (clock: Clock.Clock) => clock.monotonicTimeNanosUnsafe()]
    ] as const
  )("throws on %s", async (_name, use) => {
    const error = await raised(
      provided(Effect.gen(function*() {
        return use(yield* Clock.Clock)
      })) as Effect.Effect<unknown>
    )
    expect(error).toBeInstanceOf(CapabilityContractError)
  })

  it("dies on the monotonic clock effect", async () => {
    expect(await raised(provided(Clock.Clock.pipe(Effect.flatMap((clock) => clock.monotonicTimeNanos)))))
      .toBeInstanceOf(CapabilityContractError)
  })

  it.each(
    [
      ["nextIntUnsafe", (random: typeof Random.Random.Service) => random.nextIntUnsafe()],
      ["nextDoubleUnsafe", (random: typeof Random.Random.Service) => random.nextDoubleUnsafe()]
    ] as const
  )("throws on %s", async (_name, use) => {
    const error = await raised(
      provided(Effect.gen(function*() {
        return use(yield* Random.Random)
      })) as Effect.Effect<unknown>
    )
    expect(error).toBeInstanceOf(CapabilityContractError)
  })
})
