import { Effect, Metric } from "effect";
import { runPromise } from "../effect/runtime";
import { dbRetries } from "../effect/metrics";
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

function computeDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.max(1, Math.round(backoff * jitter));
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

  const loop = (attempt: number): Effect.Effect<A, SmithersError> =>
    operation().pipe(
      Effect.catchAll((error) => {
        if (!isRetryableSqliteWriteError(error) || attempt >= maxAttempts) {
          return Effect.fail(error);
        }
        const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs);
        return Effect.gen(function* () {
          yield* Metric.increment(dbRetries);
          yield* Effect.logWarning(
            `${label} failed with ${describeSqliteWriteError(error)}; retrying in ${delayMs}ms (${attempt}/${maxAttempts})`,
          );
          if (sleep) {
            yield* Effect.tryPromise({
              try: () => sleep(delayMs),
              catch: (cause) =>
                toSmithersError(cause, label, {
                  code: "DB_WRITE_FAILED",
                  details: { retryDelayMs: delayMs },
                }),
            });
          } else {
            yield* Effect.sleep(delayMs);
          }
          return yield* loop(attempt + 1);
        }).pipe(
          Effect.annotateLogs({
            retryable: true,
            retryAttempt: attempt,
            retryMaxAttempts: maxAttempts,
            retryDelayMs: delayMs,
            retryLabel: label,
          }),
        );
      }),
    );

  return loop(1).pipe(Effect.withLogSpan("sqlite-write-retry"));
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
