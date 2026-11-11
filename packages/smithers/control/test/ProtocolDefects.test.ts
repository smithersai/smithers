import { Effect, Schema } from "effect"
import { RpcSerialization } from "effect/rpc"
import { expect, it } from "vitest"
import { ControlDefect, defectMessage } from "../src/ControlRpcs.ts"
import { protectProtocolDefects } from "../src/internal/RpcSerialization.ts"

const assertSerialization = (original: RpcSerialization.RpcSerialization["Service"]) => {
  const protectedSerialization = protectProtocolDefects(original)
  expect(protectedSerialization.codecFor).toBe(original.codecFor)
  expect(protectedSerialization.contentType).toBe(original.contentType)
  expect(protectedSerialization.includesFraming).toBe(original.includesFraming)
  const parser = protectedSerialization.makeUnsafe()
  const success = { _tag: "Pong" }
  expect(parser.decode(parser.encode(success)!)).toEqual([success])
  const defect = Schema.encodeSync(original.codecFor(Schema.Defect()))(new Error("private-request-content"))
  const frames = parser.decode(parser.encode({ _tag: "Defect", defect })!)
  expect(frames).toHaveLength(1)
  expect(frames[0]).toMatchObject({ _tag: "Defect" })
  const decoded = Schema.decodeUnknownSync(original.codecFor(ControlDefect))((frames[0] as { defect: unknown }).defect)
  expect(decoded).toMatchObject({ name: "Error", message: defectMessage })
}

it.each([
  { name: "JSON", original: RpcSerialization.json },
  { name: "NDJSON", original: RpcSerialization.ndjson }
])(
  "preserves $name framing and codecs while redacting protocol defects",
  ({ original }) => assertSerialization(original)
)

it("preserves SchemaBinary framing and codecs while redacting protocol defects", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      assertSerialization(yield* RpcSerialization.RpcSerialization)
    }).pipe(Effect.provide(RpcSerialization.layerSchemaBinary()))
  )
})

it("keeps native NDJSON decode failures", () => {
  const parser = protectProtocolDefects(RpcSerialization.ndjson).makeUnsafe()
  expect(() => parser.decode("private-request-content\n")).toThrow()
})
