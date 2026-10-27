/** @jsxImportSource react */
// RepositoryHome under happy-dom: real createRoot + act. Clicks reach a host
// listener on the document that prevents them, so no link navigates the shared window.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Home } from "@smthrs/views";
import { LinkTabs, RepositoryHome, type RepositoryHomeList, type RepositoryHomeLive, smithersUiCss } from "../src";
import { highlight } from "../src/repository-home/highlight";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  if (root === undefined) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const mounted = root;
  await act(async () => mounted.render(element));
}

const $ = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const $$ = <E extends Element = HTMLElement>(selector: string) => [...container!.querySelectorAll<E>(selector)];
const block = (kind: string) => $(`[data-slot='repository-home-block'][data-kind='${kind}']`);
const texts = (elements: ReadonlyArray<Element>) => elements.map((element) => element.textContent);

const ASK = "https://smithers.test/maya/tinyhttp?ask=1";

/** A home of one section for everyone holding `blocks`, as a file with bare `blocks` reads. */
const one = (blocks: ReadonlyArray<Home.Block>): ReadonlyArray<Home.Section> => [{ audience: "everyone", blocks }];

/** Clicks `link`; reports whether it was already default-prevented when it reached the host, which then prevents it. */
async function click(link: HTMLElement, init: MouseEventInit = {}): Promise<boolean> {
  let prevented: boolean | undefined;
  const host = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", host);
  try {
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
  } finally {
    document.removeEventListener("click", host);
  }
  if (prevented === undefined) throw new Error("the click never reached the document");
  return prevented;
}

describe("RepositoryHome: text", () => {
  test("a titled text block is an h3 over its text in a paragraph", async () => {
    await render(<RepositoryHome sections={one([{ type: "text", title: "About", text: "A tiny HTTP server.\nNo deps." }])} />);
    const text = block("text")!;
    expect(text.querySelector("h3")!.textContent).toBe("About");
    expect(text.querySelector("p")!.textContent).toBe("A tiny HTTP server.\nNo deps.");
  });

  test("the title is optional", async () => {
    await render(<RepositoryHome sections={one([{ type: "text", text: "Hello." }])} />);
    expect(block("text")!.querySelector("h3")).toBeNull();
    expect(block("text")!.querySelector("p")!.textContent).toBe("Hello.");
  });

  test("text that looks like markup is shown as text, never as elements", async () => {
    const text = '<img src=x onerror="alert(1)"><b>bold</b>';
    await render(<RepositoryHome sections={one([{ type: "text", title: "<i>t</i>", text }])} />);
    expect(block("text")!.querySelector("p")!.textContent).toBe(text);
    expect(block("text")!.querySelector("h3")!.textContent).toBe("<i>t</i>");
    expect($("img")).toBeNull();
    expect($("b")).toBeNull();
    expect($("i")).toBeNull();
  });

  test("its sheet keeps line breaks, reflows by its own width, and is part of smithersUiCss", () => {
    expect(smithersUiCss).toMatch(/\.sui-repository-home-text \{[^}]*white-space:pre-wrap/);
    expect(smithersUiCss).toMatch(/\.sui-repository-home \{[^}]*container-type:inline-size/);
    expect(smithersUiCss).toContain("@container (max-width: 640px)");
    expect(smithersUiCss).toContain(".sui-repository-home-apps");
  });
});

describe("RepositoryHome: links", () => {
  test("each link opens its URL in a new tab with no opener or referrer, labelled as text", async () => {
    await render(
      <RepositoryHome
        sections={one([
          {
            type: "links",
            title: "Docs",
            links: [
              { label: "Install", url: "https://smithers.sh/" },
              { label: "<b>Report</b>", url: "http://example.com/bug?x=1" },
            ],
          },
        ])}
      />,
    );
    const links = block("links")!;
    expect(links.querySelector("h3")!.textContent).toBe("Docs");
    const anchors = [...links.querySelectorAll<HTMLAnchorElement>("ul > li > a")];
    expect(anchors.map((a) => [a.textContent, a.getAttribute("href"), a.target, a.rel])).toEqual([
      ["Install", "https://smithers.sh/", "_blank", "noopener noreferrer"],
      ["<b>Report</b>", "http://example.com/bug?x=1", "_blank", "noopener noreferrer"],
    ]);
    expect($("b")).toBeNull();
  });

  test("a link that isn't absolute http or https is not drawn, and a block with none left draws nothing", async () => {
    await render(
      <RepositoryHome
        sections={one([
          {
            type: "links",
            links: [
              { label: "Script", url: "javascript:alert(1)" },
              { label: "Relative", url: "/settings" },
              { label: "Tab", url: "https://exa\tmple.com/" },
              { label: "Kept", url: "HTTPS://example.com/" },
            ],
          },
        ])}
      />,
    );
    expect(texts($$("a"))).toEqual(["Kept"]);

    await render(<RepositoryHome sections={one([{ type: "links", links: [{ label: "Script", url: "javascript:alert(1)" }] }])} />);
    expect(container!.innerHTML).toBe("");
  });
});

