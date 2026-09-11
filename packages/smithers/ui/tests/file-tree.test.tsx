/** @jsxImportSource react */
// FileTree behavior under happy-dom: real createRoot + act (the gateway-react
// convention, same as radix-interaction.test.tsx). The DOM is registered by
// tests/happy-dom-preload.ts via bunfig `[test] preload`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileTree, SMITHERS_UI_STYLE_ATTR } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const PATHS = ["src/app/main.ts", "src/app/util/helpers.ts", "src/index.ts", "README.md"];

function files(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="file-tree-file"]'));
}
function dirToggles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="file-tree-dir-toggle"]'));
}

describe("FileTree", () => {
  test("groups a flat path list into a nested tree and toggles collapse", async () => {
    await render(<FileTree nodes={PATHS} />);

    expect(container!.querySelector('[role="tree"]')).toBeNull();
    expect(container!.querySelector('[role="treeitem"]')).toBeNull();

    // Directories: src, src/app, src/app/util (README.md is a root leaf).
    const dirNames = dirToggles().map((toggle) => toggle.querySelector(".sui-file-tree-dir-name")?.textContent);
    expect(dirNames).toEqual(["src", "app", "util"]);

    // All four leaves render, labelled by their last path segment.
    const names = files().map((file) => file.textContent);
    expect(names).toEqual(["helpers.ts", "main.ts", "index.ts", "README.md"]);

    // Collapse `src` -> every descendant leaf/dir disappears; only README stays.
    const srcToggle = dirToggles()[0]!;
    expect(srcToggle.getAttribute("aria-expanded")).toBe("true");
    await click(srcToggle);
    expect(srcToggle.getAttribute("aria-expanded")).toBe("false");
    expect(files().map((file) => file.textContent)).toEqual(["README.md"]);
    expect(dirToggles().length).toBe(1);

    // Expand again -> the full tree comes back.
    await click(dirToggles()[0]!);
    expect(files().length).toBe(4);
    expect(dirToggles().length).toBe(3);
  });

  test("fires onSelect with the node path and applies the active highlight", async () => {
    const selected: string[] = [];
    function Harness() {
      return <FileTree nodes={PATHS} selected="src/index.ts" onSelect={(path) => selected.push(path)} />;
    }
    await render(<Harness />);

    const active = files().find((file) => file.getAttribute("data-active") === "true");
    expect(active).not.toBeUndefined();
    expect(active!.textContent).toBe("index.ts");
    // Only the selected leaf is highlighted.
    expect(files().filter((file) => file.getAttribute("data-active") === "true").length).toBe(1);

    const readme = files().find((file) => file.textContent === "README.md")!;
    await click(readme);
    expect(selected).toEqual(["README.md"]);
  });

  test("renders the trailing affordance slot per node when provided", async () => {
    await render(
      <FileTree
        nodes={PATHS}
        renderAffordance={(node) => (node.path === "README.md" ? <span data-testid="dirty" /> : null)}
      />,
    );

    // The render slot is invoked for every leaf, but only emits for README.md.
    const affordances = document.querySelectorAll('[data-slot="file-tree-affordance"]');
    expect(affordances.length).toBe(1);
    expect(affordances[0]!.querySelector('[data-testid="dirty"]')).not.toBeNull();
  });

  test("accepts full nodes with custom labels and honors defaultCollapsed", async () => {
    await render(
      <FileTree nodes={[{ path: "src/app/main.ts", label: "Entry point" }, "docs/guide.md"]} defaultCollapsed />,
    );

    // Every directory starts collapsed: only the two top-level dirs are visible,
    // and no leaf shows yet.
    expect(files().length).toBe(0);
    expect(dirToggles().map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "false"]);

    // Drill into src -> app -> the custom-labelled leaf.
    await click(dirToggles()[0]!);
    await click(dirToggles().find((t) => t.textContent?.includes("app"))!);
    const entry = files().find((file) => file.textContent === "Entry point");
    expect(entry).not.toBeUndefined();
  });

  test("composes nodeProps without surrendering selection or structural attributes", async () => {
    const events: string[] = [];
    await render(
      <FileTree
        nodes={["active.ts", "cancelled.ts"]}
        selected="active.ts"
        onSelect={(path) => events.push(`select:${path}`)}
        nodeProps={(node) => ({
          type: "submit",
          className: "host-file",
          "data-slot": "hostile-slot",
          "data-active": "false",
          onClick: (event) => {
            events.push(`host:${node.path}`);
            if (node.path === "cancelled.ts") event.preventDefault();
          },
        })}
      />,
    );

    const active = container!.querySelector<HTMLButtonElement>('[title="active.ts"]')!;
    expect(active.type).toBe("button");
    expect(active.classList).toContain("sui-file-tree-file");
    expect(active.classList).toContain("host-file");
    expect(active.dataset.slot).toBe("file-tree-file");
    expect(active.dataset.active).toBe("true");
    await click(active);
    expect(events).toEqual(["host:active.ts", "select:active.ts"]);

    const cancelled = container!.querySelector<HTMLButtonElement>('[title="cancelled.ts"]')!;
    await click(cancelled);
    expect(events).toEqual(["host:active.ts", "select:active.ts", "host:cancelled.ts"]);
  });
});

/*
 * The lazy, controlled tree a host drives from its own state (apps/app's
 * sidebar loads one directory per fetch): `directories` names directories
 * whose children are not loaded yet, `collapsed` makes collapse state the
 * host's, `onToggle` reports the next state, `renderDirectoryEmpty` is the one
 * row an expanded directory with nothing loaded shows, `renderDirectoryFooter`
 * trails a directory's children, and `directoryProps` stamps the host's
 * attributes on the toggle the way `nodeProps` does on a leaf.
 */
