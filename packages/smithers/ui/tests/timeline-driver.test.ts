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
      spans: [], arcs: [], onJump: id => { jumps.push(id); } });
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
