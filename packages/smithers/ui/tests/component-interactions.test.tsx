/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Window } from "happy-dom";
import { ActionMenu, type ActionMenuItem } from "../src/action-menu/ActionMenu";
import { InlineCitation, CitationCard, CitationCarousel } from "../src/agentic/InlineCitation";
import { NotificationEntry, NotificationPanel } from "../src/agent-status/NotificationPanel";
import { Toast, ToastStack } from "../src/agent-status/ToastStack";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
});

async function render(element: ReactElement) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(element));
}
const $ = (selector: string) => host!.querySelector<HTMLElement>(selector)!;
const $$ = (selector: string) => [...host!.querySelectorAll<HTMLElement>(selector)];
const press = (element: Element, key: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
});
const click = (element: HTMLElement) => act(async () => element.click());
const noop = () => {};
const source = { id: "report", title: "Report", url: "https://example.test/report", excerpt: "Report details." };
const settle = () => act(async () => {
  await (window as unknown as Window).happyDOM.waitUntilComplete();
});

test("toast arrows count from Hide or action in the current toast", async () => {
  await render(<ToastStack>{["a", "b", "c"].map(id =>
    <Toast key={id} tone="done" detail={id} onOpen={noop} onHide={noop} action={{ label: "Details", onAction: noop }} />
  )}</ToastStack>);
  const opens = $$('[data-slot="toast-open"]');
  const hides = $$('button[aria-label="Hide"]');
  await act(async () => hides[1]!.focus());
  await press(hides[1]!, "ArrowDown");
  expect(document.activeElement === opens[2]).toBe(true);
  const action = $$('[data-slot="toast"]')[1]!.querySelectorAll<HTMLElement>("button")[1]!;
  await press(action, "ArrowUp");
  expect(document.activeElement === opens[0]).toBe(true);
});

test("panel arrows count from controls in an expanded entry", async () => {
  await render(<NotificationPanel open onOpenChange={noop}>{["a", "b", "c"].map(id =>
    <NotificationEntry key={id} entryId={id} tone="done" detail={id} expanded onExpandedChange={noop} onOpen={noop} onHide={noop}>
      <button>Choose</button>
    </NotificationEntry>
  )}</NotificationPanel>);
  const rows = $$('[data-slot="notification-row"]');
  const entries = $$('[data-slot="notification"]');
  for (const control of entries[1]!.querySelectorAll<HTMLElement>("button")) {
    if (control === rows[1]) continue;
    await act(async () => control.focus());
    await press(control, "ArrowDown");
    expect(document.activeElement === rows[2]).toBe(true);
    await press(control, "k");
    expect(document.activeElement === rows[0]).toBe(true);
  }
});

test.each([0, 2, 3])("an expanded toast stack resets after shrinking to %i entries", async count => {
  const stack = (size: number) => <ToastStack>{Array.from({ length: size }, (_, id) =>
    <Toast key={id} tone="done" detail={String(id)} onHide={noop} />
  )}</ToastStack>;
  await render(stack(5));
  await click($$("button").find(button => button.textContent === "+2")!);
  expect($$('[data-slot="toast"]')).toHaveLength(5);
  await render(stack(count));
  expect($$("button").some(button => button.textContent === "Less")).toBe(false);
  await render(stack(5));
  expect($$('[data-slot="toast"]')).toHaveLength(3);
  expect($$("button").some(button => button.textContent === "+2")).toBe(true);
});

test("focus leaving a citation cancels its pending preview", async () => {
  const changes: boolean[] = [];
  await render(<><InlineCitation index={1} label="Report" sources={[source]} onOpenChange={open => changes.push(open)} /><button>Next</button></>);
  await act(async () => $('[data-slot="inline-citation-trigger"]').focus());
  await act(async () => $$("button").at(-1)!.focus());
  await settle();
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(0);
  expect(changes).toEqual([]);
});

test("focus can enter a preview; leaving it closes an unpinned preview", async () => {
  await render(<><InlineCitation index={1} label="Report" sources={[source]} /><button>Next</button></>);
  await act(async () => $('[data-slot="inline-citation-trigger"]').focus());
  await settle();
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
  await act(async () => $(".sui-citation-card-link").focus());
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
  await act(async () => $$("button").at(-1)!.focus());
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(0);
});

test.each(["leave", "outside", "escape"])("a hover preview closes on %s without trigger focus", async reason => {
  await render(<><InlineCitation index={1} label="Report" sources={[source]} /><button>Outside</button></>);
  const trigger = $('[data-slot="inline-citation-trigger"]');
  await act(async () => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await settle();
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
  if (reason === "leave") {
    await act(async () => trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: host })));
  } else if (reason === "outside") {
    await act(async () => $$("button").at(-1)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  } else {
    await press(document.body, "Escape");
  }
  await settle();
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(0);
});

test("click-opened previews survive blur, pointer leave and outside clicks until Escape", async () => {
  await render(<><InlineCitation index={1} label="Report" sources={[source]} /><button>Outside</button></>);
  const trigger = $('[data-slot="inline-citation-trigger"]');
  await click(trigger);
  await act(async () => {
    trigger.focus();
    $$("button").at(-1)!.focus();
    trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: host }));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
  await press(trigger, "Escape");
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(0);
});

