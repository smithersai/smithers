import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { spawnCaptureEffect } from "../effect/child-process";
import { fromPromise } from "../effect/interop";
import { SmithersError } from "../utils/errors";

export type SandboxRuntime = "bubblewrap" | "docker" | "codeplane";

export type SandboxTransportConfig = {
  runId: string;
  sandboxId: string;
  runtime: SandboxRuntime;
  rootDir: string;
  image?: string;
};

export type SandboxHandle = {
  runtime: SandboxRuntime;
  runId: string;
  sandboxId: string;
  sandboxRoot: string;
  requestPath: string;
  resultPath: string;
  containerId?: string;
  workspaceId?: string;
};

export type SandboxBundleResult = {
  bundlePath: string;
};

export type SandboxTransportService = {
  readonly create: (
    config: SandboxTransportConfig,
  ) => Effect.Effect<SandboxHandle, SmithersError>;
  readonly ship: (
    bundlePath: string,
    handle: SandboxHandle,
  ) => Effect.Effect<void, SmithersError>;
  readonly execute: (
    command: string,
    handle: SandboxHandle,
  ) => Effect.Effect<{ exitCode: number }, SmithersError>;
  readonly collect: (
    handle: SandboxHandle,
  ) => Effect.Effect<SandboxBundleResult, SmithersError>;
  readonly cleanup: (
    handle: SandboxHandle,
  ) => Effect.Effect<void, SmithersError>;
};

export class SandboxTransport extends Context.Tag("SandboxTransport")<
  SandboxTransport,
  SandboxTransportService
>() {}

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

const BubblewrapTransportLive = Layer.succeed(
  SandboxTransport,
  SandboxTransport.of({
    create: (config) =>
      Effect.gen(function* () {
        if (process.platform === "linux") {
          const bwrap = typeof Bun !== "undefined" ? Bun.which("bwrap") : null;
          if (!bwrap) {
            yield* Effect.fail(
              new SmithersError(
                "PROCESS_SPAWN_FAILED",
                "Bubblewrap runtime requested but `bwrap` is not installed. Install bubblewrap (package: bubblewrap) or use runtime=\"docker\".",
                { runtime: "bubblewrap" },
              )
            );
          }
        }
        if (process.platform === "darwin") {
          const sandboxExec =
            typeof Bun !== "undefined" ? Bun.which("sandbox-exec") : null;
          if (!sandboxExec) {
            yield* Effect.fail(
              new SmithersError(
                "PROCESS_SPAWN_FAILED",
                "bubblewrap runtime on macOS requires `sandbox-exec` for fallback isolation.",
                { runtime: "bubblewrap" },
              )
            );
          }
        }

        const handle = baseHandle(config);
        yield* fromPromise("create sandbox workspace", async () => {
          await mkdir(handle.requestPath, { recursive: true });
          await mkdir(handle.resultPath, { recursive: true });
        });
        return handle;
      }),
    ship: (bundlePath, handle) =>
      fromPromise("ship sandbox bundle", async () => {
        await rm(handle.requestPath, { recursive: true, force: true });
        await mkdir(handle.requestPath, { recursive: true });
        await cp(bundlePath, handle.requestPath, { recursive: true });
      }),
    execute: (_command, _handle) => Effect.succeed({ exitCode: 0 }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (_handle) => Effect.void,
  }),
);

const DockerTransportLive = Layer.succeed(
  SandboxTransport,
  SandboxTransport.of({
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

const CodeplaneTransportLive = Layer.succeed(
  SandboxTransport,
  SandboxTransport.of({
    create: (config) =>
      Effect.gen(function* () {
        const apiUrl = process.env.CODEPLANE_API_URL;
        const apiKey = process.env.CODEPLANE_API_KEY;
        if (!apiUrl || !apiKey) {
          yield* Effect.fail(
            new SmithersError(
              "INVALID_INPUT",
              "Codeplane runtime requires CODEPLANE_API_URL and CODEPLANE_API_KEY.",
            )
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

export function layerForSandboxRuntime(runtime: SandboxRuntime) {
  switch (runtime) {
    case "docker":
      return DockerTransportLive;
    case "codeplane":
      return CodeplaneTransportLive;
    case "bubblewrap":
    default:
      return BubblewrapTransportLive;
  }
}

export function resolveSandboxRuntime(requested: SandboxRuntime): SandboxRuntime {
  if (requested !== "docker") return requested;
  const hasDocker = typeof Bun !== "undefined" ? Boolean(Bun.which("docker")) : false;
  return hasDocker ? "docker" : "bubblewrap";
}
