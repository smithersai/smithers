/** @jsxImportSource react */
// ItemConversation under happy-dom: real createRoot + act, native events, so default-prevented flags are the browser's.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ItemAsideSection,
  ItemConversation,
  itemConversationCss,
  type ItemConversationComment,
  type ItemConversationProps,
  SMITHERS_UI_STYLE_ATTR,
  smithersUiCss,
} from "../src/index";
import { installDarkThemeStyles, removeDarkThemeStyles } from "./theme-test-utils";
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
  removeDarkThemeStyles();
  document.documentElement.removeAttribute("data-theme");
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => root!.render(element));
}

/** Presses a key like a browser, returning whether its default action still runs. */
async function key(el: Element, init: KeyboardEventInit): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  return followed;
}

async function click(el: Element): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  return followed;
}

async function type(field: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const COMMENTS: ReadonlyArray<ItemConversationComment> = [
  { id: "c1", author: "ben", createdAt: ago(3_600_000), body: "Same here on **0.4.1**." },
  { id: "c2", author: "maya", body: "On its way", pending: "requested" },
  {
    id: "c3",
    author: "maya",
    body: "Refused one",
    pending: "not_sent",
    reason: "Not allowed",
    actions: (
      <>
        <button type="button">Edit</button>
        <button type="button">Discard</button>
      </>
    ),
  },
];

const BASE: ItemConversationProps = {
  title: "Fix webhook retries",
  number: 12,
  state: "open",
  author: "maya",
  createdAt: ago(7_200_000),
  body: "Retries **double** the delivery.",
  comments: COMMENTS,
};

const article = () => container!.querySelector<HTMLElement>("[data-slot=item-conversation]")!;
const comments = () => [...container!.querySelectorAll<HTMLLIElement>("ol.sui-item-conv-comments > li")];
const textarea = () => container!.querySelector<HTMLTextAreaElement>("textarea")!;
const commentButton = () => container!.querySelector<HTMLButtonElement>(".sui-item-conv-composer button")!;

/** The page with a live composer whose draft the harness owns, counting submits. */
function Harness({ initial = "", disabled, onSubmit }: { initial?: string; disabled?: boolean; onSubmit: () => void }) {
  const [draft, setDraft] = useState(initial);
  return <ItemConversation {...BASE} composer={{ draft, onDraft: setDraft, onSubmit, ...(disabled === undefined ? {} : { disabled }) }} />;
}

describe("ItemConversation: header", () => {
  test("names the article by its title and shows #number, the state, the author and when", async () => {
    await render(<ItemConversation {...BASE} />);
    const heading = article().querySelector("h1")!;
    expect(article().tagName).toBe("ARTICLE");
    expect(article().getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe("Fix webhook retries #12");
    expect(heading.querySelector(".sui-item-conv-number")!.textContent).toBe("#12");
    const state = article().querySelector<HTMLElement>(".sui-item-conv-state")!;
    expect([state.textContent, state.className.includes("sui-badge-success")]).toEqual(["Open", true]);
    expect(article().querySelector("header .sui-item-conv-author")!.textContent).toBe("maya");
    const time = article().querySelector("header time")!;
    expect(time.getAttribute("datetime")).toBe(BASE.createdAt!);
    expect(time.textContent).toBe("2h ago");
    expect(article().dataset.state).toBe("open");
  });

  test("an unnumbered issue shows #–; a closed one a muted Closed; a pending one its chip", async () => {
    await render(<ItemConversation {...BASE} number={null} state="closed" pending="requested" />);
    expect(article().querySelector(".sui-item-conv-number")!.textContent).toBe("#–");
    const state = article().querySelector<HTMLElement>(".sui-item-conv-state")!;
    expect([state.textContent, state.className.includes("sui-badge-muted")]).toEqual(["Closed", true]);
    expect(article().dataset.pending).toBe("requested");
    expect(article().querySelector("header .sui-item-conv-pending")!.textContent).toBe("Requested");
    await rerender(<ItemConversation {...BASE} pending="not_sent" />);
    const chip = article().querySelector<HTMLElement>("header .sui-item-conv-pending")!;
    expect([chip.textContent, chip.className.includes("sui-badge-destructive")]).toEqual(["Not sent", true]);
    await rerender(<ItemConversation {...BASE} />);
    expect(article().hasAttribute("data-pending")).toBe(false);
    expect(article().querySelector("header .sui-item-conv-pending")).toBeNull();
  });

  test("Open on GitHub opens a new tab; an unsafe or absent target shows no link", async () => {
    await render(<ItemConversation {...BASE} externalHref="https://github.com/octocat/hello/issues/12" />);
    const link = article().querySelector<HTMLAnchorElement>(".sui-item-conv-external")!;
    expect([link.textContent, link.getAttribute("href"), link.target, link.rel]).toEqual([
      "Open on GitHub ↗",
      "https://github.com/octocat/hello/issues/12",
      "_blank",
      "noopener noreferrer",
    ]);
    await rerender(<ItemConversation {...BASE} externalHref="javascript:alert(1)" />);
    expect(article().querySelector(".sui-item-conv-external")).toBeNull();
    await rerender(<ItemConversation {...BASE} />);
    expect(article().querySelector("a[target]")).toBeNull();
  });

  test("an absent author or an unreadable time shows nothing in their place", async () => {
    await render(<ItemConversation {...BASE} author={undefined} createdAt="not a date" />);
    expect(article().querySelector("header .sui-item-conv-author, header time")).toBeNull();
  });

  test("headingLevel picks the title's heading", async () => {
    await render(<ItemConversation {...BASE} headingLevel={2} />);
    expect(article().querySelector("h1")).toBeNull();
    expect(article().querySelector("h2")!.id).toBe(article().getAttribute("aria-labelledby")!);
  });
});

describe("ItemConversation: body and comments", () => {
  test("the body renders as Markdown; an empty body renders no post", async () => {
    await render(<ItemConversation {...BASE} />);
    const post = article().querySelector(".sui-item-conv-post [data-slot=markdown]")!;
    expect(post.querySelector("strong")!.textContent).toBe("double");
    await rerender(<ItemConversation {...BASE} body={"  \n "} />);
    expect(article().querySelector(".sui-item-conv-post")).toBeNull();
  });

  test("HTML in a body or comment never becomes markup: no script, no image, no comment text", async () => {
    const hostile =
      "<!-- Please fill in the template -->\nHello <script>window.__pwned = true</script> <img src=x onerror=\"window.__pwned = true\"> <b onclick=\"x()\">bold</b>";
    await render(
      <ItemConversation {...BASE} body={hostile} comments={[{ id: "h", author: "eve", body: hostile }]} />,
    );
    expect(container!.querySelectorAll("script, img, iframe, [onclick], [onerror]")).toHaveLength(0);
    expect(container!.textContent).not.toContain("Please fill in the template");
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
    for (const markdown of container!.querySelectorAll("[data-slot=markdown]")) {
      expect(markdown.querySelector("b, strong")!.textContent).toBe("bold");
    }
  });

  test("comments are an ordered list in the order given, each with author, time and Markdown", async () => {
    await render(<ItemConversation {...BASE} />);
    const list = article().querySelector("ol")!;
    expect(list.getAttribute("aria-label")).toBe("Comments");
    expect(comments().map((li) => li.querySelector("[data-slot=markdown]")!.textContent)).toEqual([
      "Same here on 0.4.1.",
      "On its way",
      "Refused one",
    ]);
    const [first] = comments();
    expect(first!.querySelector(".sui-item-conv-author")!.textContent).toBe("ben");
    expect(first!.querySelector("time")!.textContent).toBe("1h ago");
    expect(first!.querySelector("strong")!.textContent).toBe("0.4.1");
  });

  test("pending comments carry data-pending and a chip; only a not-sent one shows its reason", async () => {
    const withReason: ReadonlyArray<ItemConversationComment> = [
      ...COMMENTS,
      { id: "c4", body: "Requested with a stale reason", pending: "requested", reason: "Not allowed" },
    ];
    await render(<ItemConversation {...BASE} comments={withReason} />);
    expect(comments().map((li) => li.dataset.pending ?? null)).toEqual([null, "requested", "not_sent", "requested"]);
    expect(comments().map((li) => li.querySelector(".sui-item-conv-pending")?.textContent ?? null)).toEqual([
      null,
      "Requested",
      "Not sent",
      "Requested",
    ]);
    expect(comments().map((li) => li.querySelector(".sui-item-conv-reason")?.textContent ?? null)).toEqual([
      null,
      null,
      "Not allowed",
      null,
    ]);
  });

  test("a comment's actions render with it, and only with it", async () => {
    await render(<ItemConversation {...BASE} />);
    expect(comments().map((li) => [...li.querySelectorAll("button")].map((b) => b.textContent))).toEqual([
      [],
      [],
      ["Edit", "Discard"],
    ]);
  });

  test("no comments renders no list", async () => {
    await render(<ItemConversation {...BASE} comments={[]} />);
    expect(article().querySelector("ol")).toBeNull();
  });
});

describe("ItemConversation: composer", () => {
  test("absent composer: no form, textarea or button at all", async () => {
    await render(<ItemConversation {...BASE} comments={[]} />);
    expect(article().querySelectorAll("form, textarea, button")).toHaveLength(0);
  });

  test("the textarea is labelled Comment by default, or by the host's label", async () => {
    await render(<ItemConversation {...BASE} composer={{ draft: "", onDraft: () => {}, onSubmit: () => {} }} />);
    const label = article().querySelector<HTMLLabelElement>(".sui-item-conv-composer label")!;
    expect([label.textContent, label.htmlFor]).toEqual(["Comment", textarea().id]);
    expect(textarea().labels![0]).toBe(label);
    expect(commentButton().textContent).toBe("Comment");
    await rerender(
      <ItemConversation {...BASE} composer={{ draft: "", onDraft: () => {}, onSubmit: () => {}, label: "Reply to maya" }} />,
    );
    expect(textarea().labels![0]!.textContent).toBe("Reply to maya");
  });

  test("typing reports the draft; the button enables only for a non-blank draft and submits on click", async () => {
    let submits = 0;
    await render(<Harness onSubmit={() => (submits += 1)} />);
    expect(commentButton().disabled).toBe(true);
    await type(textarea(), "   \n ");
    expect(textarea().value).toBe("   \n ");
    expect(commentButton().disabled).toBe(true);
    await click(commentButton());
    expect(submits).toBe(0);
    await type(textarea(), "Looks good");
    expect(commentButton().disabled).toBe(false);
    await click(commentButton());
    expect(submits).toBe(1);
  });

  test("⌘Enter and Ctrl+Enter submit and prevent the newline; Enter and Shift+Enter type one", async () => {
    let submits = 0;
    await render(<Harness initial="Ship it" onSubmit={() => (submits += 1)} />);
    expect(await key(textarea(), { key: "Enter", metaKey: true })).toBe(false);
    expect(submits).toBe(1);
    expect(await key(textarea(), { key: "Enter", ctrlKey: true })).toBe(false);
    expect(submits).toBe(2);
    expect(await key(textarea(), { key: "Enter" })).toBe(true);
    expect(await key(textarea(), { key: "Enter", shiftKey: true })).toBe(true);
    expect(await key(textarea(), { key: "Enter", metaKey: true, isComposing: true })).toBe(true);
    expect(submits).toBe(2);
  });

  test("⌘Enter on a blank draft, or while disabled, submits nothing", async () => {
    let submits = 0;
    await render(<Harness initial="  " onSubmit={() => (submits += 1)} />);
    await key(textarea(), { key: "Enter", metaKey: true });
    expect(submits).toBe(0);
    await act(async () => root!.unmount());
    root = createRoot(container!);
    await act(async () => root!.render(<Harness initial="Ready" disabled onSubmit={() => (submits += 1)} />));
    expect(commentButton().disabled).toBe(true);
    expect(textarea().disabled).toBe(false);
    await key(textarea(), { key: "Enter", ctrlKey: true });
    await click(commentButton());
    expect(submits).toBe(0);
  });

  test("submitting the form never lets the browser submit it", async () => {
    let submits = 0;
    await render(<Harness initial="Ship it" onSubmit={() => (submits += 1)} />);
    const form = article().querySelector("form")!;
    let followed = true;
    await act(async () => {
      followed = form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect([followed, submits]).toEqual([false, 1]);
  });
});

describe("ItemConversation: header actions", () => {
  const actions = () => article().querySelector<HTMLElement>(".sui-item-conv-header-actions");

  test("headerActions render at the end of the header's meta row", async () => {
    let pressed = 0;
    await render(
      <ItemConversation
        {...BASE}
        externalHref="https://github.com/maya/tinyhttp/issues/12"
        headerActions={
          <button type="button" onClick={() => (pressed += 1)}>
            Accept
          </button>
        }
      />,
    );
    const meta = article().querySelector(".sui-item-conv-meta")!;
    expect(meta.lastElementChild).toBe(actions());
    expect(actions()!.closest("header")).not.toBeNull();
    const accept = actions()!.querySelector("button")!;
    accept.focus();
    expect(document.activeElement).toBe(accept);
    await click(accept);
    expect(pressed).toBe(1);
  });

  test("absent or null headerActions render no container", async () => {
    await render(<ItemConversation {...BASE} />);
    expect(actions()).toBeNull();
    await rerender(<ItemConversation {...BASE} headerActions={null} />);
    expect(actions()).toBeNull();
  });

  test("loading renders no header actions", async () => {
    await render(<ItemConversation {...BASE} loading headerActions={<button type="button">Accept</button>} />);
    expect(actions()).toBeNull();
    expect(article().querySelectorAll("button")).toHaveLength(0);
    await rerender(<ItemConversation {...BASE} headerActions={<button type="button">Accept</button>} />);
    expect(actions()!.textContent).toBe("Accept");
  });
});

describe("ItemConversation: loading and themes", () => {
  test("loading shows a status and placeholders, never a header, comments or composer", async () => {
    await render(
      <ItemConversation {...BASE} loading composer={{ draft: "Hi", onDraft: () => {}, onSubmit: () => {} }} />,
    );
    expect(article().getAttribute("aria-busy")).toBe("true");
    expect(article().getAttribute("aria-label")).toBe("Loading");
    expect(article().querySelector("[role=status]")!.textContent).toBe("Loading");
    expect(article().querySelector("[data-slot=spinner]")).toBeNull();
    expect(article().querySelectorAll(".sui-item-conv-loading [data-slot=skeleton]")).toHaveLength(3);
    expect(article().querySelectorAll("header, h1, ol, form, textarea, button, .sui-item-conv-state")).toHaveLength(0);
    await rerender(<ItemConversation {...BASE} />);
    expect(article().hasAttribute("aria-busy")).toBe(false);
    expect(article().querySelector("[role=status]")).toBeNull();
    expect(article().querySelector("h1")!.textContent).toBe("Fix webhook retries #12");
  });

  test("a not-sent reason follows the theme: its color changes between light and dark", async () => {
    installDarkThemeStyles();
    document.documentElement.dataset.theme = "light";
    await render(<ItemConversation {...BASE} />);
    const reason = () => getComputedStyle(article().querySelector(".sui-item-conv-reason")!).color;
    const light = reason();
    document.documentElement.dataset.theme = "dark";
    await rerender(<ItemConversation {...BASE} title="Dark" />);
    const dark = reason();
    expect(light).not.toBe("");
    expect(dark).not.toBe("");
    expect(dark).not.toBe(light);
  });

  test("the header's and a comment's meta rows wrap, so a phone breaks no word; an event's time keeps its line", async () => {
    installDarkThemeStyles();
    await render(<ItemConversation {...BASE} events={[{ id: "e", kind: "queued", author: "ann", text: "committed", createdAt: ago(60_000) }]} />);
    expect(getComputedStyle(article().querySelector(".sui-item-conv-meta")!).flexWrap).toBe("wrap");
    expect(getComputedStyle(article().querySelector(".sui-item-conv-comment-meta")!).flexWrap).toBe("wrap");
    const event = article().querySelector(".sui-item-conv-event")!;
    expect(getComputedStyle(event).flexWrap).not.toBe("wrap");
    expect(getComputedStyle(event.lastElementChild!).flexShrink).toBe("0");
    expect(getComputedStyle(event.querySelector(".sui-item-conv-event-text")!).flexShrink).not.toBe("0");
  });

  test("the sheet is composed into the shipped stylesheet and namespaced", () => {
    expect(smithersUiCss).toContain(itemConversationCss.trim());
    expect(itemConversationCss.match(/\.[a-z][\w-]*/g)!.every((name) => name.startsWith(".sui-"))).toBe(true);
  });
});


describe("generated host attributes", () => {
  test("the conversation keeps its title association and state while forwarding host props", async () => {
    await render(<ItemConversation {...BASE} pending="requested" aside={<span>Details</span>}
      aria-labelledby="host-title" data-slot="host-slot" data-state="closed"
      data-status="merged" data-pending="not_sent" data-aside="host-aside"
      id="host-id" className="host-class" data-host="kept" />);
    const el = container!.querySelector("article")!;
    expect(el.getAttribute("aria-labelledby")).toBe(el.querySelector("h1")!.id);
    expect(el.getAttribute("data-slot")).toBe("item-conversation");
    expect(el.getAttribute("data-state")).toBe("open");
    expect(el.getAttribute("data-status")).toBe("open");
    expect(el.getAttribute("data-pending")).toBe("requested");
    expect(el.getAttribute("data-aside")).toBe("");
    expect(el.id).toBe("host-id");
    expect(el.classList.contains("host-class")).toBe(true);
    expect(el.getAttribute("data-host")).toBe("kept");
    await rerender(<ItemConversation {...BASE} data-pending="not_sent" data-aside="host-aside" />);
    expect(article().hasAttribute("data-pending")).toBe(false);
    expect(article().hasAttribute("data-aside")).toBe(false);
  });

  test("loading keeps its busy state and accessible label", async () => {
    await render(<ItemConversation {...BASE} loading aria-busy="false" aria-label="Host label"
      data-slot="host-slot" id="loading-host" />);
    const el = container!.querySelector("article")!;
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Loading");
    expect(el.getAttribute("data-slot")).toBe("item-conversation");
    expect(el.id).toBe("loading-host");
  });

  test("aside sections keep their generated label and slot", async () => {
    await render(<ItemAsideSection title="Branch" aria-label="Host label" data-slot="host-slot"
      id="aside-host" className="host-class" data-host="kept">Content</ItemAsideSection>);
    const el = container!.querySelector("section")!;
    expect(el.getAttribute("aria-label")).toBe("Branch");
    expect(el.getAttribute("data-slot")).toBe("item-aside-section");
    expect(el.id).toBe("aside-host");
    expect(el.classList.contains("host-class")).toBe(true);
    expect(el.getAttribute("data-host")).toBe("kept");
    expect(el.textContent).toContain("Content");
  });
});


for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
  for (const ime of [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, keyCode: 229 }]) {
    test(`comment keeps IME confirmation until a later submit chord: ${JSON.stringify({ ...modifier, ...ime })}`, async () => {
      let submits = 0;
      await render(<Harness initial="Ship it" onSubmit={() => (submits += 1)} />);
      expect(await key(textarea(), { key: "Enter", ...modifier, ...ime })).toBe(true);
      expect(submits).toBe(0);
      expect(textarea().value).toBe("Ship it");
      expect(await key(textarea(), { key: "Enter", ...modifier })).toBe(false);
      expect(submits).toBe(1);
    });
  }
}
