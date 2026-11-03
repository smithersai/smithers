import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"

const embeddingService = Effect.service(Embedding.Embedding)

describe("Embedding", () => {
  it("preserves ordered batches and supports single embed", async () => {
    const service = Embedding.make((inputs) => Effect.succeed(inputs.map((_, index) => [index, 1])))
    const result = await Effect.runPromise(service.embedMany(["a", "b"]))
    expect(result.embeddings.map(({ vector }) => vector)).toEqual([[0, 1], [1, 1]])
    await expect(Effect.runPromise(service.embed("a"))).resolves.toEqual({ vector: [0, 1] })
  })

  it("provides deterministic fake vectors and rejects malformed batches", async () => {
    const service = Embedding.make((inputs) => Effect.succeed(inputs.length === 1 ? [] : inputs.map(() => [1])))
    await expect(Effect.runPromise(service.embed("bad"))).rejects.toMatchObject({ code: "embedding_unavailable" })
    const fake = await Effect.runPromise(Embedding.makeNoop().embedMany([]))
    expect(fake.embeddings).toEqual([])
  })

  it("copies every returned vector so a provider cannot mutate a stored embedding", async () => {
    const mutable = [1, 2]
    const provider = Embedding.make(() => Effect.succeed([mutable]))
    const response = await Effect.runPromise(provider.embed("a"))
    mutable[0] = 99
    expect(response.vector).toEqual([1, 2])
  })

  it("provides the injected batch provider through its layer", async () => {
    const embedded = await Effect.runPromise(
      embeddingService.pipe(
        Effect.flatMap((embedding) => embedding.embed("four")),
        Effect.provide(Embedding.layer((inputs) => Effect.succeed(inputs.map((input) => [input.length]))))
      )
    )
    expect(embedded).toEqual({ vector: [4] })
  })

  it("reports the unavailable provider for every non-empty request", async () => {
    const noop = Embedding.makeNoop()
    const single = await Effect.runPromise(Effect.flip(noop.embed("x")))
    const batch = await Effect.runPromise(Effect.flip(noop.embedMany(["x", "y"])))
    const layered = await Effect.runPromise(
      embeddingService.pipe(
        Effect.flatMap((embedding) => Effect.flip(embedding.embed("x"))),
        Effect.provide(Embedding.layerNoop)
      )
    )
    expect([single, batch, layered].map((error) => [error.code, error.message])).toEqual([
      ["embedding_unavailable", "no embedding provider is configured"],
      ["embedding_unavailable", "no embedding provider is configured"],
      ["embedding_unavailable", "no embedding provider is configured"]
    ])
  })

  it("serves fake vectors from a list and from a function, and pads an absent index", async () => {
    const listed = await Effect.runPromise(
      embeddingService.pipe(
        Effect.flatMap((embedding) => embedding.embedMany(["a", "b"])),
        Effect.provide(Embedding.layerFake([[1, 0], [0, 1]]))
      )
    )
    const computed = await Effect.runPromise(
      embeddingService.pipe(
        Effect.flatMap((embedding) => embedding.embed("abc")),
        Effect.provide(Embedding.layerFake((input, index) => [input.length, index]))
      )
    )
    const short = await Effect.runPromise(
      embeddingService.pipe(
        Effect.flatMap((embedding) => Effect.flip(embedding.embedMany(["a", "b"]))),
        Effect.provide(Embedding.layerFake([[1, 0]]))
      )
    )
    expect(listed.embeddings.map(({ vector }) => vector)).toEqual([[1, 0], [0, 1]])
    expect(computed).toEqual({ vector: [3, 0] })
    expect([short.code, short.message]).toEqual([
      "embedding_unavailable",
      "embedding provider returned an invalid batch"
    ])
  })

  it("rejects a zero-dimension batch, a ragged batch, and a non-finite component", async () => {
    const empty = Embedding.make((inputs) => Effect.succeed(inputs.map(() => [])))
    const ragged = Embedding.make(() => Effect.succeed([[1, 2], [3]]))
    const infinite = Embedding.make(() => Effect.succeed([[Number.POSITIVE_INFINITY]]))
    const notANumber = Embedding.make(() => Effect.succeed([[Number.NaN]]))
    const failures = await Effect.runPromise(Effect.all([
      Effect.flip(empty.embed("a")),
      Effect.flip(ragged.embedMany(["a", "b"])),
      Effect.flip(infinite.embed("a")),
      Effect.flip(notANumber.embed("a"))
    ]))
    expect(failures.map((error) => error.message)).toEqual(
      Array.from({ length: 4 }, () => "embedding provider returned an invalid batch")
    )
  })

  it("computes a stable normalized in-process vector and returns zeros for empty text", async () => {
    const inProcess = Embedding.makeInProcess()
    const first = await Effect.runPromise(inProcess.embed("durable checkout recovery"))
    const second = await Effect.runPromise(inProcess.embed("durable checkout recovery"))
    const long = await Effect.runPromise(inProcess.embed("durable checkout recovery ".repeat(2_000)))
    const magnitude = (vector: ReadonlyArray<number>) =>
      Math.sqrt(vector.reduce((total, value) => total + value * value, 0))

    expect(first.vector).toHaveLength(64)
    expect(second.vector).toEqual(first.vector)
    expect(magnitude(first.vector)).toBeCloseTo(1)
    expect(magnitude(long.vector)).toBeCloseTo(1)
    expect(Embedding.inProcessVector("")).toEqual(Array.from({ length: 64 }, () => 0))
    expect(Embedding.inProcessVector("A")).toEqual(Embedding.inProcessVector("a"))
    expect(Embedding.inProcessVector("I")).toEqual(Embedding.inProcessVector("i"))
    expect(Embedding.inProcessModel).toBe("flows-embedding/in-process-v1")
  })

  it("provides the in-process implementation as a layer", async () => {
    const embedded = await Effect.runPromise(
      embeddingService.pipe(
        Effect.flatMap((embedding) => embedding.embedMany(["one", "two"])),
        Effect.provide(Embedding.layerInProcess)
      )
    )
    expect(embedded.embeddings.map(({ vector }) => vector)).toEqual([
      Embedding.inProcessVector("one"),
      Embedding.inProcessVector("two")
    ])
  })
})
