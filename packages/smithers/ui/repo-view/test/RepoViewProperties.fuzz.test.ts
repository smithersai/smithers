// Replay a property by running this file with the reported EFFECT_FUZZ_SEED and execution count.
import { describe, expect, test } from "bun:test";
import { defaultValueCtx, Editor, editorViewCtx, parserCtx, remarkCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { guardDocument, HtmlPreview, previewDocument } from "../src/HtmlPreview";
import { markdownAlerts } from "../src/markdownAlerts";
import { markdownCode } from "../src/markdownCode";
import { joinMarkdownHtml, markdownHtml, type MarkdownNode } from "../src/markdownHtml";
import { markdownLinkNames } from "../src/markdownLinkNames";
import { ancestorsOf, directoriesOf, directoryEntries, parentOf, resolveLink, treeOrder } from "../src/paths";
import { externalDocumentTransaction, replaceMarkdown } from "../src/replaceMarkdown";
import { isSymbolText, moveCursor, type CodeSymbol, type CursorKey } from "../src/symbols";

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123");
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "150");
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(executions) || executions < 1) {
  throw new RangeError("Fuzzing requires an integer seed and a positive integer execution count");
}

type Draw = (exclusive: number) => number;
function mulberry32(seed: number): Draw {
  let state = seed >>> 0;
  return exclusive => {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = Math.imul(state ^ (state >>> 15), 1 | state);
    word ^= word + Math.imul(word ^ (word >>> 7), 61 | word);
    return Math.floor(((word ^ (word >>> 14)) >>> 0) / 0x100000000 * exclusive);
  };
}

function pick<T>(draw: Draw, items: readonly T[]): T {
  return items[draw(items.length)]!;
}

function many<T>(draw: Draw, maximum: number, element: () => T): T[] {
  return Array.from({ length: draw(maximum + 1) }, element);
}

// Shrink decisions, so generated models, indexes and dependent lengths stay valid.
// Missing decisions replay as zero. Drop chunks first, then simplify individual choices.
function shrink(choices: number[], fails: (candidate: number[]) => boolean): number[] {
  let attempts = 0;
  for (let width = choices.length; width >= 1; width = Math.floor(width / 2)) {
    for (let start = 0; start + width <= choices.length && attempts++ < 160;) {
      const candidate = choices.slice(0, start).concat(choices.slice(start + width));
      if (fails(candidate)) choices = candidate;
      else start += width;
    }
  }
  for (let i = 0; i < choices.length && attempts++ < 220; i++) {
    if (choices[i] === 0) continue;
    const candidate = choices.with(i, 0);
    if (fails(candidate)) choices = candidate;
  }
  return choices;
}

function property<T>(name: string, generate: (draw: Draw) => T, check: (input: T) => void): void {
  test(name, () => {
    const salt = Array.from(name).reduce((hash, c) => Math.imul(hash ^ c.charCodeAt(0), 16777619), seed);
    const next = mulberry32(salt);
    for (let iteration = 1; iteration <= executions; iteration++) {
      const draw = mulberry32(next(0x100000000));
      const choices: number[] = [];
      const input = generate(bound => {
        const value = draw(bound);
        choices.push(value);
        return value;
      });
      try {
        check(input);
      } catch (original) {
        const replay = (candidate: number[]) => {
          let index = 0;
          return generate(bound => (candidate[index++] ?? 0) % bound);
        };
        const reduced = shrink(choices, candidate => {
          try { check(replay(candidate)); return false; } catch { return true; }
        });
        const minimal = replay(reduced);
        let cause = original;
        try { check(minimal); } catch (error) { cause = error; }
        throw new Error(
          `EFFECT_FUZZ_SEED=${seed} EFFECT_FUZZ_EXECUTIONS=${iteration}\nShrunk input: ${JSON.stringify(minimal)}`,
          { cause },
        );
      }
    }
  });
}

