import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { requireCodingBinding } from "../coding/host.ts"
import { NativeCoding, NativeCodingError, type ReadResult } from "../coding/native.ts"

const head = {
  kind: "resolved" as const,
  changeId: "z".repeat(32),
  commitId: "b".repeat(40),
  treeId: "c".repeat(40),
  operationId: "a".repeat(128),
  parentCommitIds: []
}

/** A faulty native adapter: admission reads its receipt and must never mutate. */
const faultyBinding = (
  read: Effect.Effect<typeof ReadResult.Type, NativeCodingError>
): NativeCoding["Service"] => ({
  sourcePublication: "cloud",
  read: () => read,
  apply: () => Effect.die("admission must not mutate the workspace"),
  publishOriginalSource: () => Effect.die("admission must not publish source")
})

const receipt = (capabilities?: ReadonlyArray<string>): typeof ReadResult.Type => ({
  status: "read",
  operationId: head.operationId,
  head,
  revisions: [head],
  ...(capabilities === undefined ? {} : { capabilities })
})

for (const sourcePublication of [undefined, "cloud", "local-only"] as const) {
  for (const capabilities of [undefined, [], ["import-source/v1"], ["apply-files/v2"]]) {
    test(`coding host refuses missing apply-files/v1 (${sourcePublication}, ${JSON.stringify(capabilities)})`, async () => {
      let admitted = false
      await assert.rejects(
        Effect.runPromise(
          requireCodingBinding(sourcePublication === undefined ? {} : { sourcePublication }).pipe(
            Effect.andThen(Effect.sync(() => {
              admitted = true
            })),
            Effect.provideService(NativeCoding, faultyBinding(Effect.succeed(receipt(capabilities))))
          )
        ),
        /Update the workspace native adapter before starting the coding host; apply-files\/v1 is required/
      )
      assert.equal(admitted, false)
    })
  }
}

for (const sourcePublication of [undefined, "cloud"] as const) {
  test(`coding host refuses missing import-source/v1 (${sourcePublication})`, async () => {
    let admitted = false
    await assert.rejects(
      Effect.runPromise(
        requireCodingBinding(sourcePublication === undefined ? {} : { sourcePublication }).pipe(
          Effect.andThen(Effect.sync(() => {
            admitted = true
          })),
          Effect.provideService(
            NativeCoding,
            faultyBinding(Effect.succeed(receipt(["apply-files/v1", "import-source/v2"])))
          )
        )
      ),
      /Update the workspace native adapter before starting the coding host; import-source\/v1 is required/
    )
    assert.equal(admitted, false)
  })
}

test("coding host propagates a failed binding read without admitting startup", async () => {
  const failure = new NativeCodingError({ code: "host_unavailable", message: "Native binding unavailable" })
  let admitted = false
  const result = await Effect.runPromise(
    requireCodingBinding({ sourcePublication: "local-only" }).pipe(
      Effect.andThen(Effect.sync(() => {
        admitted = true
      })),
      Effect.flip,
      Effect.provideService(NativeCoding, faultyBinding(Effect.fail(failure)))
    )
  )
  assert.equal(result, failure)
  assert.equal(admitted, false)
})

test("a local-only coding host can admit an adapter missing cloud source import", async () => {
  let admitted = false
  await Effect.runPromise(
    requireCodingBinding({ sourcePublication: "local-only" }).pipe(
      Effect.andThen(Effect.sync(() => {
        admitted = true
      })),
      Effect.provideService(NativeCoding, faultyBinding(Effect.succeed(receipt(["apply-files/v1"]))))
    )
  )
  assert.equal(admitted, true)
})
