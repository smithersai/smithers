/**
 * The autosave state machine behind {@link useAutosaveDoc}, ported from the
 * VaultPane save logic (Unsaved / Saving / Saved / Changed-on-disk). Pure and
 * DOM-free: timers are injectable so tests drive them manually.
 */

export type AutosaveState = "clean" | "dirty" | "saving" | "saved" | "conflict";

/**
 * Why the last attempt did not land. The codes are stable strings a caller may
 * branch on; none is a user-facing message.
 *
 * - `read-failed`: the external copy could not be inspected. The machine fails
 *   closed into `conflict`, because a file it cannot read is a file it cannot
 *   safely overwrite. This code is what distinguishes that from a real
 *   concurrent edit detected by the read, which carries no failure.
 * - `conflict`: the conditional write refused a changed external revision.
 * - `write-failed`: `save` rejected. The machine stays `dirty` without a
 *   timer; the next edit or explicit `saveNow()` can retry the retained text.
 */
export type AutosaveFailureCode = "read-failed" | "write-failed" | "conflict";

/** The last failure, with the original rejection retained as `cause`. */
export type AutosaveFailure = {
  readonly code: AutosaveFailureCode;
  readonly cause: unknown;
};

export type AutosaveSnapshot = {
  readonly value: string;
  readonly state: AutosaveState;
  readonly mtimeMs: number | undefined;
  /**
   * The failure behind the current state, or `undefined` when the state means
   * what it says. A `conflict` with a `read-failed` failure is an inspection
   * error, not a concurrent edit; a `dirty` with a `write-failed` failure is an
   * unsaved document whose write was attempted and rejected.
   */
  readonly failure: AutosaveFailure | undefined;
};

/** The exact external revision a conditional writer must compare atomically. */
export type AutosaveRevision = {
  readonly content: string;
  readonly mtimeMs?: number;
};

export type AutosaveSaveResult =
  | { readonly status?: "saved"; readonly mtimeMs?: number }
  | { readonly status: "conflict"; readonly cause?: unknown };

export type AutosaveDocOptions = {
  /** Document text at load time. */
  initialValue: string;
  /** File mtime at load time; the conflict-check baseline. */
  initialMtimeMs?: number;
  /**
   * Persist the text only if the external copy still matches `expected`.
   * The backend MUST compare content and revision and write in one atomic
   * transaction or under a lock shared by all writers. On mismatch, leave the
   * external copy unchanged and return `{ status: "conflict", cause? }`.
   * A second read without an atomic commit does not satisfy this contract.
   *
   * `expected` is the exact readExternal result, including for discardExternal.
   * Without a configured reader it is undefined; the writer must provide its
   * own concurrency control in that mode. Reporting mtimeMs advances the
   * baseline; resolving void leaves it unchanged.
   */
  save: (value: string, expected: AutosaveRevision | undefined) => Promise<AutosaveSaveResult | void>;
  /**
   * Read the on-disk copy for conflict detection. The save is refused, and the
   * machine lands in `conflict` instead of overwriting someone else's edit,
   * when the on-disk content differs from our last persisted content AND the
   * on-disk mtime is not strictly older than our baseline.
   *
   * Both halves matter. Content alone would call a byte-identical rewrite a
   * conflict; mtime alone would call our own write one. The comparison is `>=`
   * rather than `>` on purpose: filesystems with one-second mtime granularity
   * let a second writer land inside our own timestamp, and an equal mtime with
   * differing content is exactly that case.
   *
   * When either mtime is missing or non-finite there is no baseline to compare,
   * so the check degrades to the content comparison alone — again the
   * conservative direction. A reader that throws also fails closed: a file the
   * machine cannot inspect is one it cannot safely overwrite, reported as
   * `conflict` carrying a `read-failed` {@link AutosaveFailure}.
   */
  readExternal?: () => Promise<AutosaveRevision | undefined>;
  /** Debounce window for edit-triggered saves (default 800ms). */
  debounceMs?: number;
  /** Injectable scheduler (returns a cancel fn); defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

export type AutosaveDoc = {
  /** Cached snapshot; identity changes only when emitted state changes. */
  getSnapshot(): AutosaveSnapshot;
  subscribe(listener: () => void): () => void;
  /** Record an edit: marks dirty and schedules a debounced save. */
  setValue(value: string): void;
  /**
   * Save immediately, skipping the debounce. Never force-overwrites: a pending
   * conflict is still refused, and {@link AutosaveDoc.discardExternal} is the
   * only sanctioned way to overwrite the on-disk copy.
   *
   * Resolves whether or not the write landed; read `getSnapshot().state` and
   * `getSnapshot().failure` to tell a persisted document from a refused or
   * failed one.
   */
  saveNow(): Promise<void>;
  /**
   * Resolve a conflict by discarding the external (on-disk) version:
   * reads the current revision and conditionally saves the local text over it.
   * A failed read or another write after that read still refuses the save.
   */
  discardExternal(): Promise<void>;
  dispose(): void;
};

/**
 * Status line copy per state. Plain text only — no animated ellipsis or
 * spinner — so it is stable under prefers-reduced-motion. `clean` renders
 * nothing (the VaultPane "idle" convention: no pill until the first edit).
 */
export const AUTOSAVE_STATUS_TEXT: Record<AutosaveState, string> = {
  clean: "",
  dirty: "Unsaved",
  saving: "Saving…",
  saved: "Saved",
  conflict: "Changed on disk",
};

