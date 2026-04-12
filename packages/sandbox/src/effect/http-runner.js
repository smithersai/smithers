import { HttpRunner } from "@effect/cluster";
import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
import { spawnCaptureEffect } from "@smithers/driver/child-process";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { SandboxEntityExecutor } from "./sandbox-entity.js";
/**
 * @param {SandboxTransportConfig} config
 * @returns {SandboxHandle}
 */
function baseHandle(config) {
    const sandboxRoot = join(config.rootDir, ".smithers", "sandboxes", config.runId, config.sandboxId);
    return {
        runtime: config.runtime,
        runId: config.runId,
        sandboxId: config.sandboxId,
        sandboxRoot,
        requestPath: join(sandboxRoot, "request"),
        resultPath: join(sandboxRoot, "result"),
    };
}
export const DockerSandboxExecutorLive = Layer.succeed(SandboxEntityExecutor, SandboxEntityExecutor.of({
    create: (config) => Effect.gen(function* () {
        const handle = baseHandle(config);
        yield* spawnCaptureEffect("docker", ["info"], {
            cwd: config.rootDir,
            env: process.env,
            timeoutMs: 10_000,
            maxOutputBytes: 200_000,
        }).pipe(Effect.catchAll(() => Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "Docker daemon not reachable.", { runtime: "docker" }))));
        yield* Effect.tryPromise({
            try: async () => {
                await mkdir(handle.requestPath, { recursive: true });
                await mkdir(handle.resultPath, { recursive: true });
            },
            catch: (cause) => toSmithersError(cause, "create docker sandbox workspace"),
        });
        return handle;
    }),
    ship: (bundlePath, handle) => Effect.tryPromise({
        try: async () => {
            await rm(handle.requestPath, { recursive: true, force: true });
            await mkdir(handle.requestPath, { recursive: true });
            await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship docker bundle"),
    }),
    execute: (_command, _handle) => Effect.succeed({ exitCode: 0 }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (_handle) => Effect.void,
}));
export const CodeplaneSandboxExecutorLive = Layer.succeed(SandboxEntityExecutor, SandboxEntityExecutor.of({
    create: (config) => Effect.gen(function* () {
        const apiUrl = process.env.CODEPLANE_API_URL;
        const apiKey = process.env.CODEPLANE_API_KEY;
        if (!apiUrl || !apiKey) {
            yield* Effect.fail(new SmithersError("INVALID_INPUT", "Codeplane runtime requires CODEPLANE_API_URL and CODEPLANE_API_KEY."));
        }
        const handle = baseHandle(config);
        yield* Effect.tryPromise({
            try: async () => {
                await mkdir(handle.requestPath, { recursive: true });
                await mkdir(handle.resultPath, { recursive: true });
            },
            catch: (cause) => toSmithersError(cause, "create codeplane sandbox workspace"),
        });
        return {
            ...handle,
            workspaceId: `${config.runId}:${config.sandboxId}`,
        };
    }),
    ship: (bundlePath, handle) => Effect.tryPromise({
        try: async () => {
            await rm(handle.requestPath, { recursive: true, force: true });
            await mkdir(handle.requestPath, { recursive: true });
            await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship codeplane bundle"),
    }),
    execute: (_command, _handle) => Effect.succeed({ exitCode: 0 }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (_handle) => Effect.void,
}));
export const SandboxHttpRunner = HttpRunner;
