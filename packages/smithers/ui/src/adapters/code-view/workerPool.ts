/**
 * The highlighter's worker pool (apps/app/docs/code-intel/PLAN.md §1 "Where
 * the work runs"). Shiki's JavaScript regex engine compiles a grammar inside
 * the first synchronous tokenize: measured at 2.6 s for a 16 KiB TypeScript
 * file under JavaScriptCore (the native shell's WebKit) and ~300 ms once
 * warm, both past the 300 ms law. So tokenizing runs in pierre's worker
 * pool wherever a Worker exists, and the main thread only paints the result.
 *
 * One pool per page, one worker in it (files render one at a time and every
 * worker loads Shiki and the grammars), created on the first code view and
 * kept for the page's life. pierre renders every file in a pool with the
 * POOL's theme (FileRenderer.getLocalHighlightTheme), so the pool follows
 * the house theme through `setRenderOptions` whenever a view's theme
 * differs from the pool's; pierre re-renders the mounted files itself.
 *
 * The pool is a promise the page keeps, not a fact. A worker that never
 * answers `initialize` (a shell that cannot load a module worker) would
 * leave pierre waiting for a highlight forever, so the pool is probed: an
 * `error` event on the worker, or no initialization inside the deadline,
 * marks it failed, the views remount pierre without it, and highlighting
 * runs on the main thread as before. Views read the pool through
 * `useSyncExternalStore`; nothing here is component state.
 */
import type { DiffsThemeNames, ThemesType } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import type { WorkerPoolManager } from "@pierre/diffs/worker";

export type CodeViewPoolState = "off" | "starting" | "ready" | "failed";

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
let started = false;
let themeKey = "";
let generation = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;
let probeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const clearProbes = (): void => {
  clearTimeout(deadline);
  clearTimeout(probeTimer);
  deadline = undefined;
  probeTimer = undefined;
};

const publish = (next: CodeViewPool): void => {
  pool = next;
  for (const listener of listeners) listener();
};

const keyOf = (theme: CodeViewTheme): string => (typeof theme === "string" ? theme : `${theme.dark}/${theme.light}`);

const bunRuntime = (): boolean => typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * pierre's worker entry. Under Vite the `new Worker(new URL(...))` literal
 * is what the bundler looks for: it bundles the worker and rewrites the URL
 * to the built asset, served from the app's own origin like every other
 * chunk. Under Bun (the tests) the same module is a file on disk that
 * `import.meta.resolve` names, run by Bun's own Worker.
 */
const spawnWorker = (): Worker => {
  if (bunRuntime()) {
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

const fail = (reason: string): void => {
  if (pool.state === "failed") return;
  clearProbes();
  console.warn(`code view: highlighting stays on the main thread — ${reason}`);
  try {
    terminateWorkerPoolSingleton();
  } catch {
    // A pool that never came up has nothing to terminate.
  }
  publish({ state: "failed", manager: undefined });
};

/** Start the pool once per page; the first caller's theme is the pool's. Publishes nothing: the caller is mid-render. */
const start = (theme: CodeViewTheme): void => {
  if (started) return;
  if (typeof Worker !== "function" || typeof document === "undefined") return;
  started = true;
  const currentGeneration = generation;
  let manager: WorkerPoolManager;
  try {
    manager = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        poolSize: 1,
        workerFactory: () => {
          const worker = spawnWorker();
          worker.addEventListener("error", (event) => {
            if (generation === currentGeneration) fail(`its worker failed (${(event as ErrorEvent).message || "error"})`);
          });
          return worker;
        },
      },
      highlighterOptions: { theme, useTokenTransformer: true, preferredHighlighter: "shiki-js" },
    });
  } catch (error) {
    fail(`it could not be created (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  themeKey = keyOf(theme);
  pool = { state: "starting", manager };
  deadline = setTimeout(() => {
    if (pool.manager === manager && pool.state === "starting") fail(`its worker did not initialize within ${CODE_VIEW_POOL_DEADLINE_MS / 1000} s`);
  }, CODE_VIEW_POOL_DEADLINE_MS);
  (deadline as { unref?: () => void }).unref?.();
  const probe = (): void => {
    if (pool.manager !== manager) return;
    if (manager.isInitialized()) {
      clearProbes();
      publish({ state: "ready", manager });
    } else if (!manager.isWorkingPool()) {
      clearProbes();
      fail("its worker failed to initialize");
    } else {
      probeTimer = setTimeout(probe, 50);
      (probeTimer as { unref?: () => void }).unref?.();
    }
  };
  probeTimer = setTimeout(probe, 0);
  (probeTimer as { unref?: () => void }).unref?.();
};

/**
 * The pool for a view rendering with `theme`: started on first use, and told
 * the theme when it differs from the pool's (idempotent; pierre versions the
 * request). Call it from the render body, then read the live state through
 * `useSyncExternalStore(subscribeCodeViewPool, currentCodeViewPool)`.
 */
export const codeViewWorkerPool = (theme: CodeViewTheme): CodeViewPool => {
  start(theme);
  if (pool.manager !== undefined && keyOf(theme) !== themeKey) {
    const manager = pool.manager;
    themeKey = keyOf(theme);
    void manager.setRenderOptions({ theme, useTokenTransformer: true }).catch((error: unknown) => {
      if (pool.manager === manager) fail(`it could not take the theme (${error instanceof Error ? error.message : String(error)})`);
    });
  }
  return pool;
};

export const currentCodeViewPool = (): CodeViewPool => pool;

/**
 * Release the page's highlighter after unmounting its code views, while its
 * DOM still exists. Embedded hosts and tests may close a page without ending
 * the JS process. The next page can create a fresh pool; old worker errors,
 * probes and theme requests cannot change that successor's state.
 */
export const disposeCodeViewPool = (): void => {
  generation += 1;
  clearProbes();
  const hadManager = pool.manager !== undefined;
  pool = OFF;
  started = false;
  themeKey = "";
  if (hadManager) terminateWorkerPoolSingleton();
};

export const subscribeCodeViewPool = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