export function autosaveStatusText(state: AutosaveState): string {
  return AUTOSAVE_STATUS_TEXT[state];
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createAutosaveDoc(options: AutosaveDocOptions): AutosaveDoc {
  const debounceMs = options.debounceMs ?? 800;
  const schedule = options.schedule ?? defaultSchedule;

  let value = options.initialValue;
  let persistedContent = options.initialValue;
  let state: AutosaveState = "clean";
  let mtimeMs = options.initialMtimeMs;
  let cancelPending: (() => void) | null = null;
  let inflight = false;
  let inflightDone: Promise<void> | null = null;
  let disposed = false;
  let failure: AutosaveFailure | undefined;
  const listeners = new Set<() => void>();

  let snapshot: AutosaveSnapshot = { value, state, mtimeMs, failure };

  /**
   * Publish a transition. `nextFailure` is always written, so any transition
   * that does not name a failure clears the previous one: a `conflict` reached
   * by a real external edit never inherits the `read-failed` code of the
   * attempt before it.
   */
  function emit(nextState?: AutosaveState, nextFailure?: AutosaveFailure): void {
    if (nextState !== undefined) state = nextState;
    failure = nextFailure;
    snapshot = { value, state, mtimeMs, failure };
    for (const listener of listeners) listener();
  }

  function cancelScheduled(): void {
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
  }

  function scheduleFlush(): void {
    cancelScheduled();
    cancelPending = schedule(() => {
      cancelPending = null;
      void saveNow();
    }, debounceMs);
  }

  /**
   * Whether the on-disk copy holds an edit our next write would destroy.
   *
   * The predicate is the documented conjunction: differing content AND an
   * mtime that is not strictly older than our baseline. See
   * {@link AutosaveDocOptions.readExternal} for why each half is required and
   * what happens when a baseline is unavailable.
   */
  async function detectConflict(force: boolean): Promise<{
    external?: AutosaveRevision;
    conflict: AutosaveFailure | boolean;
  }> {
    if (!options.readExternal) return { conflict: false };
    let external: AutosaveRevision | undefined;
    try {
      const read = await options.readExternal();
      external = read && { ...read };
    } catch (cause) {
      // Fail closed: an unreadable external copy cannot safely be overwritten.
      // The code is what tells this apart from a real concurrent edit.
      return { conflict: { code: "read-failed", cause } };
    }
    // `undefined` means no reader is currently configured (the React binding
    // keeps a dynamic callback proxy installed so later props are observed).
    if (!external) return { conflict: false };
    if (force || external.content === persistedContent) return { external, conflict: false };
    const externalMtime = external.mtimeMs;
    if (
      externalMtime === undefined ||
      mtimeMs === undefined ||
      !Number.isFinite(externalMtime) ||
      !Number.isFinite(mtimeMs)
    ) {
      // No usable baseline: the content comparison stands alone.
      return { external, conflict: true };
    }
    return { external, conflict: externalMtime >= mtimeMs };
  }

  async function saveNow(force = false): Promise<void> {
    cancelScheduled();
    if (disposed) return;
    if (inflight) {
      const pending = inflightDone;
      if (pending) await pending;
      if (!disposed && ((state === "dirty" && !failure) || (force && state === "conflict"))) {
        await saveNow(force);
      }
      return;
    }
    // Conflict detection is asynchronous too, so acquire the single-flight
    // guard before it. Same-tick callers can no longer overlap writes.
    inflight = true;
    let finishInflight!: () => void;
    inflightDone = new Promise<void>((resolve) => {
      finishInflight = resolve;
    });
    try {
      const { conflict, external } = await detectConflict(force);
      if (conflict) {
        if (!disposed) emit("conflict", conflict === true ? undefined : conflict);
        return;
      }
      if (disposed) return;
      const savingValue = value;
      emit("saving");
      const result = await options.save(savingValue, external);
      if (disposed) return;
      if (result && result.status === "conflict") {
        emit("conflict", { code: "conflict", cause: result.cause });
        return;
      }
      persistedContent = savingValue;
      mtimeMs = result?.mtimeMs ?? mtimeMs;
      // Edits during the flight are not covered by this save: stay dirty.
      emit(value === savingValue ? "saved" : "dirty");
    } catch (cause) {
      // Still unsaved; the next edit (or saveNow retry) will attempt again.
      // The code names the write as the thing that failed, so a caller can
      // tell "not yet saved" from "tried to save and could not".
      cancelScheduled();
      if (!disposed) emit("dirty", { code: "write-failed", cause });
    } finally {
      inflight = false;
      finishInflight();
      inflightDone = null;
    }
    if (!disposed && state === "dirty" && !failure) scheduleFlush();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setValue(next: string) {
      if (disposed) return;
      // Echoes of the current text (serializer normalization on hydrate)
      // must not dirty a clean document: viewing stays read-only.
      if (next === value && (state === "clean" || state === "saved")) return;
      value = next;
      scheduleFlush();
      emit("dirty");
    },
    // Only discardExternal may authorize replacing the version just read.
    // Keep force private so a JS caller cannot gain that capability by passing
    // an undocumented argument to saveNow.
    saveNow: () => saveNow(false),
    async discardExternal() {
      if (disposed) return;
      if (inflightDone) await inflightDone;
      await saveNow(true);
    },
    dispose() {
      disposed = true;
      cancelScheduled();
      listeners.clear();
    },
  };
}