describe("RepositoryHome: markdown", () => {
  const readme = { type: "markdown", path: "docs/README.md", title: "Read me" } as const;

  test("a path absent from files is loading, with an accessible name", async () => {
    await render(<RepositoryHome sections={one([readme])} />);
    const loading = block("markdown")!.querySelector("[role='status']")!;
    expect(loading.getAttribute("aria-label")).toBe("Loading docs/README.md");
    expect(loading.querySelectorAll("[data-slot='skeleton']")).toHaveLength(3);
    expect(block("markdown")!.querySelector("[data-slot='spinner']")).toBeNull();
    expect(block("markdown")!.querySelector("h3")!.textContent).toBe("Read me");
    expect(block("markdown")!.querySelector("[data-slot='markdown']")).toBeNull();
  });

  test("an explicit loading file is loading too", async () => {
    await render(<RepositoryHome sections={one([readme])} files={{ "docs/README.md": { state: "loading" } }} />);
    expect(block("markdown")!.querySelector("[role='status']")!.getAttribute("aria-label")).toBe("Loading docs/README.md");
  });

  test("a path an object inherits is not a file the host holds", async () => {
    await render(<RepositoryHome sections={one([{ type: "markdown", path: "constructor" }])} files={{}} />);
    expect(block("markdown")!.querySelector("[role='status']")!.getAttribute("aria-label")).toBe("Loading constructor");
  });

  test("read text renders as a document", async () => {
    await render(
      <RepositoryHome
        sections={one([readme])}
        files={{ "docs/README.md": { state: "text", text: "# tinyhttp\n\nSmall and **fast**." } }}
      />,
    );
    const markdown = block("markdown")!.querySelector("[data-slot='markdown']")!;
    expect(markdown.querySelector(".sui-md-h1")!.textContent).toBe("tinyhttp");
    expect(markdown.querySelector("strong")!.textContent).toBe("fast");
    expect(block("markdown")!.querySelector("[role='status']")).toBeNull();
  });

  test("a failed read is one status line naming the path", async () => {
    await render(<RepositoryHome sections={one([readme])} files={{ "docs/README.md": { state: "failed" } }} />);
    const status = block("markdown")!.querySelector("[role='status']")!;
    expect(status.tagName).toBe("P");
    expect(status.textContent).toBe("Couldn't read docs/README.md");
    expect(block("markdown")!.querySelector("[data-slot='markdown']")).toBeNull();
  });
});

describe("RepositoryHome: prompt", () => {
  test("a band with its title and a link to askHref named by its placeholder", async () => {
    await render(
      <RepositoryHome
        askHref={ASK}
        sections={one([{ type: "prompt", title: "What should we work on?", placeholder: "Ask about tinyhttp" }])}
      />,
    );
    const prompt = block("prompt")!;
    expect(prompt.querySelector(".sui-rh-ask h3")!.textContent).toBe("What should we work on?");
    const link = prompt.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe(ASK);
    expect(link.childNodes[0]!.textContent).toBe("Ask about tinyhttp");
    // The key at its end is decoration: it isn't part of the link's name.
    expect(link.querySelector(".sui-rh-ask-key")!.getAttribute("aria-hidden")).toBe("true");
    expect(prompt.querySelector("button")).toBeNull();
  });

  test("without a placeholder it reads Ask Smithers, and without a title it has no heading", async () => {
    await render(<RepositoryHome askHref={ASK} sections={one([{ type: "prompt" }])} />);
    expect(block("prompt")!.querySelector("a")!.childNodes[0]!.textContent).toBe("Ask Smithers");
    expect(block("prompt")!.querySelector("h3")).toBeNull();
  });

  test("with onAsk, a plain click is the host's: default prevented, onAsk gets the flow or undefined", async () => {
    const asked: Array<string | undefined> = [];
    await render(
      <RepositoryHome
        askHref={ASK}
        onAsk={(flow) => asked.push(flow)}
        sections={one([{ type: "prompt", flow: "wiki.ask", placeholder: "Ask the wiki" }, { type: "prompt" }])}
      />,
    );
    const [withFlow, withoutFlow] = $$<HTMLAnchorElement>("[data-kind='prompt'] a");
    expect(await click(withFlow!)).toBe(true);
    expect(await click(withoutFlow!)).toBe(true);
    expect(asked).toEqual(["wiki.ask", undefined]);
    expect(withFlow!.getAttribute("href")).toBe(ASK);
  });

  test("a modified or non-primary click keeps the browser's behavior and doesn't call onAsk", async () => {
    const asked: Array<string | undefined> = [];
    await render(
      <RepositoryHome askHref={ASK} onAsk={(flow) => asked.push(flow)} sections={one([{ type: "prompt", flow: "wiki.ask" }])} />,
    );
    const link = block("prompt")!.querySelector<HTMLAnchorElement>("a")!;
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect([init, await click(link, init)]).toEqual([init, false]);
    }
    expect(asked).toEqual([]);
  });

  test("without onAsk the button is a plain link: a click keeps its default", async () => {
    await render(<RepositoryHome askHref={ASK} sections={one([{ type: "prompt" }])} />);
    expect(await click(block("prompt")!.querySelector("a")!)).toBe(false);
  });

  test("not drawn without askHref", async () => {
    await render(<RepositoryHome sections={one([{ type: "prompt", title: "Ask" }, { type: "text", text: "Hi." }])} />);
    expect(block("prompt")).toBeNull();
    expect(block("text")).not.toBeNull();
  });
});

