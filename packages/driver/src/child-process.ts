import { spawn } from "node:child_process";
import { Effect, Metric } from "effect";
import { ignoreSyncError } from "./interop";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { SmithersError } from "@smithers/errors/SmithersError";
import { toolOutputTruncatedTotal } from "@smithers/observability/metrics";
import { logDebug, logWarning } from "@smithers/observability/logging";

export type SpawnCaptureOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  detached?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

type SpawnCaptureInternalResult = {
  result: SpawnCaptureResult;
  truncationCount: number;
};

export function spawnCaptureEffect(
  command: string,
  args: string[],
  options: SpawnCaptureOptions,
): Effect.Effect<SpawnCaptureResult, SmithersError> {
  const {
    cwd,
    env,
    input,
    signal,
    timeoutMs,
    idleTimeoutMs,
    maxOutputBytes = 200_000,
    detached = false,
    onStdout,
    onStderr,
  } = options;
  const errorDetails = {
    command,
    args,
    cwd,
    timeoutMs,
    idleTimeoutMs,
  };
  const logAnnotations = {
    command,
    args: args.join(" "),
    cwd,
    timeoutMs: timeoutMs ?? null,
    idleTimeoutMs: idleTimeoutMs ?? null,
  };
  const span = `process:${command}`;

  return (Effect.async<SpawnCaptureInternalResult, SmithersError>((resume) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    logDebug("spawning child process", logAnnotations, span);

    const child = spawn(command, args, {
      cwd,
      env,
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const kill = (
      reason: string,
      code: "PROCESS_ABORTED" | "PROCESS_TIMEOUT" | "PROCESS_IDLE_TIMEOUT",
    ) => {
      logWarning(
        "child process interrupted",
        {
          ...logAnnotations,
          reason,
          errorCode: code,
        },
        span,
      );
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      if (!settled) {
        settled = true;
        resume(Effect.fail(new SmithersError(code, reason, errorDetails)));
      }
    };

    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeoutMs) {
        idleTimer = setTimeout(() => {
          kill(
            `CLI idle timed out after ${idleTimeoutMs}ms`,
            "PROCESS_IDLE_TIMEOUT",
          );
        }, idleTimeoutMs);
      }
    };

    if (timeoutMs) {
      totalTimer = setTimeout(() => {
        kill(`CLI timed out after ${timeoutMs}ms`, "PROCESS_TIMEOUT");
      }, timeoutMs);
    }
    resetIdle();

    const finalize = (result: SpawnCaptureResult) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      logDebug(
        "child process completed",
        {
          ...logAnnotations,
          exitCode: result.exitCode,
          stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
          stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        },
        span,
      );
      let truncationCount = 0;
      if (stdoutTruncated) truncationCount++;
      if (stderrTruncated) truncationCount++;
      resume(Effect.succeed({ result, truncationCount }));
    };

    if (signal) {
      if (signal.aborted) {
        kill("CLI aborted", "PROCESS_ABORTED");
      } else {
        signal.addEventListener("abort", () => kill("CLI aborted", "PROCESS_ABORTED"), {
          once: true,
        });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      resetIdle();
      const text = chunk.toString("utf8");
      const nextStdout = stdout + text;
      if (!stdoutTruncated && Buffer.byteLength(nextStdout, "utf8") > maxOutputBytes) {
        stdoutTruncated = true;
        logWarning(
          "child process stdout truncated",
          {
            ...logAnnotations,
            maxOutputBytes,
            stream: "stdout",
          },
          span,
        );
      }
      stdout = truncateToBytes(nextStdout, maxOutputBytes);
      onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      resetIdle();
      const text = chunk.toString("utf8");
      const nextStderr = stderr + text;
      if (!stderrTruncated && Buffer.byteLength(nextStderr, "utf8") > maxOutputBytes) {
        stderrTruncated = true;
        logWarning(
          "child process stderr truncated",
          {
            ...logAnnotations,
            maxOutputBytes,
            stream: "stderr",
          },
          span,
        );
      }
      stderr = truncateToBytes(nextStderr, maxOutputBytes);
      onStderr?.(text);
    });

    child.on("error", (error) => {
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (!settled) {
        settled = true;
        const smithersError = toSmithersError(error, `spawn ${command}`, {
          code: "PROCESS_SPAWN_FAILED",
          details: errorDetails,
        });
        logWarning(
          "failed to spawn child process",
          {
            ...logAnnotations,
            error: smithersError.message,
          },
          span,
        );
        resume(
          Effect.fail(smithersError),
        );
      }
    });

    child.on("close", (code) => {
      finalize({ stdout, stderr, exitCode: code ?? null });
    });

    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();

    return Effect.gen(function* () {
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (!settled) {
        yield* Effect.try({
          try: () => {
            if (detached && child.pid) {
              process.kill(-child.pid, "SIGKILL");
            } else {
              child.kill("SIGKILL");
            }
          },
          catch: (cause) => toSmithersError(cause, "kill process group", {
            code: "PROCESS_ABORTED",
            details: errorDetails,
          }),
        }).pipe(
          Effect.catchAll(() => ignoreSyncError("kill fallback", () => child.kill("SIGKILL"))),
        );
      }
    });
  })).pipe(
    Effect.tap(({ truncationCount }) =>
      truncationCount > 0
        ? Metric.incrementBy(toolOutputTruncatedTotal, truncationCount)
        : Effect.void,
    ),
    Effect.map(({ result }) => result),
    Effect.annotateLogs({
      ...logAnnotations,
    }),
    Effect.withLogSpan(span),
  );
}
