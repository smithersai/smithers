import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SandboxEntityExecutor } from "../src/effect/sandbox-entity";
import {
  SandboxTransport,
  makeSandboxTransportLayer,
  type SandboxHandle,
  type SandboxTransportConfig,
} from "../src/transport";

const config: SandboxTransportConfig = {
  runId: "run-entity-contract",
  sandboxId: "sb-1",
  runtime: "bubblewrap",
  rootDir: "/tmp/smithers",
};

const handle: SandboxHandle = {
  runtime: "bubblewrap",
  runId: config.runId,
  sandboxId: config.sandboxId,
  sandboxRoot: "/tmp/smithers/.smithers/sandboxes/run-entity-contract/sb-1",
  requestPath: "/tmp/smithers/.smithers/sandboxes/run-entity-contract/sb-1/request",
  resultPath: "/tmp/smithers/.smithers/sandboxes/run-entity-contract/sb-1/result",
};

describe("sandbox entity contract", () => {
  test("preserves the sandbox transport contract through entity dispatch", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const executorLayer = Layer.succeed(
      SandboxEntityExecutor,
      SandboxEntityExecutor.of({
        create: (input) =>
          Effect.sync(() => {
            calls.push({ op: "create", runtime: input.runtime, sandboxId: input.sandboxId });
            return handle;
          }),
        ship: (bundlePath, currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "ship",
              bundlePath,
              sandboxId: currentHandle.sandboxId,
            });
          }),
        execute: (command, currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "execute",
              command,
              sandboxId: currentHandle.sandboxId,
            });
            return { exitCode: 0 };
          }),
        collect: (currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "collect",
              sandboxId: currentHandle.sandboxId,
            });
            return { bundlePath: currentHandle.resultPath };
          }),
        cleanup: (currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "cleanup",
              sandboxId: currentHandle.sandboxId,
            });
          }),
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* SandboxTransport;
        const created = yield* transport.create(config);
        yield* transport.ship("/tmp/request-bundle", created);
        const executed = yield* transport.execute("smithers up bundle.tsx", created);
        const collected = yield* transport.collect(created);
        yield* transport.cleanup(created);
        return { created, executed, collected };
      }).pipe(Effect.provide(makeSandboxTransportLayer(executorLayer))),
    );

    expect(result.created).toEqual(handle);
    expect(result.executed).toEqual({ exitCode: 0 });
    expect(result.collected).toEqual({ bundlePath: handle.resultPath });
    expect(calls).toEqual([
      {
        op: "create",
        runtime: "bubblewrap",
        sandboxId: "sb-1",
      },
      {
        op: "ship",
        bundlePath: "/tmp/request-bundle",
        sandboxId: "sb-1",
      },
      {
        op: "execute",
        command: "smithers up bundle.tsx",
        sandboxId: "sb-1",
      },
      {
        op: "collect",
        sandboxId: "sb-1",
      },
      {
        op: "cleanup",
        sandboxId: "sb-1",
      },
    ]);
  });
});