test("controlled citation previews leave dismissal to the host", async () => {
  const changes: boolean[] = [];
  await render(<><InlineCitation index={1} label="Report" sources={[source]} open onOpenChange={open => changes.push(open)} /><button>Outside</button></>);
  await act(async () => {
    $('[data-slot="inline-citation-trigger"]').focus();
    $$("button").at(-1)!.focus();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  expect(changes).toEqual([]);
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
});

test.each(["link", "single", "multiple", "card", "carousel"])("citation %s navigation intercepts only unhandled plain clicks", async mode => {
  const navigated: string[] = [];
  const onNavigate = (href: string) => { navigated.push(href); };
  const props = { index: 1, label: "Report", onNavigate };
  // Card and carousel exercise their public standalone contracts.
  await render(mode === "card" ? <CitationCard source={source} onNavigate={onNavigate} /> :
    mode === "carousel" ? <CitationCarousel sources={[source]} onNavigate={onNavigate} /> :
    mode === "link" ? <InlineCitation {...props} href={source.url} /> :
    <InlineCitation {...props} sources={mode === "single" ? [source] : [source, { ...source, id: "second" }]} defaultOpen />);
  const link = $("a");
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(navigated).toEqual([]);
  }
  const handled = new MouseEvent("click", { bubbles: true, cancelable: true });
  handled.preventDefault();
  await act(async () => link.dispatchEvent(handled));
  expect(navigated).toEqual([]);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => link.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(navigated).toEqual([source.url]);
});

const confirm = { title: "Archive?", action: "Archive" };
const ask = async (items: readonly ActionMenuItem[], index = 0) => {
  await render(<ActionMenu label="Actions" items={items} />);
  await press($('[data-slot="action-menu-trigger"]'), "Enter");
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][index]!);
};
const confirmAction = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(button => button.textContent === "Archive")!;

test("confirmation runs the current callback after the host refreshes its items", async () => {
  const ran: string[] = [];
  await ask([{ label: "Archive", confirm, onSelect: () => { ran.push("stale"); } }]);
  await render(<ActionMenu label="Actions" items={[{ label: "Archive", confirm, onSelect: () => { ran.push("current"); } }]} />);
  await click(confirmAction());
  expect(ran).toEqual(["current"]);
});

test.each(["removed", "replaced", "no-confirm"])("a %s action closes its pending confirmation without running it", async change => {
  const ran: string[] = [];
  await ask([{ label: "Archive", confirm, onSelect: () => { ran.push("stale"); } }]);
  await render(<ActionMenu label="Actions" items={change === "removed" ? [] : [{
    label: change === "replaced" ? "Delete" : "Archive",
    confirm: change === "no-confirm" ? undefined : confirm,
    onSelect: () => { ran.push("replacement"); },
  }]} />);
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
  expect(ran).toEqual([]);
});

test("duplicate action labels select and confirm the requested position", async () => {
  const ran: string[] = [];
  await ask([0, 1].map(index => ({ id: String(index), label: "Archive", confirm, onSelect: () => { ran.push("old" + index); } })), 1);
  await render(<ActionMenu label="Actions" items={[0, 1].map(index => ({ id: String(index), label: "Archive", confirm, onSelect: () => { ran.push("new" + index); } }))} />);
  await click(confirmAction());
  expect(ran).toEqual(["new1"]);
});

test("pointer leave preserves a preview and its keyboard-focused source", async () => {
  await render(<InlineCitation index={1} label="Report" sources={[source]} />);
  const trigger = $('[data-slot="inline-citation-trigger"]');
  await act(async () => trigger.focus());
  await settle();
  const link = $(".sui-citation-card-link");
  await act(async () => {
    link.focus();
    trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: host }));
  });
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
  expect(document.activeElement === link).toBe(true);
});

test.each([false, true])("removing the chosen duplicate action closes confirmation (stable ids: %s)", async ids => {
  const ran: string[] = [];
  const actions = [0, 1].map(index => ({
    id: ids ? String(index) : undefined, label: "Archive", confirm,
    onSelect: () => { ran.push(String(index)); },
  }));
  await ask(actions);
  await render(<ActionMenu label="Actions" items={[actions[1]!]} />);
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
  expect(ran).toEqual([]);
});

test("reordering stable action ids retains the selected action's current callback", async () => {
  const ran: string[] = [];
  const actions = [0, 1].map(index => ({ id: String(index), label: "Archive", confirm, onSelect: () => { ran.push("old" + index); } }));
  await ask(actions);
  await render(<ActionMenu label="Actions" items={[1, 0].map(index => ({
    id: String(index), label: "Archive", confirm, onSelect: () => { ran.push("new" + index); },
  }))} />);
  await click(confirmAction());
  expect(ran).toEqual(["new0"]);
});

test("refreshing indistinguishable duplicate actions closes the ambiguous confirmation", async () => {
  const ran: string[] = [];
  const actions = () => [0, 1].map(index => ({ label: "Archive", confirm, onSelect: () => { ran.push(String(index)); } }));
  await ask(actions());
  await render(<ActionMenu label="Actions" items={actions()} />);
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
  expect(ran).toEqual([]);
});


test("re-entering a hover preview cancels its pending pointer-leave dismissal", async () => {
  await render(<InlineCitation index={1} label="Report" sources={[source]} />);
  const trigger = $('[data-slot="inline-citation-trigger"]');
  await act(async () => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await settle();
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  });
  await act(async () => {
    $(".sui-citation-card-link").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  await settle();
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(1);
});


test("an internal press never suppresses blur to a different focusable control", async () => {
  await render(<><InlineCitation index={1} label="Report" sources={[source]} /><button>Outside</button></>);
  const trigger = $('[data-slot="inline-citation-trigger"]');
  await act(async () => trigger.focus());
  await settle();
  await act(async () => $(".sui-citation-card-excerpt").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  // Exercise an explicit focus destination independently of pointer default actions.
  await act(async () => trigger.dispatchEvent(new FocusEvent("focusout", {
    bubbles: true, relatedTarget: $$("button").at(-1)!,
  })));
  expect($$('[data-slot="inline-citation-content"]')).toHaveLength(0);
  await act(async () => document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
});
