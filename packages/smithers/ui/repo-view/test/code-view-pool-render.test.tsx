/** @jsxImportSource react */
// Where views start the highlighter's pool: in an effect after a committed render, never in a render body. Only the
// browser Worker boundary is replaced; pierre's pool manager and React are real.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeFileView, currentCodeViewPool, diffsThemeForMode, disposeCodeViewPool, PierreDiffView } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A Worker that never answers, counting how many the page spawned. */
class CountedWorker extends EventTarget {
  static spawned = 0;
  constructor() {
    super();
    CountedWorker.spawned += 1;
  }
  postMessage(): void {}
  terminate(): void {}
}

const originalWorker = globalThis.Worker;
let root: Root | undefined;
let container: HTMLElement | undefined;

const hold = (): void => {
  disposeCodeViewPool();
  CountedWorker.spawned = 0;
  globalThis.Worker = CountedWorker as unknown as typeof Worker;
};

afterEach(async () => {
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  disposeCodeViewPool();
  globalThis.Worker = originalWorker;
});

const mount = async (element: ReactElement): Promise<HTMLElement> => {
  container = document.createElement("div");
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => created.render(element));
  return container;
};

const PATCH = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n";

describe("starting the pool", () => {
  test("a render that never commits starts no pool, and it highlights on the main thread", () => {
    hold();
    const markup = renderToStaticMarkup(<CodeFileView name="a.ts" contents="const a = 1" mode="dark" />);
    renderToStaticMarkup(<PierreDiffView patch={PATCH} mode="dark" />);
    expect(markup).toContain('data-highlighter="main-thread"');
    expect(currentCodeViewPool()).toEqual({ state: "off", manager: undefined });
    expect(CountedWorker.spawned).toBe(0);
  });

  test("StrictMode's doubled render and effect start the theme's pool once", async () => {
    hold();
    const el = await mount(
      <StrictMode>
        <CodeFileView name="a.ts" contents="const a = 1" mode="dark" palette="paper" />
        <CodeFileView name="b.ts" contents="const b = 2" mode="dark" palette="paper" />
      </StrictMode>,
    );
    const pool = currentCodeViewPool();
    expect(pool.state).toBe("starting");
    expect(pool.manager!.getFileRenderOptions().theme).toBe(diffsThemeForMode("dark", "paper"));
    expect([...el.querySelectorAll("[data-slot=code-view]")].map((view) => view.getAttribute("data-highlighter"))).toEqual(["worker", "worker"]);
    await act(async () => root!.render(<StrictMode><CodeFileView name="a.ts" contents="const a = 1" mode="dark" palette="paper" /></StrictMode>));
    expect(currentCodeViewPool()).toBe(pool);
  });

  test("a diff tokenizes in its theme's pool, not on the main thread", async () => {
    hold();
    await mount(<PierreDiffView patch={PATCH} mode="light" palette="paper" />);
    const pool = currentCodeViewPool();
    expect(pool.state).toBe("starting");
    expect(pool.manager!.getFileRenderOptions().theme).toBe(diffsThemeForMode("light", "paper"));
  });
});
