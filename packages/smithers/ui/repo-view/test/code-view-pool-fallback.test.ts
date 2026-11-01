// How the highlighter's pool gives up and leaves highlighting on the main thread: a worker that never answers
// `initialize` before pierre's deadline, and a page whose policy refuses to create workers. And where a browser's
// worker comes from. Only the Worker boundary is replaced; pierre's pool manager is real.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  CODE_VIEW_POOL_DEADLINE_MS,
  codeViewWorkerPool,
  currentCodeViewPool,
  disposeCodeViewPool,
  spawnWorker,
} from "../src/workerPool";

/** A Worker that records what it was started with and never answers. */
class SilentWorker extends EventTarget {
  static started: Array<{ readonly url: unknown; readonly options: unknown }> = [];
  constructor(url: unknown, options: unknown) {
    super();
    SilentWorker.started.push({ url, options });
  }
  postMessage(): void {}
  terminate(): void {}
}

const originalWorker = globalThis.Worker;
const until = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("the pool did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

afterEach(() => {
  disposeCodeViewPool();
  globalThis.Worker = originalWorker;
  SilentWorker.started.length = 0;
});

/**
 * Holds pierre's initialization deadline for the test to fire; every other timer runs as usual. pierre arms the
 * deadline once it has loaded the theme, so a test waits for it.
 */
const holdDeadline = () => {
  const realSetTimeout = globalThis.setTimeout;
  const deadlines: Array<() => void> = [];
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms?: number, ...rest: Array<unknown>) => {
    if (ms === CODE_VIEW_POOL_DEADLINE_MS) {
      deadlines.push(run);
      return deadlines.length as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(run, ms, ...rest);
  }) as unknown as typeof setTimeout);
  return { deadlines, restore: () => schedule.mockRestore() };
};

describe("the pool's deadline", () => {
  test("a worker that never initializes hands highlighting back to the main thread at the deadline", async () => {
    globalThis.Worker = SilentWorker as unknown as typeof Worker;
    const timers = holdDeadline();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    // pierre logs its own timed-out initialization too.
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(codeViewWorkerPool("github-dark").state).toBe("starting");
      await until(() => timers.deadlines.length === 1);
      expect(currentCodeViewPool().state).toBe("starting");
      timers.deadlines[0]!();
      await until(() => currentCodeViewPool().state === "failed");
      expect(currentCodeViewPool()).toEqual({ state: "failed", manager: undefined });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^code view: highlighting stays on the main thread — its worker failed to initialize \\(.*${CODE_VIEW_POOL_DEADLINE_MS}ms\\)$`),
        ),
      );
    } finally {
      timers.restore();
      warning.mockRestore();
      error.mockRestore();
    }
  });

  test("a deadline that fires after the page closed changes nothing", async () => {
    globalThis.Worker = SilentWorker as unknown as typeof Worker;
    const timers = holdDeadline();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      codeViewWorkerPool("github-dark");
      await until(() => timers.deadlines.length === 1);
      disposeCodeViewPool();
      timers.deadlines[0]!();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(currentCodeViewPool().state).toBe("off");
      expect(warning).not.toHaveBeenCalled();
    } finally {
      timers.restore();
      warning.mockRestore();
    }
  });
});

describe("a page that refuses workers", () => {
  test("a Worker constructor that throws leaves highlighting on the main thread", async () => {
    globalThis.Worker = class {
      constructor() {
        throw new DOMException("worker-src 'none'", "SecurityError");
      }
    } as unknown as typeof Worker;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(codeViewWorkerPool("github-dark").state).toBe("starting");
      await until(() => currentCodeViewPool().state === "failed");
      expect(currentCodeViewPool().manager).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        "code view: highlighting stays on the main thread — its worker failed to initialize (worker-src 'none')",
      );
    } finally {
      warning.mockRestore();
      error.mockRestore();
    }
  });
});

describe("a browser's worker", () => {
  test("outside Bun the worker is pierre's entry as a module URL, which the app's bundler rewrites", () => {
    globalThis.Worker = SilentWorker as unknown as typeof Worker;
    expect(spawnWorker(false)).toBeInstanceOf(SilentWorker);
    const [{ url, options }] = SilentWorker.started;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).href.endsWith("/@pierre/diffs/worker/worker.js")).toBe(true);
    expect(options).toEqual({ type: "module" });
  });
});
