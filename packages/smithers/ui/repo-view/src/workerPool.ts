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
 * after the house theme flips.
 *
 * The pool is a promise the page keeps, not a fact, and pierre's own
 * initialization settles it: a worker that cannot start (a page whose policy
 * refuses workers, a shell that cannot load a module worker) or that never
 * answers `initialize` within the deadline rejects it, and pierre reports any
 * worker error to the pool. Either marks the pool failed, the views remount
 * pierre without it, and highlighting runs on the main thread as before. Views read the pool through
 * `useSyncExternalStore`; nothing here is component state.
 */
import type { DiffsThemeNames, ThemesType } from "@pierre/diffs";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { registerVibe } from "./vibe";

registerVibe();

export type CodeViewPoolState = "off" | "starting" | "ready" | "failed";

/** The page's pools: their state, which a failure of any one ends for all, and the first theme's pool. */
export interface CodeViewPool {
  readonly state: CodeViewPoolState;
  /** The pool pierre's File takes; undefined off the pool (no Worker here, or a pool that failed). */
  readonly manager: WorkerPoolManager | undefined;
}

export type CodeViewTheme = DiffsThemeNames | ThemesType;

/** How long a worker may take to answer `initialize` before the page gives up on it. */
export const CODE_VIEW_POOL_DEADLINE_MS = 15_000;

const OFF: CodeViewPool = { state: "off", manager: undefined };

let pool: CodeViewPool = OFF;
/** The page's pools by theme key. */
const managers = new Map<string, WorkerPoolManager>();
const listeners = new Set<() => void>();

const publish = (next: CodeViewPool): void => {
  pool = next;
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

/** Retire every pool of the page. */
const terminateAll = (): void => {
  for (const manager of managers.values()) manager.terminate();
  managers.clear();
};

/** Give up on the page's pools when `manager` fails, unless the page has closed it or started another since. */
const fail = (manager: WorkerPoolManager, reason: string): void => {
  if (![...managers.values()].includes(manager)) return;
  console.warn(`code view: highlighting stays on the main thread — ${reason}`);
  terminateAll();
  publish({ state: "failed", manager: undefined });
};

/** Start the pool for `theme` once per page. Publishes nothing: the caller is mid-render. */
const start = (theme: CodeViewTheme): void => {
  if (pool.state === "failed" || managers.has(codeViewThemeKey(theme))) return;
  if (typeof Worker !== "function" || typeof document === "undefined") return;
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
  managers.set(codeViewThemeKey(theme), manager);
  if (pool.manager === undefined) pool = { state: "starting", manager };
  manager.initialize().then(
    () => {
      if (pool.manager === manager && manager.isInitialized()) publish({ state: "ready", manager });
    },
    (error: unknown) => fail(manager, `its worker failed to initialize (${messageOf(error)})`),
  );
};

/**
 * The pool for a view rendering with `theme`: started on first use of that
 * theme, and carrying the page's state. Call it from the render body, then
 * read the live state through
 * `useSyncExternalStore(subscribeCodeViewPool, currentCodeViewPool)`.
 */
export const codeViewWorkerPool = (theme: CodeViewTheme): CodeViewPool => {
  start(theme);
  const manager = managers.get(codeViewThemeKey(theme));
  return manager === undefined || manager === pool.manager ? pool : { state: pool.state, manager };
};

export const currentCodeViewPool = (): CodeViewPool => pool;

/**
 * Release the page's highlighter after unmounting its code views, while its
 * DOM still exists. Embedded hosts and tests may close a page without ending
 * the JS process. The next page can create fresh pools; the old pools'
 * initialization and errors cannot change their successors' state.
 */
export const disposeCodeViewPool = (): void => {
  pool = OFF;
  terminateAll();
};

export const subscribeCodeViewPool = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
