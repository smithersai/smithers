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
    // 23 rows of 40 px fill 804 px: the rail reads 68 px as 68 / (804 / 920) of transcript.
    expect(viewport.scrollTop).toBeCloseTo(68 * 920 / 804, 5);
    box.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    expect(rail.hasAttribute("data-dragging")).toBe(false);
    expect(rail.dataset.dragStage).toBeUndefined();
    expect(rail.dataset.dragLevel).toBeUndefined();
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 70 }));
    expect(rail.dataset.dragStage).toBeUndefined();
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
    expect(inputs).toEqual([]); // reader input uses the scroller command, never a synthetic gesture
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


const minimap = (rowsHtml: string, blocksHtml = "") => {
  const host = document.createElement("div"); host.className = "sui-chat-transcript";
  host.innerHTML = `<div data-slot="message-scroller-viewport"></div><nav><div class="sui-timeline-box"><div class="sui-tl-lv" data-level="0"><div class="sui-tl-clip"><div class="sui-tl-inner"><ol>${rowsHtml}</ol><div class="sui-tl-thumb"></div><div class="sui-tl-dot"></div><div class="sui-tl-cur"></div></div></div></div>${blocksHtml}</div></nav>`;
  document.body.append(host);
  const viewport = host.firstElementChild as HTMLElement, rail = host.querySelector<HTMLElement>("nav")!, box = rail.firstElementChild as HTMLElement;
  Object.defineProperties(box, { clientHeight: { value: 300, configurable: true }, clientWidth: { value: 340 } });
  Object.defineProperty(viewport, "clientHeight", { value: 200 });
  const mount = (id: string, top: number, bottom: number) => {
    const article = document.createElement("article"); article.id = id;
    article.getBoundingClientRect = () => rect(top - viewport.scrollTop, bottom - viewport.scrollTop);
    viewport.append(article);
  };
  return { host, viewport, rail, box, mount };
};
const rowHtml = (row: number, state = "done", text = "A summary") => `<button class="sui-tl-row" data-row="${row}" data-state="${state}"><i class="sui-tl-mk"></i><i class="sui-tl-lead"></i><span class="sui-tl-tx">${text}</span></button>`;

test("each mark sits at its message's place, sized by its share, and the band matches the screen (FE-22)", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const { host, viewport, rail, box, mount } = minimap([0, 1, 2].map(row => rowHtml(row)).join(""));
  mount("m-0", 0, 40); mount("m-1", 60, 1140); mount("m-2", 1160, 1200);
  const driver = timelineDriver(rail, box);
  const style = (row: number) => box.querySelector<HTMLElement>(`[data-row="${row}"]`)!.style;
  try {
    driver.sync({ ids: ["m-0", "m-1", "m-2"], asks: [true, false, true], levels: 1, spans: [], arcs: [] });
    // 1,200 px of transcript on 300 px of rail.
    expect([style(0).top, style(0).height, style(1).top, style(1).height, style(2).top]).toEqual(["0px", "10px", "15px", "270px", "290px"]);
    expect(style(0).zIndex).toBe("3");
    expect(box.querySelector<HTMLElement>(".sui-tl-thumb")!.style.height).toBe("50px");
    viewport.scrollTop = 400; viewport.dispatchEvent(new Event("scroll")); await frame();
    expect(box.querySelector<HTMLElement>(".sui-tl-thumb")!.style.top).toBe("100px");
    expect(box.querySelector<HTMLElement>(".sui-tl-dot")!.style.top).toBe("125px");
    expect(box.querySelector<HTMLElement>(".sui-tl-clip")!.style.height).toBe("300px");
    expect(box.querySelector<HTMLElement>(".sui-tl-inner")!.style.getPropertyValue("--sui-tl-move")).toBe("0ms");
  } finally { driver.dispose(); host.remove(); }
});

