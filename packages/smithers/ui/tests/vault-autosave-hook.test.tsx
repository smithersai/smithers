/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AutosaveState } from "../src/vault/autosaveMachine";
import { useAutosaveDoc, type UseAutosaveDocResult } from "../src/vault/useAutosaveDoc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

/** One commit's worth of what the hook told React to render. */
type Observed = { state: AutosaveState; statusText: string };

/**
 * Poll a predicate across React commits instead of waiting a fixed duration.
 *
 * Each iteration yields to the real event loop (so a real debounce timer and
 * the save's own microtasks can run) and then lets `act` flush React, which is
 * what re-reads the hook's snapshot: an async `act` body never sees its own
 * renders, so the flush has to be the loop rather than something inside it.
 * The deadline is a hang guard, not a wait -- the loop returns on the commit
 * that satisfies the predicate, so nothing here is timed. Exceeding it throws
 * rather than falling through, so a stall names the transition it was waiting
 * for instead of surfacing as whichever assertion happened to read next. Every
 * caller runs under a test timeout longer than this ceiling, so the throw is
 * what a hung transition reports.
 */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
}

/**
 * Append a commit to the observed history, collapsing a repeat of the state
 * already at the tail (React may render the same snapshot twice; StrictMode
 * always does). The history is what the assertions read: sampling `api` names
 * an instant, and with a REAL debounce every instant after an `await` races
 * the timer, whereas a transition React has already committed cannot be lost.
 */
function record(history: Array<Observed>, next: Observed): void {
  const last = history[history.length - 1];
  if (last && last.state === next.state && last.statusText === next.statusText) return;
  history.push(next);
}

