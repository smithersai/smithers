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