test("a pushed label keeps a leader to its mark, and a label with no room waits for hover", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const long = "Long enough to wrap onto a second line of the label ".repeat(3);
  const { host, rail, box, mount } = minimap([rowHtml(0, "done", long), rowHtml(1, "failed"), rowHtml(2), rowHtml(3)].join(""));
  mount("l-0", 0, 30); mount("l-1", 30, 900); mount("l-2", 900, 906); mount("l-3", 906, 912);
  const driver = timelineDriver(rail, box);
  const row = (index: number) => box.querySelector<HTMLElement>(`[data-row="${index}"]`)!;
  try {
    driver.sync({ ids: ["l-0", "l-1", "l-2", "l-3"], asks: [], lengths: [1, 1, 1, 1], levels: 1, spans: [], arcs: [] });
    expect(row(0).querySelector<HTMLElement>(".sui-tl-tx")!.style.getPropertyValue("--sui-tl-lines")).toBe("1");
    expect(row(1).querySelector<HTMLElement>(".sui-tl-tx")!.style.top).not.toBe("0px");
    expect(row(1).querySelector(".sui-tl-lead")!.hasAttribute("data-on")).toBe(true);
    expect(row(0).querySelector(".sui-tl-lead")!.hasAttribute("data-on")).toBe(false);
    expect(row(3).dataset.label).toBe("hidden");
    expect(row(3).querySelector(".sui-tl-lead")!.hasAttribute("data-on")).toBe(false);
  } finally { driver.dispose(); host.remove(); }
});

test("unmounted history stands on its estimate, then its measure, and a drag holds the scale still", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const { timelineEstimate } = await import("../src/chat/timelineZoom");
  const { host, viewport, rail, box, mount } = minimap([0, 1, 2].map(row => rowHtml(row)).join(""));
  mount("h-1", 0, 100); mount("h-2", 120, 220);
  const driver = timelineDriver(rail, box);
  const model = { ids: ["h-0", "h-1", "h-2"], asks: [], lengths: [800, 1, 1], levels: 1, spans: [], arcs: [] };
  const top = (row: number) => parseFloat(box.querySelector<HTMLElement>(`[data-row="${row}"]`)!.style.top);
  try {
    driver.sync(model);
    const estimate = timelineEstimate(800).advance;
    expect(top(1)).toBeCloseTo(estimate * 300 / (estimate + 220));
    box.querySelector(".sui-tl-thumb")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(rail.hasAttribute("data-dragging")).toBe(true);
    const held = top(1);
    mount("h-0", -200, -180); await frame(); await frame();
    expect(top(1)).toBe(held);
    box.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await frame();
    // Measured, and kept when the message unmounts again: the estimate never comes back.
    expect(top(1)).toBeCloseTo(200 * 300 / 420);
    viewport.querySelector("#h-0")!.remove(); await frame(); await frame();
    expect(top(1)).toBeCloseTo(200 * 300 / 420);
  } finally { driver.dispose(); host.remove(); }
});

