import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { spawnCaptureEffect } from "@smithers/runtime/child-process";
import { SmithersError } from "@smithers/errors/SmithersError";

const DEFAULT_COMMAND = "smithers-ctl";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

export type SmithersIdeOverlayType = "chat" | "progress" | "panel";

export type SmithersIdeOverlayOptions = {
  readonly message: string;
  readonly title?: string;
  readonly position?: "top" | "center" | "bottom";
  readonly duration?: number;
  readonly percent?: number;
};

export type SmithersIdeCommandBaseResult = {
  readonly args: readonly string[];
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

export type SmithersIdeOpenFileResult = SmithersIdeCommandBaseResult & {
  readonly column: number | null;
  readonly line: number | null;
  readonly opened: boolean;
  readonly path: string;
};

export type SmithersIdeOpenDiffResult = SmithersIdeCommandBaseResult & {
  readonly opened: boolean;
};

export type SmithersIdeOverlayResult = SmithersIdeCommandBaseResult & {
  readonly overlayId: string | null;
  readonly shown: boolean;
  readonly type: SmithersIdeOverlayType;
};

export type SmithersIdeRunTerminalResult = SmithersIdeCommandBaseResult & {
  readonly cwd: string | null;
  readonly launched: boolean;
  readonly status: string;
  readonly terminalCommand: string;
};

export type SmithersIdeAskUserResult = SmithersIdeCommandBaseResult & {
  readonly overlayId: string | null;
  readonly prompt: string;
  readonly status: "prompted";
};

export type SmithersIdeOpenWebviewResult = SmithersIdeCommandBaseResult & {
  readonly opened: boolean;
  readonly tabId: string | null;
  readonly url: string;
};

export type SmithersIdeAvailability =
  | {
      readonly available: true;
      readonly binaryAvailable: true;
      readonly binaryPath: string;
      readonly environmentActive: true;
      readonly reason: "available";
      readonly signals: readonly string[];
    }
  | {
      readonly available: false;
      readonly binaryAvailable: boolean;
      readonly binaryPath: string | null;
      readonly environmentActive: boolean;
      readonly reason: "binary-missing" | "environment-inactive";
      readonly signals: readonly string[];
    };

export type SmithersIdeServiceConfig = {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly idleTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
};

export type SmithersIdeResolvedConfig = {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly idleTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
};

export type SmithersIdeServiceApi = {
  readonly config: SmithersIdeResolvedConfig;
  readonly askUser: (
    prompt: string,
  ) => Effect.Effect<SmithersIdeAskUserResult, SmithersError>;
  readonly detectAvailability: () => Effect.Effect<SmithersIdeAvailability>;
  readonly openDiff: (
    content: string,
  ) => Effect.Effect<SmithersIdeOpenDiffResult, SmithersError>;
  readonly openFile: (
    path: string,
    line?: number,
    column?: number,
  ) => Effect.Effect<SmithersIdeOpenFileResult, SmithersError>;
  readonly openWebview: (
    url: string,
  ) => Effect.Effect<SmithersIdeOpenWebviewResult, SmithersError>;
  readonly runTerminal: (
    command: string,
    cwd?: string,
  ) => Effect.Effect<SmithersIdeRunTerminalResult, SmithersError>;
  readonly showOverlay: (
    type: SmithersIdeOverlayType,
    options: SmithersIdeOverlayOptions,
  ) => Effect.Effect<SmithersIdeOverlayResult, SmithersError>;
};

export class SmithersIdeService extends Context.Tag("SmithersIdeService")<
  SmithersIdeService,
  SmithersIdeServiceApi
>() {}

function resolveConfig(
  config: SmithersIdeServiceConfig = {},
): SmithersIdeResolvedConfig {
  return {
    command: config.command ?? DEFAULT_COMMAND,
    cwd: config.cwd ?? process.cwd(),
    env: config.env ?? process.env,
    idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function isTruthyEnv(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function detectSmithersIdeEnvironment(env: Record<string, string | undefined>) {
  const signals: string[] = [];

  if (isTruthyEnv(env.SMITHERS_IDE)) {
    signals.push("SMITHERS_IDE");
  }
  if (isTruthyEnv(env.SMITHERS_CTL_ACTIVE)) {
    signals.push("SMITHERS_CTL_ACTIVE");
  }
  if ((env.SMITHERS_SESSION_KIND ?? "").trim().toLowerCase() === "ide") {
    signals.push("SMITHERS_SESSION_KIND");
  }
  if ((env.TERM_PROGRAM ?? "").trim().toLowerCase() === "smithers") {
    signals.push("TERM_PROGRAM");
  }
  if ((env.__CFBundleIdentifier ?? "").trim().toLowerCase().includes("smithers")) {
    signals.push("__CFBundleIdentifier");
  }

  return {
    active: signals.length > 0,
    signals: signals as readonly string[],
  };
}

function resolveBinaryOnPath(
  command: string,
  env: Record<string, string | undefined>,
) {
  if (!command.trim()) return null;

  const checkCandidate = (candidate: string) => {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  };

  if (command.includes("/") || isAbsolute(command)) {
    return checkCandidate(command);
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const resolved = checkCandidate(join(entry, command));
    if (resolved) return resolved;
  }

  return null;
}

function parseJsonObject(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseIdentifier(
  stdout: string,
  keys: readonly string[],
) {
  const parsed = parseJsonObject(stdout);
  if (parsed) {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean);

  return line ?? null;
}

function parseStatus(stdout: string, fallback: string) {
  const parsed = parseJsonObject(stdout);
  const candidates = [
    parsed?.status,
    parsed?.result,
    parsed?.exitStatus,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return fallback;
}

function invalidInput(message: string, details?: Record<string, unknown>) {
  return new SmithersError("INVALID_INPUT", message, details);
}

function mapSpawnError(
  error: SmithersError,
  config: SmithersIdeResolvedConfig,
  args: readonly string[],
) {
  if (
    error.code === "PROCESS_SPAWN_FAILED" &&
    ((error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
      error.message.includes("ENOENT"))
  ) {
    return new SmithersError(
      "PROCESS_SPAWN_FAILED",
      `smithers-ctl is not installed or not on PATH (${config.command})`,
      {
        args: [...args],
        command: config.command,
        cwd: config.cwd,
      },
      { cause: error },
    );
  }

  return error;
}

function commandFailedError(
  config: SmithersIdeResolvedConfig,
  args: readonly string[],
  stdout: string,
  stderr: string,
  exitCode: number | null,
) {
  return new SmithersError(
    "TOOL_COMMAND_FAILED",
    `${config.command} ${args.join(" ")} failed with exit code ${exitCode ?? "unknown"}`,
    {
      args: [...args],
      command: config.command,
      cwd: config.cwd,
      exitCode,
      stderr,
      stdout,
    },
  );
}

function runCtlCommand(
  config: SmithersIdeResolvedConfig,
  toolName: string,
  args: readonly string[],
) {
  return spawnCaptureEffect(config.command, [...args], {
    cwd: config.cwd,
    env: config.env,
    idleTimeoutMs: config.idleTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    timeoutMs: config.timeoutMs,
  }).pipe(
    Effect.mapError((error) => mapSpawnError(error, config, args)),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            commandFailedError(
              config,
              args,
              result.stdout,
              result.stderr,
              result.exitCode,
            ),
          )),
    Effect.annotateLogs({
      command: config.command,
      cwd: config.cwd,
      toolName,
    }),
    Effect.withLogSpan("ide:tool-call"),
  );
}

export function detectSmithersIdeAvailabilityEffect(
  config: SmithersIdeServiceConfig = {},
) {
  const resolved = resolveConfig(config);

  return Effect.sync((): SmithersIdeAvailability => {
    const binaryPath = resolveBinaryOnPath(resolved.command, resolved.env);
    const environment = detectSmithersIdeEnvironment(resolved.env);

    if (!binaryPath) {
      return {
        available: false as const,
        binaryAvailable: false as const,
        binaryPath: null,
        environmentActive: environment.active,
        reason: "binary-missing" as const,
        signals: environment.signals,
      };
    }

    if (!environment.active) {
      return {
        available: false as const,
        binaryAvailable: true,
        binaryPath,
        environmentActive: false as const,
        reason: "environment-inactive" as const,
        signals: environment.signals,
      };
    }

    return {
      available: true as const,
      binaryAvailable: true as const,
      binaryPath,
      environmentActive: true as const,
      reason: "available" as const,
      signals: environment.signals,
    };
  }).pipe(
    Effect.annotateLogs({ command: resolved.command }),
    Effect.withLogSpan("ide:capability-detect"),
  );
}

export function createSmithersIdeService(
  config: SmithersIdeServiceConfig = {},
): SmithersIdeServiceApi {
  const resolved = resolveConfig(config);

  return {
    config: resolved,

    detectAvailability: () => detectSmithersIdeAvailabilityEffect(resolved),

    openFile: (path, line, column) => {
      if (!path.trim()) {
        return Effect.fail(invalidInput("openFile requires a non-empty path"));
      }
      if (column !== undefined && line === undefined) {
        return Effect.fail(
          invalidInput("openFile requires line when column is provided", {
            column,
            path,
          }),
        );
      }

      const args = ["open", path];
      if (line !== undefined) {
        args.push(`+${line}${column !== undefined ? `:${column}` : ""}`);
      }

      return runCtlCommand(resolved, "smithers_ide_open_file", args).pipe(
        Effect.map((result) => ({
          args: [...args] as readonly string[],
          column: column ?? null,
          command: resolved.command,
          exitCode: result.exitCode,
          line: line ?? null,
          opened: true,
          path,
          stderr: result.stderr,
          stdout: result.stdout,
        })),
      );
    },

    openDiff: (content) => {
      if (!content.trim()) {
        return Effect.fail(invalidInput("openDiff requires non-empty diff content"));
      }

      const args = ["diff", "show", "--content", content];
      return runCtlCommand(resolved, "smithers_ide_open_diff", args).pipe(
        Effect.map((result) => ({
          args: [...args] as readonly string[],
          command: resolved.command,
          exitCode: result.exitCode,
          opened: true,
          stderr: result.stderr,
          stdout: result.stdout,
        })),
      );
    },

    showOverlay: (type, options) => {
      if (!options.message.trim()) {
        return Effect.fail(invalidInput("showOverlay requires a message"));
      }

      const args = ["overlay", "--type", type, "--message", options.message];
      if (options.title) {
        args.push("--title", options.title);
      }
      if (options.position) {
        args.push("--position", options.position);
      }
      if (options.duration !== undefined) {
        args.push("--duration", String(options.duration));
      }
      if (options.percent !== undefined) {
        args.push("--percent", String(options.percent));
      }

      return runCtlCommand(resolved, "smithers_ide_show_overlay", args).pipe(
        Effect.map((result) => ({
          args: [...args] as readonly string[],
          command: resolved.command,
          exitCode: result.exitCode,
          overlayId: parseIdentifier(result.stdout, ["overlayId", "id"]),
          shown: true,
          stderr: result.stderr,
          stdout: result.stdout,
          type,
        })),
      );
    },

    runTerminal: (command, cwd) => {
      if (!command.trim()) {
        return Effect.fail(invalidInput("runTerminal requires a non-empty command"));
      }

      const args = ["terminal"];
      if (cwd) {
        args.push("--cwd", cwd);
      }
      args.push("run", command);

      return runCtlCommand(resolved, "smithers_ide_run_terminal", args).pipe(
        Effect.map((result) => ({
          args: [...args] as readonly string[],
          command: resolved.command,
          cwd: cwd ?? null,
          exitCode: result.exitCode,
          launched: true,
          status: parseStatus(result.stdout, "launched"),
          stderr: result.stderr,
          stdout: result.stdout,
          terminalCommand: command,
        })),
      );
    },

    askUser: (prompt) =>
      Effect.flatMap(
        createSmithersIdeService(resolved).showOverlay("chat", { message: prompt }),
        (result) =>
          Effect.succeed({
            args: result.args,
            command: result.command,
            exitCode: result.exitCode,
            overlayId: result.overlayId,
            prompt,
            status: "prompted" as const,
            stderr: result.stderr,
            stdout: result.stdout,
          }),
      ),

    openWebview: (url) => {
      if (!url.trim()) {
        return Effect.fail(invalidInput("openWebview requires a non-empty url"));
      }

      const args = ["webview", "open", url];
      return runCtlCommand(resolved, "smithers_ide_open_webview", args).pipe(
        Effect.map((result) => ({
          args: [...args] as readonly string[],
          command: resolved.command,
          exitCode: result.exitCode,
          opened: true,
          stderr: result.stderr,
          stdout: result.stdout,
          tabId: parseIdentifier(result.stdout, ["tabId", "id"]),
          url,
        })),
      );
    },
  };
}

export function createSmithersIdeLayer(
  config: SmithersIdeServiceConfig = {},
) {
  return Layer.succeed(SmithersIdeService, createSmithersIdeService(config));
}

export function openFile(
  path: string,
  line?: number,
  column?: number,
) {
  return Effect.flatMap(SmithersIdeService, (service) =>
    service.openFile(path, line, column),
  );
}

export function openDiff(content: string) {
  return Effect.flatMap(SmithersIdeService, (service) =>
    service.openDiff(content),
  );
}

export function showOverlay(
  type: SmithersIdeOverlayType,
  options: SmithersIdeOverlayOptions,
) {
  return Effect.flatMap(SmithersIdeService, (service) =>
    service.showOverlay(type, options),
  );
}

export function runTerminal(command: string, cwd?: string) {
  return Effect.flatMap(SmithersIdeService, (service) =>
    service.runTerminal(command, cwd),
  );
}

export function askUser(prompt: string) {
  return Effect.flatMap(SmithersIdeService, (service) =>
    service.askUser(prompt),
  );
}

export function openWebview(url: string) {
  return Effect.flatMap(SmithersIdeService, (service) =>
    service.openWebview(url),
  );
}
