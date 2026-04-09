import { TaskAborted } from "../errors/tagged";

export function makeAbortError(message = "Task aborted"): TaskAborted {
  return new TaskAborted({
    message,
    name: "AbortError",
  });
}

export function wireAbortSignal(
  controller: AbortController,
  signal?: AbortSignal,
) {
  if (!signal) {
    return () => {};
  }
  const forwardAbort = () => {
    controller.abort(signal.reason ?? makeAbortError());
  };
  if (signal.aborted) {
    forwardAbort();
    return () => {};
  }
  signal.addEventListener("abort", forwardAbort, { once: true });
  return () => signal.removeEventListener("abort", forwardAbort);
}

export function parseAttemptMetaJson(
  metaJson?: string | null,
): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
