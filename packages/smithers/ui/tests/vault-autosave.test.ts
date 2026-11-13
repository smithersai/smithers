import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { autosaveStatusText, createAutosaveDoc, type AutosaveState } from "../src/vault/autosaveMachine";
import { useAutosaveDoc, type UseAutosaveDocResult } from "../src/vault/useAutosaveDoc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Manual scheduler: the test decides when debounced saves fire. */
function manualScheduler() {
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule(fn: () => void, _ms: number) {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    runAll() {
      for (const entry of queue.splice(0)) {
        if (!entry.cancelled) entry.fn();
      }
    },
    pending() {
      return queue.filter((entry) => !entry.cancelled).length;
    },
  };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createAutosaveDoc", () => {
  test("starts clean with the initial value", () => {
    const doc = createAutosaveDoc({ initialValue: "hello", save: async () => {} });
    expect(doc.getSnapshot()).toEqual({ value: "hello", state: "clean", mtimeMs: undefined, failure: undefined });
  });

  test("an edit marks dirty and the debounce fires exactly one save with the latest value", async () => {
    const scheduler = manualScheduler();
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "a",
      schedule: scheduler.schedule,
      save: async (value) => {
        saved.push(value);
        return { mtimeMs: 42 };
      },
    });

    const states: AutosaveState[] = [];
    doc.subscribe(() => states.push(doc.getSnapshot().state));
    doc.setValue("ab");
    doc.setValue("abc");
    expect(doc.getSnapshot().state).toBe("dirty");
    expect(scheduler.pending()).toBe(1);

    scheduler.runAll();
    await flushMicrotasks();

    expect(saved).toEqual(["abc"]);
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().mtimeMs).toBe(42);
    // Both setValue calls emit (the value changes even while state stays dirty).
    expect(states).toEqual(["dirty", "dirty", "saving", "saved"]);
  });

  test("echoing the current text does not dirty a clean or saved document", () => {
    const scheduler = manualScheduler();
    const doc = createAutosaveDoc({ initialValue: "same", schedule: scheduler.schedule, save: async () => {} });
    doc.setValue("same");
    expect(doc.getSnapshot().state).toBe("clean");
    expect(scheduler.pending()).toBe(0);
  });

  test("saveNow skips the debounce", async () => {
    const scheduler = manualScheduler();
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "a",
      schedule: scheduler.schedule,
      save: async (value) => {
        saved.push(value);
      },
    });
    doc.setValue("b");
    await doc.saveNow();
    expect(saved).toEqual(["b"]);
    expect(doc.getSnapshot().state).toBe("saved");
    expect(scheduler.pending()).toBe(0);
  });

  test("same-tick saveNow calls share conflict detection and one write", async () => {
    let finishConflictCheck!: () => void;
    let readCalls = 0;
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "a",
      initialMtimeMs: 100,
      readExternal: async () => {
        readCalls += 1;
        await new Promise<void>((resolve) => {
          finishConflictCheck = resolve;
        });
        return { content: "a", mtimeMs: 100 };
      },
      save: async (value) => {
        saved.push(value);
      },
    });
    doc.setValue("b");
    const first = doc.saveNow();
    const second = doc.saveNow();
    expect(readCalls).toBe(1);
    finishConflictCheck();
    await Promise.all([first, second]);
    expect(saved).toEqual(["b"]);
  });

  test("a saveNow waiter persists an edit made during an in-flight save", async () => {
    const saved: string[] = [];
    let finishFirstSave!: () => void;
    const doc = createAutosaveDoc({
      initialValue: "a",
      save: async (value) => {
        saved.push(value);
        if (saved.length === 1) {
          await new Promise<void>((resolve) => {
            finishFirstSave = resolve;
          });
        }
      },
    });
    doc.setValue("b");
    const first = doc.saveNow();
    await flushMicrotasks();
    doc.setValue("c");
    const flushLatest = doc.saveNow();

    finishFirstSave();
    await Promise.all([first, flushLatest]);
    expect(saved).toEqual(["b", "c"]);
    expect(doc.getSnapshot().state).toBe("saved");
  });

  for (const recovery of ["edit", "saveNow"] as const) {
    test(`a failed save stays idle until ${recovery}`, async () => {
      const scheduler = manualScheduler();
      const cause = new Error("disk full");
      const saved: string[] = [];
      let reads = 0;
      const doc = createAutosaveDoc({
        initialValue: "a",
        schedule: scheduler.schedule,
        readExternal: async () => { reads++; return { content: "a" }; },
        save: async (value) => {
          saved.push(value);
          if (saved.length === 1) throw cause;
        },
      });
      doc.setValue("b");
      scheduler.runAll();
      await flushMicrotasks();
      expect(doc.getSnapshot()).toMatchObject({
        value: "b", state: "dirty", failure: { code: "write-failed", cause },
      });
      expect(scheduler.pending()).toBe(0);
      scheduler.runAll();
      await flushMicrotasks();
      expect(saved).toEqual(["b"]);
      expect(reads).toBe(1);

      if (recovery === "edit") {
        doc.setValue("c");
        expect(scheduler.pending()).toBe(1);
        scheduler.runAll();
        await flushMicrotasks();
      } else {
        await doc.saveNow();
      }
      expect(saved).toEqual(["b", recovery === "edit" ? "c" : "b"]);
      expect(reads).toBe(2);
      expect(doc.getSnapshot().state).toBe("saved");
      expect(doc.getSnapshot().failure).toBeUndefined();
      expect(scheduler.pending()).toBe(0);
      doc.dispose();
    });
  }

  for (const succeeds of [false, true]) {
    test(`edits during a ${succeeds ? "successful" : "failed"} write only reschedule on success`, async () => {
      const scheduler = manualScheduler();
      const cause = new Error("offline");
      const saved: string[] = [];
      let finish!: () => void;
      const doc = createAutosaveDoc({
        initialValue: "a", schedule: scheduler.schedule,
        save: async (value) => {
          saved.push(value);
          if (saved.length === 1) {
            await new Promise<void>((resolve) => { finish = resolve; });
            if (!succeeds) throw cause;
          }
        },
      });
      doc.setValue("b");
      const saving = doc.saveNow();
      await flushMicrotasks();
      doc.setValue("c");
      finish();
      await saving;
      expect(scheduler.pending()).toBe(succeeds ? 1 : 0);
      scheduler.runAll();
      await flushMicrotasks();
      expect(saved).toEqual(succeeds ? ["b", "c"] : ["b"]);
      expect(doc.getSnapshot().value).toBe("c");
      expect(doc.getSnapshot().state).toBe(succeeds ? "saved" : "dirty");
      expect(doc.getSnapshot().failure).toEqual(succeeds ? undefined : { code: "write-failed", cause });
      doc.dispose();
    });
  }

  test("mtime conflict: a newer on-disk copy with different content refuses the save", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
      },
      readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("conflict");
    expect(saved).toEqual([]);
  });

  test("compares external content with the persisted baseline, not the unsaved edit", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
        return { mtimeMs: 300 };
      },
      readExternal: async () => ({ content: "mine", mtimeMs: 200 }),
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().mtimeMs).toBe(300);
  });

  test("detects an external edit even when it matches the current unsaved value", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
      },
      readExternal: async () => ({ content: "shared edit", mtimeMs: 200 }),
    });
    doc.setValue("shared edit");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("conflict");
    expect(saved).toEqual([]);
  });

  test("updates the persisted-content baseline after each successful save", async () => {
    const saved: string[] = [];
    let external = "mine";
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
        external = value;
      },
      readExternal: async () => ({ content: external, mtimeMs: 200 }),
    });
    doc.setValue("first");
    await doc.saveNow();
    doc.setValue("second");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(saved).toEqual(["first", "second"]);
  });

  test("a failed external read blocks the save until a safe retry", async () => {
    const saved: string[] = [];
    let readFails = true;
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
      },
      readExternal: async () => {
        if (readFails) throw new Error("stat failed");
        return { content: "mine", mtimeMs: 100 };
      },
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("conflict");
    expect(saved).toEqual([]);

    readFails = false;
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(saved).toEqual(["mine edited"]);
  });

  test("discardExternal re-baselines and force-saves the local text", async () => {
    const saved: string[] = [];
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
        return { mtimeMs: 250 };
      },
      readExternal: async () => ({ content: "someone else", mtimeMs: 200 }),
    });
    doc.setValue("mine edited");
    await doc.saveNow();
    expect(doc.getSnapshot().state).toBe("conflict");

    await doc.discardExternal();
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().value).toBe("mine edited");
    expect(saved).toEqual(["mine edited"]);
    expect(doc.getSnapshot().mtimeMs).toBe(250);
  });

  test("discardExternal waits for an in-flight save before force-saving exactly once", async () => {
    const saved: string[] = [];
    let finishFirstSave!: () => void;
    let readCalls = 0;
    const doc = createAutosaveDoc({
      initialValue: "mine",
      initialMtimeMs: 100,
      save: async (value) => {
        saved.push(value);
        if (saved.length === 1) {
          await new Promise<void>((resolve) => {
            finishFirstSave = resolve;
          });
          return { mtimeMs: 150 };
        }
        return { mtimeMs: 250 };
      },
      readExternal: async () => {
        readCalls += 1;
        return readCalls === 1 ? { content: "mine", mtimeMs: 100 } : { content: "someone else", mtimeMs: 200 };
      },
    });
    doc.setValue("mine edited");
    const firstSave = doc.saveNow();
    await flushMicrotasks();
    expect(doc.getSnapshot().state).toBe("saving");

    const discard = doc.discardExternal();
    await flushMicrotasks();
    expect(saved).toEqual(["mine edited"]);

    finishFirstSave();
    await firstSave;
    await discard;
    expect(saved).toEqual(["mine edited", "mine edited"]);
    expect(doc.getSnapshot().state).toBe("saved");
    expect(doc.getSnapshot().mtimeMs).toBe(250);
  });

  test("subscribers are notified on transitions and unsubscribe works", async () => {
    const states: AutosaveState[] = [];
    const doc = createAutosaveDoc({ initialValue: "a", save: async () => {} });
    const unsubscribe = doc.subscribe(() => states.push(doc.getSnapshot().state));
    doc.setValue("b");
    await doc.saveNow();
    unsubscribe();
    doc.setValue("c");
    expect(states).toEqual(["dirty", "saving", "saved"]);
  });

  test("dispose cancels a pending debounce", () => {
    const scheduler = manualScheduler();
    const doc = createAutosaveDoc({ initialValue: "a", schedule: scheduler.schedule, save: async () => {} });
    doc.setValue("b");
    doc.dispose();
    expect(scheduler.pending()).toBe(0);
  });

  test("dispose suppresses late conflict and save completion notifications", async () => {
    let finishRead!: () => void;
    let saveCalls = 0;
    const states: AutosaveState[] = [];
    const doc = createAutosaveDoc({
      initialValue: "a",
      initialMtimeMs: 100,
      readExternal: async () => {
        await new Promise<void>((resolve) => {
          finishRead = resolve;
        });
        return { content: "external", mtimeMs: 200 };
      },
      save: async () => {
        saveCalls += 1;
      },
    });
    doc.subscribe(() => states.push(doc.getSnapshot().state));
    doc.setValue("b");
    const saving = doc.saveNow();
    doc.dispose();
    finishRead();
    await saving;
    expect(states).toEqual(["dirty"]);
    expect(saveCalls).toBe(0);
  });
});

describe("useAutosaveDoc", () => {
  test("flushes a pending edit before a real unmount", async () => {
    let api: UseAutosaveDocResult | undefined;
    const saved: string[] = [];
    const scheduler = manualScheduler();
    function Probe() {
      api = useAutosaveDoc({
        initialValue: "before",
        schedule: scheduler.schedule,
        save: async (value) => {
          saved.push(value);
        },
      });
      return null;
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => api!.setValue("pending edit"));
    expect(scheduler.pending()).toBe(1);

    await act(async () => root.unmount());
    await flushMicrotasks();
    container.remove();

    expect(saved).toEqual(["pending edit"]);
    expect(scheduler.pending()).toBe(0);
  });
});

describe("autosaveStatusText", () => {
  test("maps states to reduced-motion-safe plain text", () => {
    expect(autosaveStatusText("clean")).toBe("");
    expect(autosaveStatusText("dirty")).toBe("Unsaved");
    expect(autosaveStatusText("saving")).toBe("Saving…");
    expect(autosaveStatusText("saved")).toBe("Saved");
    expect(autosaveStatusText("conflict")).toBe("Changed on disk");
  });
});
