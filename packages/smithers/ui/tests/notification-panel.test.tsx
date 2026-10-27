/** @jsxImportSource react */
// The notifications panel and the keys notices answer to (apps/mvp decision 0009): a toast that opens what it is
// about, `+N` that opens the panel, the panel's entries that expand in place, the bell, and every key. Real createRoot
// + act under happy-dom.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  isNoticeHotkey,
  isTypingTarget,
  NeedsYouCard,
  NOTICE_KEYS,
  noticeKeyAction,
  NotificationBell,
  NotificationEntry,
  NotificationPanel,
  smithersUiCss,
  Toast,
  ToastStack,
} from "../src";
import { moveFocus } from "../src/agent-status/roving";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;
const outside: Array<HTMLElement> = [];

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  for (const element of outside.splice(0)) element.remove();
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

/** A button outside the rendered tree, to hold focus before a hotkey or to be clicked outside a panel. */
const elsewhere = () => {
  const button = document.createElement("button");
  button.textContent = "elsewhere";
  document.body.appendChild(button);
  outside.push(button);
  return button;
};

const $ = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const $$ = (selector: string) => [...container!.querySelectorAll<HTMLElement>(selector)];
const click = (element: Element | null) => act(async () => (element as HTMLElement).click());
const byText = (text: string) => $$("button").find((button) => button.textContent === text) ?? null;
const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
const hotkey = (code: "KeyT" | "KeyN", init: KeyboardEventInit = {}) =>
  act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: code === "KeyT" ? "†" : "˜", code, altKey: true, bubbles: true, cancelable: true, ...init }),
    );
  });
const pointerDown = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
const noop = () => {};

/** Counts each handler's calls by name. */
const counter = () => {
  const calls: Record<string, number> = {};
  const on = (name: string) => () => void (calls[name] = (calls[name] ?? 0) + 1);
  return { calls, on };
};

