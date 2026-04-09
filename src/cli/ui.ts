import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { Effect, Schedule } from "effect";
import { toError } from "../effect/interop";
import { SmithersError } from "../utils/errors";

export type UiTarget =
  | { kind: "dashboard" }
  | { kind: "run"; runId: string }
  | { kind: "node"; runId: string; nodeId: string }
  | { kind: "approvals" };

export type EnsureServerRunningResult = {
  serverAutoStarted: boolean;
};

type ProbeServerHealthOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type EnsureServerRunningOptions = {
  env?: NodeJS.ProcessEnv;
  host?: string;
  healthTimeoutMs?: number;
  startupTimeoutMs?: number;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  entrypointPath?: string;
  execPath?: string;
};

type OpenInBrowserOptions = {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
};

const DEFAULT_UI_HOST = "127.0.0.1";
const DEFAULT_UI_PORT = 4173;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_200;
const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const HEALTH_POLL_INTERVAL_MS = 250;

function parsePort(rawValue: string | undefined) {
  if (!rawValue) {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return null;
  }

  return parsed;
}

function resolveUiHostEntrypoint() {
  // Smithers still serves the browser UI through the standalone packaged web host.
  return resolve(import.meta.dir, "../../apps/cli/src/bin.ts");
}

function waitForChildSpawn(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      child.off("error", onError);
      callback();
    };

    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    child.once("error", onError);
    queueMicrotask(() => {
      finish(() => resolvePromise());
    });
  });
}

function isPortInUse(port: number) {
  return Effect.tryPromise(() =>
    new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port,
      });

      let settled = false;

      const finish = (value: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        resolvePromise(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
      socket.setTimeout(400);
    }),
  ).pipe(Effect.orElseSucceed(() => false));
}

export function resolveUiHost(env: NodeJS.ProcessEnv = process.env) {
  const configuredHost =
    env.SMITHERS_UI_HOST?.trim() || env.BURNS_WEB_HOST?.trim();

  return configuredHost || DEFAULT_UI_HOST;
}

export function resolveUiPort(env: NodeJS.ProcessEnv = process.env) {
  return (
    parsePort(env.SMITHERS_UI_PORT) ??
    parsePort(env.BURNS_WEB_PORT) ??
    DEFAULT_UI_PORT
  );
}

export function probeServerHealth(
  port: number,
  options: ProbeServerHealthOptions = {},
) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthUrl = new URL("/health", `http://localhost:${port}`);

  return Effect.tryPromise(() =>
    fetchImpl(healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    }),
  ).pipe(
    Effect.map((response) => response.ok),
    Effect.orElseSucceed(() => false),
  );
}

function waitForServerHealthy(
  port: number,
  options: ProbeServerHealthOptions & { startupTimeoutMs?: number } = {},
) {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const attempts = Math.max(
    1,
    Math.ceil(startupTimeoutMs / HEALTH_POLL_INTERVAL_MS),
  );

  return probeServerHealth(port, options).pipe(
    Effect.filterOrFail(
      (healthy) => healthy,
      () => new Error("UI host not ready"),
    ),
    Effect.retry(
      Schedule.spaced(`${HEALTH_POLL_INTERVAL_MS} millis`).pipe(
        Schedule.compose(Schedule.recurs(attempts)),
      ),
    ),
    Effect.asVoid,
    Effect.mapError(
      () =>
        new SmithersError(
          "UI_COMMAND_FAILED",
          "Timed out waiting for UI host to start",
          { port },
        ),
    ),
  );
}

function spawnDetachedUiHost(
  port: number,
  options: EnsureServerRunningOptions = {},
) {
  const spawnImpl = options.spawn ?? spawn;
  const host = options.host ?? resolveUiHost(options.env);
  const entrypointPath = options.entrypointPath ?? resolveUiHostEntrypoint();
  const execPath = options.execPath ?? process.execPath;

  return Effect.tryPromise({
    try: async () => {
      const child = spawnImpl(
        execPath,
        [entrypointPath, "web", "--host", host, "--port", String(port)],
        {
          detached: true,
          env: options.env ?? process.env,
          stdio: "ignore",
        },
      );
      child.unref();
      await waitForChildSpawn(child);
      return child.pid;
    },
    catch: (cause) =>
      toError(cause, "start smithers ui host", {
        code: "UI_COMMAND_FAILED",
        details: { host, port, entrypointPath },
      }),
  });
}

export function ensureServerRunning(
  port: number,
  options: EnsureServerRunningOptions = {},
) {
  return Effect.gen(function* () {
    const healthy = yield* probeServerHealth(port, {
      fetch: options.fetch,
      timeoutMs: options.healthTimeoutMs,
    });
    if (healthy) {
      return { serverAutoStarted: false } satisfies EnsureServerRunningResult;
    }

    const portOccupied = yield* isPortInUse(port);
    if (portOccupied) {
      return yield* Effect.fail(
        new SmithersError("UI_COMMAND_FAILED", `Port ${port} is in use`, {
          port,
        }),
      );
    }

    yield* Effect.scoped(
      Effect.acquireRelease(
        spawnDetachedUiHost(port, options),
        () => Effect.void,
      ),
    );

    yield* waitForServerHealthy(port, {
      fetch: options.fetch,
      timeoutMs: options.healthTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });

    return { serverAutoStarted: true } satisfies EnsureServerRunningResult;
  }).pipe(
    Effect.annotateLogs({ port }),
    Effect.withLogSpan("cli:ui:ensure-server"),
  );
}

export function buildUrl(port: number, target: UiTarget) {
  const url = new URL("/", `http://localhost:${port}`);

  switch (target.kind) {
    case "dashboard":
      url.searchParams.set("tab", "runs");
      break;
    case "run":
      url.searchParams.set("tab", "runs");
      url.searchParams.set("runId", target.runId);
      break;
    case "node":
      url.searchParams.set("tab", "runs");
      url.searchParams.set("runId", target.runId);
      url.searchParams.set("nodeId", target.nodeId);
      break;
    case "approvals":
      url.searchParams.set("tab", "approvals");
      break;
  }

  return url.toString();
}

export function shouldSuppressAutoOpen(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (env.SMITHERS_UI_NO_OPEN === "1" || env.BURNS_UI_NO_OPEN === "1") {
    return true;
  }

  if (env.CI) {
    return true;
  }

  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  const isSshSession = Boolean(
    env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT,
  );

  if (platform === "linux" && !hasDisplay) {
    return true;
  }

  if (isSshSession && !hasDisplay) {
    return true;
  }

  return false;
}

export function openInBrowser(
  url: string,
  options: OpenInBrowserOptions = {},
) {
  const spawnImpl = options.spawn ?? spawn;
  const platform = options.platform ?? process.platform;
  const opener = platform === "darwin" ? "open" : "xdg-open";

  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolvePromise, reject) => {
        const child = spawnImpl(opener, [url], {
          stdio: "ignore",
        });

        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0 || code === null) {
            resolvePromise();
            return;
          }

          reject(new Error(`${opener} exited with code ${code}`));
        });
      }),
    catch: (cause) =>
      toError(cause, "open smithers ui browser url", {
        code: "UI_COMMAND_FAILED",
        details: { opener, url },
      }),
  });
}
