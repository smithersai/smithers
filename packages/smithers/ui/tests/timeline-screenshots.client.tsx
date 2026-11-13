/** @jsxImportSource react */
// Browser-only comparison fixture: the production rail, with the approved mock's conversation and shell.
import { createRoot } from "react-dom/client";
import { ChatTimeline, type ChatTimelineEntry, type TimelineMarker } from "../src/chat/ChatTimeline";

type Entry = { i: number; kind: string; st: string; sum: string | null; len: number };
type Phase = { g: string; x0: number; x1: number };
export function mount(element: HTMLElement, fixture: { entries: Entry[]; phases: Phase[]; arcs: { g: string; b0: number; b1: number }[]; at: number | null; open: boolean }) {
  const entries: ChatTimelineEntry[] = fixture.entries.map(entry => ({
    id: `e${entry.i}`, kind: entry.kind === "q" ? "ask" : "answer",
    state: entry.st === "needs" ? "waiting" : entry.st === "waiting" ? "queued" : entry.st as ChatTimelineEntry["state"],
    ...(entry.sum ? { summary: entry.sum } : {}), length: entry.len,
  }));
  const marker = (phase: Phase, id: string): TimelineMarker => ({ id, start: `e${phase.x0 * 2}`, end: `e${phase.x1 * 2 - 1}`, title: phase.g });
  let phases = fixture.phases.map((phase, index) => marker(phase, `p${index}`));
  let arcs = fixture.arcs.map((arc, index) => marker({ g: arc.g, x0: fixture.phases[arc.b0]!.x0, x1: fixture.phases[arc.b1 - 1]!.x1 }, `a${index}`));
  const stress = new URLSearchParams(location.hash.slice(1)).has("stress");
  if (stress) {
    const count = entries.length / 2;
    phases = Array.from({ length: count }, (_, index) => marker({ g: `Goal ${index + 1}`, x0: index, x1: index + 1 }, `phase-${index}`));
    arcs = Array.from({ length: 50 }, (_, index) => marker({ g: `Arc ${index + 1}`, x0: Math.floor(index * count / 50), x1: Math.floor((index + 1) * count / 50) }, `arc-${index}`));
  }
  element.innerHTML = "";
  createRoot(element).render(<ChatTimeline entries={entries} phases={phases} arcs={arcs} onJump={id => document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "instant" })} />);
  const viewport = document.getElementById("vp")!;
  const toggle = document.getElementById("tlbtn")!;
  toggle.addEventListener("click", () => { element.classList.toggle("sheet"); toggle.setAttribute("aria-expanded", String(element.classList.contains("sheet"))); });
  element.addEventListener("keydown", event => { if (event.key === "Escape") element.classList.remove("sheet"); });
  if (fixture.open) element.classList.add("sheet");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (fixture.at === null) viewport.scrollTop = viewport.scrollHeight;
    else {
      const first = document.getElementById(`e${fixture.at * 2}`)!, last = document.getElementById(`e${fixture.at * 2 + 1}`)!;
      viewport.scrollTop = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2 - viewport.clientHeight / 2;
    }
    document.documentElement.dataset.ready = "1";
  }));
}