describe("notice keys", () => {
  test("letters, arrows, J and K, Home, End and Escape, in either case; held with Alt, Ctrl or ⌘ they do nothing", () => {
    const expected = {
      o: "open",
      O: "open",
      e: "expand",
      a: "answer",
      h: "hide",
      r: "read",
      R: "read",
      ArrowDown: "next",
      j: "next",
      ArrowUp: "previous",
      k: "previous",
      Home: "first",
      End: "last",
      Escape: "close",
    } as const;
    for (const [key, action] of Object.entries(expected)) {
      expect(noticeKeyAction({ key })).toBe(action);
      expect(noticeKeyAction({ key, altKey: false, ctrlKey: false, metaKey: false })).toBe(action);
      expect(noticeKeyAction({ key, altKey: true })).toBeUndefined();
      expect(noticeKeyAction({ key, ctrlKey: true })).toBeUndefined();
      expect(noticeKeyAction({ key, metaKey: true })).toBeUndefined();
    }
    for (const key of ["Enter", " ", "x", "Tab", "ArrowLeft", "1"]) expect(noticeKeyAction({ key })).toBeUndefined();
  });

  test("Alt+T and Alt+N by the key's place, alone", () => {
    const base = { altKey: true, ctrlKey: false, metaKey: false };
    expect(isNoticeHotkey({ ...base, code: "KeyT" }, "toasts")).toBe(true);
    expect(isNoticeHotkey({ ...base, code: "KeyN" }, "notifications")).toBe(true);
    expect(isNoticeHotkey({ ...base, code: "KeyN" }, "toasts")).toBe(false);
    expect(isNoticeHotkey({ ...base, code: "KeyT" }, "notifications")).toBe(false);
    expect(isNoticeHotkey({ ...base, altKey: false, code: "KeyT" }, "toasts")).toBe(false);
    expect(isNoticeHotkey({ ...base, ctrlKey: true, code: "KeyT" }, "toasts")).toBe(false);
    expect(isNoticeHotkey({ ...base, metaKey: true, code: "KeyN" }, "notifications")).toBe(false);
    expect(NOTICE_KEYS).toEqual({
      toasts: "Alt+T",
      notifications: "Alt+N",
      open: "O",
      expand: "E",
      answer: "A",
      hide: "H",
      read: "R",
    });
    expect(Object.isFrozen(NOTICE_KEYS)).toBe(true);
  });

  test("fields a person types in keep their letters", () => {
    for (const tag of ["input", "textarea", "select"]) expect(isTypingTarget(document.createElement(tag))).toBe(true);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.appendChild(editable);
    outside.push(editable);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  test("moveFocus: next, previous, first and last, clamped at the ends; other actions and empty lists move nothing", async () => {
    await render(
      <div>
        <button className="item">a</button>
        <button className="item">b</button>
        <button className="item">c</button>
      </div>,
    );
    const list = $("div")!;
    const [a, b, c] = $$(".item");
    expect(moveFocus(list, ".item", "next", a!)).toBe(true);
    expect(document.activeElement).toBe(b);
    expect(moveFocus(list, ".item", "next", c!)).toBe(true);
    expect(document.activeElement).toBe(c);
    expect(moveFocus(list, ".item", "previous", a!)).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(moveFocus(list, ".item", "last", a!)).toBe(true);
    expect(document.activeElement).toBe(c);
    expect(moveFocus(list, ".item", "first", c!)).toBe(true);
    expect(document.activeElement).toBe(a);
    // From outside the list, next starts at the first.
    expect(moveFocus(list, ".item", "next", null)).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(moveFocus(list, ".item", "previous", elsewhere())).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(moveFocus(list, ".item", "open", a!)).toBe(false);
    expect(moveFocus(list, ".none", "next", a!)).toBe(false);
  });
});

describe("Toast that opens", () => {
  test("its words are one button that opens what it is about, and focus lands on it", async () => {
    const { calls, on } = counter();
    await render(<Toast tone="done" detail="Clone tinyhttp" unread onOpen={on("open")} onHide={on("hide")} />);
    const open = $("button[data-slot=toast-open]")!;
    expect(open.textContent).toBe("Unread✓Done · Clone tinyhttp");
    expect(open.hasAttribute("data-toast-focus")).toBe(true);
    expect(open.getAttribute("aria-keyshortcuts")).toBe("O H");
    await click(open);
    expect(calls).toEqual({ open: 1 });
    // Its only other button is Hide.
    expect($$("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Unread✓Done · Clone tinyhttp",
      "Hide",
    ]);
  });

  test("O opens, E expands, A answers, H hides and R reads; with a modifier, in a field or unknown, nothing", async () => {
    const { calls, on } = counter();
    await render(
      <Toast
        tone="needs_you"
        detail="Which branch?"
        action={{ label: "Answer", onAction: on("action") }}
        onOpen={on("open")}
        onExpand={on("expand")}
        onAnswer={on("answer")}
        onRead={on("read")}
        onHide={on("hide")}
      >
      </Toast>,
    );
    const open = $("button[data-slot=toast-open]")!;
    expect(open.getAttribute("aria-keyshortcuts")).toBe("O E A H R");
    expect(byText("Answer")!.getAttribute("aria-keyshortcuts")).toBe("A");
    for (const key of ["o", "e", "a", "h", "r"]) await press(open, key);
    expect(calls).toEqual({ open: 1, expand: 1, answer: 1, hide: 1, read: 1 });
    await press(open, "o", { metaKey: true });
    await press(open, "x");
    const field = document.createElement("input");
    $("[data-slot=toast]")!.appendChild(field);
    await press(field, "h");
    expect(calls).toEqual({ open: 1, expand: 1, answer: 1, hide: 1, read: 1 });
  });

  test("a key with no handler does nothing, and a caller's onKeyDown that prevents it wins", async () => {
    const { calls, on } = counter();
    await render(<Toast tone="working" onHide={on("hide")} onKeyDown={(event) => event.key === "h" && event.preventDefault()} />);
    const toast = $("[data-slot=toast]")!;
    for (const key of ["o", "e", "a", "r", "h"]) await press(toast, key);
    expect(calls).toEqual({});
  });

  test("without onOpen, focus lands on its action, else on Hide", async () => {
    await render(<Toast tone="needs_you" action={{ label: "Answer", onAction: noop }} onHide={noop} />);
    expect(byText("Answer")!.hasAttribute("data-toast-focus")).toBe(true);
    expect($("button[aria-label=Hide]")!.hasAttribute("data-toast-focus")).toBe(false);
    expect(byText("Answer")!.hasAttribute("aria-keyshortcuts")).toBe(false);
    await render(<Toast tone="done" onHide={noop} />);
    expect($("button[aria-label=Hide]")!.hasAttribute("data-toast-focus")).toBe(true);
    expect($("button[data-slot=toast-open]")).toBeNull();
  });
});

describe("ToastStack that opens the panel", () => {
  const toast = (id: string) => <Toast key={id} tone="needs_you" detail={id} onOpen={noop} onHide={noop} />;

  test("+N counts the toasts past max and the entries besides them, and opens the panel instead of expanding", async () => {
    let opened = 0;
    await render(
      <ToastStack onMore={() => opened++} moreCount={2} more={<Toast tone="done" onHide={noop} />}>
        {["a", "b", "c", "d"].map(toast)}
      </ToastStack>,
    );
    const more = byText("+3")!;
    expect(more.getAttribute("aria-haspopup")).toBe("dialog");
    expect(more.getAttribute("aria-keyshortcuts")).toBe("Alt+N");
    expect(more.hasAttribute("data-notifications-trigger")).toBe(true);
    expect(more.hasAttribute("aria-expanded")).toBe(false);
    await click(more);
    expect(opened).toBe(1);
    // It never expands: three toasts, and `more` isn't shown.
    expect($$("[data-slot=toast]")).toHaveLength(3);
    expect(byText("Less")).toBeNull();
  });

  test("entries alone show +N with no toasts; none at all renders nothing", async () => {
    await render(<ToastStack onMore={noop} moreCount={4} />);
    expect($$("button").map((button) => button.textContent)).toEqual(["+4"]);
    await render(<ToastStack onMore={noop} />);
    expect(container!.innerHTML).toBe("");
  });

  test("Alt+T focuses the first toast from anywhere; arrows, J, K, Home and End move; Escape gives focus back", async () => {
    await render(<ToastStack label="Smithers">{["a", "b", "c"].map(toast)}</ToastStack>);
    const stack = $("[data-slot=toast-stack]")!;
    expect(stack.getAttribute("aria-keyshortcuts")).toBe("Alt+T");
    const start = elsewhere();
    start.focus();
    await hotkey("KeyT");
    const opens = $$("button[data-slot=toast-open]");
    expect(document.activeElement).toBe(opens[0]);
    await press(opens[0]!, "ArrowDown");
    expect(document.activeElement).toBe(opens[1]);
    await press(opens[1]!, "j");
    expect(document.activeElement).toBe(opens[2]);
    await press(opens[2]!, "k");
    expect(document.activeElement).toBe(opens[1]);
    await press(opens[1]!, "Home");
    expect(document.activeElement).toBe(opens[0]);
    await press(opens[0]!, "End");
    expect(document.activeElement).toBe(opens[2]);
    // Alt+T again, from inside, keeps where focus came from.
    await hotkey("KeyT");
    expect(document.activeElement).toBe(opens[0]);
    await press(opens[0]!, "Escape");
    expect(document.activeElement).toBe(start);
  });

  test("Escape with nowhere to go back to just leaves the toast; Alt+T with a modifier, or the wrong key, does nothing", async () => {
    await render(<ToastStack>{[toast("a")]}</ToastStack>);
    const open = $("button[data-slot=toast-open]")!;
    open.focus();
    await press(open, "Escape");
    expect(document.activeElement).not.toBe(open);
    const start = elsewhere();
    start.focus();
    await hotkey("KeyT", { ctrlKey: true });
    await hotkey("KeyN");
    expect(document.activeElement).toBe(start);
    // Letters in a field inside the stack stay letters.
    const field = document.createElement("input");
    $("[data-slot=toast-stack]")!.appendChild(field);
    field.focus();
    await press(field, "j");
    expect(document.activeElement).toBe(field);
  });

  test("a caller's onKeyDown runs first, and Alt+T with no stack shown does nothing", async () => {
    const seen: Array<string> = [];
    await render(
      <ToastStack onKeyDown={(event) => (seen.push(event.key), event.preventDefault())}>{[toast("a"), toast("b")]}</ToastStack>,
    );
    const [first] = $$("button[data-slot=toast-open]");
    first!.focus();
    await press(first!, "ArrowDown");
    expect(seen).toEqual(["ArrowDown"]);
    expect(document.activeElement).toBe(first);
    await render(<ToastStack>{[]}</ToastStack>);
    const start = elsewhere();
    start.focus();
    await hotkey("KeyT");
    expect(document.activeElement).toBe(start);
  });
});

describe("NotificationPanel", () => {
  type Change = Array<boolean>;
  const entry = (id: string, more: Partial<Parameters<typeof NotificationEntry>[0]> = {}) => (
    <NotificationEntry
      key={id}
      entryId={id}
      tone="done"
      detail={id}
      expanded={false}
      onExpandedChange={noop}
      onOpen={noop}
      onHide={noop}
      {...more}
    />
  );

  test("closed, it renders nothing; Alt+N asks to open it, and again to close it", async () => {
    const changes: Change = [];
    await render(<NotificationPanel open={false} onOpenChange={(open) => changes.push(open)}>{[entry("a")]}</NotificationPanel>);
    expect(container!.innerHTML).toBe("");
    await hotkey("KeyN");
    expect(changes).toEqual([true]);
    await render(<NotificationPanel open onOpenChange={(open) => changes.push(open)}>{[entry("a")]}</NotificationPanel>);
    await hotkey("KeyN");
    expect(changes).toEqual([true, false]);
    await hotkey("KeyN", { metaKey: true });
    await hotkey("KeyT");
    expect(changes).toEqual([true, false]);
  });

  test("open: a non-modal dialog named Notifications, its entries in a list; focus goes to the first, or to `focus`", async () => {
    const start = elsewhere();
    start.focus();
    await render(<NotificationPanel open onOpenChange={noop}>{[entry("a"), entry("b")]}</NotificationPanel>);
    const panel = $("[data-slot=notification-panel]")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.getAttribute("aria-keyshortcuts")).toBe("Alt+N");
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe("Notifications");
    expect($("ul")!.getAttribute("aria-label")).toBe("Notifications");
    const rows = $$("[data-slot=notification-row]");
    expect(document.activeElement).toBe(rows[0]);
    await render(<NotificationPanel open onOpenChange={noop} focus="b">{[entry("a"), entry("b")]}</NotificationPanel>);
    expect(document.activeElement).toBe($$("[data-slot=notification-row]")[1]);
    // An entry no longer there: the first.
    await render(<NotificationPanel open onOpenChange={noop} focus="gone">{[entry("a"), entry("b")]}</NotificationPanel>);
    expect(document.activeElement).toBe($$("[data-slot=notification-row]")[0]);
  });

  test("with no entries it says so, and Close takes focus", async () => {
    let closed = 0;
    await render(<NotificationPanel open onOpenChange={(open) => void (open || closed++)} label="Inbox" />);
    expect($(".sui-notification-empty")!.textContent).toBe("No notifications");
    expect($("h2")!.textContent).toBe("Inbox");
    const close = $("button[aria-label=Close]")!;
    expect(document.activeElement).toBe(close);
    await click(close);
    expect(closed).toBe(1);
  });

  test("Escape, from a row or a field in it, asks to close; arrows move between rows; letters in a field stay", async () => {
    const changes: Change = [];
    await render(
      <NotificationPanel open onOpenChange={(open) => changes.push(open)}>
        {[entry("a"), entry("b", { expanded: true, children: <input aria-label="Your answer" /> }), entry("c")]}
      </NotificationPanel>,
    );
    const rows = $$("[data-slot=notification-row]");
    await press(rows[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    await press(rows[1]!, "End");
    expect(document.activeElement).toBe(rows[2]);
    await press(rows[2]!, "Home");
    expect(document.activeElement).toBe(rows[0]);
    const field = $("input")!;
    field.focus();
    await press(field, "j");
    expect(document.activeElement).toBe(field);
    await press(rows[0]!, "Tab");
    expect(changes).toEqual([]);
    await press(field, "Escape");
    await press(rows[0]!, "Escape");
    expect(changes).toEqual([false, false]);
    // A key something inside already handled is left alone.
    $("ul")!.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    await press(rows[0]!, "Escape");
    expect(changes).toEqual([false, false]);
  });

  test("a click outside closes it; a click inside it or on a trigger doesn't", async () => {
    const changes: Change = [];
    const trigger = elsewhere();
    trigger.setAttribute("data-notifications-trigger", "");
    const page = elsewhere();
    await render(<NotificationPanel open onOpenChange={(open) => changes.push(open)}>{[entry("a")]}</NotificationPanel>);
    await pointerDown($("[data-slot=notification-row]")!);
    await pointerDown(trigger);
    expect(changes).toEqual([]);
    await pointerDown(page);
    expect(changes).toEqual([false]);
  });

  test("closing gives focus back where it was, unless the person moved it elsewhere", async () => {
    const start = elsewhere();
    start.focus();
    await render(<NotificationPanel open onOpenChange={noop}>{[entry("a")]}</NotificationPanel>);
    expect(document.activeElement).toBe($("[data-slot=notification-row]"));
    await render(<NotificationPanel open={false} onOpenChange={noop}>{[entry("a")]}</NotificationPanel>);
    expect(document.activeElement).toBe(start);

    await render(<NotificationPanel open onOpenChange={noop}>{[entry("a")]}</NotificationPanel>);
    const other = elsewhere();
    other.focus();
    await render(<NotificationPanel open={false} onOpenChange={noop}>{[entry("a")]}</NotificationPanel>);
    expect(document.activeElement).toBe(other);
  });
});

describe("NotificationEntry", () => {
  test("a row with the unread dot, glyph, word, detail and time; clicking it expands it", async () => {
    const changes: Array<boolean> = [];
    await render(
      <ul>
        <NotificationEntry
          entryId="run:1"
          tone="needs_you"
          detail="Which branch should I deploy?"
          time="2m"
          unread
          expanded={false}
          onExpandedChange={(expanded) => changes.push(expanded)}
          onOpen={noop}
          onAnswer={noop}
          onRead={noop}
          onHide={noop}
        />
      </ul>,
    );
    const item = $("[data-slot=notification]")!;
    expect(item.dataset.entry).toBe("run:1");
    expect(item.dataset.tone).toBe("needs_you");
    expect(item.hasAttribute("data-unread")).toBe(true);
    expect(item.hasAttribute("data-expanded")).toBe(false);
    const row = $("[data-slot=notification-row]")!;
    expect(row.textContent).toBe("Unread◆Needs you · Which branch should I deploy?2m");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.hasAttribute("aria-controls")).toBe(false);
    expect(row.getAttribute("aria-keyshortcuts")).toBe("O E A H R");
    expect($("[data-slot=notification-body]")).toBeNull();
    await click(row);
    expect(changes).toEqual([true]);
  });

  test("expanded: who, the last steps, a note, what else it holds, its actions and Open", async () => {
    const { calls, on } = counter();
    await render(
      <ul>
        <NotificationEntry
          entryId="run:1"
          tone="failed"
          word="Failed"
          detail="Deploy the docs preview"
          expanded
          onExpandedChange={on("collapse")}
          onOpen={on("open")}
          onHide={on("dismiss")}
          hideLabel="Dismiss"
          meta="ann"
          steps={[
            { id: "1", label: "repo/clone", state: "done" },
            { id: "2", label: "app/deploy", state: "running" },
            { id: "3", label: "app/check", state: "failed" },
          ]}
          note="Model error"
          actions={<button onClick={on("retry")}>Retry</button>}
        >
          <p className="extra">more</p>
        </NotificationEntry>
      </ul>,
    );
    const row = $("[data-slot=notification-row]")!;
    const body = $("[data-slot=notification-body]")!;
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-controls")).toBe(body.id);
    expect(row.getAttribute("aria-keyshortcuts")).toBe("O E H");
    expect($("[data-slot=notification]")!.hasAttribute("data-expanded")).toBe(true);
    expect($(".sui-notification-meta")!.textContent).toBe("ann");
    expect($$(".sui-notification-steps li").map((step) => [step.dataset.state, step.textContent])).toEqual([
      ["done", "✓Donerepo/clone"],
      ["running", "◌Runningapp/deploy"],
      ["failed", "✕Failedapp/check"],
    ]);
    expect($(".sui-notification-note")!.textContent).toBe("Model error");
    expect($(".extra")!.textContent).toBe("more");
    expect($$(".sui-notification-actions button").map((button) => button.textContent)).toEqual(["Retry", "Open"]);
    await click(byText("Retry"));
    await click(byText("Open"));
    await click($("button[aria-label=Dismiss]"));
    await click(row);
    expect(calls).toEqual({ retry: 1, open: 1, dismiss: 1, collapse: 1 });
  });

  test("an expanded entry with nothing more shows only Open, named as given", async () => {
    await render(
      <ul>
        <NotificationEntry entryId="main:r" tone="update" word="main" expanded steps={[]} openLabel="Go" onExpandedChange={noop} onOpen={noop} onHide={noop} />
      </ul>,
    );
    expect($(".sui-notification-text")!.textContent).toBe("main");
    expect($(".sui-notification-steps")).toBeNull();
    expect($(".sui-notification-meta")).toBeNull();
    expect($(".sui-notification-note")).toBeNull();
    expect($(".sui-notification-time")).toBeNull();
    expect($$("[data-slot=notification-body] button").map((button) => button.textContent)).toEqual(["Go"]);
    expect($("button[aria-label=Hide]")).not.toBeNull();
  });

  test("O opens, E toggles, A answers, H hides, R reads; keys it has no handler for do nothing", async () => {
    const { calls, on } = counter();
    const changes: Array<boolean> = [];
    await render(
      <ul>
        <NotificationEntry
          entryId="run:1"
          tone="needs_you"
          expanded
          onExpandedChange={(expanded) => changes.push(expanded)}
          onOpen={on("open")}
          onAnswer={on("answer")}
          onRead={on("read")}
          onHide={on("hide")}
        />
      </ul>,
    );
    const row = $("[data-slot=notification-row]")!;
    for (const key of ["o", "e", "a", "h", "r", "x"]) await press(row, key);
    expect(calls).toEqual({ open: 1, answer: 1, hide: 1, read: 1 });
    expect(changes).toEqual([false]);
    await render(
      <ul>
        <NotificationEntry entryId="run:1" tone="done" expanded={false} onExpandedChange={(expanded) => changes.push(expanded)} onOpen={noop} onHide={noop} />
      </ul>,
    );
    await press($("[data-slot=notification-row]")!, "e");
    await press($("[data-slot=notification-row]")!, "a");
    await press($("[data-slot=notification-row]")!, "r");
    expect(changes).toEqual([false, true]);
  });
});

describe("NotificationBell", () => {
  test("names itself with the unread count, shows the count, and opens the panel", async () => {
    let pressed = 0;
    await render(<NotificationBell unread={3} expanded onClick={() => pressed++} />);
    const bell = $("[data-slot=notification-bell]")!;
    expect(bell.getAttribute("aria-label")).toBe("Notifications: 3 unread");
    expect(bell.getAttribute("aria-haspopup")).toBe("dialog");
    expect(bell.getAttribute("aria-expanded")).toBe("true");
    expect(bell.getAttribute("aria-keyshortcuts")).toBe("Alt+N");
    expect(bell.hasAttribute("data-notifications-trigger")).toBe(true);
    expect($(".sui-notification-count")!.textContent).toBe("3");
    expect(bell.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    await click(bell);
    expect(pressed).toBe(1);
  });

  test("runs waiting on the person: ◆ Needs you in gold, the count above 1, and both counts in its name", async () => {
    await render(<NotificationBell unread={3} needsYou={1} />);
    const bell = $("[data-slot=notification-bell]")!;
    expect(bell.hasAttribute("data-needs-you")).toBe(true);
    expect(bell.getAttribute("aria-label")).toBe("Notifications: 1 needs you, 3 unread");
    expect($(".sui-notification-needs")!.textContent).toBe("◆Needs you");
    expect($(".sui-notification-needs")!.getAttribute("aria-hidden")).toBe("true");
    expect($(".sui-notification-count")!.textContent).toBe("3");
    await render(<NotificationBell needsYou={2} />);
    expect($("[data-slot=notification-bell]")!.getAttribute("aria-label")).toBe("Notifications: 2 need you");
    expect($(".sui-notification-needs-count")!.textContent).toBe("2");
    expect($(".sui-notification-count")).toBeNull();
    expect(smithersUiCss).toMatch(/\.sui-notification-bell\[data-needs-you\] \{[^}]*background:var\(--warning-soft/);
  });

  test("no count at 0; 99+ past 99", async () => {
    await render(<NotificationBell />);
    expect($("[data-slot=notification-bell]")!.getAttribute("aria-label")).toBe("Notifications");
    expect($("[data-slot=notification-bell]")!.getAttribute("aria-expanded")).toBe("false");
    expect($(".sui-notification-count")).toBeNull();
    expect($(".sui-notification-needs")).toBeNull();
    expect($("[data-slot=notification-bell]")!.hasAttribute("data-needs-you")).toBe(false);
    await render(<NotificationBell unread={120} />);
    expect($(".sui-notification-count")!.textContent).toBe("99+");
  });
});

test("a compact NeedsYouCard keeps only its controls; the prompt stays for screen readers", async () => {
  await render(
    <NeedsYouCard compact kind="question" prompt="Which branch?" options={["main"]} value="" onValueChange={noop} onAnswer={noop} />,
  );
  const card = $("[data-slot=needs-you]")!;
  expect(card.hasAttribute("data-compact")).toBe(true);
  expect($("[data-slot=agent-status]")).toBeNull();
  const prompt = document.getElementById(card.getAttribute("aria-labelledby")!)!;
  expect(prompt.textContent).toBe("Which branch?");
  expect(prompt.className).toBe("sui-sr-only");
  expect($$("button").map((button) => button.textContent)).toEqual(["main", "Answer"]);
  await render(<NeedsYouCard kind="question" prompt="Which branch?" value="" onValueChange={noop} onAnswer={noop} />);
  expect($("[data-slot=needs-you]")!.hasAttribute("data-compact")).toBe(false);
  expect($("[data-slot=agent-status]")).not.toBeNull();
  expect($(".sui-needs-you-prompt")!.textContent).toBe("Which branch?");
  expect(smithersUiCss).toContain(".sui-needs-you[data-compact] { padding:0; border:0; background:transparent; }");
});

test("the panel's sheet: fixed at the top-right, its list scrolls, full width on a phone", () => {
  expect(smithersUiCss).toMatch(/\.sui-notification-panel \{ position:fixed;[^}]*top:12px; right:12px;/);
  expect(smithersUiCss).toMatch(/\.sui-notification-list \{[^}]*overflow-y:auto;/);
  expect(smithersUiCss).toContain("@media (max-width: 640px) { .sui-notification-panel { top:0; right:0; left:0;");
  expect(smithersUiCss).toMatch(/button\.sui-toast-open \{[^}]*cursor:pointer;/);
});

 test("a direct-open row keeps Details separate and failure distinct from dismiss", async () => {
  let opened = 0;
  const changes: boolean[] = [];
  await render(<ul><NotificationEntry entryId="run:direct" tone="failed" expanded={false}
    onActivate={() => opened++} onOpen={() => opened++} onExpandedChange={value => changes.push(value)} onHide={noop} /></ul>);
  const row = $("[data-slot=notification-row]")!;
  await click(row);
  expect(opened).toBe(1);
  expect(changes).toEqual([]);
  expect(row.hasAttribute("aria-expanded")).toBe(false);
  expect($(".sui-notification-glyph")!.textContent).toBe("!");
  await click(byText("Details"));
  await press(row, "e");
  expect(changes).toEqual([true, true]);
 });

 test("an entry without a destination exposes details without a dead Open action", async () => {
  await render(<ul><NotificationEntry entryId="clone:missing" tone="failed" expanded
    onExpandedChange={noop} onHide={noop} note="Not found" /></ul>);
  expect(byText("Open")).toBeNull();
  expect($("[data-slot=notification-row]")!.getAttribute("aria-keyshortcuts")).toBe("E H");
  await press($("[data-slot=notification-row]")!, "o");
 });
