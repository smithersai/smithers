/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";
import { Markdown } from "../src/primitives/markdown";
import { parseOutline } from "../src/vault/OutlineView";
import { noteHref, pathFromHref, splitFrontmatter, wikilinksToMarkdown } from "../src/vault/wikilinks";
import { RepoAbout } from "../src/repo-about";
import { RelativeTime, TICK_MS } from "../src/time/RelativeTime";
import { formatRelativeTime } from "../src/time/formatRelativeTime";
import { WebPreviewContent } from "../src/sandbox/WebPreview";
import { WebLinkCard } from "../src/web-page/WebLinkCard";
import { Sandbox, SandboxContent } from "../src/sandbox/AgentSandbox";
import { KnowledgeGraph } from "../src/vault/KnowledgeGraph";
import { BacklinksPanel } from "../src/vault/BacklinksPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});
async function render(element: ReactElement) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(element));
  return container;
}
test("outline preserves hashes belonging to the heading", () => {
  expect(parseOutline("# C#\n## F# and C#\n# Closing ###\n# ###").map((h) => h.text))
    .toEqual(["C#", "F# and C#", "Closing", ""]);
  fc.assert(fc.property(fc.stringMatching(/^[A-Za-z]{1,20}$/), fc.integer({ min: 1, max: 8 }), (body, count) => {
    const text = body + "#".repeat(count);
    expect(parseOutline("# " + text)[0]?.text).toBe(text);
    expect(parseOutline("# " + text + " ###")[0]?.text).toBe(text);
  }));
});
test("wikilinks with parentheses survive the Markdown renderer", () => {
  for (const path of ["Meetings/Standup (2024).md", "Notes/((nested)).md", "Notes/A[1] (draft).md"]) {
    const markdown = wikilinksToMarkdown("[[Meeting]] tail", () => path);
    const node = document.createElement("div");
    node.innerHTML = renderToStaticMarkup(<Markdown content={markdown} />);
    const link = node.querySelector("a")!;
    expect(pathFromHref(link.getAttribute("href")!)).toBe(path);
    expect(node.textContent).toBe("Meeting tail");
    expect(noteHref(path)).not.toMatch(/[()]/);
  }
});
test("frontmatter closes only at a complete fence and accepts an empty block", () => {
  for (const newline of ["\n", "\r\n"]) {
    expect(splitFrontmatter(["---", "---", "body"].join(newline))).toEqual({ frontmatter: "", body: "body" });
    expect(splitFrontmatter(["---", "title: x", "----", "body"].join(newline)))
      .toEqual({ frontmatter: null, body: ["---", "title: x", "----", "body"].join(newline) });
    expect(splitFrontmatter(["---", "title: x", "--- suffix", "--- \t", "body"].join(newline)))
      .toEqual({ frontmatter: ["title: x", "--- suffix"].join(newline), body: "body" });
  }
  expect(splitFrontmatter("---\ntitle: x\n---")).toEqual({ frontmatter: "title: x", body: "" });
});
test.each(["example.com", "mailto:a@b.c", "//example.com"])("repository homepage refuses %s", (homepage) => {
  const html = renderToStaticMarkup(<RepoAbout homepage={homepage} />);
  expect(html).not.toContain('class="sui-repo-about-homepage"');
});
test("repository statistics use singular nouns", () => {
  const node = document.createElement("div");
  node.innerHTML = renderToStaticMarkup(<RepoAbout stars={1} forks={1} />);
  expect([...node.querySelectorAll(".sui-repo-about-stats li")].map((el) => el.textContent)).toEqual(["1 star", "1 fork"]);
});
test("absolute timestamps from an earlier day retain their date", async () => {
  const ts = Date.now() - 3 * 86_400_000;
  const container = await render(<RelativeTime ts={ts} relativeUntilMs={1_000} />);
  expect(container.querySelector("time")!.textContent).toBe(formatRelativeTime(ts, Date.now()));
});
test("absolute display switches on the shared tick even when the relative label stays the same", async () => {
  const container = await render(<RelativeTime ts={Date.now() - 60_000} relativeUntilMs={60_500} />);
  expect(container.textContent).toBe("1m ago");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, TICK_MS + 150)); });
  expect(container.textContent).not.toContain("ago");
}, 10_000);
test.each(["srcDoc", "srcdoc", "sRcDoC"])("preview rejects %s and permission delegation from runtime props", async (name) => {
  const extra = { [name]: "<script>bad()</script>", ALLOW: "camera; microphone" } as ComponentProps<typeof WebPreviewContent>;
  const container = await render(<WebPreviewContent {...extra} src="https://example.com" />);
  const iframe = container.querySelector("iframe")!;
  expect(iframe.getAttribute("src")).toBe("https://example.com");
  expect(iframe.hasAttribute("srcdoc")).toBe(false);
  expect(iframe.hasAttribute("allow")).toBe(false);
});
test("page cards never load an icon from a third party", () => {
  for (const icon of ["https://tracker.example/icon.png", "//tracker.example/icon.png", "/\t/tracker.example/icon.png"]) {
    const html = renderToStaticMarkup(<WebLinkCard url="https://example.com" icon={icon} />);
    expect(html).not.toContain("<img");
  }
  for (const icon of ["data:image/png;base64,aGVsbG8=", "/icons/page.png"]) {
    expect(renderToStaticMarkup(<WebLinkCard url="https://example.com" icon={icon} />)).toContain("<img");
  }
});
test("sandbox states use only their title", () => {
  for (const state of ["provisioning", "disconnected", "suspended", "failed", "destroyed"] as const) {
    const html = renderToStaticMarkup(<Sandbox state={state}><SandboxContent /></Sandbox>);
    expect(html).not.toContain("The sandbox");
    expect(html).not.toContain("The connection");
  }
});
test("vault graph and links show accurate minimal copy", () => {
  const empty = renderToStaticMarkup(<KnowledgeGraph notes={[]} links={[]} />);
  expect(empty).toContain("No notes");
  expect(empty).not.toContain("No wikilinks");
  const graph = renderToStaticMarkup(<KnowledgeGraph notes={[{ path: "A.md", title: "A", linksOut: [] }]} links={[]} />);
  expect(graph).toContain("<circle");
  expect(graph).not.toContain("Drag to pan");
  const links = renderToStaticMarkup(<BacklinksPanel backlinks={[]} linksOut={["A.md"]} />);
  expect(links).toContain(">Links<");
  expect(links).not.toContain("Linked mentions");
});


test("preview source and sandbox cannot be overwritten by case variants on server render or updates", async () => {
  const safe = "https://example.com";
  const extra = { SRC: "https://evil.example", SANDBOX: "allow-scripts allow-same-origin" };
  const container = await render(<WebPreviewContent {...extra} src={safe} />);
  const iframe = container.querySelector("iframe")!;
  await act(async () => mounted[mounted.length - 1]!.root.render(
    <WebPreviewContent {...{ ...extra, SRC: "javascript:bad()", SANDBOX: "allow-same-origin" }} src={safe} />,
  ));
  expect(iframe.getAttribute("src")).toBe(safe);
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  const html = renderToStaticMarkup(<WebPreviewContent {...extra} src={safe} />);
  const parsed = document.createElement("div");
  parsed.innerHTML = html;
  expect(parsed.querySelector("iframe")!.getAttribute("src")).toBe(safe);
  expect(parsed.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
});
