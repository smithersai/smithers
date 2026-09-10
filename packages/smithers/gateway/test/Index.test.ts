import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Gateway from "../src/index.ts"

describe("/gateway", () => {
  it("exports its canonical schemas, supervision port, and sync package", () => {
    expect(Gateway.GatewaySchema.ProjectionSnapshot).toBeDefined()
    expect(Gateway.SuperviseRuntime.SuperviseRuntime).toBeDefined()
    expect(Gateway.Sync.SyncClient.Sync).toBeDefined()
  })

  it("provides overridable no-op supervision services and layers", async () => {
    const noop = Gateway.SuperviseRuntime.makeNoop()
    expect(await Effect.runPromise(noop.scan(0))).toEqual([])
    await Effect.runPromise(noop.resume({} as Gateway.SuperviseRuntime.ResumeLease))

    const candidate = { _tag: "quota-due" } as Gateway.SuperviseRuntime.Candidate
    const overridden = Gateway.SuperviseRuntime.makeNoop({
      scan: () => Effect.succeed([candidate])
    })
    expect(await Effect.runPromise(overridden.scan(0))).toEqual([candidate])

    const layered = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* Gateway.SuperviseRuntime.SuperviseRuntime
        return yield* runtime.scan(0)
      }).pipe(
        Effect.provide(
          Gateway.SuperviseRuntime.layerNoop({
            scan: () => Effect.succeed([candidate])
          })
        )
      )
    )
    expect(layered).toEqual([candidate])
  })
})
