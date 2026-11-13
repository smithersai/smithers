/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KnowledgeGraph } from "../src/vault/KnowledgeGraph";
import type { VaultLink, VaultNoteMeta } from "../src/vault/types";

/**
 * The live half of the graph: the real `d3-force` simulation being built and
 * settled, and the zoom/pan/hover chrome that sits on top of it. The existing
 * suite covered only the server render and the `failed` physics state, so
 * everything between "the module loaded" and "the user moved the view" was
 * unexercised.
 *
 * Physics runs for real here: `loadPhysics` is left unset so the component
 * imports the `d3-force` this package already depends on. Reduced motion is
 * forced on, which is the component's own synchronous-settle branch, so the
 * simulation reaches a stable layout inside one act() instead of over animation
 * frames happy-dom does not schedule.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTES: VaultNoteMeta[] = [
  { path: "Areas/Marketing.md", title: "Marketing", linksOut: ["People/Ada.md"] },
  { path: "People/Ada.md", title: "Ada", linksOut: ["Areas/Marketing.md", "HQ.md"] },
  { path: "HQ.md", title: "HQ", linksOut: ["People/Ada.md"] },
];
const LINKS: VaultLink[] = [
  { source: "Areas/Marketing.md", target: "People/Ada.md" },
  { source: "People/Ada.md", target: "HQ.md" },
  { source: "HQ.md", target: "People/Ada.md" },
];

let container: HTMLElement | undefined;
let root: Root | undefined;
let originalMatchMedia: typeof window.matchMedia | undefined;

function forceReducedMotion(reduced = true): void {
  originalMatchMedia ??= window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia;
    originalMatchMedia = undefined;
  }
});

async function mount(onOpenNote?: (path: string) => void, reduced = true): Promise<HTMLElement> {
  forceReducedMotion(reduced);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(<KnowledgeGraph notes={NOTES} links={LINKS} onOpenNote={onOpenNote} />));
  // The physics import resolves on a microtask; the settle is synchronous.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

function transform(host: HTMLElement): string {
  return host.querySelector("svg > g")!.getAttribute("transform")!;
}

describe("KnowledgeGraph with real physics", () => {
  test("settles the simulation and keeps the graph on screen", async () => {
    const host = await mount();
    expect(host.querySelector('[data-slot="vault-graph"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="vault-graph-fallback"]')).toBeNull();
    expect(host.querySelectorAll("circle")).toHaveLength(NOTES.length);
    // d3 settled the nodes somewhere other than the seeded ring: every node
    // carries a finite position and none collapsed onto the origin.
    const positions = [...host.querySelectorAll<SVGGElement>("g.sui-vault-graph-node")].map((node) =>
      node.getAttribute("transform")
    );
    expect(positions).toHaveLength(NOTES.length);
    expect(positions.every((value) => value !== null && !value.includes("NaN"))).toBe(true);
    expect(positions).not.toContain("translate(0 0)");
  });

  test("animated physics publishes ticks and supports resetting the live layout", async () => {
    const host = await mount(undefined, false);
    const positions = () => [...host.querySelectorAll("g.sui-vault-graph-node")]
      .map((node) => node.getAttribute("transform"));
    const before = positions();
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reset")!;
    await act(async () => reset.click());
    const deadline = Date.now() + 5_000;
    while (positions().every((value, index) => value === before[index]) && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    expect(positions()).not.toEqual(before);
    expect(positions().every((value) => value !== null && !value.includes("NaN"))).toBe(true);
  });

  test("exposes labeled, focusable note buttons inside the graph group", async () => {
    const opened: string[] = [];
    const host = await mount((path) => opened.push(path));
    expect(host.querySelector("svg")!.getAttribute("role")).toBe("group");
    const nodes = [...host.querySelectorAll<SVGGElement>("g.sui-vault-graph-node")];
    expect(nodes).toHaveLength(NOTES.length);
    for (const [index, node] of nodes.entries()) {
      expect(node.getAttribute("role")).toBe("button");
      expect(node.getAttribute("tabindex")).toBe("0");
      expect(node.getAttribute("aria-label")).toBe(NOTES[index]!.title!);
      await act(async () => node.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      expect(host.querySelector(".sui-vault-graph-head")!.textContent).toContain(NOTES[index]!.path);
      const path = NOTES[index]!.path;
      const neighbours = new Set([path, ...LINKS.flatMap((link) =>
        link.source === path ? [link.target] : link.target === path ? [link.source] : [])]);
      for (const [otherIndex, otherNode] of nodes.entries()) {
        expect(otherNode.querySelector("circle")!.getAttribute("fill-opacity"))
          .toBe(neighbours.has(NOTES[otherIndex]!.path) ? "0.9" : "0.15");
      }
      for (const key of ["ArrowDown", "Enter", " "]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        await act(async () => node.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(key !== "ArrowDown");
      }
      await act(async () => node.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(host.querySelector(".sui-vault-graph-head")!.textContent).not.toContain(NOTES[index]!.path);
    }
    expect(opened).toEqual(NOTES.flatMap((note) => [note.path, note.path]));
    await act(async () => nodes[0]!.dispatchEvent(new MouseEvent("mouseover", {
      bubbles: true, relatedTarget: document.body,
    })));
    expect(host.querySelector(".sui-vault-graph-head")!.textContent).toContain(NOTES[0]!.path);
    await act(async () => nodes[0]!.querySelector("circle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(opened.at(-1)).toBe(NOTES[0]!.path);
  });

  test("keyboard activation is safe without an open callback", async () => {
    const host = await mount();
    const node = host.querySelector("g.sui-vault-graph-node")!;
    for (const key of ["Enter", " "]) {
      await act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    }
  });

  test("zoom in, zoom out and reset move the view transform and return it", async () => {
    const host = await mount();
    const at = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(transform(host)).toBe("translate(0 0) scale(1)");

    await act(async () => at("Zoom in").click());
    expect(transform(host)).toBe("translate(0 0) scale(1.25)");

    await act(async () => at("Zoom out").click());
    expect(transform(host)).toBe("translate(0 0) scale(1)");

    await act(async () => at("Zoom in").click());
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Reset")!;
    await act(async () => reset.click());
    expect(transform(host)).toBe("translate(0 0) scale(1)");
  });

  test("the wheel zooms in on scroll up and out on scroll down, inside the clamp", async () => {
    const host = await mount();
    const svg = host.querySelector("svg")!;
    const spin = async (deltaY: number) => {
      await act(async () => {
        svg.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
      });
    };
    await spin(-100);
    expect(transform(host)).toBe("translate(0 0) scale(1.1)");
    await spin(100);
    expect(transform(host)).toContain("scale(0.99");

    // Clamped, never unbounded: forty more scroll-ups stop at MAX_ZOOM (4),
    // and forty scroll-downs stop at MIN_ZOOM (0.25).
    for (let i = 0; i < 40; i += 1) await spin(-100);
    expect(transform(host)).toBe("translate(0 0) scale(4)");
    for (let i = 0; i < 40; i += 1) await spin(100);
    expect(transform(host)).toBe("translate(0 0) scale(0.25)");
  });

  test("dragging pans the view, and the pan survives the button release", async () => {
    const host = await mount();
    const svg = host.querySelector("svg")!;
    const at = (type: string, clientX: number, clientY: number) =>
      act(async () => {
        svg.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true }));
      });

    await at("mousemove", 40, 40);
    expect(transform(host)).toBe("translate(0 0) scale(1)");

    await at("mousedown", 10, 10);
    await at("mousemove", 40, 30);
    expect(transform(host)).toBe("translate(30 20) scale(1)");

    await at("mouseup", 40, 30);
    await at("mousemove", 200, 200);
    expect(transform(host)).toBe("translate(30 20) scale(1)");
  });

  test("leaving the surface ends a drag so a later move cannot resume it", async () => {
    const host = await mount();
    const svg = host.querySelector("svg")!;
    await act(async () => {
      svg.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
      svg.dispatchEvent(new MouseEvent("mousemove", { clientX: 15, clientY: 0, bubbles: true }));
    });
    expect(transform(host)).toBe("translate(15 0) scale(1)");

    // React synthesizes onMouseLeave from a bubbling mouseout whose
    // relatedTarget sits outside the element, not from the non-bubbling
    // native mouseleave.
    await act(async () => {
      svg.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, cancelable: true, relatedTarget: document.body }),
      );
    });
    await act(async () => {
      svg.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 300, bubbles: true }));
    });
    expect(transform(host)).toBe("translate(15 0) scale(1)");
  });
});
