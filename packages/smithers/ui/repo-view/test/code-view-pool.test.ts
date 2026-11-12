import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  codeViewWorkerPool,
  currentCodeViewPool,
  disposeCodeViewPool,
  subscribeCodeViewPool,
} from "../src/workerPool";

// Exercise the real Pierre manager, with only the browser Worker boundary
// held open. No module mock can leak into the real highlighting tests.
class HeldWorker extends EventTarget {
  static instances: HeldWorker[] = [];
  terminated = false;
  requests: unknown[] = [];
  constructor() {
    super();
    HeldWorker.instances.push(this);
  }
  postMessage(request: unknown): void {
    this.requests.push(request);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const originalWorker = globalThis.Worker;
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Worker boundary did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};
const holdWorkers = (): void => {
  disposeCodeViewPool();
  HeldWorker.instances.length = 0;
  globalThis.Worker = HeldWorker as unknown as typeof Worker;
};

afterEach(() => {
  disposeCodeViewPool();
  globalThis.Worker = originalWorker;
});

describe("code view page lifetime", () => {
  test("a no-worker render does not prevent a later browser from starting", () => {
    holdWorkers();
    globalThis.Worker = undefined as unknown as typeof Worker;
    expect(codeViewWorkerPool("github-dark").state).toBe("off");
    globalThis.Worker = HeldWorker as unknown as typeof Worker;
    expect(codeViewWorkerPool("github-dark").state).toBe("starting");
  });

  test("views share one pool until the page closes; even pending initialization is terminated", async () => {
    holdWorkers();
    const first = codeViewWorkerPool("github-dark");
    expect(codeViewWorkerPool("github-dark").manager).toBe(first.manager);
    await waitFor(() => HeldWorker.instances.length === 1);
    const worker = HeldWorker.instances[0]!;
    expect(worker.requests.length).toBeGreaterThan(0);
    expect(worker.terminated).toBe(false);
    disposeCodeViewPool();
    expect(worker.terminated).toBe(true);
    expect(currentCodeViewPool()).toEqual({ state: "off", manager: undefined });
    expect(first.manager!.getStats().totalWorkers).toBe(0);
    expect(() => disposeCodeViewPool()).not.toThrow();
    const second = codeViewWorkerPool("github-dark");
    expect(second.manager).not.toBe(first.manager);
    await waitFor(() => HeldWorker.instances.length === 2);
    expect(HeldWorker.instances[1]!.terminated).toBe(false);
  });

  test("a retired worker's late error cannot fail its successor", async () => {
    holdWorkers();
    codeViewWorkerPool("github-dark");
    await waitFor(() => HeldWorker.instances.length === 1);
    const old = HeldWorker.instances[0]!;
    disposeCodeViewPool();
    const next = codeViewWorkerPool("github-dark");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      old.dispatchEvent(new Event("error"));
      // pierre settles a failed initialization asynchronously; give it the time it takes.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(currentCodeViewPool()).toBe(next);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      error.mockRestore();
    }
  });

  test("views with different themes highlight in pools of their own themes", async () => {
    holdWorkers();
    const dark = codeViewWorkerPool("github-dark");
    const light = codeViewWorkerPool("github-light");
    // pierre paints every file in a pool with the pool's theme, so a shared pool would repaint the dark view light.
    expect(light.manager).toBeDefined();
    expect(light.manager).not.toBe(dark.manager);
    expect(codeViewWorkerPool("github-dark").manager).toBe(dark.manager);
    expect(codeViewWorkerPool("github-light").manager).toBe(light.manager);
    expect(dark.manager!.getFileRenderOptions().theme).toBe("github-dark");
    expect(light.manager!.getFileRenderOptions().theme).toBe("github-light");
    await waitFor(() => HeldWorker.instances.length === 2);
    // One failure ends the page's pools together.
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      HeldWorker.instances[1]!.dispatchEvent(new Event("error"));
      await waitFor(() => currentCodeViewPool().state === "failed");
      expect(HeldWorker.instances.map((worker) => worker.terminated)).toEqual([true, true]);
      expect(codeViewWorkerPool("github-light")).toEqual({ state: "failed", manager: undefined });
    } finally {
      warning.mockRestore();
      error.mockRestore();
    }
  });

  test("a current worker failure publishes fallback once, terminates it, and can restart on a new page", async () => {
    holdWorkers();
    codeViewWorkerPool("github-dark");
    await waitFor(() => HeldWorker.instances.length === 1);
    const states: string[] = [];
    const unsubscribe = subscribeCodeViewPool(() => states.push(currentCodeViewPool().state));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      HeldWorker.instances[0]!.dispatchEvent(new Event("error"));
      HeldWorker.instances[0]!.dispatchEvent(new Event("error"));
      await waitFor(() => states.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(states).toEqual(["failed"]);
      expect(warning).toHaveBeenCalledTimes(1);
      // pierre hands the worker's error to the pool's hook instead of logging it; the page's one warning is the report.
      expect(error).not.toHaveBeenCalled();
      expect(HeldWorker.instances[0]!.terminated).toBe(true);
      expect(codeViewWorkerPool("github-dark").state).toBe("failed");
      disposeCodeViewPool();
      expect(codeViewWorkerPool("github-dark").state).toBe("starting");
    } finally {
      unsubscribe();
      warning.mockRestore();
      error.mockRestore();
    }
  });
});
