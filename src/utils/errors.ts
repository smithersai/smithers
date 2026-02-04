export function errorToJson(err: unknown) {
  if (err instanceof Error) {
    const anyErr = err as any;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: anyErr?.cause,
      code: anyErr?.code,
    };
  }
  if (err && typeof err === "object") {
    return err;
  }
  return { message: String(err) };
}