const atoms = ["", "a", "0", " ", "\n", "\r", "\t", "\0", "\u001f", "Ω", "漢", "🙂", "e\u0301", "\ud800", "\udfff",
  "&", "<", ">", '"', "'", "/", "\\", "`", "~", "[]", "*", "%", "const ", "/*", "*/"];
const noise = (draw: Draw) => many(draw, 16, () =>
  draw(5) === 0 ? String.fromCharCode(draw(65536)) : pick(draw, atoms)).join("");
const components = ["src", "SRC", "src2", "a b", "naïve", "漢", "🙂", "a#b", "q?", "100%", "__proto__", "a\\b"];
const cmp = new Intl.Collator("en");
const nameOrder = (a: string, b: string) => cmp.compare(a.toLowerCase(), b.toLowerCase()) || cmp.compare(a, b);

describe("repository paths", () => {
  property("relative navigation agrees with a component walk and canonical paths are fixed points", draw => ({
    base: many(draw, 5, () => pick(draw, components)),
    ops: many(draw, 10, () => pick(draw, [".", "..", "", ...components])),
    rooted: Boolean(draw(2)), trailing: Boolean(draw(2)), suffix: pick(draw, ["", "?plain=1", "#a/b", "?q#z"]),
    leaf: Boolean(draw(2)),
  }), ({ base, ops, rooted, trailing, suffix, leaf }) => {
    const from = [...base, "readme.md"].join("/");
    const stack = rooted ? [] : [...base];
    let contained = true;
    for (const part of ops) {
      if (part === "..") {
        if (!stack.length) contained = false;
        stack.pop();
      } else if (part && part !== ".") stack.push(part);
    }
    // The explicit './' keeps redundant leading separators from becoming an authority.
    const href = (rooted ? "/./" : "./") + ops.map(encodeURIComponent).join("/") + (trailing ? "/" : "") + suffix;
    const path = stack.join("/");
    const files = leaf ? [path] : [path + "/child"];
    const actual = resolveLink(from, href, files);
    if (!contained) {
      expect(actual).toBeUndefined();
      return;
    }
    const directory = !path || !leaf || href.split(/[?#]/, 1)[0]!.endsWith("/");
    expect(actual).toEqual({ path, kind: directory ? "tree" : "blob" });
    const canonical = "/" + stack.map(encodeURIComponent).join("/") + (path && directory ? "/" : "");
    expect(resolveLink(from, canonical, files)).toEqual(actual);
  });

  property("above-root, external and malformed UTF-8 references have no repository target", draw => ({
    base: many(draw, 6, () => pick(draw, components)), extra: draw(5), tail: noise(draw),
  }), ({ base, extra, tail }) => {
    const from = [...base, "file"].join("/");
    for (const prefix of ["../".repeat(base.length + 1 + extra), "x+y:", "//", "#", "?", "%ED%A0%80/"]) {
      expect(resolveLink(from, prefix + tail, [])).toBeUndefined();
    }
    // In a Git tree a backslash is data inside a name, including after two literal dots.
    expect(resolveLink(from, "./..\\x", [])).toEqual({ kind: "blob", path: [...base, "..\\x"].join("/") });
    expect(resolveLink(from, "./\ud800", [])).toEqual({ kind: "blob", path: [...base, "\ud800"].join("/") });
  });

  // Regression suite for percent-encoded traversal, encoded separators, and NUL smuggling in resolveLink.
  for (const [description, segment] of [
    ["encoded separator", "%2f"],
    ["encoded nested separator", "a%2fb"],
    ["literal NUL", "\0"],
    ["encoded NUL", "%00"],
  ] as const) {
    test(`resolved Git path rejects invalid component (${description})`, () => {
      expect(resolveLink("README.md", segment, [])).toBeUndefined();
      expect(resolveLink("docs/guide.md", `sub/${segment}`, [])).toBeUndefined();
    });
  }

  test("encoded dot segments enforce root boundary and normalize without leaving dot components", () => {
    expect(resolveLink("README.md", "%2e%2e", [])).toBeUndefined();
    expect(resolveLink("docs/guide.md", "%2e%2e/%2e%2e", [])).toBeUndefined();
    expect(resolveLink("docs/guide.md", "%2e%2e/src/router.ts", ["src/router.ts"])).toEqual({
      kind: "blob",
      path: "src/router.ts",
    });
    expect(resolveLink("docs/guide.md", "%2e/a.md", ["docs/a.md"])).toEqual({
      kind: "blob",
      path: "docs/a.md",
    });
  });

  property("every resolved non-empty path contains only valid Git path components", draw => ({
    base: many(draw, 4, () => pick(draw, components)),
    href: many(draw, 10, () =>
      pick(draw, [".", "..", "%2e", "%2e%2e", "%2f", "%00", "\0", "/", "a", "b", "?", "#", noise(draw)])).join(""),
  }), ({ base, href }) => {
    const from = [...base, "README.md"].join("/");
    const target = resolveLink(from, href, []);
    if (target === undefined || target.path === "") return;
    expect(target.path.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.includes("\0")))
      .toBe(true);
  });

  property("each listing is the sorted immediate-child projection and DFS visits every file exactly once", draw => ({
    files: many(draw, 17, () => [...many(draw, 4, () => pick(draw, components)), pick(draw, components) + ".md"].join("/")),
    folders: many(draw, 8, () => many(draw, 3, () => pick(draw, components)).join("/")),
  }), ({ files, folders }) => {
    const input = Object.freeze([...files]);
    const leaves = [...new Set(files)];
    const dirs = new Set<string>();
    for (const path of [...leaves, ...folders]) {
      const parents: string[] = [];
      let current = path;
      while (current.includes("/")) {
        current = current.slice(0, current.lastIndexOf("/"));
        parents.unshift(current);
        dirs.add(current);
      }
      expect(ancestorsOf(path)).toEqual(parents);
      expect(parentOf(path)).toBe(parents.at(-1) ?? "");
    }
    for (const folder of folders) if (folder) dirs.add(folder);
    expect([...directoriesOf(input, folders)].sort()).toEqual([...dirs].sort());
    const ordered: string[] = [];
    const visit = (parent: string) => {
      const direct = (paths: string[]) => paths.filter(path => parentOf(path) === parent)
        .sort((a, b) => nameOrder(a.split("/").at(-1)!, b.split("/").at(-1)!));
      const children = [...direct([...dirs]), ...direct(leaves)];
      const expected: ReturnType<typeof directoryEntries> = children.map(path => ({
        path, name: path.split("/").at(-1)!, kind: dirs.has(path) ? "directory" : "file",
      }));
      expect(directoryEntries(input, parent, folders)).toEqual(expected);
      for (const path of children) {
        if (dirs.has(path)) visit(path);
        else ordered.push(path);
      }
    };
    visit("");
    expect(treeOrder(leaves.toReversed())).toEqual(ordered);
    const withDuplicates = treeOrder(input);
    expect(withDuplicates).toEqual(ordered.flatMap(path => files.filter(file => file === path)));
    expect(treeOrder(withDuplicates)).toEqual(withDuplicates);
  });
});

const parser = remarkCtx.create(new Map()).get()();
const htmlTags = new Set(
  "a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img kbd li ol p pre s samp small span strong sub summary sup table tbody td th thead tr ul".split(" "),
);
const kinds = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;

// Only detached templates and render trees are inspected. No input is navigated or executed.
function fragment(source: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = source;
  return template.content;
}

function checkPolicy(root: ParentNode): void {
  for (const element of root.querySelectorAll("*")) {
    const tag = element.localName;
    expect(htmlTags.has(tag)).toBe(true);
    for (const { name, value } of element.attributes) {
      switch (name) {
        case "title": break;
        case "alt": expect(tag).toBe("img"); break;
        case "href":
        case "src":
          expect(tag).toBe(name === "href" ? "a" : "img");
          expect(["http:", "https:", "mailto:"]).toContain(new URL(value, "https://repo.invalid/docs/").protocol);
          break;
        case "rel":
          expect(tag).toBe("a");
          expect(value.split(/\s+/).sort()).toEqual(["noopener", "noreferrer"]);
          break;
        case "aria-label": expect(tag).toBe("a"); break;
        case "class":
          expect(tag).toBe("strong");
          expect(value).toBe("sui-markdown-alert-title");
          break;
        case "data-kind":
          expect(tag).toBe("strong");
          expect(kinds.map(kind => kind.toLowerCase())).toContain(value);
          break;
        case "style": expect(value).toMatch(/^text-align:\s*(left|center|right);?$/i); break;
        default: throw new Error(`unexpected attribute ${tag}[${name}]`);
      }
    }
    if (tag === "a") expect(element.getAttribute("rel")).toBe("noopener noreferrer");
  }
}

const fragments = [
  "<b>", "</b>", "<details>", "</summary>", "<unlisted>", "</div>", "<!--x-->", "<span align=center>",
  "<script>discard</script>", "<style>discard</style>", "<svg><title>discard</title></svg>",
  '<img alt="caption" onerror="">', '<a href="/docs" onclick="">', "</a>", "<template>discard</template>",
  "**a**", "[ref](/docs)", "> [!NOTE]\n", "```ts\n", "\n\n", "&#65;", "&lt;", "<", ">", '"', "\0",
];
const schemes = ["javascript:", "JaVaScRiPt:", "java&#115;cript:", "data:", "DATA:", "vbscript:", "file:"];

describe("read-only Markdown and HTML preview", () => {
  property("malformed HTML and parsed Markdown produce deterministic, allowlisted DOM after serialization", draw => ({
    parts: many(draw, 28, () => draw(4) === 0 ? noise(draw) : pick(draw, fragments)),
    scheme: pick(draw, schemes),
  }), ({ parts, scheme }) => {
    const source = parts.join("");
    const assertSafe = (raw: string) => {
      const dom = markdownHtml(raw);
      checkPolicy(dom);
      checkPolicy(fragment(dom.innerHTML));
      expect(markdownHtml(raw).outerHTML).toBe(dom.outerHTML);
    };
    assertSafe(source);
    // A well-formed sibling probe prevents arbitrary malformed markup from swallowing the assertion target.
    const probe = markdownHtml(`<p><a href="${scheme}" onclick="">visible</a><img src="${scheme}" onerror=""></p>`);
    expect(probe.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(probe.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(probe.textContent).toBe("visible");
    checkPolicy(probe);

    const transform = (): MarkdownNode => {
      // mdast permits explicit undefined on optional metadata; the transforms read missing and undefined identically.
      const root = parser.parse(source) as MarkdownNode;
      markdownAlerts(root);
      joinMarkdownHtml(root);
      return root;
    };
    const root = transform();
    expect(transform()).toEqual(root);
    const walk = (node: MarkdownNode) => {
      if (node.type === "html") assertSafe(node.value ?? "");
      node.children?.forEach(walk);
    };
    walk(root);
  });

  property("sanitizing a badge keeps its safe destination, image source and accessible name", draw => ({
    base: pick(draw, ["../docs/", "/repo/", "https://example.invalid/", "http://example.invalid/"]),
    part: pick(draw, ["tree", "café", "a%20b", "q?q=1&amp;x=2", "#heading"]),
    caption: pick(draw, ["Docs", "漢字", "🙂", "e\u0301"]),
  }), ({ base, part, caption }) => {
    const url = base + part;
    const dom = markdownHtml(`<a href="${url}"><img src="${url}" alt="${caption}" onerror=""></a>`);
    const link = dom.querySelector("a")!;
    const image = link.querySelector("img")!;
    expect(link.getAttribute("href")).toBe(url.replaceAll("&amp;", "&"));
    expect(image.getAttribute("src")).toBe(link.getAttribute("href"));
    expect(link.getAttribute("aria-label")).toBe(caption);
    expect(image.getAttribute("alt")).toBe(caption);
    checkPolicy(dom);
  });

  property("joined inline Markdown preserves nesting and keeps text and code literal", draw => ({
    // These characters round-trip through HTML text. Arbitrary controls are exercised above and in fences.
    text: many(draw, 12, () => pick(draw, ["abc", "<i>", "</code>", "'", '"', "&amp;", "🙂", "e\u0301"])).join(""),
    marks: many(draw, 12, () => pick(draw, ["strong", "emphasis", "delete"] as const)),
  }), ({ text, marks }) => {
    let leaf: MarkdownNode = { type: "inlineCode", value: text };
    for (const type of marks) leaf = { type, children: [leaf] };
    const paragraph: MarkdownNode = { type: "paragraph", children: [
      { type: "html", value: "<b>" }, leaf, { type: "html", value: "</b>" },
    ] };
    joinMarkdownHtml(paragraph);
    const once = structuredClone(paragraph);
    joinMarkdownHtml(paragraph);
    expect(paragraph).toEqual(once);
    expect(paragraph.children).toHaveLength(1);
    const dom = markdownHtml(paragraph.children![0]!.value!);
    let parent = dom.firstElementChild!;
    expect(parent.localName).toBe("b");
    for (const mark of marks.toReversed()) {
      expect(parent.childElementCount).toBe(1);
      parent = parent.firstElementChild!;
      expect(parent.localName).toBe({ strong: "strong", emphasis: "em", delete: "del" }[mark]);
    }
    expect(parent.firstElementChild?.localName).toBe("code");
    expect(parent.firstElementChild?.childElementCount).toBe(0);
    expect(dom.textContent).toBe(text);
    expect(fragment(dom.innerHTML).firstElementChild?.outerHTML).toBe(dom.firstElementChild?.outerHTML);
  });

  test("bounded deep nesting preserves the innermost text through joining and sanitization", () => {
    let node: MarkdownNode = { type: "text", value: "deep leaf" };
    for (let i = 0; i < 192; i++) node = { type: "strong", children: [node] };
    const paragraph: MarkdownNode = { type: "paragraph", children: [{ type: "html", value: "" }, node] };
    joinMarkdownHtml(paragraph);
    const dom = markdownHtml(paragraph.children![0]!.value!);
    expect(dom.querySelectorAll("strong")).toHaveLength(192);
    expect(dom.textContent).toBe("deep leaf");
  });

  property("alerts change only a top-level quote starting with a whole marker and are idempotent", draw => ({
    kind: pick(draw, kinds), form: draw(6), body: noise(draw),
  }), ({ kind, form, body }) => {
    const marker = `[!${kind}]`;
    const value = [marker + "\n" + body, marker, marker.toLowerCase(), marker + " inline", marker, marker][form]!;
    const first = { type: form === 4 ? "inlineCode" : "text", value };
    const rest = { type: "paragraph", children: [{ type: "text", value: body }] };
    const quote: MarkdownNode = { type: "blockquote", children: [{ type: "paragraph", children: [first] }, rest] };
    const root: MarkdownNode = { type: "root", children: [form === 5 ? { type: "list", children: [quote] } : quote] };
    const before = structuredClone(root);
    markdownAlerts(root);
    if (form < 2) {
      expect(quote.children).toHaveLength(3);
      const title = markdownHtml(quote.children![0]!.children![0]!.value!);
      expect(title.querySelector("strong")?.dataset.kind).toBe(kind.toLowerCase());
      expect(quote.children!.slice(1)).toEqual([
        { type: "paragraph", children: [{ type: "text", value: form === 0 ? body : "" }] },
        { type: "paragraph", children: [{ type: "text", value: body }] },
      ]);
    } else expect(root).toEqual(before);
    const once = structuredClone(root);
    markdownAlerts(root);
    expect(root).toEqual(once);
  });

  property("fences tokenize losslessly and CommonMark fence delimiters stay outside the rendered text", draw => ({
    language: pick(draw, ["ts", "BASH", "vibe", "", "unknown", 'a"<b']),
    source: noise(draw) + pick(draw, fragments) + noise(draw), tick: pick(draw, ["`", "~"]),
  }), ({ source, language, tick }) => {
    const pre = markdownCode(language, source);
    expect(pre.localName).toBe("pre");
    expect(pre.children).toHaveLength(1);
    expect(pre.firstElementChild?.localName).toBe("code");
    expect(pre.textContent).toBe(source);
    expect(pre.querySelectorAll("code *:not(span), [onerror], [onclick]")).toHaveLength(0);
    expect(markdownCode(language, source).outerHTML).toBe(pre.outerHTML);
    const fence = tick.repeat(Math.max(3, ...Array.from(source.matchAll(new RegExp(tick + "+", "g")), m => m[0].length + 1)));
    const content = "start\n" + source.replace(/\r\n?/g, "\n").replaceAll("\0", "\ufffd") + "\nend";
    const tree = parser.parse(fence + " ts\n" + content + "\n" + fence);
    expect(tree.children).toHaveLength(1);
    const code = tree.children[0]!;
    expect(code.type).toBe("code");
    if (code.type !== "code") throw new Error("expected fenced code");
    expect(markdownCode(code.lang ?? "", code.value).textContent).toBe(content);
  });

  property("image-link naming respects precedence and repeated naming preserves the whole DOM", draw => ({
    alt: pick(draw, ["", " ", " 🐈 "]), title: pick(draw, ["", " ", " A "]), imageTitle: pick(draw, ["", " B "]),
    existing: pick(draw, ["", "chosen"]), visible: pick(draw, ["", " ", "visible"]),
    destination: pick(draw, ["/", "/tree/readme", "#badge", "?q"]), image: Boolean(draw(2)),
  }), ({ alt, title, imageTitle, existing, visible, destination, image }) => {
    const root = document.createElement("div");
    const a = document.createElement("a");
    root.append(a);
    a.href = destination;
    a.title = title;
    a.textContent = visible;
    if (existing) a.setAttribute("aria-label", existing);
    if (image) {
      const img = document.createElement("img");
      img.alt = alt;
      img.title = imageTitle;
      a.append(img);
    }
    const expected = existing || (visible.trim() || !image ? null :
      alt.trim() || title.trim() || imageTitle.trim() || destination.split(/[/?#]/).filter(Boolean).at(-1) || "Link");
    markdownLinkNames(root);
    expect(a.getAttribute("aria-label")).toBe(expected);
    const once = root.outerHTML;
    markdownLinkNames(root);
    expect(root.outerHTML).toBe(once);
  });

  property("preview content and title round-trip only inside the two policy-controlled frames", draw => ({
    html: many(draw, 12, () => pick(draw, [...fragments, '"', "&amp;", "</iframe>", "漢"])).join(""),
    title: many(draw, 9, () => pick(draw, ["'", '"', "<b>", "&quot;", "🙂", "title"])).join(""),
    doctype: pick(draw, ["", "<!DOCTYPE html>", "\ufeff \n<!DoCtYpE html>"]),
  }), ({ html, title, doctype }) => {
    const page = doctype + html;
    const preview = previewDocument(page);
    const prefix = previewDocument("");
    expect(preview).toBe(prefix + html);
    const outer = fragment(renderToStaticMarkup(createElement(HtmlPreview, { html: page, title })));
    expect(outer.children).toHaveLength(1);
    const guardFrame = outer.firstElementChild!;
    expect(guardFrame.localName).toBe("iframe");
    const guardSource = guardFrame.getAttribute("srcdoc")!;
    expect(guardSource).toBe(guardDocument(page, title));
    const guard = fragment(guardSource);
    expect(guard.querySelectorAll("iframe")).toHaveLength(1);
    const pageFrame = guard.querySelector("iframe")!;
    for (const frame of [guardFrame, pageFrame]) {
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.getAttribute("title")).toBe(title);
      expect(frame.hasAttribute("src")).toBe(false);
    }
    expect(pageFrame.getAttribute("srcdoc")).toBe(preview);
    // Normalize just the two input fields. Every other guard node and attribute must be constant.
    pageFrame.setAttribute("title", "");
    pageFrame.setAttribute("srcdoc", prefix);
    expect(guard.isEqualNode(fragment(guardDocument("", "")))).toBe(true);
    for (const head of [guard, fragment(prefix)]) {
      const meta = head.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
      const directives = (meta.getAttribute("content") ?? "").split(";").map(s => s.trim()).sort();
      expect(directives).toEqual([
        "base-uri 'none'", "connect-src 'none'", "default-src 'none'", "font-src data:", "form-action 'none'",
        "frame-src 'none'", "img-src data: blob:", "media-src data: blob:", "object-src 'none'",
        "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
      ]);
      expect(meta.previousElementSibling?.getAttribute("charset")).toBe("utf-8");
      expect(meta.previousElementSibling?.previousElementSibling).toBeNull();
    }
  });
});

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
  marks: { strong: {} },
});
const paragraph = (text: string, bold = false) =>
  schema.node("paragraph", null, text ? schema.text(text, bold ? [schema.mark("strong")] : []) : undefined);
const doc = (blocks: ProseNode[]) => schema.node("doc", null, blocks);

function replace(state: EditorState, target: ProseNode): EditorState {
  const before = state.doc.toJSON();
  const transaction = externalDocumentTransaction(state, target);
  expect(transaction === null).toBe(state.doc.eq(target));
  if (!transaction) return state;
  expect(transaction.getMeta("addToHistory")).toBe(false);
  const next = state.apply(transaction);
  next.doc.check();
  expect(next.doc.toJSON()).toEqual(target.toJSON());
  expect(state.doc.toJSON()).toEqual(before);
  expect(externalDocumentTransaction(next, target)).toBeNull();
  return next;
}

describe("external Markdown edits", () => {
  property("disjoint block and mark changes preserve UTF-16 selections through replay and reversal", draw => ({
    original: [noise(draw), noise(draw)], middle: "fixed🙂" + noise(draw) + "tail",
    updates: many(draw, 4, () => ({
      left: many(draw, 3, () => noise(draw)), right: many(draw, 3, () => noise(draw)), bold: Boolean(draw(2)),
    })),
    start: draw(65536), end: draw(65536),
  }), ({ original, middle, updates, start, end }) => {
    const initial = doc([paragraph(original[0]!), paragraph(middle), paragraph(original[1]!)]);
    const a = start % (middle.length + 1);
    const b = end % (middle.length + 1);
    const offset = initial.child(0).nodeSize + 1;
    let state = EditorState.create({ doc: initial, selection: TextSelection.create(initial, offset + a, offset + b) });
    const transition = (target: ProseNode, middleStart: number) => {
      state = replace(state, target);
      expect(state.selection.anchor).toBe(middleStart + a);
      expect(state.selection.head).toBe(middleStart + b);
      expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe(middle.slice(Math.min(a, b), Math.max(a, b)));
    };
    for (const { left, right, bold } of updates) {
      const prefix = left.map((text, i) => paragraph("left" + i + text, bold));
      const suffix = right.map((text, i) => paragraph("right" + i + text, !bold));
      transition(doc([...prefix, paragraph(middle), ...suffix]), 1 + prefix.reduce((n, p) => n + p.nodeSize, 0));
    }
    transition(initial, offset);
  });

  test("the real Milkdown action applies parsed peer edits and repeated updates keep the editor state", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const initial = "**before**\n\nfixed🙂\n\nafter";
    const editor = Editor.make().config(ctx => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, initial);
    }).use(commonmark);
    try {
      await editor.create();
      const draw = mulberry32(seed);
      for (const markdown of [
        ...many(draw, 8, () => noise(draw) + "\n\nfixed🙂\n\n" + noise(draw)),
        "left\n\nfixed🙂\n\n**right**", "", initial,
      ]) {
        const target = editor.action(ctx => ctx.get(parserCtx)(markdown));
        editor.action(replaceMarkdown(markdown));
        const current = editor.action(ctx => ctx.get(editorViewCtx).state);
        expect(current.doc.eq(target)).toBe(true);
        editor.action(replaceMarkdown(markdown));
        expect(editor.action(ctx => ctx.get(editorViewCtx).state)).toBe(current);
      }
    } finally {
      try { await editor.destroy(); } finally { host.remove(); }
    }
  });

  test("empty and 65,536-code-unit paragraphs round-trip with a change between surrogate halves", () => {
    const text = "🙂ab".repeat(16384);
    const initial = doc([paragraph("")]);
    let state = EditorState.create({ doc: initial });
    for (const value of [text, text.slice(0, 32769) + "x" + text.slice(32769), text, ""]) {
      state = replace(state, doc([paragraph(value)]));
    }
    expect(state.doc.eq(initial)).toBe(true);
  });
});

