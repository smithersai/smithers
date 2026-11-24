/**
 * The sealed key of a prepared model request: one canonicalization and one
 * digest per key, with the bytes the retired marker search produced.
 */
import { Digest, type KeyMaterial } from "@smthrs/core"
import { ModelRequest, type Route } from "@smthrs/model"
import * as StepKey from "@smthrs/plan/StepKey"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it, vi } from "vitest"
import * as InternalModelStep from "../src/internal/ModelStep.ts"

const prepared = (body: Uint8Array): Route.PreparedRequest => ({
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body,
  bodyText: "not the wire bytes"
})

/** The key as it was first derived: the body as a numeric array, canonicalized like everything else. */
const historical = (material: KeyMaterial.KeyMaterial, declaration: unknown, request: Route.PreparedRequest) =>
  Digest.provideSync(StepKey.fromKeyMaterial({
    ...material,
    body: {
      _tag: "PreparedModelCall",
      declaration,
      request: {
        routeId: request.routeId,
        protocolId: request.protocolId,
        method: request.method,
        url: request.url,
        publicHeaders: request.publicHeaders,
        body: Array.from(request.body)
      }
    }
  }, {}))

/** Every marker string the retired search could choose, in a row. */
const markers = Array.from({ length: 8 }, (_, ordinal) => `flows/agent/wire-body/${ordinal}`)

/** Caller material that spells the body's own members, keys and placeholder at several depths. */
const hostile = {
  markers,
  body: "",
  request: { body: "", method: "POST" },
  declaration: { request: { body: "" }, _tag: "PreparedModelCall" },
  quoted: "\"request\":{\"body\":\"\"},\\",
  "\"body\":\"\",}]": [{ "a,b": "}]{[" }, [1, "x,y", [[]]], null, true, 1.5]
}

const bodies = [
  new Uint8Array(),
  Uint8Array.from({ length: 256 }, (_, index) => index),
  new Uint8Array([99, 0, 127, 255, 88]).subarray(1, 4)
]

describe("ModelStep key sealing", () => {
  it.each(bodies)(
    "keeps the historical key of a declaration full of marker strings, for wire body %j",
    async (body) => {
      const material: KeyMaterial.KeyMaterial = {
        ...InternalModelStep.material(ModelRequest.ModelRequest.make({
          modelId: "test-model",
          system: [],
          messages: [],
          tools: [],
          params: ModelRequest.GenerationParams.make()
        })),
        body: hostile,
        inputs: [{ _tag: "Literal", value: hostile }],
        layers: markers
      }
      const request = prepared(body)
      const expected = await Effect.runPromise(historical(material, hostile, request))
      expect(await Effect.runPromise(InternalModelStep.key(material, request))).toBe(expected)
    }
  )

  it("keeps the historical key of a model call whose messages are marker strings", async () => {
    const call = ModelRequest.ModelRequest.make({
      modelId: "test-model",
      system: [ModelRequest.SystemPart.make({ text: "\"body\":\"\"" })],
      messages: markers.map((marker) => ModelRequest.Message.user(marker)),
      tools: [],
      params: ModelRequest.GenerationParams.make()
    })
    const material = InternalModelStep.material(call)
    const request = prepared(bodies[1]!)
    const declaration = {
      _tag: "ModelCall",
      request: JSON.parse(JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(call)))
    }
    const expected = await Effect.runPromise(historical(material, declaration, request))
    expect(await Effect.runPromise(InternalModelStep.key(material, request))).toBe(expected)
  })

  it("canonicalizes and digests once per key, however many marker strings the caller holds", async () => {
    const material: KeyMaterial.KeyMaterial = {
      ...InternalModelStep.material(ModelRequest.ModelRequest.make({
        modelId: "test-model",
        system: [],
        messages: [],
        tools: [],
        params: ModelRequest.GenerationParams.make()
      })),
      body: hostile,
      layers: markers
    }
    // The service every key hashes with, observed and otherwise untouched.
    const digests = vi.spyOn(await Effect.runPromise(Digest.provideSync(EffectDigest.Digest)), "digest")
    const derive = vi.spyOn(StepKey, "fromKeyMaterial")
    try {
      await Effect.runPromise(InternalModelStep.key(material, prepared(bodies[1]!)))
      expect(derive).toHaveBeenCalledTimes(1)
      expect(digests).toHaveBeenCalledTimes(1)
    } finally {
      derive.mockRestore()
      digests.mockRestore()
    }
  })
})
