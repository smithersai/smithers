/** @jsxImportSource react */
import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeGraph } from "../src/vault/KnowledgeGraph";
import type { VaultGraphNode } from "../src/vault/graphModel";
import type { VaultLink, VaultNoteMeta } from "../src/vault/types";

const NOTES: VaultNoteMeta[] = [
  { path: "Areas/Marketing.md", title: "Marketing", linksOut: ["People/Ada.md"] },
  { path: "People/Ada.md", title: "Ada", linksOut: ["Areas/Marketing.md", "HQ.md", "Inbox.md"] },
  { path: "HQ.md", title: "HQ", linksOut: ["People/Ada.md", "Areas/Marketing.md", "Inbox.md"] },
  { path: "Inbox.md", title: "Inbox", linksOut: ["People/Ada.md", "HQ.md"] },
];
const LINKS: VaultLink[] = [
  { source: "Areas/Marketing.md", target: "People/Ada.md" },
  { source: "People/Ada.md", target: "Areas/Marketing.md" },
  { source: "People/Ada.md", target: "HQ.md" },
  { source: "People/Ada.md", target: "Inbox.md" },
  { source: "HQ.md", target: "People/Ada.md" },
  { source: "HQ.md", target: "Areas/Marketing.md" },
  { source: "HQ.md", target: "Inbox.md" },
  { source: "Inbox.md", target: "People/Ada.md" },
  { source: "Inbox.md", target: "HQ.md" },
];
// Degrees under LINKS: Ada 5, HQ 5, Inbox 3, Marketing 2 — nobody reaches
// the hub label threshold of 6, so add two more edges for the label test.
const HUB_LINKS: VaultLink[] = [
  ...LINKS,
  { source: "Areas/Marketing.md", target: "HQ.md" },
  { source: "Areas/Marketing.md", target: "Inbox.md" },
];
// Now: Ada 6, HQ 6, Inbox 4, Marketing 4 — Ada and HQ are hubs.

describe("KnowledgeGraph (server render)", () => {
  test("renders the SVG with one circle per note and hub-only labels", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={NOTES} links={HUB_LINKS} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Vault link graph"');
    expect(html.match(/<circle/g)).toHaveLength(4);
    // Only the degree-6 hubs (Ada, HQ) get labels.
    expect(html.match(/sui-vault-graph-label/g)).toHaveLength(2);
    expect(html).toContain(">HQ</text>");
    expect(html).toContain(">Ada</text>");
    // Folder tinting is assigned via data-tint.
    expect(html).toContain("data-tint=");
    // Header tally.
    expect(html).toContain("4 notes · 11 links");
  });

  test("renders edges as lines", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={NOTES} links={LINKS} />);
    expect(html.match(/<line/g)).toHaveLength(LINKS.length);
  });

  test("first paint (pre-physics) is already spread out — nothing stacked at the origin", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={NOTES} links={HUB_LINKS} />);
    const nodeTransforms = Array.from(
      html.matchAll(/<g[^>]*class="sui-vault-graph-node"[^>]*transform="([^"]+)"/g),
      (match) => match[1],
    );
    expect(nodeTransforms).toHaveLength(NOTES.length);
    expect(nodeTransforms).not.toContain("translate(0 0)");
    expect(html).not.toContain('x1="0"');
    expect(html).not.toContain('y2="0"');
  });

  test("empty vault renders the empty state", () => {
    const html = renderToStaticMarkup(<KnowledgeGraph notes={[]} links={[]} />);
    expect(html).toContain("No graph");
    expect(html).toContain("No wikilinks found across the vault.");
    expect(html).not.toContain("<svg");
  });
});

