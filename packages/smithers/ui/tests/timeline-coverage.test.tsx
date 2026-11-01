/** @jsxImportSource react */
import { expect, test } from "bun:test";
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
