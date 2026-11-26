import { ShapeSource } from "@smthrs/effect-electric"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, ManagedRuntime } from "effect"
import { expect, test } from "vitest"
import { repoAuthority } from "../../test/repoAuthority"
import { repoId } from "../repo/contract"
import { RepoStore } from "../repo/store.vibe"
import { SECRETS_SHAPE_ROUTE } from "./contract"
import { SecretsStore } from "./store.vibe"

test("a standalone secrets store opens each repository once and handles refusal before a page opens", async () => {
  const origin = "https://unused.test"
  const id = repoId("octo", "project")
  const refusedId = repoId("octo", "refused")
  const runtime = ManagedRuntime.make(SecretsStore.layer({ origin }).pipe(
    Layer.provideMerge(repoAuthority),
    Layer.provideMerge(ShapeSource.layerFaulty((faults) => faults.down())),
    Layer.provide(Persistence.memory),
  ))
  try {
    const store = await runtime.runPromise(Effect.service(SecretsStore))
    expect(store.opened(id)).toBeUndefined()
    const [first, second] = await runtime.runPromise(Effect.all(
      [store.listOf(id), store.listOf(id)],
      { concurrency: "unbounded" },
    ))
    expect(second).toBe(first)
    expect(store.opened(id)).toBe(first)

    const faults = await runtime.runPromise(Effect.service(ShapeSource.Faults))
    await expect.poll(async () => (await runtime.runPromise(faults.sent)).some(
      (url) => url.pathname === SECRETS_SHAPE_ROUTE && url.searchParams.get("repo") === id,
    )).toBe(true)

    expect(store.opened(refusedId)).toBeUndefined()
    const repos = await runtime.runPromise(Effect.service(RepoStore))
    await runtime.runPromise(repos.refuse(refusedId))
    await runtime.runPromise(repos.wiped(refusedId))
    expect(repos.isRefused(refusedId)).toBe(true)
    expect(store.opened(refusedId)).toBeDefined()
  } finally {
    await runtime.dispose()
  }
})
