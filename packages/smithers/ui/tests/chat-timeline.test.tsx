import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTimeline, timelineKey, timelineLabel, type ChatTimelineEntry } from "../src/chat/ChatTimeline";
import { chatTimelineCss } from "@smthrs/ui-css";

test("timeline keys are bounded and leave other keys to the host", () => {
  for (const key of ["ArrowDown", "j"]) { expect(timelineKey(key, 1, 3)).toBe(2); expect(timelineKey(key, 2, 3)).toBe(2); }
  for (const key of ["ArrowUp", "k"]) { expect(timelineKey(key, 1, 3)).toBe(0); expect(timelineKey(key, 0, 3)).toBe(0); }
  expect(timelineKey("Home", 2, 3)).toBe(0);
  expect(timelineKey("End", 0, 3)).toBe(2);
  expect(timelineKey("Enter", 0, 3)).toBeUndefined();
  expect(timelineKey("Home", 0, 0)).toBeUndefined();
});
test("pending rows use recorded state, never a copied first line", () => {
  const entry = { id: "a", kind: "answer" as const, state: "done" as const };
  expect(timelineLabel(entry)).toBe("Reply completed");
  expect(timelineLabel({ ...entry, kind: "ask" })).toBe("Question sent");
  expect(timelineLabel({ ...entry, kind: "ask", state: "queued" })).toBe("Queued");
  for (const [state, label] of [["working", "Working"], ["waiting", "Needs you"], ["failed", "Couldn't answer"], ["queued", "Waiting"]] as const) expect(timelineLabel({ ...entry, state })).toBe(label);
  expect(timelineLabel({ ...entry, summary: "Inspect both retry attempts" })).toBe("Inspect both retry attempts");
  const html = renderToStaticMarkup(<ChatTimeline entries={[entry, { ...entry, id: "b", summary: "Inspect both retry attempts" }]} />);
  expect(html).toContain('aria-label="Conversation timeline"');
  expect(html).toContain('aria-controls="a"');
  expect(html).toContain('data-summary="pending"');
  expect(html).toContain('data-summary="ready"');
});

test("keyboard movement focuses and jumps; Escape returns to the entry", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const jumps: string[] = [];
  const entries = ["first", "last"].map(id => ({ id, kind: "ask" as const, state: "done" as const }));
  try {
    await act(async () => root.render(<><div id="first">First entry</div><div id="last">Last entry</div><ChatTimeline entries={entries} onJump={id => { jumps.push(id); }} /></>));
    const buttons = host.querySelectorAll("button");
    await act(async () => buttons[0]!.click());
    expect(jumps).toEqual(["first"]);
    await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[1]);
    expect(jumps).toEqual(["first", "last"]);
    await act(async () => buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement?.id).toBe("first");
    await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(jumps).toEqual(["first", "last", "first"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});


test("fallback labels match the rendered rail for every kind and state", () => {
  const states = ["done", "working", "waiting", "failed", "queued"] as const;
  const expected = {
    ask: ["Question sent", "Working", "Needs you", "Not sent", "Queued"],
    answer: ["Reply completed", "Working", "Needs you", "Couldn't answer", "Waiting"],
    tool: ["Tool completed", "Working", "Needs you", "Tool failed", "Waiting"],
    flow: ["Run completed", "Working", "Needs you", "Run failed", "Waiting"],
  } as const;
  for (const kind of ["ask", "answer", "tool", "flow"] as const) {
    const entries = states.map(state => ({ id: `${kind}-${state}`, kind, state }));
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={entries} />);
    expect([...host.querySelectorAll('ol[data-level="0"] .sui-tl-tx')].map(element => element.textContent)).toEqual([...expected[kind]]);
    expect(entries.map(timelineLabel)).toEqual([...expected[kind]]);
  }
});

