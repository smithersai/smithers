/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTimeline, type ChatTimelineEntry } from "../src/chat/ChatTimeline";

test("child strip marks intersect covered endpoints and leave a navigable pending tail", () => {
  const entries: ChatTimelineEntry[] = Array.from({ length: 10 }, (_, index) => [
    { id: `q${index}`, kind: "ask" as const, state: "done" as const, summary: `Question ${index}` },
    { id: `a${index}`, kind: "answer" as const, state: "done" as const, summary: `Answer ${index}` },
    { id: `run${index}`, kind: "flow" as const, state: "done" as const, label: `Run ${index}` },
  ]).flat();
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={entries} phases={[{ id: "research", start: "q0", end: "a9", title: "Research" }]} />);
  const blocks = host.querySelectorAll('ol[data-level="1"] li');
  expect(blocks.length).toBe(2);
  const coveredMarks = blocks[0]!.querySelectorAll<HTMLElement>(".sui-tl-sm");
  expect(coveredMarks[coveredMarks.length - 1]!.dataset.end).toBe("29");
  const pending = blocks[1]!.querySelector<HTMLElement>(".sui-tl-sm")!;
  expect(pending).not.toBeNull();
  expect([pending.dataset.start, pending.dataset.end]).toEqual(["29", "30"]);
});

test("a level 0 row and an outer block both preview on hover and focus, and hide after", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const jumps: string[] = [];
  const entries: ChatTimelineEntry[] = Array.from({ length: 40 }, (_, index) => ({ id: `e${index}`, kind: index % 2 ? "answer" as const : "ask" as const, state: "done" as const, summary: `Entry ${index}`, time: "19:58" }));
  const tip = () => host.querySelector<HTMLElement>('[role="tooltip"]')!;
  try {
    await act(async () => root.render(<ChatTimeline entries={entries} onJump={id => { jumps.push(id); }} phases={[{ id: "p", start: "e0", end: "e39", title: "Research", summary: "Why." }]} />));
    for (const button of [host.querySelector<HTMLElement>('ol[data-level="1"] button')!, host.querySelector<HTMLElement>('ol[data-level="0"] button')!]) {
      await act(async () => { button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
      expect(tip().hidden).toBe(false);
      await act(async () => { button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })); });
      expect(tip().hidden).toBe(true);
      await act(async () => button.focus());
      expect(tip().hidden).toBe(false);
      await act(async () => button.blur());
      expect(tip().hidden).toBe(true);
      await act(async () => button.click());
    }
    expect(jumps).toEqual(["e0", "e0"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
