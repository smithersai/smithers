function makeAbortError(): Error {
  const error = new Error("Task aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw makeAbortError();
  }
}

function abortPromise(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(makeAbortError()), {
      once: true,
    });
  });
}

export async function withAbort<T>(
  value: Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const abort = abortPromise(signal);
  const promise = Promise.resolve(value);
  return abort ? Promise.race([promise, abort]) : promise;
}
