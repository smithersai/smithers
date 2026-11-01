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
    message.getBoundingClientRect = () => rect(500 - viewport.scrollTop, 700 - viewport.scrollTop);
    host.querySelector("#history-mount")!.append(message);
    await frame(); await frame();
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
    article.getBoundingClientRect = () => rect(top - viewport.scrollTop, top + 200 - viewport.scrollTop); viewport.append(article);
  };
  try {
    driver.sync({ ids: Array.from({ length: 30 }, (_, index) => `race-${index}`), asks: [], levels: 2, spans: [], arcs: [], onRequestHistory: id => { jumps.push(id); } });
    box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    move(.5); move(10.5);
    expect(jumps).toEqual(["race-10", "race-20"]);
    mount(10, 500); await frame();
    expect(viewport.scrollTop).toBe(0);
    expect(rail.dataset.navigation).toBe("pending");
    mount(20, 800); await frame(); await frame();
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
  const mount = (id: string, top: number) => { const article = document.createElement("article"); article.id = id; article.getBoundingClientRect = () => rect(top - viewport.scrollTop, top + 200 - viewport.scrollTop); viewport.append(article); };
  try {
    driver.sync(model);
    box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: .5 }));
    expect(requests).toEqual(["insert-10"]);
    driver.sync({ ...model, ids: ["inserted", ...ids] });
    mount("insert-9", 200); await frame();
    expect(rail.dataset.navigation).toBe("pending");
    expect(viewport.scrollTop).toBe(0);
    mount("insert-10", 500); await frame(); await frame();
    expect(viewport.scrollTop).toBe(550);
    expect(rail.dataset.navigation).toBeUndefined();
  } finally { driver.dispose(); host.remove(); }
});

test("a completed history read follows later layout changes until the reader scrolls", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="1"><div class="sui-tl-inner"><i class="sui-tl-sm" data-start="10" data-end="11"></i><div data-lens="1"></div></div></div></div></nav>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  const driver = timelineDriver(rail, box);
  try {
    driver.sync({ ids: Array.from({ length: 30 }, (_, index) => `stable-${index}`), asks: [], levels: 2, spans: [], arcs: [], onRequestHistory: () => {} });
    box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: .5 }));
    let shift = 0;
    const message = document.createElement("article"); message.id = "stable-10";
    message.getBoundingClientRect = () => rect(500 + shift - viewport.scrollTop, 700 + shift - viewport.scrollTop);
    viewport.append(message); await frame(); await frame();
    expect(viewport.scrollTop).toBe(550);
    shift = 8; window.dispatchEvent(new Event("resize")); await frame();
    expect(viewport.scrollTop).toBe(558);
    rail.dispatchEvent(new WheelEvent("wheel", { deltaY: 42, cancelable: true }));
    expect(viewport.scrollTop).toBe(600);
    viewport.dispatchEvent(new Event("scroll"));
    shift = 16; window.dispatchEvent(new Event("resize")); await frame();
    expect(viewport.scrollTop).toBe(600);
  } finally { driver.dispose(); host.remove(); }
});

test("external navigation cancels an unmounted history request before it can snap back", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><button class="bottom">Bottom</button><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="1"><div class="sui-tl-inner"><i class="sui-tl-sm" data-start="10" data-end="11"></i><div data-lens="1"></div></div></div></div></nav>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  const driver = timelineDriver(rail, box);
  try {
    driver.sync({ ids: Array.from({ length: 30 }, (_, index) => `cancel-${index}`), asks: [], levels: 2, spans: [], arcs: [], onRequestHistory: () => {} });
    const request = () => {
      box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: .5 }));
      expect(rail.dataset.navigation).toBe("pending");
    };
    request();
    viewport.scrollTop = 200; viewport.dispatchEvent(new Event("scroll"));
    expect(rail.dataset.navigation).toBeUndefined();
    request();
    host.querySelector<HTMLButtonElement>(".bottom")!.click();
    expect(rail.dataset.navigation).toBeUndefined();
    request();
    rail.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, cancelable: true }));
    expect(viewport.scrollTop).toBe(160);
    expect(rail.dataset.navigation).toBeUndefined();
    const message = document.createElement("article"); message.id = "cancel-10";
    message.getBoundingClientRect = () => rect(500 - viewport.scrollTop, 700 - viewport.scrollTop);
    viewport.append(message); await frame(); await frame();
    expect(viewport.scrollTop).toBe(160);
    box.querySelector("[data-lens]")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: .5 }));
    expect(viewport.scrollTop).toBe(550);
    driver.sync({ ids: [], asks: [], levels: 0, spans: [], arcs: [] });
    viewport.scrollTop = 300;
    driver.sync({ ids: Array.from({ length: 30 }, (_, index) => `cancel-${index}`), asks: [], levels: 2, spans: [], arcs: [] });
    await frame();
    expect(viewport.scrollTop).toBe(300);
  } finally { driver.dispose(); host.remove(); }
});

