import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
try { GlobalRegistrator.register(); } catch { /* the package preload already registered */ }

test("lens navigation requests unmounted history and restores its fractional reading position after mount", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div");
  host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"><div id="history-mount"></div></div><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="1"><div class="sui-tl-inner"><i class="sui-tl-sm" data-start="10" data-end="11"></i><div class="sui-tl-lens" data-lens="1"></div></div></div></div></nav>`;
  document.body.append(host);
  const viewport = host.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!;
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  const rail = host.querySelector<HTMLElement>("nav")!, box = host.querySelector<HTMLElement>(".sui-timeline-box")!;
  const recent = document.createElement("article");
  recent.id = "history-150";
  host.querySelector("#history-mount")!.append(recent);
  const jumps: string[] = [];
  const driver = timelineDriver(rail, box);
  try {
    driver.sync({ ids: Array.from({ length: 200 }, (_, index) => `history-${index}`), asks: [], levels: 2,
      spans: [], arcs: [], onRequestHistory: id => { jumps.push(id); } });
    const lens = box.querySelector<HTMLElement>("[data-lens]")!;
    lens.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: 0 }));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 0.5 }));
    expect(jumps).toEqual(["history-10"]);
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 0.5 }));
    expect(jumps).toEqual(["history-10"]);
    expect(rail.dataset.navigation).toBe("pending");
    const message = document.createElement("article");
    message.id = "history-10";
    message.getBoundingClientRect = () => ({ top: 500, bottom: 700, height: 200, left: 0, right: 100, width: 100, x: 0, y: 500, toJSON: () => ({}) });
    host.querySelector("#history-mount")!.append(message);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(viewport.scrollTop).toBe(550);
    expect(rail.dataset.navigation).toBeUndefined();
    box.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  } finally { driver.dispose(); host.remove(); }
});

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });

test("a newer drag request supersedes an earlier mount and disposal stops pending restoration", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="1"><div class="sui-tl-inner"><i class="sui-tl-sm" data-start="10" data-end="11"></i><i class="sui-tl-sm" data-start="20" data-end="21"></i><div data-lens="1"></div></div></div></div></nav>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  Object.defineProperty(box.querySelectorAll("i")[1], "offsetTop", { value: 10 });
  const jumps: string[] = [], driver = timelineDriver(rail, box);
  const move = (y: number) => box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: y }));
  const mount = (index: number, top: number) => {
    const article = document.createElement("article"); article.id = `race-${index}`;
    article.getBoundingClientRect = () => rect(top, top + 200); viewport.append(article);
  };
  try {
    driver.sync({ ids: Array.from({ length: 30 }, (_, index) => `race-${index}`), asks: [], levels: 2, spans: [], arcs: [], onRequestHistory: id => { jumps.push(id); } });
    box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    move(.5); move(10.5);
    expect(jumps).toEqual(["race-10", "race-20"]);
    mount(10, 500); await frame();
    expect(viewport.scrollTop).toBe(0);
    expect(rail.dataset.navigation).toBe("pending");
    mount(20, 800); await frame();
    expect(viewport.scrollTop).toBe(850);
    move(.5); driver.dispose();
    const before = viewport.scrollTop;
    mount(29, 2000); await frame();
    expect(viewport.scrollTop).toBe(before);
  } finally { driver.dispose(); host.remove(); }
});

test("thumb dragging preserves its top-edge position and resize rebuilds its visible window", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="0"><div class="sui-tl-clip"><div class="sui-tl-inner"><button class="sui-tl-row" data-row="0"></button><div class="sui-tl-thumb"></div><div class="sui-tl-dot"></div><div class="sui-tl-cur"></div></div></div></div></div></nav>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  let height = 804;
  Object.defineProperties(box, { clientHeight: { get: () => height }, clientWidth: { value: 342 } });
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  const ids = Array.from({ length: 100 }, (_, index) => `thumb-${index}`);
  for (const [index, id] of ids.entries()) {
    const article = document.createElement("article"); article.id = id;
    article.getBoundingClientRect = () => rect(index * 40 - viewport.scrollTop, (index + 1) * 40 - viewport.scrollTop);
    viewport.append(article);
  }
  const driver = timelineDriver(rail, box);
  try {
    driver.sync({ ids, asks: [], levels: 2, spans: [], arcs: [] });
    box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); // ordinary rail background does not drag
    expect(rail.hasAttribute("data-dragging")).toBe(false);
    box.querySelector(".sui-tl-dot")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 68 }));
    expect(viewport.scrollTop).toBe(80);
    box.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    expect(rail.hasAttribute("data-dragging")).toBe(false);
    viewport.scrollTop = 2000; viewport.dispatchEvent(new Event("scroll")); await frame();
    expect(box.querySelector('[data-row="0"]')!.hasAttribute("data-in")).toBe(false);
    height = 544; window.dispatchEvent(new Event("resize")); await frame();
    const clip = box.querySelector<HTMLElement>(".sui-tl-clip")!;
    expect(parseFloat(clip.style.height)).toBeLessThanOrEqual(544);
    height = 804; window.dispatchEvent(new Event("resize")); await frame();
    expect(parseFloat(clip.style.height)).toBeGreaterThan(544);
    expect(parseFloat(clip.style.height)).toBeLessThanOrEqual(804);
  } finally { driver.dispose(); host.remove(); }
});

test("history restoration follows the requested ID when entries are inserted before it", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="1"><div class="sui-tl-inner"><i class="sui-tl-sm" data-start="10" data-end="11"></i><div data-lens="1"></div></div></div></div></nav>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  const ids = Array.from({ length: 30 }, (_, index) => `insert-${index}`), requests: string[] = [];
  const driver = timelineDriver(rail, box);
  const model = { ids, asks: [], levels: 2, spans: [], arcs: [], onRequestHistory: (id: string) => { requests.push(id); } };
  const mount = (id: string, top: number) => { const article = document.createElement("article"); article.id = id; article.getBoundingClientRect = () => rect(top, top + 200); viewport.append(article); };
  try {
    driver.sync(model);
    box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: .5 }));
    expect(requests).toEqual(["insert-10"]);
    driver.sync({ ...model, ids: ["inserted", ...ids] });
    mount("insert-9", 200); await frame();
    expect(rail.dataset.navigation).toBe("pending");
    expect(viewport.scrollTop).toBe(0);
    mount("insert-10", 500); await frame();
    expect(viewport.scrollTop).toBe(550);
    expect(rail.dataset.navigation).toBeUndefined();
  } finally { driver.dispose(); host.remove(); }
});
