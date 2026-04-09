import { SocketRunner } from "@effect/cluster";
import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { SandboxHandle, SandboxTransportConfig } from "../sandbox/transport";
import { SmithersError } from "../utils/errors";
import { fromPromise } from "./interop";
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

export const BubblewrapSandboxExecutorLive = Layer.succeed(
  SandboxEntityExecutor,
  SandboxEntityExecutor.of({
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
              ),
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
              ),
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

export const SandboxSocketRunner = SocketRunner;
