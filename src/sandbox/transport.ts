import { Context, Effect, Layer } from "effect";
import {
  CodeplaneSandboxExecutorLive,
  DockerSandboxExecutorLive,
} from "../effect/http-runner";
import {
  SandboxEntityExecutor,
  makeSandboxTransportServiceEffect,
} from "../effect/sandbox-entity";
import { BubblewrapSandboxExecutorLive } from "../effect/socket-runner";
import { type SmithersError } from "../utils/errors";

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

export function makeSandboxTransportLayer<R, E>(
  executorLayer: Layer.Layer<SandboxEntityExecutor, E, R>,
): Layer.Layer<SandboxTransport, E, R> {
  return Layer.scoped(
    SandboxTransport,
    makeSandboxTransportServiceEffect(executorLayer).pipe(
      Effect.map((service) => SandboxTransport.of(service)),
    ),
  );
}

export function layerForSandboxRuntime(runtime: SandboxRuntime) {
  switch (runtime) {
    case "docker":
      return makeSandboxTransportLayer(DockerSandboxExecutorLive);
    case "codeplane":
      return makeSandboxTransportLayer(CodeplaneSandboxExecutorLive);
    case "bubblewrap":
    default:
      return makeSandboxTransportLayer(BubblewrapSandboxExecutorLive);
  }
}

export function resolveSandboxRuntime(requested: SandboxRuntime): SandboxRuntime {
  if (requested !== "docker") return requested;
  const hasDocker = typeof Bun !== "undefined" ? Boolean(Bun.which("docker")) : false;
  return hasDocker ? "docker" : "bubblewrap";
}