describe("FileTree lazy and controlled", () => {
  test("an explicit directory renders a caret with no children; expanded, it shows renderDirectoryEmpty once", async () => {
    const toggles: Array<[string, boolean]> = [];
    await render(
      <FileTree
        nodes={["README.md"]}
        directories={["apps", "packages"]}
        collapsed={new Set(["apps"])}
        onToggle={(path, expanded) => toggles.push([path, expanded])}
        renderDirectoryEmpty={(path) => <em data-testid="empty">{path === "packages" ? "loading…" : "empty"}</em>}
      />,
    );
    const dirNames = dirToggles().map((toggle) => toggle.querySelector(".sui-file-tree-dir-name")?.textContent);
    expect(dirNames).toEqual(["apps", "packages"]);
    expect(dirToggles().map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    // The expanded, unloaded directory renders exactly one empty row from the host.
    const empties = Array.from(document.querySelectorAll('[data-slot="file-tree-empty"]'));
    expect(empties.length).toBe(1);
    expect(empties[0]!.textContent).toBe("loading…");
    expect(empties[0]!.closest('[data-slot="file-tree-dir"]')?.querySelector(".sui-file-tree-dir-name")?.textContent).toBe("packages");
    expect(files().map((file) => file.textContent)).toEqual(["README.md"]);

    // Controlled: a click reports the next state and changes nothing on its own.
    await click(dirToggles()[0]!);
    expect(toggles).toEqual([["apps", true]]);
    expect(dirToggles()[0]!.getAttribute("aria-expanded")).toBe("false");
    await click(dirToggles()[1]!);
    expect(toggles).toEqual([["apps", true], ["packages", false]]);
    expect(dirToggles()[1]!.getAttribute("aria-expanded")).toBe("true");
  });

  test("a controlled tree follows the collapsed set it is given", async () => {
    await render(
      <FileTree
        nodes={["src/index.ts"]}
        directories={["src", "src/lib"]}
        collapsed={new Set(["src/lib"])}
        renderDirectoryEmpty={(path) => <span data-testid="empty">{`empty:${path}`}</span>}
      />,
    );
    // src is expanded (not in the set): its file and its unloaded child directory show, collapsed.
    expect(files().map((file) => file.textContent)).toEqual(["index.ts"]);
    expect(dirToggles().map((toggle) => toggle.querySelector(".sui-file-tree-dir-name")?.textContent)).toEqual(["src", "lib"]);
    expect(document.querySelectorAll('[data-slot="file-tree-empty"]').length).toBe(0);
  });

  test("an empty root renders renderDirectoryEmpty for \"\"", async () => {
    await render(
      <FileTree nodes={[]} directories={[]} collapsed={new Set()} renderDirectoryEmpty={(path) => <span>{`empty:${path}`}</span>} />,
    );
    const empties = Array.from(document.querySelectorAll('[data-slot="file-tree-empty"]'));
    expect(empties.map((row) => row.textContent)).toEqual(["empty:"]);
  });

  test("directoryProps stamps the host's attributes on the toggle without surrendering its structure; renderDirectoryFooter trails the children", async () => {
    const seen: string[] = [];
    await render(
      <FileTree
        nodes={["src/a.ts", "src/b.ts"]}
        collapsed={new Set()}
        onToggle={(path) => seen.push(`toggle:${path}`)}
        directoryProps={(path) => ({
          "data-flow": "repo.tree",
          "data-testid": `dir-${path}`,
          className: "host-dir",
          type: "submit",
          "aria-expanded": false,
          onClick: () => seen.push(`host:${path}`),
        })}
        renderDirectoryFooter={(path) => (path === "src" ? <span data-testid="footer">Truncated</span> : null)}
      />,
    );
    const toggle = container!.querySelector<HTMLButtonElement>('[data-testid="dir-src"]')!;
    expect(toggle.type).toBe("button");
    expect(toggle.dataset.slot).toBe("file-tree-dir-toggle");
    expect(toggle.dataset.flow).toBe("repo.tree");
    expect(toggle.classList).toContain("sui-file-tree-dir-toggle");
    expect(toggle.classList).toContain("host-dir");
    // The structural state wins over a hostile aria-expanded.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await click(toggle);
    expect(seen).toEqual(["host:src", "toggle:src"]);
    // The footer follows the directory's two leaves, inside its children block.
    const footer = container!.querySelector('[data-slot="file-tree-footer"]')!;
    expect(footer.textContent).toBe("Truncated");
    const children = footer.closest(".sui-file-tree-children")!;
    expect(Array.from(children.children).map((child) => child.getAttribute("data-slot"))).toEqual([
      "file-tree-row",
      "file-tree-row",
      "file-tree-footer",
    ]);
  });

  test("without collapsed the tree still owns its state and reports onToggle", async () => {
    const toggles: Array<[string, boolean]> = [];
    await render(<FileTree nodes={PATHS} onToggle={(path, expanded) => toggles.push([path, expanded])} />);
    await click(dirToggles()[0]!);
    expect(toggles).toEqual([["src", false]]);
    expect(dirToggles()[0]!.getAttribute("aria-expanded")).toBe("false");
    await click(dirToggles()[0]!);
    expect(toggles).toEqual([["src", false], ["src", true]]);
    expect(files().length).toBe(4);
  });
});
