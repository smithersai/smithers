import { useLayoutEffect, type RefObject } from "react";
import { toastClearance } from "./toastClearance";

/**
 * Keep an anchored overlay in free space below page chrome. Observers follow
 * wrapping, newly mounted plugin controls, fonts and scroll without moving the page.
 */
export function useToastClearance(section: RefObject<HTMLElement | null>, avoid: string | undefined, present: boolean) {
  useLayoutEffect(() => {
    const stack = section.current;
    if (!present || stack === null || avoid === undefined) return;
    let offset = 0;
    let frame: number | undefined;
    const watched = new Set<Element>();
    const update = () => {
      const box = stack.getBoundingClientRect();
      const targets = [...document.querySelectorAll<HTMLElement>(avoid)].filter(element => !stack.contains(element));
      const next = new Set<Element>([document.body, stack, stack.parentElement ?? document.body, ...stack.children, ...targets]);
      for (const element of watched) if (!next.has(element)) { resize.unobserve(element); watched.delete(element); }
      for (const element of next) if (!watched.has(element)) { resize.observe(element); watched.add(element); }
      const faces = [...stack.children].map(element => element.getBoundingClientRect());
      const left = Math.min(...faces.map(rect => rect.left));
      const right = Math.max(...faces.map(rect => rect.right));
      const obstacles = targets.flatMap(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < right && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(element).visibility !== "hidden" ? [rect] : [];
      });
      const naturalTop = box.top - offset;
      const height = stack.scrollHeight;
      const clear = toastClearance(naturalTop, height, innerHeight, obstacles);
      offset = clear.top - naturalTop;
      const top = `${offset}px`, room = `${clear.maxHeight}px`;
      const overflow = clear.maxHeight < height ? "auto" : "visible";
      const pointer = clear.maxHeight < height ? "auto" : "none";
      if (stack.style.getPropertyValue("--sui-toast-clearance") !== top) stack.style.setProperty("--sui-toast-clearance", top);
      if (stack.style.getPropertyValue("--sui-toast-room") !== room) stack.style.setProperty("--sui-toast-room", room);
      if (stack.style.getPropertyValue("--sui-toast-overflow") !== overflow) stack.style.setProperty("--sui-toast-overflow", overflow);
      if (stack.style.getPropertyValue("--sui-toast-pointer") !== pointer) stack.style.setProperty("--sui-toast-pointer", pointer);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; update(); });
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.target !== stack || record.attributeName !== "style")) schedule();
    });
    const attributes = ["class", "style", "hidden", "open", "id", "role", "disabled", ...[...avoid.matchAll(/\[\s*([\w-]+)/g)].map(match => match[1]!)];
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: attributes });
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    update();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      stack.style.removeProperty("--sui-toast-clearance");
      stack.style.removeProperty("--sui-toast-room");
      stack.style.removeProperty("--sui-toast-overflow");
      stack.style.removeProperty("--sui-toast-pointer");
    };
  }, [avoid, present, section]);
}
