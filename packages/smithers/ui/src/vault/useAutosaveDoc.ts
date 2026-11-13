import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  autosaveStatusText,
  createAutosaveDoc,
  type AutosaveDoc,
  type AutosaveDocOptions,
  type AutosaveFailure,
  type AutosaveState,
} from "./autosaveMachine";

export type { AutosaveFailure } from "./autosaveMachine";

export type UseAutosaveDocOptions = AutosaveDocOptions & {
  /** Stable document identity, also used to recover unsaved drafts on remount. */
  resetKey?: string | number;
  /** Stable vault/session scope for document keys. Defaults to a shared owner. */
  owner?: object;
};

export type UseAutosaveDocResult = {
  value: string;
  setValue: (value: string) => void;
  state: AutosaveState;
  /** Reduced-motion-safe status line (plain text, "" while clean). */
  statusText: string;
  mtimeMs: number | undefined;
  readonly failure: AutosaveFailure | undefined;
  saveNow: () => Promise<void>;
  discardExternal: () => Promise<void>;
};

type DocEntry = {
  readonly doc: AutosaveDoc;
  save: AutosaveDocOptions["save"];
  readExternal: AutosaveDocOptions["readExternal"];
  users: number;
  retired: boolean;
  releaseIfClean: () => void;
};

const defaultOwner = {};
const owners = new WeakMap<object, Map<string | number | symbol, DocEntry>>();

/**
 * Retain each document until its last view leaves AND all edits are persisted.
 * Failures keep their machine and draft without retrying. A stable owner/resetKey
 * lets a later mount recover the draft and its failure for explicit recovery.
 */
export function useAutosaveDoc(options: UseAutosaveDocOptions): UseAutosaveDocResult {
  const privateKey = useRef(Symbol());
  const serverOwner = useRef({});
  // SSR has no effect cleanup and must never reuse another request's text.
  const owner = typeof window === "undefined" ? serverOwner.current : options.owner ?? defaultOwner;
  const key = options.resetKey ?? privateKey.current;
  const entry = useMemo(() => {
    let documents = owners.get(owner);
    if (!documents) {
      documents = new Map();
      owners.set(owner, documents);
    }
    const existing = documents.get(key);
    if (existing) return existing;
    const created: DocEntry = {
      save: options.save,
      readExternal: options.readExternal,
      users: 0,
      retired: false,
      releaseIfClean: () => {
        const state = created.doc.getSnapshot().state;
        if (!created.retired || created.users > 0 || (state !== "clean" && state !== "saved")) return;
        if (documents.get(key) === created) documents.delete(key);
        created.doc.dispose();
      },
      doc: createAutosaveDoc({
        initialValue: options.initialValue,
        initialMtimeMs: options.initialMtimeMs,
        debounceMs: options.debounceMs,
        schedule: options.schedule,
        save: (value, expected) => created.save(value, expected),
        readExternal: async () => created.readExternal?.(),
      }),
    };
    documents.set(key, created);
    created.doc.subscribe(created.releaseIfClean);
    return created;
  }, [owner, key]);

  // Each entry keeps its own document's callbacks after retirement. Updating
  // the live entry also picks up readers or writers supplied after mount.
  entry.save = options.save;
  entry.readExternal = options.readExternal;

  useEffect(() => {
    entry.users++;
    entry.retired = false;
    return () => {
      // StrictMode replays setup immediately. Count both setups until this
      // microtask so replay never retires or flushes the still-mounted entry.
      queueMicrotask(() => {
        entry.users--;
        if (entry.users > 0) return;
        entry.retired = true;
        const { state, failure } = entry.doc.getSnapshot();
        if ((state === "dirty" && !failure) || state === "saving") {
          // saveNow waits for an in-flight write and flushes any newer edits.
          // A settled promise is not evidence of persistence: only a clean
          // snapshot permits release. Failed drafts wait for explicit recovery.
          void entry.doc.saveNow().then(entry.releaseIfClean);
        } else {
          entry.releaseIfClean();
        }
      });
    };
  }, [entry]);

  const doc = entry.doc;
  const snapshot = useSyncExternalStore(doc.subscribe, doc.getSnapshot, doc.getSnapshot);
  const setValue = useCallback((value: string) => doc.setValue(value), [doc]);
  const saveNow = useCallback(() => doc.saveNow(), [doc]);
  const discardExternal = useCallback(() => doc.discardExternal(), [doc]);

  return {
    value: snapshot.value,
    setValue,
    state: snapshot.state,
    statusText: autosaveStatusText(snapshot.state),
    mtimeMs: snapshot.mtimeMs,
    failure: snapshot.failure,
    saveNow,
    discardExternal,
  };
}