test("hover and focus add detail; the disclosure starts closed", async () => {
  const { ChatTranscript } = await import("../src/chat/ChatTranscript");
  const html = renderToStaticMarkup(<ChatTranscript rail={<ChatTimeline entries={[{ id: "proof", kind: "answer", state: "done", summary: "Checked retries" }]} />} />);
  expect(html).toContain('<details class="sui-timeline-disclosure">');
  expect(html).not.toContain('<details open');
  expect(html).toContain('<summary>Timeline</summary>');
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ChatTimeline entries={[{ id: "proof", kind: "answer", state: "done", summary: "Checked retries", actor: "Reviewer", time: "19:58", duration: "4s", tokens: 240, cost: "$0.002" }]} />));
    const tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(tip.hidden).toBe(true);
    await act(async () => host.querySelector("button")!.focus());
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe("Checked retriesReviewer · 19:58 · 4s · 240 tokens · $0.002");
    await act(async () => host.querySelector("button")!.blur());
    expect(tip.hidden).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("Escape closes an open timeline and restores its control", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChatTranscript } = await import("../src/chat/ChatTranscript");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ChatTranscript rail={<ChatTimeline entries={[{ id: "escape-entry", kind: "ask", state: "done" }]} />} />));
    const disclosure = host.querySelector("details")!;
    const toggle = host.querySelector("summary")!;
    const entry = host.querySelector("nav button")!;
    expect(disclosure.open).toBe(false);
    disclosure.open = true;
    await act(async () => entry.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(disclosure.open).toBe(true);
    await act(async () => entry.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(toggle);
    await act(async () => toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(disclosure.open).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("concrete host labels render while a summary is pending, and a summary takes precedence", () => {
  for (const kind of ["ask", "answer", "tool", "flow"] as const) {
    const entry = { id: kind, kind, state: "done" as const, label: "README.md · updated" }
    expect(timelineLabel(entry)).toBe("README.md · updated")
    const html = renderToStaticMarkup(<ChatTimeline entries={[entry]} />)
    expect(html).toContain("README.md · updated")
    expect(html).toContain('data-summary="pending"')
    expect(timelineLabel({ ...entry, summary: "Release notes updated" })).toBe("Release notes updated")
  }
})

test("summary navigation retains the recorded object and outcome in its accessible name", () => {
  const entries: ChatTimelineEntry[] = [
    { id: "question", kind: "ask", state: "done", label: "Timeline check unique", summary: "Requested a short reply" },
    { id: "answer", kind: "answer", state: "done", label: "Timeline check unique · answered", summary: "Replied briefly" },
    { id: "failed", kind: "answer", state: "failed", label: "Timeline check unique · failed" },
    { id: "same", kind: "ask", state: "done", label: "Same subject", summary: "Same subject" },
    { id: "legacy", kind: "ask", state: "done", summary: "Legacy summary" },
  ];
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={entries} />);
  const buttons = host.querySelectorAll("button");
  expect(buttons[0]!.getAttribute("aria-label")).toBe("Requested a short reply · Timeline check unique");
  expect(buttons[1]!.getAttribute("aria-label")).toBe("Replied briefly · Timeline check unique · answered");
  expect(buttons[0]!.textContent).toBe("Requested a short reply");
  expect(buttons[1]!.getAttribute("aria-controls")).toBe("answer");
  expect(buttons[2]!.textContent).toBe("Timeline check unique · failed");
  expect(buttons[2]!.hasAttribute("aria-label")).toBe(false);
  for (const button of [...buttons].slice(3)) expect(button.hasAttribute("aria-label")).toBe(false);
})

test("keyboard traversal does not activate an entry's external destination", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const jumps: string[] = [];
  const activations: string[] = [];
  const entries = ["question", "todo"].map(id => ({ id, kind: "ask" as const, state: "done" as const }));
  try {
    await act(async () => root.render(<ChatTimeline entries={entries} onJump={id => jumps.push(id)} onActivate={id => activations.push(id)} />));
    const buttons = host.querySelectorAll("button");
    await act(async () => buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(jumps).toEqual(["todo"]);
    expect(activations).toEqual([]);
    expect(document.activeElement).toBe(buttons[1]);
    await act(async () => buttons[1]!.click());
    expect(activations).toEqual(["todo"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

const phased = (count: number, every: number) => ({
  entries: Array.from({ length: count }, (_, index) => ({ id: `e${index}`, kind: index % 2 === 0 ? "ask" as const : "answer" as const, state: "done" as const, label: `Entry ${index}`, time: `${index}m` })),
  phases: Array.from({ length: Math.ceil(count / every) }, (_, index) => ({ id: `p${index}`, start: `e${index * every}`, end: `e${Math.min(count, (index + 1) * every) - 1}`, title: `Phase ${index}`, summary: `What happened in ${index}.`, closed: true })),
});

test("phases are logical blocks: never counts, and hover adds their span", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const { entries, phases } = phased(100, 14);
  try {
    await act(async () => root.render(<ChatTimeline entries={entries} phases={phases} />));
    const blocks = host.querySelectorAll<HTMLButtonElement>('ol[data-level="1"] button');
    expect([...blocks].map(block => block.textContent)).toEqual(phases.map(phase => phase.title));
    expect(host.textContent).not.toMatch(/\d+ entries|Zoom level/);
    await act(async () => blocks[1]!.focus());
    expect(host.querySelector('[role="tooltip"]')!.textContent).toBe("Phase 1What happened in 1.14 messages · 14m – 27m");
    expect(blocks[1]!.getAttribute("aria-label")).toBe("Phase 1, 14 messages · 14m – 27m");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("an unwritten tail is honest: its first entry's label, pending or marked unavailable with the reason", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const { entries } = phased(100, 14);
  const phases = [{ id: "p0", start: "e0", end: "e59", title: "Research" }, { id: "p1", start: "e60", title: "", closed: false }].slice(0, 1);
  try {
    await act(async () => root.render(<ChatTimeline entries={entries} />));
    const block = () => host.querySelector<HTMLButtonElement>('ol[data-level="1"] button')!;
    expect(block().textContent).toBe("Entry 0");
    expect(block().dataset.summary).toBe("pending");
    await act(async () => root.render(<ChatTimeline entries={entries} unavailable="No summary model" />));
    expect(block().dataset.summary).toBe("unavailable");
    expect(host.querySelector<HTMLButtonElement>('ol[data-level="0"] button')!.dataset.summary).toBe("unavailable");
    await act(async () => block().focus());
    expect(host.querySelector('[role="tooltip"]')!.textContent).toContain("No summary model");
    await act(async () => root.render(<ChatTimeline entries={entries} phases={phases} unavailable="No summary model" />));
    expect(block().dataset.summary).toBe("ready");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("a third level appears only when phases outgrow the column, and each level is marked as it enters", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const small = phased(20, 4), large = phased(400, 8);
  const arcs = [{ id: "a0", start: "e0", end: "e199", title: "Early arc" }, { id: "a1", start: "e200", end: "e399", title: "Late arc" }];
  try {
    await act(async () => root.render(<ChatTimeline entries={small.entries} phases={small.phases} />));
    expect(host.querySelector("nav")!.dataset.levels).toBe("1");
    expect(host.querySelector('[data-level="1"]')).toBeNull();
    await act(async () => root.render(<ChatTimeline entries={large.entries} phases={large.phases} arcs={arcs} />));
    expect(host.querySelector("nav")!.dataset.levels).toBe("3");
    expect(host.querySelector('.sui-tl-lv[data-level="2"]')!.hasAttribute("data-entering")).toBe(true);
    expect(host.querySelector('g[data-f="2"]')!.hasAttribute("data-entering")).toBe(true);
    expect(host.querySelector('.sui-tl-lv[data-level="0"]')!.hasAttribute("data-entering")).toBe(false);
    expect([...host.querySelectorAll('ol[data-level="2"] button')].map(button => button.textContent)).toEqual(["Early arc", "Late arc"]);
    await act(async () => root.render(<ChatTimeline entries={small.entries} phases={small.phases} />));
    expect(host.querySelector('.sui-tl-lv[data-level="2"]')!.hasAttribute("data-leaving")).toBe(true);
    await act(async () => { await new Promise(done => setTimeout(done, 450)); });
    expect(host.querySelector('.sui-tl-lv[data-level="2"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("horizontal keys move between an entry and the blocks that contain it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const { entries, phases } = phased(100, 14);
  try {
    await act(async () => root.render(<ChatTimeline entries={entries} phases={phases} />));
    const detail = host.querySelectorAll<HTMLButtonElement>('ol[data-level="0"] button');
    const coarse = host.querySelectorAll<HTMLButtonElement>('ol[data-level="1"] button');
    const key = async (button: HTMLButtonElement, value: string) => {
      button.focus();
      await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
    };
    await key(detail[20]!, "ArrowLeft");
    expect(document.activeElement).toBe(coarse[1]);
    await key(coarse[1]!, "ArrowRight");
    expect(document.activeElement).toBe(detail[14]);
    await key(detail[0]!, "ArrowRight");
    expect(document.activeElement).toBe(detail[0]);
    await key(coarse[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(coarse[0]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("the stylesheet is the mock's: quiet at rest, forward on hover, no level headers, reduced motion", () => {
  for (const rule of [
    "--q-off:.85;--q-mk:30%", "--q-off:1;--q-mk:48%", ".sui-tl-mk{position:absolute;left:11px;top:0;bottom:0;width:3px", "@keyframes sui-tl-in{from{opacity:0;transform:translateX(-18px)}}",
    "font-size:10px;line-height:12px", "@media(prefers-reduced-motion:reduce)", "sui-tl-fade 120ms",
  ]) expect(chatTimelineCss).toContain(rule);
  expect(chatTimelineCss).not.toContain("content:attr(aria-label)");
});

test("labels break only between words, never with a hyphen", () => {
  expect(chatTimelineCss).toMatch(/\.sui-tl-tx\{[^}]*-webkit-hyphens:none;hyphens:none/);
});

test("the default jump reaches a mounted transcript anchor and Escape focuses it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><article id="default-timeline-entry">Recorded question</article><ChatTimeline entries={[{ id: "default-timeline-entry", kind: "ask", state: "done" }]} /></>));
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(host.querySelector("article"));
    expect(host.querySelector("article")?.tabIndex).toBe(-1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("new unsummarized messages never inherit a closed phase's ready label", async () => {
  const { entries } = phased(100, 14);
  for (const unavailable of [undefined, "No summary model"]) {
    const html = renderToStaticMarkup(<ChatTimeline entries={entries} phases={[
      { id: "research", start: "e0", end: "e59", title: "Research", closed: true },
    ]} unavailable={unavailable} />);
    const host = document.createElement("div");
    host.innerHTML = html;
    const blocks = host.querySelectorAll<HTMLElement>('ol[data-level="1"] button');
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.dataset.summary).toBe("ready");
    expect(blocks[0]!.getAttribute("aria-label")).toContain("60 messages");
    expect(blocks[1]!.textContent).toBe("Entry 60");
    expect(blocks[1]!.dataset.summary).toBe(unavailable ? "unavailable" : "pending");
  }
});

test("fifty arcs create another level and clip every outer window", () => {
  const { entries, phases } = phased(2000, 8);
  const arcs = Array.from({ length: 50 }, (_, index) => ({ id: `arc-${index}`, start: `e${index * 40}`, end: `e${index * 40 + 39}`, title: `Arc ${index}` }));
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={entries} phases={phases} arcs={arcs} />);
  expect(host.querySelector("nav")!.dataset.levels).toBe("4");
  expect(host.querySelectorAll(".sui-tl-lv").length).toBe(4);
  expect(host.querySelectorAll(".sui-tl-clip[style*=visible]").length).toBe(0);
  expect(host.querySelector('ol[data-level="3"] button')!.getAttribute("data-summary")).toBe("pending");
  const higher = [[{ id: "release", start: "e0", end: "e1999", title: "Preparing the release" }]];
  host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={entries} phases={phases} arcs={arcs} higherLevels={higher} />);
  expect(host.querySelector('ol[data-level="3"] button')!.textContent).toBe("Preparing the release");
  expect(host.querySelector('ol[data-level="3"] button')!.getAttribute("data-summary")).toBe("ready");
});

test("entry summaries stay on one quiet line", () => {
  expect(chatTimelineCss).toContain('.sui-tl-row .sui-tl-tx{position:absolute;left:22px;right:2px;top:0;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
});

test("pending messages without host labels keep the transcript's state words", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={[
    { id: "unsent", kind: "ask", state: "failed" },
    { id: "reply", kind: "answer", state: "working" },
  ]} />);
  expect([...host.querySelectorAll('ol[data-level="0"] .sui-tl-tx')].map(element => element.textContent)).toEqual(["Not sent", "Working"]);
  expect(host.querySelectorAll('ol[data-level="0"] [data-summary="pending"]').length).toBe(2);
});
