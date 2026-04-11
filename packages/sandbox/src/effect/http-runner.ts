import { HttpRunner } from "@effect/cluster";
import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { SandboxHandle, SandboxTransportConfig } from "../transport";
import { SmithersError } from "@smithers/core/errors";
import { spawnCaptureEffect } from "@smithers/runtime/child-process";
import { fromPromise } from "@smithers/runtime/interop";
import { SandboxEntityExecutor } from "./sandbox-entity";

function baseHandle(config: SandboxTransportConfig): SandboxHandle {
  const sandboxRoot = join(
    config.rootDir,
    ".smithers",
    "sandboxes",
    config.runId,
    config.sandboxId,
  );

  return {
    runtime: config.runtime,
    runId: config.runId,
    sandboxId: config.sandboxId,
    sandboxRoot,
    requestPath: join(sandboxRoot, "request"),
    resultPath: join(sandboxRoot, "result"),
  };
}

export const DockerSandboxExecutorLive = Layer.succeed(
  SandboxEntityExecutor,
  SandboxEntityExecutor.of({
    create: (config) =>
      Effect.gen(function* () {
        const handle = baseHandle(config);

        yield* spawnCaptureEffect("docker", ["info"], {
          cwd: config.rootDir,
          env: process.env,
          timeoutMs: 10_000,
          maxOutputBytes: 200_000,
        }).pipe(
          Effect.catchAll(() =>
            Effect.fail(
              new SmithersError(
                "PROCESS_SPAWN_FAILED",
                "Docker daemon not reachable.",
                { runtime: "docker" },
              ),
            ),
          ),
        );

        yield* fromPromise("create docker sandbox workspace", async () => {
          await mkdir(handle.requestPath, { recursive: true });
          await mkdir(handle.resultPath, { recursive: true });
        });

        return handle;
      }),
    ship: (bundlePath, handle) =>
      fromPromise("ship docker bundle", async () => {
        await rm(handle.requestPath, { recursive: true, force: true });
        await mkdir(handle.requestPath, { recursive: true });
        await cp(bundlePath, handle.requestPath, { recursive: true });
      }),
    execute: (_command, _handle) => Effect.succeed({ exitCode: 0 }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (_handle) => Effect.void,
  }),
);

export const CodeplaneSandboxExecutorLive = Layer.succeed(
  SandboxEntityExecutor,
  SandboxEntityExecutor.of({
    create: (config) =>
      Effect.gen(function* () {
        const apiUrl = process.env.CODEPLANE_API_URL;
        const apiKey = process.env.CODEPLANE_API_KEY;

        if (!apiUrl || !apiKey) {
          yield* Effect.fail(
            new SmithersError(
              "INVALID_INPUT",
              "Codeplane runtime requires CODEPLANE_API_URL and CODEPLANE_API_KEY.",
            ),
          );
        }

        const handle = baseHandle(config);

        yield* fromPromise("create codeplane sandbox workspace", async () => {
          await mkdir(handle.requestPath, { recursive: true });
          await mkdir(handle.resultPath, { recursive: true });
        });

        return {
          ...handle,
          workspaceId: `${config.runId}:${config.sandboxId}`,
        };
      }),
    ship: (bundlePath, handle) =>
      fromPromise("ship codeplane bundle", async () => {
        await rm(handle.requestPath, { recursive: true, force: true });
        await mkdir(handle.requestPath, { recursive: true });
        await cp(bundlePath, handle.requestPath, { recursive: true });
      }),
    execute: (_command, _handle) => Effect.succeed({ exitCode: 0 }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (_handle) => Effect.void,
  }),
);

export const SandboxHttpRunner = HttpRunner;
