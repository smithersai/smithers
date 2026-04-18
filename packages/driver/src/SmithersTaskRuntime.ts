/**
 * Structural stand-in for the full `SmithersDb` class exported from
 * `@smithers-orchestrator/db/adapter`. The generated `@smithers-orchestrator/db` index.d.ts does not
 * expose `SmithersDb` as a named export (it emits `SmithersDb$1` plus a
 * non-exported alias), and the package's wildcard subpath mapping sends every
 * `@smithers-orchestrator/db/<sub>` type lookup back to that same bundle. Until the db
 * package fixes its public type surface, we keep the runtime `db` handle typed
 * as a branded record so consumers cannot treat it as arbitrary `any` while
 * still allowing a real `SmithersDb` instance to flow through.
 */
type SmithersDb = Record<string, unknown> & { readonly __smithersDbBrand?: never };

export type SmithersTaskRuntime = {
  runId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  signal: AbortSignal;
  db: SmithersDb;
  heartbeat: (data?: unknown) => void;
  lastHeartbeat: unknown | null;
};
