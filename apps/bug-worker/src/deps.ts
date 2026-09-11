/**
 * Effects the worker's routes take as arguments instead of reaching for
 * globals, so tests inject a controllable clock and a stub fetch.
 */
export interface BugWorkerDeps {
  now: () => number;
  fetch: typeof fetch;
}