test("outer blocks and strips share the scale, and the lens covers exactly level 0's window", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const blockHtml = (index: number, start: number, end: number) => `<li class="sui-tl-blk-li" data-block="${index}"><button class="sui-tl-blk"><i class="sui-tl-sm" data-start="${start}" data-end="${end}"></i><span class="sui-tl-tx">Phase</span></button></li>`;
  const { host, rail, box, mount } = minimap([0, 1, 2, 3].map(row => rowHtml(row)).join(""),
    `<div class="sui-tl-lv" data-level="1"><div class="sui-tl-clip"><div class="sui-tl-inner"><ol>${blockHtml(0, 0, 3)}${blockHtml(1, 3, 4)}</ol><div class="sui-tl-lens" data-lens="1"></div></div></div></div>`);
  for (const row of [0, 1, 2, 3]) mount(`o-${row}`, row * 100, row * 100 + 100);
  const driver = timelineDriver(rail, box);
  const li = (index: number) => box.querySelector<HTMLElement>(`[data-block="${index}"]`)!;
  try {
    driver.sync({ ids: [0, 1, 2, 3].map(row => `o-${row}`), asks: [], levels: 2, arcs: [],
      spans: [{ id: "a", start: 0, end: 3 }, { id: "b", start: 3, end: 4 }] });
    expect(parseFloat(li(0).style.height)).toBeGreaterThan(parseFloat(li(1).style.height) * 2);
    expect(parseFloat(li(1).style.top) + parseFloat(li(1).style.height)).toBeCloseTo(300);
    expect(li(0).querySelector<HTMLElement>(".sui-tl-sm")!.style.top).toBe("0px");
    expect(li(0).querySelector<HTMLElement>(".sui-tl-tx")!.style.getPropertyValue("--sui-tl-lines")).toBe(String(Math.floor(parseFloat(li(0).style.height) / 12)));
    const lens = box.querySelector<HTMLElement>("[data-lens]")!;
    expect(lens.style.top).toBe("0px");
    expect(parseFloat(lens.style.height)).toBeCloseTo(300);
    expect(li(0).querySelector(".sui-tl-sm")!.hasAttribute("data-in")).toBe(true);
    driver.sync({ ids: [0, 1, 2, 3].map(row => `o-${row}`), asks: [], levels: 2, arcs: [], spans: [{ id: "a", start: 0, end: 4 }] });
    expect(parseFloat(li(0).style.height)).toBeCloseTo(300);
  } finally { driver.dispose(); host.remove(); }
});


test("render after resize refreshes computed block geometry while retaining its window", async () => {
  const { timelineDriver } = await import("../src/chat/timelineDriver");
  const blockHtml = (index: number) => `<li class="sui-tl-blk-li" data-block="${index}"><button class="sui-tl-blk"><i class="sui-tl-sm" data-start="${index * 2}" data-end="${index * 2 + 2}"></i></button></li>`;
  const { host, rail, box, mount } = minimap(Array.from({ length: 80 }, (_, i) => rowHtml(i)).join(""),
    `<div class="sui-tl-lv" data-level="1"><div class="sui-tl-clip"><div class="sui-tl-inner"><ol>${Array.from({ length: 40 }, (_, i) => blockHtml(i)).join("")}</ol><div data-lens="1"></div></div></div></div>`);
  let height = 704;
  Object.defineProperty(box, "clientHeight", { get: () => height });
  for (let i = 0; i < 80; i++) mount(`resize-${i}`, i * 100, i * 100 + 100);
  const model = { ids: Array.from({ length: 80 }, (_, i) => `resize-${i}`), asks: [], levels: 2, arcs: [],
    spans: Array.from({ length: 40 }, (_, i) => ({ id: `phase-${i}`, start: i * 2, end: i * 2 + 2 })) };
  const driver = timelineDriver(rail, box);
  const clip = box.querySelector<HTMLElement>("[data-level='1'] .sui-tl-clip")!;
  const block = box.querySelector<HTMLElement>("[data-block='0']")!;
  try {
    driver.sync(model);
    height = 544; window.dispatchEvent(new Event("resize")); await frame();
    const start = clip.dataset.windowStart, expectedHeight = block.style.height;
    // A React commit can replace DOM geometry after ResizeObserver has recorded the new dimensions.
    block.style.height = "748px"; clip.style.height = "748px";
    driver.sync(model);
    expect(block.style.height).toBe(expectedHeight);
    expect(clip.dataset.windowStart).toBe(start);
    expect(rail.dataset.layoutHeight).toBe("544");
    expect(parseFloat(clip.style.height)).toBeLessThanOrEqual(544);
    const lens = box.querySelector<HTMLElement>("[data-lens]")!;
    expect(parseFloat(lens.style.top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(lens.style.top) + parseFloat(lens.style.height)).toBeLessThanOrEqual(parseFloat(clip.style.height));
  } finally { driver.dispose(); host.remove(); }
});