describe("useAutosaveDoc", () => {
  // The one test that injects no `schedule`, so the machine's own setTimeout
  // is what moves it. Nothing here advances or fakes a clock; the assertions
  // read the sequence of commits React made, never the state at a chosen
  // instant, so a runner slow enough to let the 5ms debounce fire early
  // changes when the transitions land but not which ones did.
  test("drives the state machine from React with the real (default) timer", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    const observed: Array<Observed> = [];
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "hello",
        debounceMs: 5,
        save: async (value) => {
          saved.push(value);
          return { mtimeMs: 42 };
        },
      });
      record(observed, { state: api.state, statusText: api.statusText });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Wait for the mount commit rather than assuming this `act` flushed it.
    // Nothing else can emit yet, so there is no transition to miss by waiting.
    await act(async () => {
      root!.render(<Probe />);
    });
    await waitFor("the probe's first commit", () => observed.length > 0);
    expect(observed).toEqual([{ state: "clean", statusText: "" }]);

    // The edit's commit is NOT waited for, because waiting could lose it:
    // React coalesces emits that land before one flush, so a "dirty" left
    // unflushed until after the debounce would arrive already collapsed into
    // "saved". It does not need waiting for. `act` flushes in the microtask
    // that resolves its callback, and a setTimeout callback cannot run between
    // two microtasks however loaded the runner, so the debounce cannot beat
    // this commit -- unlike `api.state` sampled after the await, which is
    // whatever the debounce has since made it and is what this test used to
    // assert on.
    await act(async () => {
      api!.setValue("hello world");
    });
    expect(observed.slice(0, 2)).toEqual([
      { state: "clean", statusText: "" },
      { state: "dirty", statusText: "Unsaved" },
    ]);

    // Nothing here forces the save: reaching "saved" proves the default
    // scheduler is live, since no `schedule` was injected. Wait on the
    // transition itself rather than on `saved.length`, which the writer pushes
    // before the machine has emitted anything.
    await waitFor('the default debounce to reach "saved"', () => api!.state === "saved");
    expect(saved).toEqual(["hello world"]);
    expect(observed[observed.length - 1]).toEqual({ state: "saved", statusText: "Saved" });
    // "saving" is the one commit React may coalesce away, when the save
    // resolves before the flush; every other commit is pinned, in order.
    expect(observed.map((commit) => commit.state).filter((state) => state !== "saving")).toEqual([
      "clean",
      "dirty",
      "saved",
    ]);
    expect(api!.mtimeMs).toBe(42);
  }, 30_000);

  test("exposes conflict state and discardExternal", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "mine",
        initialMtimeMs: 100,
        save: async (value) => {
          saved.push(value);
          return { mtimeMs: 250 };
        },
        readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
    await act(async () => {
      api!.setValue("mine edited");
    });
    await act(async () => {
      await api!.saveNow();
    });
    expect(api!.state).toBe("conflict");
    expect(api!.statusText).toBe("Changed on disk");
    expect(saved).toEqual([]);

    await act(async () => {
      await api!.discardExternal();
    });
    expect(api!.state).toBe("saved");
    expect(saved).toEqual(["mine edited"]);
  });

  test("survives StrictMode effect replay without losing a pending save", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "hello",
        debounceMs: 5,
        save: async (value) => {
          saved.push(value);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
    });
    await act(async () => {
      api!.setValue("strict edit");
    });
    await waitFor("the StrictMode-replayed debounce to write once", () => saved.length > 0);

    expect(api!.value).toBe("strict edit");
    expect(saved).toEqual(["strict edit"]);
  }, 30_000);

  test("uses a readExternal callback supplied after mount", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe({ checkExternal }: { checkExternal: boolean }) {
      api = useAutosaveDoc({
        initialValue: "mine",
        initialMtimeMs: 100,
        save: async (value) => {
          saved.push(value);
        },
        readExternal: checkExternal ? async () => ({ content: "changed elsewhere", mtimeMs: 200 }) : undefined,
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe checkExternal={false} />);
    });
    await act(async () => {
      api!.setValue("mine edited");
      root!.render(<Probe checkExternal />);
    });
    await act(async () => {
      await api!.saveNow();
    });

    expect(api!.state).toBe("conflict");
    expect(saved).toEqual([]);
  });

  test("recreates the machine when resetKey switches documents, flushing the outgoing draft", async () => {
    let api: UseAutosaveDocResult | undefined;
    const savedA: string[] = [];
    const savedB: string[] = [];
    function Probe({ documentId, initialValue }: { documentId: "a" | "b"; initialValue: string }) {
      api = useAutosaveDoc({
        resetKey: documentId,
        initialValue,
        debounceMs: 60_000,
        save: async (value) => {
          (documentId === "a" ? savedA : savedB).push(value);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<Probe documentId="a" initialValue="document A" />));
    await act(async () => api!.setValue("document A draft"));
    await act(async () => root!.render(<Probe documentId="b" initialValue="document B" />));

    expect(api!.value).toBe("document B");
    // The outgoing machine held an unsaved draft well inside its 60s debounce.
    // Switching documents writes it, exactly as unmounting does; dropping it
    // would be silent data loss on every document switch.
    expect(savedA).toEqual(["document A draft"]);
    await act(async () => api!.saveNow());
    expect(savedB).toEqual(["document B"]);
  });

  test("a rapid a-to-b-to-c switch flushes every draft it passes through", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: Array<string> = [];
    function Probe({ documentId }: { documentId: "a" | "b" | "c" }) {
      api = useAutosaveDoc({
        resetKey: documentId,
        initialValue: `document ${documentId}`,
        debounceMs: 60_000,
        save: async (value) => {
          saved.push(`${documentId}:${value}`);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<Probe documentId="a" />));
    await act(async () => api!.setValue("draft a"));
    await act(async () => root!.render(<Probe documentId="b" />));
    await act(async () => api!.setValue("draft b"));
    await act(async () => root!.render(<Probe documentId="c" />));

    expect(saved).toEqual(["a:draft a", "b:draft b"]);
    expect(api!.value).toBe("document c");
  });

  test("switching documents under StrictMode still flushes exactly one draft", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    function Probe({ documentId }: { documentId: "a" | "b" }) {
      api = useAutosaveDoc({
        resetKey: documentId,
        initialValue: `document ${documentId}`,
        debounceMs: 60_000,
        save: async (value) => {
          saved.push(value);
        },
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <StrictMode>
          <Probe documentId="a" />
        </StrictMode>,
      )
    );
    await act(async () => api!.setValue("strict draft"));
    await act(async () =>
      root!.render(
        <StrictMode>
          <Probe documentId="b" />
        </StrictMode>,
      )
    );

    expect(saved).toEqual(["strict draft"]);
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function scheduler() {
  const pending = new Set<() => void>();
  return {
    pending,
    schedule(fn: () => void) { pending.add(fn); return () => { pending.delete(fn); }; },
    run() { const batch = [...pending]; pending.clear(); for (const fn of batch) fn(); },
  };
}

describe("retired autosave drafts", () => {
  for (const exit of ["switch", "unmount"] as const) {
    for (const state of ["dirty", "saving", "conflict", "read-failed", "write-failed", "commit-conflict"] as const) {
      test(`${exit} retains and recovers a ${state} draft`, async () => {
        const key = `${exit}:${state}`;
        const timer = scheduler();
        const flight = deferred();
        const cause = new Error(state);
        let mode: string = state;
        let disk = "original a";
        let api!: UseAutosaveDocResult;
        let saving: Promise<void> | undefined;
        let writes = 0;
        function Probe({ id }: { id: string }) {
          api = useAutosaveDoc({
            resetKey: id,
            initialValue: id === key ? disk : "original b",
            initialMtimeMs: 1,
            schedule: timer.schedule,
            readExternal: async () => {
              if (id !== key) return { content: "original b", mtimeMs: 1 };
              if (mode === "read-failed") throw cause;
              return { content: mode === "conflict" ? "external edit" : disk, mtimeMs: 1 };
            },
            save: async (value, expected) => {
              writes++;
              expect(expected).toEqual({ content: disk, mtimeMs: 1 });
              if (id !== key) throw new Error("outgoing draft used the next document's writer");
              if (mode === "saving") await flight.promise;
              if (mode === "commit-conflict") return { status: "conflict", cause };
              if (mode === "dirty" || mode === "write-failed") throw cause;
              disk = value;
              return { mtimeMs: 2 };
            },
          });
          return null;
        }
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => root!.render(<Probe id={key} />));
        await act(async () => api.setValue("retained draft"));
        if (state === "saving") {
          await act(async () => { saving = api.saveNow(); });
          expect(api.state).toBe("saving");
          await act(async () => api.setValue("latest retained draft"));
        } else if (state !== "dirty") {
          await act(async () => api.saveNow());
        }
        if (exit === "switch") {
          await act(async () => root!.render(<Probe id={`${key}:b`} />));
        } else {
          await act(async () => root!.unmount());
          root = undefined;
        }
        if (state === "saving") {
          await act(async () => { flight.reject(cause); await saving; });
        }
        expect(timer.pending.size).toBe(0);
        if (state === "write-failed" || state === "saving") expect(writes).toBe(1);
        if (exit === "unmount") root = createRoot(container);
        await act(async () => root!.render(<Probe id={key} />));
        expect(api.value).toBe(state === "saving" ? "latest retained draft" : "retained draft");
        expect(disk).toBe("original a");
        if (state === "commit-conflict") expect(api.failure).toEqual({ code: "conflict", cause });
        if (state === "read-failed") expect(api.failure).toEqual({ code: "read-failed", cause });
        if (state === "dirty" || state === "write-failed" || state === "saving") {
          expect(api.failure).toEqual({ code: "write-failed", cause });
        }
        mode = "healthy";
        await act(async () => {
          if (state === "conflict") await api.discardExternal();
          else await api.saveNow();
        });
        expect(disk).toBe(state === "saving" ? "latest retained draft" : "retained draft");
        expect(api.state).toBe("saved");
        expect(api.failure).toBeUndefined();
      });
    }
  }

  test("exposes the original write failure through the hook", async () => {
    let api!: UseAutosaveDocResult;
    const cause = new Error("disk full");
    let fails = true;
    function Probe() {
      api = useAutosaveDoc({ initialValue: "initial", schedule: () => () => {},
        save: async () => { if (fails) throw cause; } });
      return null;
    }
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Probe />));
    await act(async () => { api.setValue("draft"); await api.saveNow(); });
    expect(api.failure).toEqual({ code: "write-failed", cause });
    fails = false;
    await act(async () => api.saveNow());
    expect(api.failure).toBeUndefined();
  });
});

for (const exit of ["switch", "unmount"] as const) {
  test(`${exit} pauses a failed write until the draft is reopened and saved`, async () => {
    const timer = scheduler();
    let disk = "original";
    let calls = 0;
    let reads = 0;
    let api!: UseAutosaveDocResult;
    const cause = new Error("offline");
    function Probe({ id }: { id: string }) {
      api = useAutosaveDoc({
        resetKey: id, initialValue: disk, schedule: timer.schedule,
        readExternal: async () => { reads++; return { content: disk }; },
        save: async (value) => {
          if (++calls === 1) throw cause;
          disk = value;
        },
      });
      return null;
    }
    container = document.createElement("div");
    root = createRoot(container);
    const key = `paused:${exit}`;
    await act(async () => root!.render(<Probe id={key} />));
    await act(async () => api.setValue("retained draft"));
    await act(async () => {
      if (exit === "switch") root!.render(<Probe id={`${key}:b`} />);
      else { root!.unmount(); root = undefined; }
    });
    expect(timer.pending.size).toBe(0);
    await act(async () => timer.run());
    expect(disk).toBe("original");
    expect(calls).toBe(1);
    expect(reads).toBe(1);
    if (!root) root = createRoot(container);
    await act(async () => root!.render(<Probe id={key} />));
    expect(api.value).toBe("retained draft");
    expect(api.failure).toEqual({ code: "write-failed", cause });
    expect(calls).toBe(1);
    await act(async () => api.saveNow());
    expect(disk).toBe("retained draft");
    expect(api.state).toBe("saved");
    expect(calls).toBe(2);
  });
}

for (const exit of ["switch", "unmount"] as const) {
  test(`${exit} finishes a deferred write and persists edits made during it`, async () => {
    const timer = scheduler();
    const flight = deferred();
    const writes: string[] = [];
    let api!: UseAutosaveDocResult;
    let saving!: Promise<void>;
    const key = `deferred-success:${exit}`;
    function Probe({ id }: { id: string }) {
      api = useAutosaveDoc({ resetKey: id, initialValue: "original", schedule: timer.schedule,
        save: async (value) => {
          expect(id).toBe(key);
          if (writes.length === 0) await flight.promise;
          writes.push(value);
        } });
      return null;
    }
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Probe id={key} />));
    await act(async () => { api.setValue("first draft"); saving = api.saveNow(); });
    await act(async () => api.setValue("latest draft"));
    await act(async () => {
      if (exit === "switch") root!.render(<Probe id={`${key}:b`} />);
      else { root!.unmount(); root = undefined; }
    });
    await act(async () => { flight.resolve(); await saving; });
    expect(writes).toEqual(["first draft", "latest draft"]);
    expect(timer.pending.size).toBe(0);
  });
}

