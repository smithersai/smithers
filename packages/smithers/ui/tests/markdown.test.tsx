import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, type ReactElement, type ReactNode } from "react";
import fc from "fast-check";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { markdownBlockParser } from "../src/primitives/markdown";

/**
 * The mixed-block structure and HTML-escaping cases render with
 * `renderToStaticMarkup` (no DOM), the components.test.tsx convention. The
 * link-activation cases need real event dispatch, so they mount through
 * `createRoot` + `act` under the happy-dom preload, like radix-interaction.
 */

const SAMPLE = [
  "# Title",
  "",
  "Some **bold**, *italic*, `code`, and a [link](https://smithers.sh).",
  "",
  "- one",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "```",
  "const x = 1;",
  "```",
].join("\n");

describe("Markdown (static markup)", () => {
  test("is a memoized component (re-renders only on prop change)", () => {
    expect((Markdown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  test("a heading is a heading to assistive technology, at its level, written in Markdown or HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"# Welcome home\n\n### Setup\n\n<h2>From HTML</h2>\n\nText"} variant="document" />,
    );
    expect(html).toContain('role="heading" aria-level="1">Welcome home</div>');
    expect(html).toContain('role="heading" aria-level="3">Setup</div>');
    expect(html).toMatch(/role="heading" aria-level="2"[^>]*>From HTML<\/div>/);
    expect(html).not.toMatch(/role="heading"[^>]*>Text</);
  });

  test("renders headings, lists, code fence, inline styles, and links", () => {
    const html = renderToStaticMarkup(<Markdown content={SAMPLE} />);
    expect(html).toContain('data-slot="markdown"');
    expect(html).toContain("sui-md");
    // heading
    expect(html).toContain("sui-md-h1");
    expect(html).toContain("Title");
    // inline
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("sui-md-inline-code");
    expect(html).toContain(">code<");
    // link
    expect(html).toContain("sui-md-link");
    expect(html).toContain('href="https://smithers.sh"');
    // lists
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("sui-md-list");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>first</li>");
    // fenced code
    expect(html).toContain("sui-codeblock");
    expect(html).toContain("const x = 1;");
  });

  test("escapes raw HTML in the source (no markup injection)", () => {
    const html = renderToStaticMarkup(
      <Markdown content={'Hello <img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("drops non-navigable link schemes (javascript:)", () => {
    const html = renderToStaticMarkup(<Markdown content="[click](javascript:alert(1))" />);
    expect(html).not.toContain("javascript:");
    // label still renders as an anchor, just without a dangerous href.
    expect(html).toContain("sui-md-link");
    expect(html).toContain("click");
  });

  test("keeps a consumer className and data-slot", () => {
    const html = renderToStaticMarkup(<Markdown content="hi" className="mine" />);
    expect(html).toContain("mine");
    expect(html).toContain("sui-md");
    expect(html).toContain('data-slot="markdown"');
  });

  test("matches the uncached renderer across markdown block shapes", () => {
    const inputs = [
      "",
      "plain text",
      "first line\nsecond line",
      "first paragraph\n\nsecond paragraph",
      "# Heading\nparagraph\n## Next",
      "- one\n- two\nparagraph",
      "1. one\n2. two\n\n- three",
      "```\nconst x = 1;",
      "```ts\nconst x = 1;\n```\nAfter",
      "same\n\nsame\n\nlast",
      "Raw <tag> and **bold**, *italic*, `code`, and [link](/docs).",
      "| repo | issues |\n| --- | ---: |\n| smithers | 3 |",
      "Before\n\n| a | b |\n|:-:|---|\n| 1 | 2 |\n\nAfter",
      // A header row that also looks like a bullet: the delimiter row decides.
      "- a | b\n--- | ---\n- c | d",
      SAMPLE,
    ];

    for (const content of inputs) {
      const cached = renderToStaticMarkup(<Markdown content={content} />);
      const uncached = renderToStaticMarkup(
        <div data-slot="markdown" className="sui-md">
          {markdownBlockParser.render(content)}
        </div>,
      );
      expect(cached).toBe(uncached);
    }
  });
});

describe("Markdown (inline parse bounds)", () => {
  const paragraph = (children: ReactNode) => renderToStaticMarkup(
    <div data-slot="markdown" className="sui-md"><p className="sui-md-p">{children}</p></div>,
  );

  for (const variant of ["chat", "document"] as const) {
    test.each([
      ["unmatched brackets", "[".repeat(200_000)],
      ["unterminated destinations", "[a](".repeat(50_000)],
      ["unterminated image labels", "![".repeat(100_000)],
      ["unterminated image destinations", "![a](".repeat(40_000)],
    ])(`${variant} renders 200,000 characters of %s within one second`, (_name, content) => {
      const started = performance.now();
      const html = renderToStaticMarkup(<Markdown content={content} variant={variant} />);
      const elapsed = performance.now() - started;
      expect(html).toBe(paragraph(content));
      expect(elapsed).toBeLessThan(1_000);
    }, 120_000);

    test(`${variant} preserves long labels, destinations and opening delimiters`, () => {
      const label = "[".repeat(2_000) + "label";
      const href = "/docs/" + "segment (".repeat(1_000);
      const content = `Before [${label}](${href}) after`;
      expect(renderToStaticMarkup(<Markdown content={content} variant={variant} />)).toBe(
        paragraph(<>Before <a className="sui-md-link" href={href}>{label}</a> after</>),
      );
    });

    test(`${variant} keeps malformed links literal and still finds following emphasis`, () => {
      fc.assert(fc.property(
        fc.array(fc.constantFrom("[", "![", "[![", "[a](", "![a](", "x", "("), { maxLength: 200 }),
        (parts) => {
          const prefix = "Before " + parts.join("") + " ";
          const visiblePrefix = variant === "document" ? prefix.replace(/ +/g, " ") : prefix;
          expect(renderToStaticMarkup(<Markdown content={prefix + "**bold**"} variant={variant} />)).toBe(
            paragraph(<>{visiblePrefix}<strong>bold</strong></>),
          );
        },
      ), { numRuns: 200, seed: 5021 });
    });

    test(`${variant} preserves generated link labels and destinations`, () => {
      const label = fc.array(fc.constantFrom("a", "[", "(", ")", "!", "*", "`", " ", "&"), { minLength: 1, maxLength: 100 }).map((parts) => parts.join(""));
      const destination = fc.array(fc.constantFrom("a", "[", "]", "(", "!", "*", "`"), { maxLength: 100 }).map((parts) => "/docs/" + parts.join(""));
      fc.assert(fc.property(label, destination, (label, href) => {
        // Document flow collapses source whitespace before reading inline tokens.
        const visibleLabel = variant === "document" ? label.replace(/ +/g, " ") : label;
        expect(renderToStaticMarkup(<Markdown content={`Before [${label}](${href}) after`} variant={variant} />)).toBe(
          paragraph(<>Before <a className="sui-md-link" href={href}>{visibleLabel}</a> after</>),
        );
        if (variant === "document") {
          expect(renderToStaticMarkup(<Markdown content={`Before [![${label}]()](${href}) after`} variant={variant} />)).toBe(
            paragraph(<>Before <a className="sui-md-link" href={href}>{visibleLabel}</a> after</>),
          );
          expect(renderToStaticMarkup(<Markdown content={`Before ![${label}]() after`} variant={variant} />)).toBe(
            paragraph(`Before ${visibleLabel} after`),
          );
        }
      }), { numRuns: 200, seed: 5021 });
    });
  }

  test.each([
    ["[](/empty-label)", "[](/empty-label)"],
    ["[label]()", "[label]()"],
    ["[![alt]()](/target)", <a className="sui-md-link" href="/target">alt</a>],
    ["[![]()](/target)", ""],
    ["[![alt]()]()", <>[alt]()</>],
    ["[![alt](/image)]()", <><a className="sui-md-link" href="/image">![alt</a>]()</>],
    ["![alt]() [ok](/target)", <>alt <a className="sui-md-link" href="/target">ok</a></>],
    ["[![alt](/image)](/target) [ok](/next)", <><a className="sui-md-link" href="/target">alt</a> <a className="sui-md-link" href="/next">ok</a></>],
    ["[![alt](/image)](missing **bold**", <><a className="sui-md-link" href="/image">![alt</a>](missing <strong>bold</strong></>],
    ["`[![alt](/image)](/target)`", <code className="sui-md-inline-code">[![alt](/image)](/target)</code>],
  ])("document preserves image priority and fallback for %s", (content, expected) => {
    expect(renderToStaticMarkup(<Markdown content={`Before ${content} after`} variant="document" />)).toBe(
      paragraph(<>Before {expected} after</>),
    );
  });
});

describe("Markdown (link activation)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  test("onLinkClick fires with the href and default navigation is prevented", async () => {
    const seen: string[] = [];
    await render(
      <Markdown content="Read the [docs](https://smithers.sh/docs) now." onLinkClick={(href) => seen.push(href)} />,
    );
    const anchor = container!.querySelector("a.sui-md-link") as HTMLAnchorElement;
    expect(anchor).toBeTruthy();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(seen).toEqual(["https://smithers.sh/docs"]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("rejects unsafe links without invoking onLinkClick", async () => {
    const seen: string[] = [];
    await render(<Markdown content="Click [this](javascript:alert)" onLinkClick={(href) => seen.push(href)} />);
    const anchor = container!.querySelector("a.sui-md-link") as HTMLAnchorElement;
    expect(anchor).toBeTruthy();
    expect(anchor.hasAttribute("href")).toBe(false);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(seen).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("without onLinkClick the anchor keeps its href and default is not prevented", async () => {
    await render(<Markdown content="[docs](https://smithers.sh/docs)" />);
    const anchor = container!.querySelector("a.sui-md-link") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("https://smithers.sh/docs");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      anchor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  test("replacing the content keeps the completed-block cache the size of the document", async () => {
    // The cache is private to the instance, so the test captures it the only way
    // a caller can: the Map that block sources are written into.
    const caches = new Set<Map<unknown, unknown>>();
    const originalSet = Map.prototype.set;
    Map.prototype.set = function set(this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === "string" && key.startsWith("cache-probe:")) caches.add(this);
      return originalSet.call(this, key, value);
    };
    try {
      await render(<Markdown content={"cache-probe:0\n\ntail"} />);
      for (let version = 1; version < 200; version += 1) {
        await act(async () => root!.render(<Markdown content={`cache-probe:${version}\n\ntail`} />));
      }
    } finally {
      Map.prototype.set = originalSet;
    }

    expect(caches.size).toBe(1);
    // One completed block is on screen ("cache-probe:199"); the trailing block
    // is never cached. Retaining every replaced version would be 200 entries.
    expect([...caches][0]!.size).toBe(1);
    expect(container!.textContent).toContain("cache-probe:199");
  });

  test("appending streamed content does not re-parse completed blocks", async () => {
    const parse = spyOn(markdownBlockParser, "render");
    try {
      await render(<Markdown content={"First.\n\nSecond"} />);
      expect(parse.mock.calls.filter(([source]) => source === "First.")).toHaveLength(1);

      await act(async () => root!.render(<Markdown content={"First.\n\nSecond grows"} />));
      await act(async () => root!.render(<Markdown content={"First.\n\nSecond grows\n\nThird"} />));
      const completedSecondParses = parse.mock.calls.filter(([source]) => source === "Second grows").length;
      await act(async () => root!.render(<Markdown content={"First.\n\nSecond grows\n\nThird grows"} />));

      expect(parse.mock.calls.filter(([source]) => source === "First.")).toHaveLength(1);
      expect(parse.mock.calls.filter(([source]) => source === "Second grows")).toHaveLength(completedSecondParses);
      expect(parse.mock.calls.filter(([source]) => source === "Third grows")).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });
});

/*
 * Document mode reads a repository file the way GitHub renders it. The
 * fixture is the head of the smithers-canary README as smithers.sh serves it
 * (generated by apps/site/scripts/generate-project-copy.mjs): a comment, a
 * centered `<pre>` banner, a centered `<p><strong>` tagline, and a paragraph
 * whose sentences sit on separate source lines.
 */
const BANNER = [
  "███████╗███╗   ███╗██╗████████╗██╗  ██╗",
  "██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║",
  "╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝",
];
const README = [
  "<!-- Generated from apps/site/src/data/project.json by apps/site/scripts/generate-project-copy.mjs. -->",
  "",
  '<pre align="center">',
  ...BANNER,
  "</pre>",
  "",
  '<p align="center"><strong>Automate maintaining your codebase</strong></p>',
  "",
  "## Open Smithers",
  "",
  "Open [the Smithers repository](https://smithers.sh/smithersai/smithers) in your browser.",
  "Explore its files, ask questions in chat, and inspect runs and changes in the conversation.",
].join("\n");

/** Static markup, parsed back into a detached element for structural queries. */
const documentDom = (content: string, variant: "chat" | "document" = "document"): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Markdown content={content} variant={variant} />);
  return host;
};

describe("Markdown (document mode)", () => {
  test("renders the canary README with no markup text: comment dropped, banner preformatted, tagline bold", () => {
    const dom = documentDom(README);
    const text = dom.textContent ?? "";
    expect(text).not.toContain("<");
    expect(text).not.toContain("Generated from");
    expect(text).not.toContain("align=");

    const pre = dom.querySelectorAll("pre");
    expect(pre).toHaveLength(1);
    expect(pre[0]!.className).toBe("sui-md-pre");
    expect(pre[0]!.getAttribute("data-align")).toBe("center");
    // Every space of the banner survives, one row per source line.
    expect(pre[0]!.textContent).toBe(BANNER.join("\n"));

    const tagline = dom.querySelector("p.sui-md-p > strong");
    expect(tagline?.textContent).toBe("Automate maintaining your codebase");
    expect((tagline!.parentElement as HTMLElement).style.textAlign).toBe("center");
    expect(dom.querySelector(".sui-md-h2")?.textContent).toBe("Open Smithers");
  });

  test("joins a paragraph's single newlines into spaces, as GitHub does", () => {
    const dom = documentDom(README);
    const paragraph = [...dom.querySelectorAll("p.sui-md-p")].at(-1)!;
    expect(paragraph.textContent).toBe(
      "Open the Smithers repository in your browser. Explore its files, ask questions in chat, and inspect runs and changes in the conversation.",
    );
    expect(paragraph.querySelector("br")).toBeNull();
    expect(paragraph.querySelector("a.sui-md-link")?.getAttribute("href")).toBe("https://smithers.sh/smithersai/smithers");
    // A trailing two spaces (or a backslash) is still a hard break.
    expect(documentDom("one  \ntwo\\\nthree\nfour").querySelectorAll("p br")).toHaveLength(2);
  });

  test("keeps bold, italic, code, breaks and safe links from HTML, and only their text otherwise", () => {
    const dom = documentDom(
      [
        '<div align="center"><h1>Smithers</h1>',
        '<a href="https://smithers.sh/docs"><img src="badge.svg" alt="Docs"></a> <b>bold</b> <i>it</i> <code>x &lt; y</code><br><span title="t">plain</span> <img src="x.png">',
        "</div>",
        "",
        "Inline <em>html</em> in **Markdown**, a `<br>` code span, and <https://smithers.sh/bug>.",
      ].join("\n"),
    );
    expect(dom.querySelector(".sui-md-h1")?.textContent).toBe("Smithers");
    expect((dom.querySelector(".sui-md-h1") as HTMLElement).style.textAlign).toBe("center");
    const link = dom.querySelector('a.sui-md-link[href="https://smithers.sh/docs"]');
    expect(link?.textContent).toBe("Docs");
    expect(dom.querySelector("strong")?.textContent).toBe("bold");
    expect(dom.querySelector("em")?.textContent).toBe("it");
    expect(dom.querySelector("code.sui-md-inline-code")?.textContent).toBe("x < y");
    expect(dom.querySelectorAll("p br")).toHaveLength(1);
    expect(dom.querySelector("span, img, div[align]")).toBeNull();
    expect(dom.textContent).toContain("plain");
    const inline = [...dom.querySelectorAll("p.sui-md-p")].at(-1)!;
    expect(inline.querySelector("em")?.textContent).toBe("html");
    expect(inline.querySelector("strong")?.textContent).toBe("Markdown");
    expect(inline.querySelector("code")?.textContent).toBe("<br>");
    expect(inline.querySelector('a[href="https://smithers.sh/bug"]')?.textContent).toBe("https://smithers.sh/bug");
  });

  test("a script, an event attribute or an unsafe URL renders as text only, never as an element or attribute", () => {
    const source = [
      "<script>alert(1)</script>",
      "",
      '<div onclick="alert(2)">Hi <b onmouseover="steal()">there</b> <a href="javascript:alert(3)">bad link</a> <img src=x onerror="alert(4)" alt="logo"></div>',
      "",
      'Inline <a href="javascript:alert(5)" onclick="alert(6)">also bad</a> and <script>alert(7)</script>.',
    ].join("\n");
    const html = renderToStaticMarkup(<Markdown content={source} variant="document" />);
    for (const forbidden of ["<script", "onclick", "onmouseover", "onerror", "javascript:", "<img", "<div onclick", "steal"]) {
      expect(html).not.toContain(forbidden);
    }
    const dom = documentDom(source);
    expect(dom.querySelectorAll("a")).toHaveLength(0);
    expect(dom.querySelector("strong")?.textContent).toBe("there");
    expect(dom.querySelector("strong")!.attributes).toHaveLength(0);
    for (const text of ["alert(1)", "Hi there bad link logo", "Inline also bad and alert(7)."]) {
      expect(dom.textContent).toContain(text);
    }
  });

  test("decodes HTML entities in prose, not in code", () => {
    const dom = documentDom("<p>Tom &amp; Jerry &copy; &#x1F600; &unknown;</p>\n\nA &lt;tag&gt; and `&amp;`");
    expect(dom.querySelector("p")?.textContent).toBe("Tom & Jerry © 😀 &unknown;");
    expect([...dom.querySelectorAll("p")].at(-1)?.textContent).toBe("A <tag> and &amp;");
  });

  test("chat mode is unchanged: HTML stays text and each line keeps its break", () => {
    const chat = renderToStaticMarkup(<Markdown content={README} />);
    expect(renderToStaticMarkup(<Markdown content={README} variant="chat" />)).toBe(chat);
    expect(chat).toBe(
      renderToStaticMarkup(
        <div data-slot="markdown" className="sui-md">
          {markdownBlockParser.render(README)}
        </div>,
      ),
    );
    expect(chat).toContain("&lt;!-- Generated from");
    expect(chat).toContain("&lt;pre align=&quot;center&quot;&gt;");
    expect(chat).not.toContain("sui-md-pre");
    const dom = documentDom(README, "chat");
    expect([...dom.querySelectorAll("p.sui-md-p")].at(-1)!.querySelectorAll("br")).toHaveLength(1);
  });

  test("matches the uncached document renderer across block shapes", () => {
    const inputs = [
      README,
      "<!-- one\ntwo -->\nafter",
      "<pre>\n  a  b\n</pre>\ntrailing",
      "<pre>unterminated\n  x",
      "para\n<div>block</div>\nmore",
      "para\n<span>inline</span>\nmore",
      "- <b>one</b>\n- two\n\n| <i>a</i> | b |\n| --- | --- |\n| 1 | 2 |",
      "```html\n<p>kept verbatim</p>\n```",
      "> [!TIP]\n> Ask your agent.\n\n> quote\nlazy\n> > nested",
      "para\n> interrupts\n> ```\n> code\nafter",
    ];
    for (const content of inputs) {
      const cached = renderToStaticMarkup(<Markdown content={content} variant="document" />);
      const uncached = renderToStaticMarkup(
        <div data-slot="markdown" className="sui-md">
          {markdownBlockParser.render(content, undefined, "document")}
        </div>,
      );
      expect(cached).toBe(uncached);
    }
    // A fence keeps HTML as code, in either mode.
    expect(documentDom("```html\n<p>kept verbatim</p>\n```").textContent).toContain("<p>kept verbatim</p>");
  });
});

/*
 * Blockquotes, GitHub alerts and images, document mode only. The Tip is the
 * smithers-canary README's own block, which rendered as "> [!TIP] > Ask your
 * agent..." before quotes were read.
 */
const CANARY_TIP = [
  "> [!TIP]",
  "> Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.",
].join("\n");
const ALERT_KINDS = [
  ["[!NOTE]", "note", "Note"],
  ["[!TIP]", "tip", "Tip"],
  ["[!IMPORTANT]", "important", "Important"],
  ["[!WARNING]", "warning", "Warning"],
  ["[!CAUTION]", "caution", "Caution"],
] as const;
const PLAIN_QUOTE = ["> A quote with **bold**", "> on two lines", "lazy continuation", ">", "> - one", "> - two", ">", "> > Nested"].join("\n");
const LATE_MARKER = "> Before\n> [!TIP]\n> after";
const UNKNOWN_MARKER = "> [!FOO]\n> Some text";
const IMAGES = "Logo: ![Smithers logo](https://smithers.sh/logo.png). Empty: ![](https://smithers.sh/spacer.gif). Badge: [![CI passing](https://smithers.sh/ci.svg)](https://smithers.sh/ci).";

describe("Markdown (document mode): blockquotes, alerts and images", () => {
  test("a plain blockquote holds its rendered paragraphs, lists, inline marks and nested quotes", () => {
    const dom = documentDom(PLAIN_QUOTE);
    const quote = dom.querySelector(":scope > .sui-md > blockquote.sui-md-blockquote")!;
    expect(quote).not.toBeNull();
    // `>` lines and the lazy line join into one paragraph, as GitHub does.
    expect(quote.querySelector(":scope > p.sui-md-p")?.textContent).toBe("A quote with bold on two lines lazy continuation");
    expect(quote.querySelector(":scope > p > strong")?.textContent).toBe("bold");
    expect([...quote.querySelectorAll(":scope > ul.sui-md-list > li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(quote.querySelector(":scope > blockquote.sui-md-blockquote > p")?.textContent).toBe("Nested");
    expect(dom.textContent).not.toContain(">");
    expect(dom.querySelector("aside")).toBeNull();
    // A `>` line interrupts a paragraph; a blank line ends the quote.
    const interrupted = documentDom("Before the quote\n> quoted\n\nAfter the quote");
    expect([...interrupted.querySelectorAll(".sui-md > *")].map((node) => `${node.tagName.toLowerCase()}:${node.textContent}`)).toEqual([
      "p:Before the quote",
      "blockquote:quoted",
      "p:After the quote",
    ]);
  });

  test.each(ALERT_KINDS)("%s renders as an alert: its title, an icon and the body", (marker, kind, title) => {
    const dom = documentDom(`> ${marker}\n> Body of the **${title}** alert.\n> Second line.`);
    const alert = dom.querySelector(`:scope > .sui-md > aside.sui-md-alert[data-kind="${kind}"]`)!;
    expect(alert).not.toBeNull();
    expect(dom.querySelectorAll("aside")).toHaveLength(1);
    expect(dom.querySelector("blockquote")).toBeNull();
    const label = alert.querySelector(":scope > strong.sui-md-alert-label")!;
    expect(label.textContent).toBe(title);
    expect(label.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const body = alert.querySelector(":scope > p.sui-md-p")!;
    expect(body.textContent).toBe(`Body of the ${title} alert. Second line.`);
    expect(body.querySelector("strong")?.textContent).toBe(title);
    expect(dom.textContent).toBe(`${title}Body of the ${title} alert. Second line.`);
  });

  test("the canary README's Tip is a Tip alert with no marker or quote text", () => {
    const dom = documentDom(`Intro.\n\n${CANARY_TIP}\n\n## Documentation`);
    const alert = dom.querySelector('aside.sui-md-alert[data-kind="tip"]')!;
    expect(alert.querySelector(".sui-md-alert-label")?.textContent).toBe("Tip");
    expect(alert.querySelector("p")?.textContent).toBe(
      "Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.",
    );
    expect(dom.textContent).not.toContain("[!TIP]");
    expect(dom.textContent).not.toContain(">");
    expect(dom.querySelector(".sui-md-h2")?.textContent).toBe("Documentation");
  });

  test("[!TIP] that is not the quote's first line, or nested in a quote, stays a plain blockquote", () => {
    const late = documentDom(LATE_MARKER);
    expect(late.querySelector("aside")).toBeNull();
    expect(late.querySelector("blockquote.sui-md-blockquote > p")?.textContent).toBe("Before [!TIP] after");
    // GitHub draws alerts only at the top level.
    const nested = documentDom("> > [!TIP]\n> > inner");
    expect(nested.querySelector("aside")).toBeNull();
    expect(nested.querySelector("blockquote > blockquote > p")?.textContent).toBe("[!TIP] inner");
  });

  test("an unknown [!FOO] marker stays a plain blockquote with its text", () => {
    const dom = documentDom(UNKNOWN_MARKER);
    expect(dom.querySelector("aside")).toBeNull();
    expect(dom.querySelector("blockquote.sui-md-blockquote > p")?.textContent).toBe("[!FOO] Some text");
    // The match is exact: a lowercase marker or trailing words are not an alert either.
    for (const source of ["> [!tip]\n> body", "> [!TIP] inline words\n> body"]) {
      expect(documentDom(source).querySelector("aside")).toBeNull();
      expect(documentDom(source).querySelector("blockquote")).not.toBeNull();
    }
  });

  test("an image renders its alt text and never an <img>, so nothing is fetched", () => {
    const html = renderToStaticMarkup(<Markdown content={IMAGES} variant="document" />);
    expect(html).not.toContain("<img");
    for (const url of ["logo.png", "spacer.gif", "ci.svg"]) expect(html).not.toContain(url);
    const dom = documentDom(IMAGES);
    // An empty alt renders nothing; a linked badge is a link labeled with its alt.
    expect(dom.querySelector("p")?.textContent).toBe("Logo: Smithers logo. Empty: . Badge: CI passing.");
    const links = dom.querySelectorAll("a.sui-md-link");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://smithers.sh/ci");
    expect(links[0]!.textContent).toBe("CI passing");
    // A linked image with no alt leaves no empty link to tab to.
    expect(documentDom("[![](https://smithers.sh/x.svg)](https://smithers.sh)").querySelector("a")).toBeNull();
    // Images inside a quote, a list and a heading read the same way; a code span keeps its source.
    const nested = documentDom("> ![Quoted](q.png)\n\n- ![Listed](l.png)\n\n# ![Titled](t.png)\n\n`![code](c.png)`");
    expect(nested.querySelector("img")).toBeNull();
    expect(nested.textContent).toBe("QuotedListedTitled![code](c.png)");
  });

  test("chat mode is unchanged for every one of these inputs", () => {
    const chat = (content: string) => renderToStaticMarkup(<Markdown content={content} />);
    const paragraph = (inner: string) => `<div data-slot="markdown" class="sui-md"><p class="sui-md-p">${inner}</p></div>`;
    // The quote markers stay text and each line keeps its break, as before document mode read quotes.
    expect(chat(CANARY_TIP)).toBe(
      paragraph(
        "&gt; [!TIP]<br/>&gt; Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.",
      ),
    );
    expect(chat(LATE_MARKER)).toBe(paragraph("&gt; Before<br/>&gt; [!TIP]<br/>&gt; after"));
    expect(chat(UNKNOWN_MARKER)).toBe(paragraph("&gt; [!FOO]<br/>&gt; Some text"));
    for (const [marker] of ALERT_KINDS) {
      expect(chat(`> ${marker}\n> body`)).toBe(paragraph(`&gt; ${marker}<br/>&gt; body`));
    }
    // An image stays a "!" before a link, as chat always drew it.
    expect(chat("![Smithers logo](https://smithers.sh/logo.png)")).toBe(
      paragraph('!<a class="sui-md-link" href="https://smithers.sh/logo.png">Smithers logo</a>'),
    );
    for (const content of [PLAIN_QUOTE, IMAGES, CANARY_TIP]) {
      const html = chat(content);
      for (const absent of ["<blockquote", "<aside", "sui-md-alert", "<svg"]) expect(html).not.toContain(absent);
      expect(renderToStaticMarkup(<Markdown content={content} variant="chat" />)).toBe(html);
    }
  });
});

/*
 * Block screenshots. A line that is exactly `![alt](src)` is an image block;
 * the host's `resolveImage` maps the source to its light and dark files and
 * the sheet shows the one that matches `html[data-theme]`. Markdown never
 * puts a source it was handed into an `<img>`: without a resolver or on a miss
 * the line reads exactly as it would as a paragraph in that variant, and an
 * image inside a paragraph is never drawn.
 */
describe("Markdown (images)", () => {
  const shot = { light: "/assets/repo-home.light-a1.webp", dark: "/assets/repo-home.dark-b2.webp" };
  const resolveImage = (src: string) => (src === "images/repo-home.webp" ? shot : undefined);
  const BLOCK = "Before.\n\n![The repository home with its file tree](images/repo-home.webp)\n\nAfter.";

  test("a resolved block image is a figure with one image per theme", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<Markdown content={BLOCK} resolveImage={resolveImage} />);
    const figure = host.querySelector("figure.sui-md-figure");
    expect(figure).toBeTruthy();
    const images = [...figure!.querySelectorAll("img")];
    expect(
      images.map((img) => ({
        variant: img.getAttribute("data-variant"),
        src: img.getAttribute("src"),
        alt: img.getAttribute("alt"),
        width: img.getAttribute("width"),
        height: img.getAttribute("height"),
        loading: img.getAttribute("loading"),
        decoding: img.getAttribute("decoding"),
      })),
    ).toEqual(
      (["light", "dark"] as const).map((variant) => ({
        variant,
        src: shot[variant],
        alt: "The repository home with its file tree",
        width: "1440",
        height: "900",
        loading: "lazy",
        decoding: "async",
      })),
    );
    expect(host.textContent).toBe("Before.After.");
    expect(host.querySelector("a")).toBeNull();
  });

  test("a block image a resolver misses shows its alt text; without a resolver the line reads as before", () => {
    for (const variant of ["chat", "document"] as const) {
      for (const resolve of [() => undefined, (src: string) => (src === "images/other.webp" ? shot : undefined)]) {
        const host = document.createElement("div");
        host.innerHTML = renderToStaticMarkup(<Markdown content={BLOCK} variant={variant} resolveImage={resolve} />);
        expect(host.querySelector("img")).toBeNull();
        expect(host.querySelector("a")).toBeNull();
        expect(host.innerHTML).toContain('<p class="sui-md-p">The repository home with its file tree</p>');
        expect(host.textContent).not.toContain("!");
      }
      expect(renderToStaticMarkup(<Markdown content={BLOCK} variant={variant} />)).not.toContain("<img");
    }
    // No resolver: the chat line keeps main's rendering, a bang and a link to the file.
    expect(renderToStaticMarkup(<Markdown content={"![Gone](images/missing.webp)"} />)).toContain("!");
  });

  test("an image inside a paragraph, list or table is never drawn, even when it resolves", () => {
    for (const variant of ["chat", "document"] as const) {
      for (const content of [
        "See ![the home](images/repo-home.webp) here.",
        "- ![the home](images/repo-home.webp)",
        "| a |\n| --- |\n| ![the home](images/repo-home.webp) |",
      ]) {
        const html = renderToStaticMarkup(<Markdown content={content} variant={variant} resolveImage={resolveImage} />);
        expect({ variant, content, img: html.includes("<img") }).toEqual({ variant, content, img: false });
      }
    }
  });

  test("an image line ends the paragraph above it", () => {
    const html = renderToStaticMarkup(
      <Markdown content={"Open the repository.\n![The repository home](images/repo-home.webp)"} resolveImage={resolveImage} />,
    );
    expect(html).toContain('<p class="sui-md-p">Open the repository.</p><figure class="sui-md-figure">');
    expect(markdownBlockParser.scan("Text\n![a](b.webp)\nMore").map((span) => span.kind)).toEqual([
      "paragraph",
      "image",
      "paragraph",
    ]);
  });

  test("the sheet shows only the variant that matches html[data-theme]", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const shown: Record<string, Array<string | null>> = {};
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-theme", theme);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(<Markdown content={BLOCK} resolveImage={resolveImage} />));
        shown[theme] = [...host.querySelectorAll("img")]
          .filter((img) => getComputedStyle(img).display !== "none")
          .map((img) => img.getAttribute("data-variant"));
      } finally {
        await act(async () => root.unmount());
        host.remove();
        document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
        document.documentElement.removeAttribute("data-theme");
      }
    }
    expect(shown).toEqual({ light: ["light"], dark: ["dark"] });
  });

  test("a new resolver re-renders completed blocks", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Markdown content={BLOCK} />));
      expect(host.querySelector("img")).toBeNull();
      await act(async () => root.render(<Markdown content={BLOCK} resolveImage={resolveImage} />));
      expect(host.querySelectorAll("img")).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
    }
  });
});

describe("Markdown (baseUrl)", () => {
  const hrefs = (html: string) => [...html.matchAll(/<a class="sui-md-link"(?: href="([^"]*)")?/g)].map((match) => match[1]);

  test("resolves relative links against the document's URL and keeps absolute ones", () => {
    const html = renderToStaticMarkup(
      <Markdown
        variant="document"
        baseUrl="https://docs.example/guide/intro.md"
        content={"[a](/setup/vite.md) [b](./next.md) [c](#part) [d](https://other.example/x) [e](mailto:a@b.c)"}
      />,
    );
    expect(hrefs(html)).toEqual([
      "https://docs.example/setup/vite.md",
      "https://docs.example/guide/next.md",
      "https://docs.example/guide/intro.md#part",
      "https://other.example/x",
      "mailto:a@b.c",
    ]);
  });

  test("never turns an unsafe link into an href, with or without a base", () => {
    const html = renderToStaticMarkup(
      <Markdown variant="document" baseUrl="https://docs.example/a.md" content={"[x](javascript:alert(1)) <a href=\"javascript:alert(1)\">y</a>"} />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain("x");
  });

  test("leaves relative links as written without a base, or with one that isn't a URL", () => {
    expect(hrefs(renderToStaticMarkup(<Markdown content="[a](/x.md)" />))).toEqual(["/x.md"]);
    expect(hrefs(renderToStaticMarkup(<Markdown baseUrl="not a url" content="[a](/x.md)" />))).toEqual(["/x.md"]);
  });
});
