import { Entity, ShardingConfig } from "@effect/cluster";
import * as Rpc from "@effect/rpc/Rpc";
import { Context, Effect, Layer, Schema } from "effect";
import type {
  SandboxBundleResult,
  SandboxHandle,
  SandboxTransportConfig,
  SandboxTransportService,
} from "../sandbox/transport";
import { toSmithersError, type SmithersError } from "../utils/errors";

const SandboxRuntimeSchema = Schema.Literal("bubblewrap", "docker", "codeplane");

const SandboxTransportConfigSchema = Schema.Struct({
  runId: Schema.String,
  sandboxId: Schema.String,
  runtime: SandboxRuntimeSchema,
  rootDir: Schema.String,
  image: Schema.optional(Schema.String),
});

const SandboxHandleSchema = Schema.Struct({
  runtime: SandboxRuntimeSchema,
  runId: Schema.String,
  sandboxId: Schema.String,
  sandboxRoot: Schema.String,
  requestPath: Schema.String,
  resultPath: Schema.String,
  containerId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
});

const SandboxBundleResultSchema = Schema.Struct({
  bundlePath: Schema.String,
});

const SandboxExecuteResultSchema = Schema.Struct({
  exitCode: Schema.Number,
});

const SandboxShipPayloadSchema = Schema.Struct({
  bundlePath: Schema.String,
  handle: SandboxHandleSchema,
});

const SandboxExecutePayloadSchema = Schema.Struct({
  command: Schema.String,
  handle: SandboxHandleSchema,
});

const SandboxHandlePayloadSchema = Schema.Struct({
  handle: SandboxHandleSchema,
});

const SandboxCreateRpc = Rpc.make("create", {
  payload: SandboxTransportConfigSchema,
  success: SandboxHandleSchema,
  error: Schema.Unknown,
});

const SandboxShipRpc = Rpc.make("ship", {
  payload: SandboxShipPayloadSchema,
  success: Schema.Void,
  error: Schema.Unknown,
});

const SandboxExecuteRpc = Rpc.make("execute", {
  payload: SandboxExecutePayloadSchema,
  success: SandboxExecuteResultSchema,
  error: Schema.Unknown,
});

const SandboxCollectRpc = Rpc.make("collect", {
  payload: SandboxHandlePayloadSchema,
  success: SandboxBundleResultSchema,
  error: Schema.Unknown,
});

const SandboxCleanupRpc = Rpc.make("cleanup", {
  payload: SandboxHandlePayloadSchema,
  success: Schema.Void,
  error: Schema.Unknown,
});

export const SandboxEntity = Entity.make("Sandbox", [
  SandboxCreateRpc,
  SandboxShipRpc,
  SandboxExecuteRpc,
  SandboxCollectRpc,
  SandboxCleanupRpc,
]);

export class SandboxEntityExecutor extends Context.Tag("SandboxEntityExecutor")<
  SandboxEntityExecutor,
  SandboxTransportService
>() {}

type SandboxEntityClient = {
  readonly create: (
    config: SandboxTransportConfig,
  ) => Effect.Effect<SandboxHandle, unknown>;
  readonly ship: (payload: {
    bundlePath: string;
    handle: SandboxHandle;
  }) => Effect.Effect<void, unknown>;
  readonly execute: (payload: {
    command: string;
    handle: SandboxHandle;
  }) => Effect.Effect<{ exitCode: number }, unknown>;
  readonly collect: (payload: {
    handle: SandboxHandle;
  }) => Effect.Effect<SandboxBundleResult, unknown>;
  readonly cleanup: (payload: {
    handle: SandboxHandle;
  }) => Effect.Effect<void, unknown>;
};

export function makeSandboxEntityId(input: {
  runId: string;
  sandboxId: string;
}): string {
  return `${input.runId}:${input.sandboxId}`;
}

const SandboxEntityLayer = SandboxEntity.toLayer(
  Effect.gen(function* () {
    const executor = yield* SandboxEntityExecutor;

    return SandboxEntity.of({
      create: ({ payload }) => executor.create(payload),
      ship: ({ payload }) => executor.ship(payload.bundlePath, payload.handle),
      execute: ({ payload }) => executor.execute(payload.command, payload.handle),
      collect: ({ payload }) => executor.collect(payload.handle),
      cleanup: ({ payload }) => executor.cleanup(payload.handle),
    });
  }),
);

function sandboxEntityError(
  error: unknown,
  operation: string,
  details: Record<string, unknown>,
): SmithersError {
  return toSmithersError(error, `sandbox entity ${operation} failed`, {
    code: "SANDBOX_EXECUTION_FAILED",
    details,
  });
}

export const makeSandboxTransportServiceEffect = <R, E>(
  executorLayer: Layer.Layer<SandboxEntityExecutor, E, R>,
) =>
  Effect.gen(function* () {
    const makeClient = yield* Entity.makeTestClient(
      SandboxEntity,
      SandboxEntityLayer.pipe(Layer.provide(executorLayer)),
    ).pipe(Effect.provide(ShardingConfig.layer()));

    const withClient = <A>(
      input: { runId: string; sandboxId: string },
      operation: string,
      details: Record<string, unknown>,
      f: (client: SandboxEntityClient) => Effect.Effect<A, unknown>,
    ) =>
      makeClient(makeSandboxEntityId(input)).pipe(
        Effect.flatMap((client) => f(client as SandboxEntityClient)),
        Effect.mapError((error) =>
          sandboxEntityError(error, operation, {
            runId: input.runId,
            sandboxId: input.sandboxId,
            ...details,
          }),
        ),
      );

    const service: SandboxTransportService = {
      create: (config) =>
        withClient(
          config,
          "create",
          { runtime: config.runtime, rootDir: config.rootDir },
          (client) => client.create(config),
        ) as Effect.Effect<SandboxHandle, SmithersError>,
      ship: (bundlePath, handle) =>
        withClient(
          handle,
          "ship",
          { bundlePath },
          (client) => client.ship({ bundlePath, handle }),
        ) as Effect.Effect<void, SmithersError>,
      execute: (command, handle) =>
        withClient(
          handle,
          "execute",
          { command },
          (client) => client.execute({ command, handle }),
        ) as Effect.Effect<{ exitCode: number }, SmithersError>,
      collect: (handle) =>
        withClient(
          handle,
          "collect",
          {},
          (client) => client.collect({ handle }),
        ) as Effect.Effect<SandboxBundleResult, SmithersError>,
      cleanup: (handle) =>
        withClient(
          handle,
          "cleanup",
          {},
          (client) => client.cleanup({ handle }),
        ) as Effect.Effect<void, SmithersError>,
    };

    return service;
  });
