/**
 * The highlighter's worker pool. Shiki's JavaScript regex engine compiles a grammar inside
 * the first synchronous tokenize: measured at 2.6 s for a 16 KiB TypeScript
 * file under JavaScriptCore (the native shell's WebKit) and ~300 ms once
 * warm, both past the 300 ms law. So tokenizing runs in pierre's worker
 * pool wherever a Worker exists, and the main thread only paints the result.
 *
 * One pool per theme per page, one worker in each (files render one at a
 * time and every worker loads Shiki and the grammars), created on the first
 * code view with that theme and kept for the page's life. pierre renders
 * every file in a pool with the POOL's theme
 * (FileRenderer.getLocalHighlightTheme), so views whose themes differ (a
 * dark repository view beside a light conversation card) never share a
 * pool: sharing one would repaint every mounted file in the theme of
 * whichever view rendered last. A page normally holds one theme, or two
 * after the house theme flips. Each theme's pool has its own state: a second
 * theme still starting is "starting" while the first is "ready".
 *
 * The pool is a promise the page keeps, not a fact, and pierre's own
 * initialization settles it: a worker that cannot start (a page whose policy
 * refuses workers, a shell that cannot load a module worker) or that never
 * answers `initialize` within the deadline rejects it, and pierre reports any
 * worker error to the pool. Either marks the pool failed, the views remount
 * pierre without it, and highlighting runs on the main thread as before.
 *
 * A view starts its theme's pool from an effect, never from its render body,
 * so a render React discards (StrictMode's second pass, an interrupted
 * concurrent render) spawns no worker. Views read the pool through
 * `useCodeViewWorkerPool`; nothing here is component state.
 */
import type { DiffsThemeNames, ThemesType } from "@pierre/diffs";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { registerVibe } from "./vibe";

registerVibe();

export type CodeViewPoolState = "off" | "starting" | "ready" | "failed";

/** One theme's pool: its state, which a failure of any pool ends for all. */
export interface CodeViewPool {
  readonly state: CodeViewPoolState;
  /** The pool pierre's File takes; undefined off the pool (no Worker here, or a pool that failed). */
  readonly manager: WorkerPoolManager | undefined;
}

export type CodeViewTheme = DiffsThemeNames | ThemesType;

/** How long a worker may take to answer `initialize` before the page gives up on it. */
export const CODE_VIEW_POOL_DEADLINE_MS = 15_000;

const OFF: CodeViewPool = { state: "off", manager: undefined };
const FAILED: CodeViewPool = { state: "failed", manager: undefined };

/** The page's pools by theme key; each entry is replaced, never mutated, so a snapshot read is stable. */
const pools = new Map<string, CodeViewPool & { readonly manager: WorkerPoolManager }>();
/** The theme key of the page's first pool, which `currentCodeViewPool` reports. */
let first: string | undefined;
let failed = false;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of listeners) listener();
};

/** One key per theme: a view remounts pierre onto another pool when its key changes. */
export const codeViewThemeKey = (theme: CodeViewTheme): string => (typeof theme === "string" ? theme : `${theme.dark}/${theme.light}`);

const bunRuntime = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * pierre's worker entry. Under Vite the `new Worker(new URL(...))` literal
 * is what the bundler looks for: it bundles the worker and rewrites the URL
 * to the built asset, served from the app's own origin like every other
 * chunk. Under Bun (the tests) the same module is a file on disk that
 * `import.meta.resolve` names, run by Bun's own Worker. `inBun` is the
 * runtime check; Bun's global can't be hidden, so the suite passes `false`
 * to read the bundler's path.
 */
