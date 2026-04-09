import {
  Duration,
  Effect,
  Metric,
  Schedule,
  ScheduleDecision,
  ScheduleIntervals,
} from "effect";
import { dbRetries } from "../effect/metrics";
import { runPromise } from "../effect/runtime";
import { retryPolicyToSchedule } from "../utils/retry";
import { type SmithersError, toSmithersError } from "../utils/errors";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 2_000;

export type SqliteWriteRetryOptions = {
  label?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type SqliteErrorMetadata = {
  code: string;
  message: string;
};

function readSqliteErrorMetadata(error: unknown): SqliteErrorMetadata | null {
  if (!error || (typeof error !== "object" && !(error instanceof Error))) {
    return null;
  }
  const code = typeof (error as any)?.code === "string" ? (error as any).code : "";
  const message = String((error as any)?.message ?? "");
  return { code, message };
}

function findSqliteErrorMetadata(error: unknown): SqliteErrorMetadata | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    const metadata = readSqliteErrorMetadata(current);
    if (metadata) {
      const message = metadata.message.toLowerCase();
      if (
        metadata.code.startsWith("SQLITE_BUSY") ||
        metadata.code.startsWith("SQLITE_IOERR") ||
        message.includes("database is locked") ||
        message.includes("database is busy") ||
        message.includes("disk i/o error")
      ) {
        return metadata;
      }
    }
    current = (current as any)?.cause;
  }

  return readSqliteErrorMetadata(error);
}

export function isRetryableSqliteWriteError(error: unknown): boolean {
  const metadata = findSqliteErrorMetadata(error);
  if (!metadata) return false;
  const { code } = metadata;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR")) {
    return true;
  }

  const message = metadata.message.toLowerCase();
  return (
    message.includes("database is locked") ||
    message.includes("database is busy") ||
    message.includes("disk i/o error")
  );
}

function describeSqliteWriteError(error: unknown): string {
  const metadata = findSqliteErrorMetadata(error);
  const code = metadata?.code ?? "";
  const message = metadata?.message || String((error as any)?.message ?? error ?? "unknown error");
  return code ? `${code}: ${message}` : message;
}

function makeSqliteRetrySchedule(
  maxAttempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
) {
  const boundedBaseDelayMs = Math.max(1, Math.floor(baseDelayMs));
  const boundedMaxDelayMs = Math.max(1, Math.floor(maxDelayMs));

  return retryPolicyToSchedule({
    backoff: "exponential",
    initialDelayMs: boundedBaseDelayMs,
  }).pipe(
    Schedule.modifyDelay((_, delay) =>
      Duration.millis(Math.min(boundedMaxDelayMs, Duration.toMillis(delay))),
    ),
    Schedule.jitteredWith({ min: 0.75, max: 1.25 }),
    Schedule.whileInput(isRetryableSqliteWriteError),
    Schedule.intersect(Schedule.recurs(Math.max(0, maxAttempts - 1))),
  );
}

export function withSqliteWriteRetryEffect<A>(
  operation: () => Effect.Effect<A, SmithersError>,
  opts: SqliteWriteRetryOptions = {},
): Effect.Effect<A, SmithersError> {
  const {
    label = "sqlite write",
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    sleep,
  } = opts;

  const boundedMaxAttempts = Math.max(1, Math.floor(maxAttempts));
  let retryAttempt = 0;
  let lastRetryError: SmithersError | undefined;

  const retrySchedule = Schedule.mapInput(
    makeSqliteRetrySchedule(boundedMaxAttempts, baseDelayMs, maxDelayMs),
    (error: SmithersError) => {
      lastRetryError = error;
      return error;
    },
  ).pipe(
    Schedule.onDecision((_, decision) => {
      if (ScheduleDecision.isDone(decision) || !lastRetryError) {
        return Effect.void;
      }

      retryAttempt += 1;
      const delayMs = Math.max(
        1,
        Math.round(ScheduleIntervals.start(decision.intervals) - Date.now()),
      );

      return Effect.gen(function* () {
        yield* Metric.increment(dbRetries);
        yield* Effect.logWarning(
          `${label} failed with ${describeSqliteWriteError(lastRetryError)}; retrying in ${delayMs}ms (${retryAttempt}/${boundedMaxAttempts})`,
        );
        if (sleep) {
          yield* Effect.promise(() => sleep(delayMs));
        }
      }).pipe(
        Effect.annotateLogs({
          retryable: true,
          retryAttempt,
          retryMaxAttempts: boundedMaxAttempts,
          retryDelayMs: delayMs,
          retryLabel: label,
        }),
      );
    }),
  );

  return Effect.suspend(operation).pipe(
    Effect.retry(
      sleep
        ? Schedule.modifyDelay(retrySchedule, () => Duration.zero)
        : retrySchedule,
    ),
    Effect.withLogSpan("sqlite-write-retry"),
  );
}

export async function withSqliteWriteRetry<T>(
  operation: () => Promise<T>,
  opts: SqliteWriteRetryOptions = {},
): Promise<T> {
  return runPromise(
    withSqliteWriteRetryEffect(
      () =>
        Effect.tryPromise({
          try: () => operation(),
          catch: (cause) =>
            toSmithersError(cause, opts.label ?? "sqlite write", {
              code: "DB_WRITE_FAILED",
            }),
        }),
      opts,
    ),
  );
}