describe("RepositoryHome: app", () => {
  const fix = { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" } as const;
  const review = { type: "app", flow: "prs.triage", title: "Review a PR", picture: "review" } as const;
  const wiki = { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" } as const;
  const all = () => true;

  test("an offered app is a link-button to askHref labelled by its title, wearing its picture", async () => {
    await render(<RepositoryHome askHref={ASK} offered={all} sections={one([fix])} />);
    const app = block("app")!;
    const link = app.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe(ASK);
    expect(link.textContent).toBe("Fix an issue");
    expect(link.dataset.picture).toBe("issue");
    expect(link.classList.contains("sui-button-outline")).toBe(true);
    expect(app.querySelector("h3")).toBeNull();
  });

  test("with onAsk, a plain click prevents the default and tells onAsk its flow; a modified click doesn't", async () => {
    const asked: Array<string | undefined> = [];
    await render(<RepositoryHome askHref={ASK} offered={all} onAsk={(flow) => asked.push(flow)} sections={one([fix])} />);
    const link = block("app")!.querySelector<HTMLAnchorElement>("a")!;
    expect(await click(link, { metaKey: true })).toBe(false);
    expect(asked).toEqual([]);
    expect(await click(link)).toBe(true);
    expect(asked).toEqual(["issue.implement"]);
    expect(link.getAttribute("href")).toBe(ASK);
  });

  test("without onAsk an app button is a plain link", async () => {
    await render(<RepositoryHome askHref={ASK} offered={all} sections={one([fix])} />);
    expect(await click(block("app")!.querySelector("a")!)).toBe(false);
  });

  test("hidden when the page hasn't its flow, and with no offered at all", async () => {
    const seen: Array<string> = [];
    await render(
      <RepositoryHome askHref={ASK} offered={(flow) => (seen.push(flow), flow === "prs.triage")} sections={one([fix, review])} />,
    );
    expect(texts($$("[data-kind='app'] a"))).toEqual(["Review a PR"]);
    expect(seen).toEqual(["issue.implement", "prs.triage"]);

    await render(<RepositoryHome askHref={ASK} sections={one([fix, { type: "text", text: "Hi." }])} />);
    expect(block("app")).toBeNull();
    expect(block("text")).not.toBeNull();
  });

  test("hidden without askHref even when offered", async () => {
    await render(<RepositoryHome offered={all} sections={one([fix])} />);
    expect(container!.innerHTML).toBe("");
  });

  test("adjacent apps share one wrapping row; other drawn blocks split rows", async () => {
    await render(
      <RepositoryHome
        askHref={ASK}
        offered={(flow) => flow !== "hidden"}
        sections={one([
          fix,
          { type: "app", flow: "hidden", title: "Hidden", picture: "wiki" },
          review,
          { type: "flows" },
          wiki,
          { type: "text", text: "Between." },
          fix,
        ])}
      />,
    );
    const section = $("[data-slot='repository-home-section']")!;
    const rows = [...section.children].map((child) =>
      child.getAttribute("data-slot") === "repository-home-apps"
        ? texts([...child.querySelectorAll("a")])
        : child.getAttribute("data-kind")
    );
    expect(rows).toEqual([["Fix an issue", "Review a PR", "Ask the codebase"], "text", ["Fix an issue"]]);
  });
});

describe("RepositoryHome: hero", () => {
  const hero: Home.Block = {
    type: "hero",
    title: "Effect",
    tagline: "Build production-ready applications in TypeScript.",
    text: "Typed errors and retries in one library.",
    install: "npm install effect",
    actions: [
      { label: "Get started", url: "https://effect.website/docs" },
      { label: "Playground", url: "https://effect.website/play" },
      { label: "Bad", url: "javascript:alert(1)" },
    ],
    announcement: { label: "Effect 4.0 is here", url: "https://effect.website/blog" },
  };

  test("its announcement, name, tagline, text, actions (the first primary) and install command", async () => {
    await render(<RepositoryHome sections={one([hero])} />);
    const drawn = block("hero")!;
    const announce = drawn.querySelector<HTMLAnchorElement>(".sui-rh-announce")!;
    expect([announce.childNodes[0]!.textContent, announce.href, announce.target]).toEqual([
      "Effect 4.0 is here",
      "https://effect.website/blog",
      "_blank",
    ]);
    expect(drawn.querySelector("h2")!.textContent).toBe("Effect");
    expect(drawn.querySelector(".sui-rh-hero-tagline")!.textContent).toBe(hero.tagline!);
    expect(drawn.querySelector(".sui-rh-hero-text")!.textContent).toBe(hero.text!);
    const actions = [...drawn.querySelectorAll<HTMLAnchorElement>(".sui-rh-action")];
    expect(actions.map((a) => [a.textContent, a.getAttribute("href"), a.rel])).toEqual([
      ["Get started", "https://effect.website/docs", "noopener noreferrer"],
      ["Playground", "https://effect.website/play", "noopener noreferrer"],
    ]);
    expect(actions.map((a) => a.classList.contains("sui-rh-action-primary"))).toEqual([true, false]);
    expect(drawn.querySelector(".sui-rh-install code")!.textContent).toBe("npm install effect");
    expect(drawn.querySelector(".sui-rh-install code")!.getAttribute("tabindex")).toBe("0");
    expect(drawn.querySelector(".sui-rh-install-prompt")!.getAttribute("aria-hidden")).toBe("true");
  });

  test("just a name when that's all it declares", async () => {
    await render(<RepositoryHome sections={one([{ type: "hero", title: "tinyhttp" }])} />);
    const drawn = block("hero")!;
    expect(drawn.querySelector("h2")!.textContent).toBe("tinyhttp");
    for (const part of [".sui-rh-announce", ".sui-rh-hero-tagline", ".sui-rh-hero-text", ".sui-rh-hero-actions", ".sui-rh-install"]) {
      expect([part, drawn.querySelector(part)]).toEqual([part, null]);
    }
  });

  test("Copy puts the install command on the clipboard the host gives, says Copied, and says when it failed", async () => {
    const copied: Array<string> = [];
    await render(<RepositoryHome sections={one([hero])} onCopy={(text) => void copied.push(text)} />);
    const copy = block("hero")!.querySelector<HTMLButtonElement>(".sui-rh-copy")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy npm install effect");
    await act(async () => copy.click());
    expect(copied).toEqual(["npm install effect"]);
    expect([copy.textContent, copy.dataset.copied]).toEqual(["Copied", "true"]);

    await render(<RepositoryHome sections={one([hero])} onCopy={() => Promise.reject(new Error("denied"))} />);
    const failing = block("hero")!.querySelector<HTMLButtonElement>(".sui-rh-copy")!;
    await act(async () => failing.click());
    expect([failing.textContent, failing.dataset.copyFailed]).toEqual(["Copy failed", "true"]);
  });

  test("an announcement whose URL isn't http or https is not drawn", async () => {
    await render(<RepositoryHome sections={one([{ type: "hero", title: "X", announcement: { label: "New", url: "data:text/html,x" } }])} />);
    expect($(".sui-rh-announce")).toBeNull();
  });
});

describe("RepositoryHome: code", () => {
  const code: Home.Block = {
    type: "code",
    title: "Example",
    file: "fetch-user.ts",
    language: "ts",
    code: 'import { Effect } from "effect"\n// Retried.\nconst n: number = 3\nEffect.runPromise(main)',
  };

  test("a figure named by its file, with its title, the source as text, colored, and Copy", async () => {
    const copied: Array<string> = [];
    await render(<RepositoryHome sections={one([code])} onCopy={(text) => void copied.push(text)} />);
    const drawn = block("code")!;
    expect(drawn.querySelector("h3")!.textContent).toBe("Example");
    const figure = drawn.querySelector("figure")!;
    expect(figure.getAttribute("aria-label")).toBe("fetch-user.ts");
    expect(figure.querySelector(".sui-rh-code-name")!.textContent).toBe("fetch-user.ts");
    const source = figure.querySelector("pre code")!;
    expect(source.textContent).toBe(code.type === "code" ? code.code : "");
    expect(source.getAttribute("data-language")).toBe("ts");
    expect(texts([...source.querySelectorAll(".sui-rh-tok-keyword")])).toEqual(["import", "from", "const"]);
    expect(texts([...source.querySelectorAll(".sui-rh-tok-string")])).toEqual(['"effect"']);
    expect(texts([...source.querySelectorAll(".sui-rh-tok-comment")])).toEqual(["// Retried."]);
    // A capitalized name is a type, unless it is a namespace before `.`.
    expect(texts([...source.querySelectorAll(".sui-rh-tok-type")])).toEqual(["Effect", "number"]);
    expect(texts([...source.querySelectorAll(".sui-rh-tok-call")])).toEqual(["runPromise"]);
    await act(async () => figure.querySelector<HTMLButtonElement>(".sui-rh-copy")!.click());
    expect(copied).toEqual([code.type === "code" ? code.code : ""]);
  });

  test("markup in the source is text, never elements", async () => {
    await render(<RepositoryHome sections={one([{ type: "code", language: "tsx", code: "const a = <img src=x onerror=alert(1) />" }])} />);
    expect($("img")).toBeNull();
    expect($("pre code")!.textContent).toBe("const a = <img src=x onerror=alert(1) />");
    expect($("figure")!.getAttribute("aria-label")).toBe("tsx");
  });

  test("with no file or language it is named Code and stays plain", async () => {
    await render(<RepositoryHome sections={one([{ type: "code", code: "make all\nmake test" }])} />);
    expect($("figure")!.getAttribute("aria-label")).toBe("Code");
    expect($$("pre code [class^='sui-rh-tok-']")).toEqual([]);
    expect($("pre code")!.textContent).toBe("make all\nmake test");
  });

  test("a hero and the code right after it share one row; code alone or apart doesn't", async () => {
    const hero: Home.Block = { type: "hero", title: "Effect" };
    await render(<RepositoryHome sections={one([hero, code, { type: "text", text: "a" }, code])} />);
    const section = $("[data-slot='repository-home-section']")!;
    expect([...section.children].map((child) => child.getAttribute("data-slot") === "repository-home-lead"
      ? [...child.children].map((each) => each.getAttribute("data-kind"))
      : child.getAttribute("data-kind")
    )).toEqual([["hero", "code"], "text", "code"]);
  });
});

describe("RepositoryHome: highlight", () => {
  const kinds = (code: string, language = "ts") =>
    highlight(code, language).map((line) => line.map((token) => [token.text, token.kind ?? "plain"]));

  test("joined back, the tokens are the source, line for line", () => {
    const source = "const s = `a\nb` /* c\nd */ + 'x' + \"y\\\"z\" + 1_000.5\nfoo()";
    expect(highlight(source, "ts").map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(source);
  });

  test("a token across lines keeps its kind on each line", () => {
    expect(kinds("/* a\nb */")).toEqual([[["/* a", "comment"]], [["b */", "comment"]]]);
    expect(kinds("`a\n\nb`")).toEqual([[["`a", "string"]], [], [["b`", "string"]]]);
  });

  test("keywords, types, calls and namespaces", () => {
    expect(kinds("new FetchError({ cause }) as Effect.Effect<A>")).toEqual([[
      ["new", "keyword"],
      [" ", "plain"],
      ["FetchError", "call"],
      ["({ cause }) ", "plain"],
      ["as", "keyword"],
      [" Effect.", "plain"],
      ["Effect", "type"],
      ["<", "plain"],
      ["A", "type"],
      [">", "plain"],
    ]]);
  });

  test("unterminated strings and comments run to the end, never throwing", () => {
    expect(kinds('"open')).toEqual([[['"open', "string"]]]);
    expect(kinds("/* open")).toEqual([[["/* open", "comment"]]]);
  });

  test("VibeLang's own keywords color in a .vibe block, and stay plain words in TypeScript", () => {
    expect(kinds("service Users { }", "vibe")[0]![0]).toEqual(["service", "keyword"]);
    expect(kinds("provide Live { }", "vibe")[0]![0]).toEqual(["provide", "keyword"]);
    expect(kinds("service Users { }", "ts")[0]![0]).toEqual(["service ", "plain"]);
  });

  test("another language, or none, is plain", () => {
    expect(kinds("const a = 1", "sh")).toEqual([[["const a = 1", "plain"]]]);
    expect(highlight("a\nb", undefined)).toEqual([[{ text: "a" }], [{ text: "b" }]]);
  });
});

describe("RepositoryHome: cards", () => {
  test("a grid of cards, each with its label, title and line; a card with a URL opens it in a new tab", async () => {
    await render(
      <RepositoryHome
        sections={one([{
          type: "cards",
          title: "Ecosystem",
          cards: [
            { title: "Core", text: "Effect and Schema.", label: "effect", url: "https://www.npmjs.com/package/effect" },
            { title: "Typed errors" },
            { title: "Bad link", url: "javascript:alert(1)" },
          ],
          more: { label: "All packages", url: "https://github.com/Effect-TS/effect#packages" },
        }])}
      />,
    );
    const drawn = block("cards")!;
    expect(drawn.querySelector("h3")!.textContent).toBe("Ecosystem");
    const cards = [...drawn.querySelectorAll(".sui-rh-cards > li > .sui-rh-card")];
    expect(cards.map((card) => [card.tagName, card.querySelector("h4")!.textContent])).toEqual([
      ["A", "Core"],
      ["DIV", "Typed errors"],
      ["DIV", "Bad link"],
    ]);
    const [core] = cards as Array<HTMLAnchorElement>;
    expect([core!.href, core!.target, core!.rel]).toEqual(["https://www.npmjs.com/package/effect", "_blank", "noopener noreferrer"]);
    expect(core!.querySelector(".sui-rh-card-label")!.textContent).toBe("effect");
    expect(core!.querySelector(".sui-rh-card-text")!.textContent).toBe("Effect and Schema.");
    expect(cards[1]!.querySelector(".sui-rh-card-label")).toBeNull();
    expect(cards[1]!.querySelector(".sui-rh-card-text")).toBeNull();
    const more = drawn.querySelector<HTMLAnchorElement>(".sui-rh-more")!;
    expect([more.childNodes[0]!.textContent, more.href]).toEqual(["All packages", "https://github.com/Effect-TS/effect#packages"]);
  });

  test("four columns for a count four divides and three doesn't, else three", async () => {
    const cards = (count: number): Home.Block => ({ type: "cards", cards: Array.from({ length: count }, (_, index) => ({ title: `c${index}` })) });
    const columns = [];
    for (const count of [1, 4, 6, 8, 12]) {
      await render(<RepositoryHome sections={one([cards(count)])} />);
      columns.push([count, $(".sui-rh-cards")!.getAttribute("data-columns")]);
    }
    expect(columns).toEqual([[1, "3"], [4, "4"], [6, "3"], [8, "4"], [12, "3"]]);
    expect(smithersUiCss).toMatch(/\.sui-rh-ask-title \{[^}]*color:/);
  });

  test("no More link when it declares none", async () => {
    await render(<RepositoryHome sections={one([{ type: "cards", cards: [{ title: "a" }] }])} />);
    expect($(".sui-rh-more")).toBeNull();
  });
});

describe("RepositoryHome: stats", () => {
  test("a description list: each stat's label as the term and its value as the description", async () => {
    await render(
      <RepositoryHome sections={one([{ type: "stats", title: "Facts", stats: [{ value: "MIT", label: "License" }, { value: "0", label: "Dependencies" }] }])} />,
    );
    const list = block("stats")!.querySelector("dl")!;
    expect([...list.children].map((stat) => [stat.querySelector("dt")!.textContent, stat.querySelector("dd")!.textContent]))
      .toEqual([["License", "MIT"], ["Dependencies", "0"]]);
    expect(block("stats")!.querySelector("h3")!.textContent).toBe("Facts");
  });
});

describe("RepositoryHome: releases", () => {
  test("each release's name opens its page; its line; its date as a date", async () => {
    await render(
      <RepositoryHome
        sections={one([{
          type: "releases",
          title: "Releases",
          releases: [
            { name: "effect@3.22.3", url: "https://github.com/Effect-TS/effect/releases/tag/effect%403.22.3", date: "2026-10-16", summary: "LayerMap fix." },
            { name: "effect@4.0.5", url: "https://github.com/Effect-TS/effect/releases/tag/effect%404.0.5", date: "2026-01-01" },
          ],
          more: { label: "All releases", url: "https://github.com/Effect-TS/effect/releases" },
        }])}
      />,
    );
    const rows = $$(".sui-rh-release");
    expect(rows.map((row) => [
      row.querySelector("a")!.textContent,
      row.querySelector("a")!.getAttribute("href"),
      row.querySelector(".sui-rh-release-summary")?.textContent ?? null,
      row.querySelector("time")!.getAttribute("datetime"),
      row.querySelector("time")!.textContent,
    ])).toEqual([
      ["effect@3.22.3", "https://github.com/Effect-TS/effect/releases/tag/effect%403.22.3", "LayerMap fix.", "2026-10-16", "Oct 16, 2026"],
      ["effect@4.0.5", "https://github.com/Effect-TS/effect/releases/tag/effect%404.0.5", null, "2026-01-01", "Jan 1, 2026"],
    ]);
    expect(block("releases")!.querySelector(".sui-rh-more")!.getAttribute("href")).toBe("https://github.com/Effect-TS/effect/releases");
  });
});

const NOW = Date.now();

const list = (prefix: string, total: number, href?: string): RepositoryHomeList => ({
  total,
  ...(href === undefined ? {} : { href }),
  entries: Array.from({ length: Math.min(total, 2) }, (_, index) => ({
    key: `${prefix}${index}`,
    label: `${prefix}${index + 1}`,
    title: `${prefix} title ${index + 1}`,
    href: `/maya/tinyhttp/${prefix}/${index + 1}`,
    status: { status: "running", label: "Running" },
    at: NOW - 60_000,
  })),
});

const live: RepositoryHomeLive = {
  issues: {
    proposed: 3,
    accepted: 12,
    notAccepted: 1,
    triage: list("#", 3, "/maya/tinyhttp/issues"),
    pulls: list("pr", 2),
    href: "/maya/tinyhttp/issues",
  },
  stack: list("T", 4, "/maya/tinyhttp/stack"),
  runs: { ...list("run", 5), failed: 2 },
  flows: [
    { flow: "flow.run release-notes", name: "release-notes", title: "Summarize merged PRs since the last tag." },
    { flow: "flow.run triage", name: "triage", title: "Triage new issues." },
  ],
};

describe("RepositoryHome: live blocks", () => {
  test("issues: four counts linking to the issues page, then the issues to triage and the pull requests waiting", async () => {
    await render(<RepositoryHome sections={one([{ type: "issues" }])} live={live} />);
    const counts = $$<HTMLAnchorElement>("[data-slot='repository-home-counts'] a");
    expect(counts.map((count) => [count.getAttribute("aria-label"), count.getAttribute("href")])).toEqual([
      ["3 Proposed", "/maya/tinyhttp/issues"],
      ["12 Accepted", "/maya/tinyhttp/issues"],
      ["1 Not accepted", "/maya/tinyhttp/issues"],
      ["2 Pull requests", "/maya/tinyhttp/issues"],
    ]);
    expect(counts.map((count) => count.classList.contains("sui-rh-tile-warning"))).toEqual([true, false, false, false]);
    const panels = $$("[data-slot='repository-home-panel']");
    expect(panels.map((panel) => [panel.dataset.panel, panel.querySelector("h3")!.textContent, panel.querySelector(".sui-rh-count")!.textContent]))
      .toEqual([["triage", "Needs triage", "3"], ["pulls", "Pull requests waiting", "2"]]);
    expect(texts([...panels[0]!.querySelectorAll(".sui-rh-entry-label")])).toEqual(["#1", "#2"]);
  });

  test("issues: nothing proposed is no warning; a titled block's panels sit one level under its title", async () => {
    const issues = { ...(live.issues as Exclude<RepositoryHomeLive["issues"], { notice: string } | undefined>), proposed: 0 };
    await render(<RepositoryHome sections={one([{ type: "issues", title: "Triage" }])} live={{ issues }} />);
    expect($(".sui-rh-tile-warning")).toBeNull();
    expect(block("issues")!.querySelector("h3")!.textContent).toBe("Triage");
    expect(texts($$("[data-slot='repository-home-panel'] h4"))).toEqual(["Needs triage", "Pull requests waiting"]);
  });

  test("each row: its label, its title linking in the app, its state, and how long ago", async () => {
    await render(<RepositoryHome sections={one([{ type: "stack" }])} live={live} />);
    const row = $("[data-slot='repository-home-entry']")!;
    expect(row.querySelector(".sui-rh-entry-label")!.textContent).toBe("T1");
    const title = row.querySelector<HTMLAnchorElement>("a.sui-rh-entry-title")!;
    expect([title.textContent, title.getAttribute("href"), title.target]).toEqual(["T title 1", "/maya/tinyhttp/T/1", ""]);
    expect(row.querySelector("[data-status='running']")!.textContent).toBe("Running");
    expect(row.querySelector("time")!.textContent).toBe("1m ago");
  });

  test("a row without a label, state or time is just its title; one with an unsafe href is text", async () => {
    await render(
      <RepositoryHome
        sections={one([{ type: "stack" }])}
        live={{
          stack: {
            total: 2,
            entries: [{ key: "a", title: "Plain", href: "/a" }, { key: "b", title: "Unsafe", href: "javascript:alert(1)" }],
          },
        }}
      />,
    );
    const [plain, unsafe] = $$("[data-slot='repository-home-entry']");
    expect([...plain!.children].map((child) => child.tagName)).toEqual(["A"]);
    expect([...unsafe!.children].map((child) => [child.tagName, child.textContent])).toEqual([["SPAN", "Unsafe"]]);
  });

  test("a link in the app: a plain click calls onNavigate; a modified one, or none without it, is the browser's", async () => {
    const went: Array<string> = [];
    await render(<RepositoryHome sections={one([{ type: "stack" }])} live={live} onNavigate={(href) => went.push(href)} />);
    const title = $<HTMLAnchorElement>("a.sui-rh-entry-title")!;
    expect(await click(title, { metaKey: true })).toBe(false);
    expect(await click(title)).toBe(true);
    expect(went).toEqual(["/maya/tinyhttp/T/1"]);
    const heading = $<HTMLAnchorElement>("a.sui-rh-panel-link")!;
    expect(await click(heading)).toBe(true);
    expect(went).toEqual(["/maya/tinyhttp/T/1", "/maya/tinyhttp/stack"]);

    await render(<RepositoryHome sections={one([{ type: "stack" }])} live={live} />);
    expect(await click($<HTMLAnchorElement>("a.sui-rh-entry-title")!)).toBe(false);
  });

  test("an http(s) row opens in a new tab", async () => {
    await render(
      <RepositoryHome
        sections={one([{ type: "runs" }])}
        live={{ runs: { total: 1, failed: 0, entries: [{ key: "a", title: "On GitHub", href: "https://github.com/a/b/pull/1" }] } }}
      />,
    );
    const link = $<HTMLAnchorElement>("a.sui-rh-entry-title")!;
    expect([link.target, link.rel]).toEqual(["_blank", "noopener noreferrer"]);
  });

  test("stack and runs: adjacent panels share one grid; runs counts its failures; an empty list says None", async () => {
    await render(
      <RepositoryHome
        sections={one([{ type: "stack", title: "Your TODOs" }, { type: "runs" }, { type: "text", text: "a" }, { type: "runs" }])}
        live={{ ...live, runs: { total: 0, failed: 0, entries: [] } }}
      />,
    );
    const section = $("[data-slot='repository-home-section']")!;
    expect([...section.children].map((child) => child.getAttribute("data-slot") === "repository-home-panels"
      ? [...child.children].map((each) => each.getAttribute("data-kind"))
      : child.getAttribute("data-kind")
    )).toEqual([["stack", "runs"], "text", ["runs"]]);
    expect(texts($$(".sui-rh-panel-title"))).toEqual(["Your TODOs", "Runs", "Runs"]);
    expect(texts($$("[data-panel='runs'] .sui-rh-empty"))).toEqual(["None", "None"]);

    await render(<RepositoryHome sections={one([{ type: "runs", title: "Recent runs" }])} live={live} />);
    expect($("[data-panel='runs'] .sui-rh-count")!.textContent).toBe("2 failed");
    expect($("[data-panel='runs'] .sui-rh-count-failed")).not.toBeNull();
  });

  test("a live block whose host says why it has no rows shows its heading and that line", async () => {
    await render(
      <RepositoryHome
        sections={one([{ type: "issues" }, { type: "stack" }, { type: "runs", title: "Builds" }])}
        live={{ issues: { notice: "Not synced" }, stack: { notice: "Sign in" }, runs: { notice: "Offline" } }}
      />,
    );
    expect($$("[data-slot='repository-home-panel']").map((panel) => [
      panel.dataset.panel,
      panel.querySelector("h3")!.textContent,
      panel.querySelector("[role='status']")!.textContent,
    ])).toEqual([["issues", "Issues", "Not synced"], ["stack", "Stack", "Sign in"], ["runs", "Builds", "Offline"]]);
  });

  test("flows: a button per flow, its name and line, each a link to askHref telling onAsk its flow", async () => {
    const asked: Array<string | undefined> = [];
    await render(
      <RepositoryHome sections={one([{ type: "flows", title: "Flows" }])} live={live} askHref={ASK} onAsk={(flow) => asked.push(flow)} />,
    );
    const buttons = $$<HTMLAnchorElement>(".sui-rh-flow");
    expect(buttons.map((button) => [
      button.querySelector("code")!.textContent,
      button.querySelector(".sui-rh-flow-title")!.textContent,
      button.title,
      button.getAttribute("href"),
    ])).toEqual([
      ["release-notes", "Summarize merged PRs since the last tag.", "Summarize merged PRs since the last tag.", ASK],
      ["triage", "Triage new issues.", "Triage new issues.", ASK],
    ]);
    expect(await click(buttons[1]!)).toBe(true);
    expect(asked).toEqual(["flow.run triage"]);
  });

  test("a live block without its rows, flows without askHref or with none, and a view draw nothing", async () => {
    await render(
      <RepositoryHome
        askHref={ASK}
        sections={one([{ type: "issues" }, { type: "stack" }, { type: "runs" }, { type: "flows" }, { type: "view", flow: "home" }])}
      />,
    );
    expect(container!.innerHTML).toBe("");
    await render(<RepositoryHome sections={one([{ type: "flows" }])} live={live} />);
    expect(container!.innerHTML).toBe("");
    await render(<RepositoryHome askHref={ASK} sections={one([{ type: "flows" }])} live={{ flows: [] }} />);
    expect(container!.innerHTML).toBe("");
  });
});

describe("RepositoryHome: sections", () => {
  test("each section in order, with its title and, when it isn't everyone's, who it is for", async () => {
    await render(
      <RepositoryHome
        sections={[
          { title: "Today", audience: "maintainer", blocks: [{ type: "text", text: "a" }] },
          { audience: "contributor", blocks: [{ type: "text", text: "b" }] },
          { title: "Effect", audience: "everyone", blocks: [{ type: "text", text: "c" }] },
          { audience: "everyone", blocks: [{ type: "text", text: "d" }] },
        ]}
      />,
    );
    const sections = $$("[data-slot='repository-home-section']");
    expect(sections.map((section) => [
      section.dataset.audience,
      section.getAttribute("aria-label"),
      section.querySelector("h2")?.textContent ?? null,
      section.querySelector("[data-slot='repository-home-audience']")?.textContent ?? null,
      section.querySelector(".sui-repository-home-text")!.textContent,
    ])).toEqual([
      ["maintainer", "Today", "Today", "Maintainers", "a"],
      ["contributor", null, null, "Contributors", "b"],
      ["everyone", "Effect", "Effect", null, "c"],
      ["everyone", null, null, null, "d"],
    ]);
    expect(sections[3]!.querySelector(".sui-rh-section-head")).toBeNull();
  });

  test("a section where nothing draws is left out; a home where nothing draws renders nothing", async () => {
    await render(
      <RepositoryHome
        sections={[
          { title: "Today", audience: "maintainer", blocks: [{ type: "issues" }] },
          { audience: "everyone", blocks: [{ type: "text", text: "a" }] },
        ]}
      />,
    );
    expect($$("[data-slot='repository-home-section']").map((section) => section.dataset.audience)).toEqual(["everyone"]);
    expect($("h2")).toBeNull();

    await render(
      <RepositoryHome
        sections={[
          { audience: "contributor", blocks: [{ type: "stack" }, { type: "prompt" }] },
          { audience: "everyone", blocks: [{ type: "app", flow: "wiki.ask", title: "Ask", picture: "wiki" }] },
        ]}
      />,
    );
    expect(container!.innerHTML).toBe("");
    await render(<RepositoryHome sections={[]} />);
    expect(container!.innerHTML).toBe("");
  });

  test("passes extra props to the outer section and merges its class", async () => {
    await render(
      <RepositoryHome
        id="home"
        aria-label="maya/tinyhttp home"
        data-testid="home"
        className="extra"
        sections={one([{ type: "text", text: "Hi." }])}
      />,
    );
    const section = $("section")!;
    expect(section.dataset.slot).toBe("repository-home");
    expect(section.id).toBe("home");
    expect(section.getAttribute("aria-label")).toBe("maya/tinyhttp home");
    expect(section.dataset.testid).toBe("home");
    expect([...section.classList]).toEqual(["sui-repository-home", "extra"]);
  });

  test("draws this repository's own .smithers/home.json as Home.read answers it", async () => {
    const text = readFileSync(join(import.meta.dir, "../../../../.smithers/home.json"), "utf8");
    const home = Home.read(text);
    if (home._tag !== "Declared") throw new Error(`home.json is ${home.reason}`);
    const blocks = home.sections.flatMap((section) => section.blocks);
    const markdown = blocks.flatMap((b) => (b.type === "markdown" ? [b.path] : []));
    await render(
      <RepositoryHome
        askHref={ASK}
        offered={() => true}
        sections={home.sections}
        files={Object.fromEntries(markdown.map((path) => [path, { state: "text", text: "# Fixed" }]))}
      />,
    );
    const kinds = $$("[data-slot='repository-home-block']").map((el) => el.dataset.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toEqual(blocks.filter((b) => !Home.liveKinds.includes(b.type) && b.type !== "view").map((b) => b.type));
  });
});

describe("RepositoryHome: action", () => {
  const newBranch: Home.Block = { type: "action", flow: "branch.new", title: "New branch", key: "b" };
  const offered = (flow: string) => flow === "branch.new";

  /** Presses `key` on `target` as a person would. */
  async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): Promise<boolean> {
    let prevented = false;
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    return prevented;
  }

  test("a primary button that runs its flow, naming its key; in a titled section's heading when it leads", async () => {
    const ran: Array<string> = [];
    await render(
      <RepositoryHome
        sections={[{ title: "Today", audience: "maintainer", blocks: [newBranch, { type: "text", text: "a" }] }]}
        offered={offered}
        onRun={(flow) => ran.push(flow)}
      />,
    );
    const button = $<HTMLButtonElement>(".sui-rh-section-head .sui-rh-action-button")!;
    expect([button.childNodes[0]!.textContent, button.getAttribute("aria-keyshortcuts"), button.dataset.flow]).toEqual([
      "New branch",
      "B",
      "branch.new",
    ]);
    expect(button.querySelector("kbd")!.getAttribute("aria-hidden")).toBe("true");
    await act(async () => button.click());
    expect(ran).toEqual(["branch.new"]);
    // The text after it stays in the section's body.
    expect($(".sui-rh-section > [data-kind='text']")).not.toBeNull();
  });

  test("its key presses it while the person isn't typing; never with a modifier, a repeat, or one already handled", async () => {
    const ran: Array<string> = [];
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      await render(<RepositoryHome sections={one([newBranch])} offered={offered} onRun={(flow) => ran.push(flow)} />);
      expect(await press(document.body, "b")).toBe(true);
      expect(ran).toEqual(["branch.new"]);
      for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }]) {
        expect([init, await press(document.body, "b", init)]).toEqual([init, false]);
      }
      expect(await press(input, "b")).toBe(false);
      expect(await press(document.body, "x")).toBe(false);
      const handled = (event: Event) => event.preventDefault();
      document.body.addEventListener("keydown", handled);
      await press(document.body, "b");
      document.body.removeEventListener("keydown", handled);
      expect(ran).toEqual(["branch.new"]);
    } finally {
      input.remove();
    }
  });

  test("while its flow runs it is disabled and its key does nothing; without a key it names none", async () => {
    const ran: Array<string> = [];
    await render(
      <RepositoryHome sections={one([newBranch])} offered={offered} onRun={(flow) => ran.push(flow)} running={["branch.new"]} />,
    );
    const button = $<HTMLButtonElement>(".sui-rh-action-button")!;
    expect([button.disabled, button.dataset.running]).toEqual([true, "true"]);
    expect(await press(document.body, "b")).toBe(false);
    expect(ran).toEqual([]);

    await render(
      <RepositoryHome sections={one([{ type: "action", flow: "branch.new", title: "New branch" }])} offered={offered} onRun={() => {}} />,
    );
    expect($(".sui-rh-action-button kbd")).toBeNull();
    expect($(".sui-rh-action-button")!.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  test("not drawn, nor its key bound, without onRun or a flow the page has; unmounting unbinds it", async () => {
    const ran: Array<string> = [];
    await render(<RepositoryHome sections={one([newBranch, { type: "text", text: "a" }])} offered={offered} />);
    expect($(".sui-rh-action-button")).toBeNull();
    await render(<RepositoryHome sections={one([newBranch, { type: "text", text: "a" }])} onRun={(flow) => ran.push(flow)} />);
    expect($(".sui-rh-action-button")).toBeNull();
    await render(<RepositoryHome sections={one([newBranch, { type: "text", text: "a" }])} offered={() => false} onRun={(flow) => ran.push(flow)} />);
    expect($(".sui-rh-action-button")).toBeNull();
    expect(await press(document.body, "b")).toBe(false);
    await act(async () => root!.unmount());
    root = undefined;
    expect(await press(document.body, "b")).toBe(false);
    expect(ran).toEqual([]);
  });

  test("an untitled section's actions share a row of their own", async () => {
    await render(<RepositoryHome sections={one([newBranch, newBranch])} offered={offered} onRun={() => {}} />);
    expect($$("[data-slot='repository-home-actions'] .sui-rh-action-button")).toHaveLength(2);
    expect($(".sui-rh-section-head")).toBeNull();
  });

  test("a heading whose section holds only actions still draws, its actions in the heading", async () => {
    await render(
      <RepositoryHome sections={[{ title: "Today", audience: "maintainer", blocks: [newBranch] }]} offered={offered} onRun={() => {}} />,
    );
    expect($$(".sui-rh-section-head .sui-rh-action-button")).toHaveLength(1);
  });
});

describe("LinkTabs", () => {
  test("a named nav of the host's links, the current one marked, and its sheet in smithersUiCss", async () => {
    await render(
      <LinkTabs aria-label="Repository pages" className="extra">
        <a href="/maya/tinyhttp" aria-current="page">Home</a>
        <a href="/maya/tinyhttp/tree/main">Code</a>
      </LinkTabs>,
    );
    const nav = $("nav")!;
    expect([nav.dataset.slot, nav.getAttribute("aria-label"), [...nav.classList]]).toEqual([
      "link-tabs",
      "Repository pages",
      ["sui-link-tabs", "extra"],
    ]);
    expect(texts($$("nav > a"))).toEqual(["Home", "Code"]);
    expect(smithersUiCss).toMatch(/\.sui-link-tabs > a\[aria-current="page"\] \{[^}]*border-bottom-color/);
  });
});