test("wheel over the rail scrolls the transcript and its in-view marks follow", async () => {
  const { host, viewport, box, ids, driver } = await wheelFixture();
  try {
    driver.sync({ ids, asks: [], levels: 1, spans: [], arcs: [] });
    expect(box.querySelector('[data-row="0"]')!.getAttribute("aria-current")).toBe("location");
    const event = new WheelEvent("wheel", { deltaY: 600, bubbles: true, cancelable: true });
    box.querySelector("button")!.dispatchEvent(event);
    expect(viewport.scrollTop).toBe(600);
    expect(event.defaultPrevented).toBe(true);
    // happy-dom has no layout-driven scroll events; deliver the browser's subsequent scroll notification.
    viewport.dispatchEvent(new Event("scroll")); await frame();
    expect(box.querySelector('[data-row="0"]')!.hasAttribute("data-in")).toBe(false);
    expect(box.querySelector('[data-row="15"]')!.getAttribute("aria-current")).toBe("location");
    expect(box.querySelector('[data-row="15"]')!.hasAttribute("data-in")).toBe(true);
  } finally { driver.dispose(); host.remove(); }
});

/** DOM geometry supplied explicitly because happy-dom does not lay out message boxes. */
const wheelFixture = async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><details class="sui-timeline-disclosure" open><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="0"><div class="sui-tl-clip"><div class="sui-tl-inner"></div></div></div></div></nav></details>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  Object.defineProperty(viewport, "clientHeight", { value: 100 });
  Object.defineProperties(box, { clientHeight: { value: 400 }, clientWidth: { value: 180 } });
  const ids = Array.from({ length: 30 }, (_, index) => `wheel-${index}`);
  for (const [index, id] of ids.entries()) {
    const article = document.createElement("article"); article.id = id;
    article.getBoundingClientRect = () => rect(index * 40 - viewport.scrollTop, (index + 1) * 40 - viewport.scrollTop);
    viewport.append(article);
    const button = document.createElement("button"); button.className = "sui-tl-row"; button.dataset.row = String(index);
    box.querySelector(".sui-tl-inner")!.append(button);
  }
  const driver = timelineDriver(rail, box);
  return { host, viewport, rail, box, ids, driver };
};

for (const [mode, delta, lineHeight, distance] of [
  [0, .5, "24px", .5],
  [0, -80, "24px", -80],
  [1, 3, "24px", 72],
  [1, -2, "normal", -32],
  [2, 2, "24px", 200],
] as const) test(`rail wheel normalizes mode ${mode}, delta ${delta}, line height ${lineHeight}`, async () => {
  const { host, viewport, rail, ids, driver } = await wheelFixture();
  try {
    viewport.style.lineHeight = lineHeight;
    driver.sync({ ids, asks: [], levels: 1, spans: [], arcs: [] });
    viewport.scrollTop = 400;
    const inputs: number[] = [];
    viewport.addEventListener("wheel", event => { inputs.push(event.deltaY); });
    const event = new WheelEvent("wheel", { deltaY: delta, deltaMode: mode, cancelable: true, bubbles: true });
    rail.dispatchEvent(event);
    expect(viewport.scrollTop).toBe(400 + distance);
    expect(inputs).toEqual([delta]); // the transcript receives its usual input before the forwarded scroll
    expect(event.defaultPrevented).toBe(true);
    expect(rail.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
  } finally { driver.dispose(); host.remove(); }
});

test("rail wheel leaves horizontal input alone, and detaches on disposal", async () => {
  const { host, viewport, rail, ids, driver } = await wheelFixture();
  try {
    driver.sync({ ids, asks: [], levels: 1, spans: [], arcs: [] });
    viewport.scrollTop = 400;
    const inputs: number[] = [];
    viewport.addEventListener("wheel", event => { inputs.push(event.deltaY); });
    {
      const event = new WheelEvent("wheel", { deltaX: 600, deltaY: 0, bubbles: true, cancelable: true });
      rail.dispatchEvent(event);
      expect(viewport.scrollTop).toBe(400);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(inputs).toEqual([]);
    driver.dispose();
    const event = new WheelEvent("wheel", { deltaY: 600, bubbles: true, cancelable: true });
    rail.dispatchEvent(event);
    expect(viewport.scrollTop).toBe(400);
    expect(event.defaultPrevented).toBe(false);
  } finally { driver.dispose(); host.remove(); }
});

test("rail wheel without a transcript viewport leaves the browser gesture alone", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const rail = document.createElement("nav"), box = document.createElement("div");
  rail.append(box); document.body.append(rail);
  const driver = timelineDriver(rail, box);
  try {
    driver.sync({ ids: [], asks: [], levels: 0, spans: [], arcs: [] });
    const event = new WheelEvent("wheel", { deltaY: 600, bubbles: true, cancelable: true });
    rail.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  } finally { driver.dispose(); rail.remove(); }
});
