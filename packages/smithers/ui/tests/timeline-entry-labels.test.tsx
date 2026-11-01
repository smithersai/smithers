import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatTimeline } from "../src/chat/ChatTimeline";

test("pending messages keep their distinct host labels until their own summaries arrive", () => {
  const entries = [
    { id: "q1", kind: "ask" as const, state: "queued" as const, label: "Question 1…" },
    { id: "q2", kind: "ask" as const, state: "queued" as const, label: "Question 2…" },
    { id: "a1", kind: "answer" as const, state: "working" as const, label: "Answer 3…" },
    { id: "a2", kind: "answer" as const, state: "waiting" as const, label: "Answer 4…" },
  ];
  const labels = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return [...host.querySelectorAll("ol[data-level='0'] .sui-tl-tx")].map(row => row.textContent);
  };
  expect(labels(renderToStaticMarkup(<ChatTimeline entries={entries} />))).toEqual(entries.map(row => row.label));
  expect(labels(renderToStaticMarkup(<ChatTimeline entries={entries.map((row, index) => ({ ...row, state: "done" as const, summary: `Model summary ${index + 1}` }))} />)))
    .toEqual(["Model summary 1", "Model summary 2", "Model summary 3", "Model summary 4"]);
});


test("empty overrides retain state labels and do not hide a supplied placeholder", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChatTimeline entries={[
    { id: "q", kind: "ask", state: "queued", label: "" },
    { id: "a", kind: "answer", state: "working", label: "" },
    { id: "b", kind: "answer", state: "queued", label: "" },
    { id: "c", kind: "answer", state: "working", summary: "", label: "Answer 4…" },
  ]} />);
  expect([...host.querySelectorAll("ol[data-level='0'] .sui-tl-tx")].map(row => row.textContent))
    .toEqual(["Queued", "Working", "Waiting", "Answer 4…"]);
  expect(host.querySelector('[aria-controls="c"]')!.getAttribute("data-summary")).toBe("pending");
});


test("empty settled summaries expose the same unavailable cause as missing summaries", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ChatTimeline entries={[
      { id: "empty", kind: "answer", state: "done", summary: "", label: "Answer 4…" },
      { id: "missing", kind: "answer", state: "done", label: "Answer 5…" },
    ]} unavailable="Offline" />));
    const empty = host.querySelector<HTMLButtonElement>('[aria-controls="empty"]')!;
    const missing = host.querySelector('[aria-controls="missing"]')!;
    expect(empty.textContent).toBe("Answer 4…");
    expect(empty.getAttribute("data-summary")).toBe("unavailable");
    expect(missing.getAttribute("data-summary")).toBe("unavailable");
    await act(async () => empty.focus());
    expect(host.querySelector('[role="tooltip"]')!.textContent).toContain("Offline");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
