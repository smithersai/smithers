import { Entity, ShardingConfig } from "@effect/cluster";
import * as Rpc from "@effect/rpc/Rpc";
import { Context, Effect, Layer, Schema } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
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
export class SandboxEntityExecutor extends Context.Tag("SandboxEntityExecutor")() {
}
/**
 * @param {{ runId: string; sandboxId: string; }} input
 * @returns {string}
 */
export function makeSandboxEntityId(input) {
    return `${input.runId}:${input.sandboxId}`;
}
const SandboxEntityLayer = SandboxEntity.toLayer(Effect.gen(function* () {
    const executor = yield* SandboxEntityExecutor;
    return SandboxEntity.of({
        create: ({ payload }) => executor.create(payload),
        ship: ({ payload }) => executor.ship(payload.bundlePath, payload.handle),
        execute: ({ payload }) => executor.execute(payload.command, payload.handle),
        collect: ({ payload }) => executor.collect(payload.handle),
        cleanup: ({ payload }) => executor.cleanup(payload.handle),
    });
}));
/**
 * @param {unknown} error
 * @param {string} operation
 * @param {Record<string, unknown>} details
 * @returns {SmithersError}
 */
function sandboxEntityError(error, operation, details) {
    return toSmithersError(error, `sandbox entity ${operation} failed`, {
        code: "SANDBOX_EXECUTION_FAILED",
        details,
    });
}
/**
 * @template R, E
 * @param {Layer.Layer<SandboxEntityExecutor, E, R>} executorLayer
 */
export const makeSandboxTransportServiceEffect = (executorLayer) => Effect.gen(function* () {
    const makeClient = yield* Entity.makeTestClient(SandboxEntity, SandboxEntityLayer.pipe(Layer.provide(executorLayer))).pipe(Effect.provide(ShardingConfig.layer()));
    /**
 * @template A
 * @param {{ runId: string; sandboxId: string }} input
 * @param {string} operation
 * @param {Record<string, unknown>} details
 * @param {(client: SandboxEntityClient) => Effect.Effect<A, unknown>} f
 */
    const withClient = (input, operation, details, f) => makeClient(makeSandboxEntityId(input)).pipe(Effect.flatMap((client) => f(client)), Effect.mapError((error) => sandboxEntityError(error, operation, {
        runId: input.runId,
        sandboxId: input.sandboxId,
        ...details,
    })));
    const service = {
        create: (config) => withClient(config, "create", { runtime: config.runtime, rootDir: config.rootDir }, (client) => client.create(config)),
        ship: (bundlePath, handle) => withClient(handle, "ship", { bundlePath }, (client) => client.ship({ bundlePath, handle })),
        execute: (command, handle) => withClient(handle, "execute", { command }, (client) => client.execute({ command, handle })),
        collect: (handle) => withClient(handle, "collect", {}, (client) => client.collect({ handle })),
        cleanup: (handle) => withClient(handle, "cleanup", {}, (client) => client.cleanup({ handle })),
    };
    return service;
});
