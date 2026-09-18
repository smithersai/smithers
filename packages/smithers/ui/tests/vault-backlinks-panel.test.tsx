/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklinksPanel } from "../src/vault/BacklinksPanel";

describe("BacklinksPanel", () => {
  test("renders both sections with count badges and note chips", () => {
    const html = renderToStaticMarkup(
      <BacklinksPanel backlinks={["Areas/Marketing.md", "People/Ada.md"]} linksOut={["HQ.md"]} onOpenNote={() => {}} />,
    );
    expect(html).toContain("Backlinks");
    expect(html).toContain("Linked mentions");
    // count badges
    expect(html).toContain(">2</span>");
    expect(html).toContain(">1</span>");
    // chips show the .md-stripped label and the full path
    expect(html).toContain("Marketing");
    expect(html).toContain("Ada");
    expect(html).toContain("HQ");
    expect(html).toContain("Areas/Marketing.md");
    expect(html).not.toContain("No backlinks yet");
  });

  test("empty sections show their empty copy with a zero badge", () => {
    const html = renderToStaticMarkup(<BacklinksPanel backlinks={[]} />);
    expect(html).toContain("No backlinks yet");
    expect(html).toContain("No outgoing links yet");
    expect(html).toContain(">0</span>");
  });

  test("chips are buttons so onOpenNote can be wired", () => {
    const html = renderToStaticMarkup(<BacklinksPanel backlinks={["Inbox.md"]} onOpenNote={() => {}} />);
    expect(html).toContain('data-slot="row-button"');
    expect(html).toContain("<button");
  });
});

describe("BacklinksPanel pass-through attributes", () => {
  test("stamps the host's attributes on each link row, per path", () => {
    const html = renderToStaticMarkup(
      <BacklinksPanel
        backlinks={["Areas/Marketing.md"]}
        linksOut={["HQ.md"]}
        onOpenNote={() => {}}
        linkProps={(path) => ({ "data-flow": "wiki.open", "data-path": path })}
      />,
    );
    expect(html.match(/data-flow="wiki\.open"/g)).toHaveLength(2);
    expect(html).toContain('data-path="Areas/Marketing.md"');
    expect(html).toContain('data-path="HQ.md"');
  });

  test("renders without the hook, exactly as before", () => {
    const html = renderToStaticMarkup(<BacklinksPanel backlinks={["Inbox.md"]} />);
    expect(html).not.toContain("data-flow");
  });
});