export const spawnWorker = (inBun: boolean = bunRuntime()): Worker => {
  if (inBun) {
    // Called as a method: Bun binds `resolve` to its import.meta and refuses a detached copy.
    const url = (import.meta as { resolve?: (specifier: string) => string }).resolve?.("@pierre/diffs/worker/worker.js");
    if (url === undefined) throw new Error("code view: this runtime cannot locate pierre's worker");
    const worker = new Worker(url, { type: "module" });
    // A test process ends when its tests end; the worker must not hold it open.
    (worker as { unref?: () => void }).unref?.();
    return worker;
  }
  return new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" });
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether this page can run a pool at all: a Worker, a document, and no pool that failed. */
const poolsAvailable = (): boolean => !failed && typeof Worker === "function" && typeof document !== "undefined";

/** Retire every pool of the page. */
const terminateAll = (): void => {
  for (const pool of pools.values()) pool.manager.terminate();
  pools.clear();
};

const owns = (manager: WorkerPoolManager): boolean => [...pools.values()].some((pool) => pool.manager === manager);

/** Give up on the page's pools when `manager` fails, unless the page has closed it or started another since. */
const fail = (manager: WorkerPoolManager, reason: string): void => {
  if (!owns(manager)) return;
  console.warn(`code view: highlighting stays on the main thread — ${reason}`);
  terminateAll();
  failed = true;
  publish();
};

/** The pool for `theme` as it stands; starts nothing. */
const poolFor = (key: string | undefined): CodeViewPool => (failed ? FAILED : (key === undefined ? undefined : pools.get(key)) ?? OFF);

/**
 * Start the pool for `theme` once per page and return it. Call it from an
 * effect or an event, never a render body: it spawns a worker and notifies
 * the subscribed views.
 */
export const codeViewWorkerPool = (theme: CodeViewTheme): CodeViewPool => {
  const key = codeViewThemeKey(theme);
  if (pools.has(key) || !poolsAvailable()) return poolFor(key);
  const manager: WorkerPoolManager = new WorkerPoolManager(
    {
      poolSize: 1,
      workerFactory: () => spawnWorker(),
      workerInitializationTimeout: CODE_VIEW_POOL_DEADLINE_MS,
      // Any worker error, at startup or later, moves the page to the main thread; pierre logs nothing itself.
      onWorkerError: (event) => fail(manager, `its worker failed (${(event as ErrorEvent).message || "error"})`),
    },
    { theme, useTokenTransformer: true, preferredHighlighter: "shiki-js" },
  );
  pools.set(key, { state: "starting", manager });
  first ??= key;
  manager.initialize().then(
    () => {
      if (pools.get(key)?.manager !== manager || !manager.isInitialized()) return;
      pools.set(key, { state: "ready", manager });
      publish();
    },
    (error: unknown) => fail(manager, `its worker failed to initialize (${messageOf(error)})`),
  );
  publish();
  return poolFor(key);
};

/** The page's first pool, or "failed" once any pool has failed. */
export const currentCodeViewPool = (): CodeViewPool => poolFor(first);

/**
 * Release the page's highlighter after unmounting its code views, while its
 * DOM still exists. Embedded hosts and tests may close a page without ending
 * the JS process. The next page can create fresh pools; the old pools'
 * initialization and errors cannot change their successors' state.
 */
export const disposeCodeViewPool = (): void => {
  terminateAll();
  first = undefined;
  failed = false;
};

export const subscribeCodeViewPool = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** What a view hands pierre: the pool's manager, or none (the main thread), and whether to wait for the pool. */
export interface CodeViewHighlighter {
  /** The manager for pierre's `WorkerPoolContext`; undefined highlights on the main thread. */
  readonly manager: WorkerPoolManager | undefined;
  /**
   * True for the render before this view's effect starts its theme's pool.
   * The view mounts no pierre widget yet: one mounted without the pool would
   * tokenize on the main thread, the stall the pool exists to avoid.
   */
  readonly waiting: boolean;
}

const MAIN_THREAD: CodeViewHighlighter = { manager: undefined, waiting: false };
const WAITING: CodeViewHighlighter = { manager: undefined, waiting: true };
/** One highlighter per published pool, so the store's snapshot is stable between changes. */
const highlighters = new WeakMap<CodeViewPool, CodeViewHighlighter>();

const highlighterFor = (key: string): CodeViewHighlighter => {
  const pool = poolFor(key);
  if (pool.manager === undefined) return pool.state === "off" && poolsAvailable() ? WAITING : MAIN_THREAD;
  let highlighter = highlighters.get(pool);
  if (highlighter === undefined) highlighters.set(pool, highlighter = { manager: pool.manager, waiting: false });
  return highlighter;
};

/**
 * The pool for a view rendering with `theme`. Its effect starts the pool for
 * the theme; the view re-renders on every change of that pool's state. A
 * server render, and the client render that hydrates it, highlight on the
 * main thread, as a page without workers does.
 */
export const useCodeViewWorkerPool = (theme: CodeViewTheme): CodeViewHighlighter => {
  const key = codeViewThemeKey(theme);
  // Keyed by the theme's key: an equal theme object made on each render starts nothing new.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void codeViewWorkerPool(theme), [key]);
  const read = useCallback(() => highlighterFor(key), [key]);
  return useSyncExternalStore(subscribeCodeViewPool, read, () => MAIN_THREAD);
};
