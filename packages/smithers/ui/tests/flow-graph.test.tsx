/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FlowGraph } from "../src/flow-graph/FlowGraph";
import { JournalScrubber, journalPosition } from "../src/flow-graph/JournalScrubber";
import { StepInspector } from "../src/flow-graph/StepInspector";
import { fitGraph, graphLayout, graphNeighbour, type GraphNode } from "../src/flow-graph/graphLayout";
import { RunWaterfall } from "../src/run-page/RunWaterfall";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; container?.remove(); });
const render = async (element: React.ReactNode) => {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(() => root!.render(element));
};
const all = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const get = (selector: string) => container.querySelector<HTMLElement>(selector)!;
const click = (selector: string) => act(() => get(selector).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const key = (selector: string, key: string) => act(() => get(selector).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const nodes: GraphNode[] = [
  { id: "a", label: "Load", state: "done" }, { id: "b", label: "Run", kind: "agent", state: "current" },
  { id: "c", label: "Check", state: "failed" }, { id: "d", label: "Wait", state: "waiting" },
  { id: "e", label: "A very long queued step name", state: "next" },
];
const edges = [{ from: "a", to: "b", kind: "value" as const, label: "input" }, { from: "a", to: "c", kind: "failure" as const }, { from: "b", to: "d", kind: "continuation" as const }, { from: "d", to: "e" }];
test("a cancelled step is Stopped in the graph and inspector, with a fixed duration", async () => {
  await render(<FlowGraph nodes={[{ id: "stopped", label: "Await", state: "cancelled" }]} edges={[]} />);
  expect(get('[data-node="stopped"]').getAttribute("aria-label")).toBe("Await, Stopped");
  await render(<StepInspector step={{ id: "stopped", label: "Await", kind: "Step", state: "cancelled", startedAtMs: 1000, endedAtMs: 2000, depth: 0, attempts: 1, failedAttempts: 0 }} logs={[]} attempts={[]} input={null} output={null} wait={null} now={100000} />);
  expect(container.textContent).toContain("Stopped");
  expect(container.textContent).toContain("1.0 s");
});
test("layout preserves dependencies, branching, parent means and stable non-overlapping ranks", () => {
  const g = graphLayout(nodes, edges);
  expect(g.ranks).toEqual([["a"], ["b", "c"], ["d"], ["e"]]);
  const p = new Map(g.nodes.map((n) => [n.id, n]));
  expect(p.get("b")!.x).toBeGreaterThan(p.get("a")!.x);
  expect(p.get("c")!.y - p.get("b")!.y).toBeGreaterThanOrEqual(96);
  expect(p.get("d")!.y).toBe(p.get("b")!.y);
  expect(graphLayout(nodes, edges)).toEqual(g);
  const tb = graphLayout(nodes, edges, "TB");
  expect(tb.nodes[1]!.y).toBeGreaterThan(tb.nodes[0]!.y);
  expect(fitGraph(nodes, edges, 300, 800).direction).toBe("TB");
  expect(fitGraph(nodes, edges, 1600, 200).direction).toBe("LR");
  expect(graphLayout([], []).nodes).toEqual([]);
  expect(graphLayout([{ id: "a" }, { id: "a" }, { id: "b" }], [{ from: "a", to: "a" }, { from: "missing", to: "a" }, { from: "a", to: "b" }, { from: "a", to: "b" }]).nodes).toHaveLength(2);
  expect(graphLayout(nodes, [{ from: "a", to: "b" }, { from: "b", to: "a" }]).nodes).toHaveLength(5);
  const crossed = [{ from: "b", to: "d" }, { from: "a", to: "e" }, { from: "e", to: "c" }];
  expect(graphLayout(nodes, crossed).ranks[1]).toEqual(["e", "d"]);
  expect(graphNeighbour(nodes, edges, "a", true)).toBe("b");
  expect(graphNeighbour(nodes, edges, "b", false)).toBe("a");
  expect(graphNeighbour(nodes, [], "e", true)).toBe("e");
  expect(graphNeighbour(nodes, [], "a", false)).toBe("a");
  expect(graphNeighbour(nodes, [{ from: "a", to: "absent" }], "a", true)).toBe("b");
  expect(graphNeighbour([], [], null, false)).toBeUndefined();
});
test("graph shows every state, typed edges, selection and inspector keyboard actions", async () => {
  const selected: string[] = [], inspected: string[] = [];
  await render(<FlowGraph nodes={nodes} edges={[...edges, { from: "absent", to: "a" }]} selected="b" onSelect={(id) => selected.push(id)} onInspect={(id) => inspected.push(id)} />);
  expect(all("[data-node]")).toHaveLength(5);
  expect(get('[data-node="c"]').getAttribute("aria-label")).toBe("Check, Failed");
  expect(get('[data-edge-kind="failure"]')).toBeDefined();
  await click('[data-node="a"]');
  await key('[data-node="b"]', "Enter");
  await key('[data-node="b"]', " ");
  await key('svg', "ArrowLeft");
  await key('svg', "ArrowDown");
  await key('svg', "i");
  await key('svg', "Enter");
  await key('svg', "x");
  await key('[data-node="a"]', "x");
  await act(() => get('[data-node="a"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(selected).toEqual(["a", "b", "b", "a", "c"]);
  expect(inspected).toEqual(["b", "b", "b", "b", "a"]);
  await click('[aria-label="Zoom in"]'); await click('[aria-label="Zoom out"]');
  await act(() => all("button").find((b) => b.textContent === "Fit")!.click());
  await render(<FlowGraph nodes={nodes} edges={edges} />);
  await key('svg', "Enter"); await key('svg', "ArrowRight"); await key('[data-node="a"]', "Enter"); await click('[data-node="a"]');
  await act(() => get('[data-node="a"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await act(() => get('svg').dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 })));
  await act(() => get('[data-node="a"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await act(() => get('svg').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 })));
  await act(() => get('svg').dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 20, clientY: 30 })));
  await act(() => get('svg').dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
  await act(() => get('svg').dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  await render(<FlowGraph nodes={[]} edges={[]} />); await key('svg', "ArrowLeft");
});
const ticks = [1, 3, 7].map((seq, i) => ({ seq, emittedAtMs: seq * 100, eventType: i === 1 ? "flows.engine.node-settled" : "other" }));
test("scrubber walks sparse sequences, step boundaries and live without mutating history", async () => {
  expect(journalPosition(ticks, null, -1)).toBe(3);
  expect(journalPosition(ticks, 1, 1)).toBe(3);
  expect(journalPosition(ticks, 7, 1)).toBe(7);
  expect(journalPosition(ticks, null, -1, true)).toBe(3);
  expect(journalPosition(ticks, 1, -1)).toBe(1);
  expect(journalPosition([], null, -1)).toBe(0);
  expect(journalPosition(ticks, 1, 1, true)).toBe(3);
  const positions: (number | null)[] = [];
  await render(<JournalScrubber events={ticks} at={null} onChange={(at) => positions.push(at)} />);
  expect(get("output").textContent).toBe("Live");
  await click('[aria-label="Previous event"]'); await click('[aria-label="Next event"]');
  await act(() => all("button").find((b) => b.textContent === "Live")!.click());
  expect(positions).toEqual([3, 7, null]);
  await render(<JournalScrubber events={ticks} at={3} onChange={(at) => positions.push(at)} />);
  expect(get("input").getAttribute("value")).toBe("2");
  expect(get("output").textContent).toBe("#3");
  await act(() => { (get("input") as HTMLInputElement).value = "1"; get("input").dispatchEvent(new InputEvent("input", { bubbles: true })); });
  await act(() => { (get("input") as HTMLInputElement).value = "0"; get("input").dispatchEvent(new InputEvent("input", { bubbles: true })); });
  expect(positions.slice(-2)).toEqual([1, 0]);
  await render(<JournalScrubber events={[]} at={null} onChange={() => {}} />);
  expect((get("input") as HTMLInputElement).disabled).toBe(true);
});
const value = { text: '{"ok":true}', bytes: 11, clipped: false };
const step = { id: "a", label: "Load", kind: "action", state: "completed" as const, startedAtMs: 100, endedAtMs: 300, depth: 1, attempts: 2, failedAttempts: 1 };
test("inspector shows values as text, logs, timing, attempts and waits", async () => {
  await render(<StepInspector step={step} input={value} output={value} logs={[value]} attempts={[{ attempt: 1, state: "failed", error: "unavailable", startedAtMs: 100, finishedAtMs: 200 }, { attempt: 2, state: "running", error: null, startedAtMs: 200, finishedAtMs: null }]} now={400} wait={{ kind: "human", sinceMs: 100, wakeAtMs: null }} actions={<button>Open</button>} />);
  expect(get('[data-slot="step-inspector"]').textContent).toContain("200 ms");
  for (const tab of ["Input", "Logs", "Attempts", "Output"]) {
    await act(() => all('[role="tab"]').find((t) => t.textContent!.startsWith(tab))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    await key(`[role="tab"][data-state="active"]`, "ArrowRight");
  }
  await render(<StepInspector step={{ ...step, state: "pending" }} input={null} output={null} logs={[]} attempts={[]} now={400} />);
  expect(get('.sui-step-inspector-time').textContent).toContain("0 ms");
  expect(get('[data-slot="span-detail"]').textContent).toContain("Queued");
});
test("waterfall accepts attempt segments, waits, children and replay cursor without changing existing callers", async () => {
  await render(<RunWaterfall steps={[step]} now={400} cursorMs={200} segments={[{ stepId: "a", startedAtMs: 100, endedAtMs: 150, state: "failed" }, { stepId: "a", startedAtMs: 160, endedAtMs: null, state: "waiting" }, { stepId: "other", startedAtMs: 0, endedAtMs: null, state: "running" }]} />);
  expect(all(".sui-waterfall-segment")).toHaveLength(2);
  expect(get(".sui-waterfall-cursor").style.left).toBe("50%");
  expect(get(".sui-waterfall-label").style.paddingInlineStart).toBe("12px");
  await render(<RunWaterfall steps={[step]} now={400} />);
  expect(all(".sui-waterfall-segment")).toHaveLength(0);
});