describe("KnowledgeGraph (physics unavailable)", () => {
  test("falls back to a clickable hub list when d3-force cannot load", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const opened: string[] = [];
    try {
      await act(async () => {
        root.render(
          <KnowledgeGraph
            notes={NOTES}
            links={HUB_LINKS}
            onOpenNote={(path) => opened.push(path)}
            loadPhysics={() => Promise.reject(new Error("d3-force unavailable"))}
          />,
        );
      });
      // Let the injected physics loader reject.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const fallback = container.querySelector('[data-slot="vault-graph-fallback"]');
      expect(fallback).toBeTruthy();
      const labels = Array.from(container.querySelectorAll(".sui-vault-link-label")).map((el) => el.textContent);
      // Sorted by degree desc; Ada and HQ tie at 6 and keep notes order.
      expect(labels.slice(0, 2)).toEqual(["Ada", "HQ"]);
      const firstRow = container.querySelector<HTMLElement>('[data-slot="row-button"]');
      await act(async () => {
        firstRow!.click();
      });
      expect(opened).toEqual(["People/Ada.md"]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

/**
 * Reduced motion plus an instrumented `d3-force`: every tick burns
 * `tickCostMs` on an injected clock, so the settle budget forces a yield no matter
 * how fast the machine is. Drop the cost to drain the rest of the settle.
 */
function reducedMotionHarness(tickCostMs: number) {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  })) as typeof window.matchMedia;

  const queue: Array<() => void> = [];
  const state = { ticks: 0, stops: 0, costMs: tickCostMs, ms: 0 };
  const clock = spyOn(performance, "now").mockImplementation(() => state.ms);
  return {
    queue,
    state,
    scheduleSettle(run: () => void) {
      queue.push(run);
      return () => {
        const at = queue.indexOf(run);
        if (at >= 0) queue.splice(at, 1);
      };
    },
    async loadPhysics() {
      const d3 = await import("d3-force");
      return {
        ...d3,
        forceSimulation: ((nodes?: VaultGraphNode[]) => {
          const sim = d3.forceSimulation(nodes);
          const tick = sim.tick.bind(sim);
          const stop = sim.stop.bind(sim);
          sim.tick = (iterations?: number) => {
            state.ticks += iterations ?? 1;
            state.ms += state.costMs * (iterations ?? 1);
            return tick(iterations);
          };
          sim.stop = () => {
            state.stops += 1;
            return stop();
          };
          return sim;
        }) as typeof d3.forceSimulation,
      };
    },
    restore() {
      clock.mockRestore();
      window.matchMedia = originalMatchMedia;
    },
  };
}

const nodeTransformsOf = (root: HTMLElement) =>
  Array.from(root.querySelectorAll(".sui-vault-graph-node"), (node) => node.getAttribute("transform"));

describe("KnowledgeGraph (reduced motion)", () => {
  test("settles in yielded batches and repaints only once, when settled", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const harness = reducedMotionHarness(3);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <KnowledgeGraph
            notes={NOTES}
            links={HUB_LINKS}
            loadPhysics={harness.loadPhysics}
            scheduleSettle={harness.scheduleSettle}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const seeded = nodeTransformsOf(container);
      expect(seeded).toHaveLength(NOTES.length);

      // The effect ran one budgeted batch and yielded. Settling all 180 ticks
      // in this one continuation is what blocked the thread on real vaults.
      expect(harness.state.ticks).toBeGreaterThan(0);
      expect(harness.state.ticks).toBeLessThan(180);
      expect(harness.queue).toHaveLength(1);
      expect(harness.state.stops).toBe(1);
      // Nothing repaints mid-settle: reduced motion sees no intermediate frames.
      expect(nodeTransformsOf(container)).toEqual(seeded);

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
      });
      expect(nodeTransformsOf(container)).toEqual(seeded);
      await act(async () => {
        Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Reset")!.click();
      });
      expect(nodeTransformsOf(container)).toEqual(seeded);

      harness.state.costMs = 0;
      while (harness.queue.length > 0) {
        await act(async () => {
          harness.queue.shift()!();
        });
      }
      expect(harness.state.ticks).toBe(180);
      expect(harness.state.stops).toBe(1);
      const settled = nodeTransformsOf(container);
      expect(settled).not.toEqual(seeded);
      expect(settled.every((transform) => /^translate\(-?[\d.]+ -?[\d.]+\)$/.test(transform ?? ""))).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      harness.restore();
    }
  });

  test("unmounting mid-settle cancels the pending batches", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const harness = reducedMotionHarness(3);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <KnowledgeGraph
            notes={NOTES}
            links={HUB_LINKS}
            loadPhysics={harness.loadPhysics}
            scheduleSettle={harness.scheduleSettle}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(harness.queue).toHaveLength(1);
      const ticksAtUnmount = harness.state.ticks;

      await act(async () => root.unmount());

      expect(harness.queue).toHaveLength(0);
      expect(harness.state.ticks).toBe(ticksAtUnmount);
    } finally {
      container.remove();
      harness.restore();
    }
  });

  test("changing the graph cancels stale settlement before publishing positions", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const harness = reducedMotionHarness(2);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <KnowledgeGraph notes={NOTES} links={LINKS}
            loadPhysics={harness.loadPhysics} scheduleSettle={harness.scheduleSettle} />,
        );
      });
      expect(harness.queue).toHaveLength(1);
      const staleBatch = harness.queue[0]!;
      const replacement = NOTES.slice(0, 2);
      const replacementLinks = LINKS.slice(0, 1);
      await act(async () => {
        root.render(
          <KnowledgeGraph notes={replacement} links={replacementLinks}
            loadPhysics={harness.loadPhysics} scheduleSettle={harness.scheduleSettle} />,
        );
      });
      expect(harness.queue).toHaveLength(1);
      expect(harness.queue[0]).not.toBe(staleBatch);
      const ticksBeforeStale = harness.state.ticks;
      const seeded = nodeTransformsOf(container);
      await act(async () => staleBatch());
      expect(harness.state.ticks).toBe(ticksBeforeStale);
      expect(nodeTransformsOf(container)).toEqual(seeded);
      expect(seeded).toHaveLength(2);

      harness.state.costMs = 0;
      while (harness.queue.length > 0) {
        await act(async () => harness.queue.shift()!());
      }
      expect(nodeTransformsOf(container)).not.toEqual(seeded);
      expect(nodeTransformsOf(container)).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      harness.restore();
    }
  });

});

describe("KnowledgeGraph pass-through attributes", () => {
  test("the rendered SVG node carries the host's data-* and the zoom chrome does not", () => {
    const html = renderToStaticMarkup(
      <KnowledgeGraph
        notes={NOTES}
        links={HUB_LINKS}
        nodeProps={(node) => ({ "data-flow": "wiki.open", "data-path": node.id })}
      />,
    );
    // One per note, and never on the component's own +/−/Reset buttons.
    expect(html.match(/data-flow="wiki\.open"/g)).toHaveLength(NOTES.length);
    expect(html).toContain('data-path="People/Ada.md"');
    const zoomIn = /<button[^>]*aria-label="Zoom in"[^>]*>/.exec(html)?.[0] ?? "";
    expect(zoomIn).not.toContain("data-flow");
  });

  test("the no-physics hub rows take the host's attributes too", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <KnowledgeGraph
            notes={NOTES}
            links={HUB_LINKS}
            nodeProps={(node) => ({ "data-flow": "wiki.open", "data-path": node.id })}
            loadPhysics={() => Promise.reject(new Error("d3-force unavailable"))}
          />,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="row-button"]'));
      expect(rows.length).toBe(NOTES.length);
      expect(rows.map((row) => row.getAttribute("data-flow"))).toEqual(NOTES.map(() => "wiki.open"));
      expect(rows[0]!.getAttribute("data-path")).toBe("People/Ada.md");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
})