test("stable owners isolate identical document keys and recover after remount", async () => {
  const owners = [{}, {}];
  const writes: string[][] = [[], []];
  let fails = true;
  let api!: UseAutosaveDocResult;
  function Probe({ vault }: { vault: number }) {
    api = useAutosaveDoc({ owner: owners[vault], resetKey: "same path", initialValue: `vault ${vault}`,
      schedule: () => () => {}, save: async (value) => {
        if (fails) throw new Error("offline");
        writes[vault]!.push(value);
      } });
    return null;
  }
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(<Probe vault={0} />));
  await act(async () => api.setValue("draft 0"));
  await act(async () => root!.render(<Probe vault={1} />));
  expect(api.value).toBe("vault 1");
  await act(async () => api.setValue("draft 1"));
  await act(async () => root!.unmount());
  root = createRoot(container);
  await act(async () => root!.render(<Probe vault={0} />));
  expect(api.value).toBe("draft 0");
  fails = false;
  await act(async () => api.saveNow());
  await act(async () => root!.render(<Probe vault={1} />));
  expect(api.value).toBe("draft 1");
  await act(async () => api.saveNow());
  expect(writes).toEqual([["draft 0"], ["draft 1"]]);
});

test("server renders do not share document state between requests", async () => {
  const { renderToString } = await import("react-dom/server");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")!;
  function Probe({ initialValue }: { initialValue: string }) {
    return useAutosaveDoc({ resetKey: "server document", initialValue, save: async () => {} }).value;
  }
  // Simulate the server without disturbing the test DOM outside this render.
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  try {
    expect(renderToString(<Probe initialValue="first request" />)).toBe("first request");
    expect(renderToString(<Probe initialValue="second request" />)).toBe("second request");
  } finally {
    Object.defineProperty(globalThis, "window", descriptor);
  }
});