describe("code symbols", () => {
  property("identifier filtering preserves exactly the generated symbols and ignores reserved words and punctuation", draw => {
    const tokens = many(draw, 35, () => {
      const form = draw(4);
      const name = pick(draw, ["$", "_", "A", "z"]) + many(draw, 12, () => pick(draw, ["$", "_", "2", "Y", "x"])).join("");
      if (form === 0) return { token: pick(draw, ["if", "let", "await", "function", "satisfies"]), symbol: false };
      if (form === 1) return { token: name + pick(draw, ["-", " ", "\0", ".", "🙂", "\ud800"]), symbol: false };
      if (form === 2) return { token: pick(draw, ["0", ".", "漢"]) + name, symbol: false };
      return { token: name, symbol: true };
    });
    return tokens;
  }, tokens => {
    const source = tokens.map(({ token }) => token);
    const expected = tokens.filter(({ symbol }) => symbol).map(({ token }) => token);
    expect(source.filter(isSymbolText)).toEqual(expected);
    expect(source.toReversed().filter(isSymbolText).reverse()).toEqual(expected);
  });

  property("cursor walks match row and column neighbors regardless of input ordering", draw => ({
    rows: many(draw, 9, () => many(draw, 6, () => draw(8) + 1)), anchor: 1 + draw(12),
    keys: many(draw, 26, () => pick<CursorKey>(draw, ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])),
  }), ({ rows, anchor, keys }) => {
    const symbols: CodeSymbol[] = rows.flatMap((gaps, row) => {
      let column = 0;
      return gaps.map(gap => ({ line: row + 1, column: column += gap, text: `sym${row}_${column}` }));
    });
    const reversed = Object.freeze(symbols.toReversed());
    let current: CodeSymbol | undefined;
    for (const key of keys) {
      let expected: CodeSymbol | undefined;
      if (!current) expected = symbols.find(s => s.line >= anchor) ?? symbols[0];
      else if (key === "ArrowLeft" || key === "ArrowRight") {
        expected = symbols[symbols.indexOf(current) + (key === "ArrowRight" ? 1 : -1)] ?? current;
      } else {
        const { line, column } = current;
        const direction = key === "ArrowDown" ? 1 : -1;
        // Minimize vertical distance, then horizontal distance, then column (left wins a tie).
        const candidates = symbols.filter(s => (s.line - line) * direction > 0);
        expected = candidates.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line)
          || Math.abs(a.column - column) - Math.abs(b.column - column) || a.column - b.column)[0] ?? current;
      }
      expect(moveCursor(reversed, current, key, anchor)).toEqual(expected);
      current = expected;
    }
  });
});
