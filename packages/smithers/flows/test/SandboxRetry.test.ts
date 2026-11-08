/**
 * A retry policy landing on a fresh sandbox session.
 *
 * `SandboxSupervision` exists to turn a dead remote session into a failure the
 * retry policy can act on, and then to give the retry somewhere to land. The
 * sandbox package proves the supervision half against `Effect.retry`, which is
 * a different mechanism from the one the claim is about: a flows `RetryPolicy`
 * is the engine's retry, with its own attempt accounting, and an action that
 * fails inside a retired session has to come back on a session the provider
 * opened after the retirement.
 *
 * This is the only package that can state it, because it is the only one that
 * has both the engine and the sandbox.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as RemoteChildProcessSpawner from "@smthrs/sandbox/RemoteChildProcessSpawner"
import * as SandboxSupervision from "@smthrs/sandbox/SandboxSupervision"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { Action, Engine, Flow, Interpreter, RetryPolicy } from "../src/index.ts"

const { ProviderError, TestRemote } = RemoteChildProcessSpawner

describe("an action retried inside a supervised sandbox", () => {
  it.live("lands its second attempt on the session opened after the retirement", () =>
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      // The first probe is the one that condemns the session. Everything after
      // it answers, so the retry has a healthy session to land on.
      const probes = yield* Ref.make(0)
      const provider = TestRemote.make({
        ping: Effect.flatMap(
          Ref.getAndUpdate(probes, (n) => n + 1),
          (seen) => seen === 0 ? Effect.fail(new ProviderError({ code: "unavailable", message: "gone" })) : Effect.void
        ),
        scripts: { serve: { pending: true }, work: { stdout: "done" } }
      })

      /**
       * Attempt 1 runs a command and then waits for the session to be pulled
       * out from under it, which is how a remote session dies in practice: the
       * command does not fail, the sandbox does.
       */
      const Work = Action.make({
        name: "flows/sandbox/work",
        success: Schema.String,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 }),
        execute: Effect.gen(function*() {
          const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
          const spawner = yield* ChildProcessSpawner
          // Attempt 1 is RUNNING a command when the probe condemns the
          // session, which is how a remote sandbox dies in practice: the
          // command does not fail, the thing it is running inside does.
          const command = attempt === 1 ? "serve" : "work"
          return yield* Effect.mapError(spawner.string(ChildProcess.make(command)), (error) => String(error))
        })
      })

      const Call = Action.make("flows/sandbox/call", {
        payload: { what: Schema.String },
        success: Schema.String,
        error: Schema.String
      })

      const Sandboxed = Flow.make("flows/sandbox/flow", {
        payload: { what: Schema.String },
        success: Schema.String,
        error: Schema.String,
        body: (payload) => Call.call(payload)
      })

      const value = yield* Sandboxed.execute({ what: "go" }, { executionId: "sandbox-retry" }).pipe(
        Effect.provide(
          Layer.mergeAll(Call.toLayer(() => Work), Interpreter.layer(Sandboxed)).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Engine.FlowEngine.layerMemory),
            Layer.provideMerge(SandboxSupervision.layer(provider, { interval: "50 millis" })),
            Layer.provideMerge(NodeCrypto.layer)
          )
        )
      )

      expect(value).toBe("done")
      // Two attempts, and the second ran in a session the provider opened only
      // after the first one was retired.
      expect(yield* Ref.get(attempts)).toBe(2)
      expect(provider.state.openedSessions).toEqual(["test-session", "test-session"])
      expect(provider.state.cancellations).toBeGreaterThanOrEqual(1)
    }), 60_000)
})
