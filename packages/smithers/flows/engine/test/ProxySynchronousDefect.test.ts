import { describe, expect } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"
import { HttpApi, HttpApiTest } from "effect/unstable/httpapi"
import { RpcTest } from "effect/unstable/rpc"
import { FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"
import { effect } from "./Harness.ts"

const flow = Flow.make("ProxySynchronousDefect", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})
const secret = "scope-secret-ABC123"
const scope: FlowProxyServer.ExecutionIdScope = () => {
  throw { message: `Bearer ${secret}`, token: secret }
}
const assertRedacted = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  expect(defect).toBeInstanceOf(FlowProxyServer.FlowHandlerDefect)
  const encoded = JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Schema.Defect()))(defect))
  expect(encoded).not.toContain(secret)
}
class Api extends HttpApi.make("proxy-synchronous-defect").add(FlowProxy.toHttpApiGroup("flows", [flow])) {}
const httpServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer)
  .pipe(Layer.provideMerge(FileSystem.layerNoop({})))

describe("synchronous proxy callback defects", () => {
  for (const operation of ["execute", "discard", "resume"] as const) {
    effect(
      `redacts a synchronous identity callback throw during ${operation}`,
      () =>
        Effect.scoped(Effect.gen(function*() {
          const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup([flow]))
          const request = { payload: {}, executionId: "caller-id" }
          const call = operation === "execute"
            ? client.ProxySynchronousDefect(request)
            : operation === "discard"
            ? client.ProxySynchronousDefectDiscard(request)
            : client.ProxySynchronousDefectResume(request)
          assertRedacted(yield* Effect.exit(call))
        })).pipe(Effect.provide(
          FlowProxyServer.layerRpcHandlers([flow], { executionId: scope })
            .pipe(Layer.provide(FlowEngine.layerMemory))
        ))
    )

    effect(`redacts the same callback throw over HTTP during ${operation}`, () =>
      Effect.scoped(Effect.gen(function*() {
        const api = yield* HttpApiTest.groups(Api, ["flows"])
        const request = { payload: { payload: {}, executionId: "caller-id" } }
        const call = operation === "execute"
          ? api.flows.ProxySynchronousDefect(request)
          : operation === "discard"
          ? api.flows.ProxySynchronousDefectDiscard(request)
          : api.flows.ProxySynchronousDefectResume({ payload: { executionId: "caller-id" } })
        assertRedacted(yield* Effect.exit(call))
      })).pipe(
        Effect.provide(
          FlowProxyServer.layerHttpApi(Api, "flows", [flow], { executionId: scope })
            .pipe(Layer.provide(FlowEngine.layerMemory))
        ),
        Effect.provide(httpServices)
      ))
  }
})
