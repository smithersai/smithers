/** @jsxImportSource react */
// LinkIntent under happy-dom: real createRoot + act, pointer and focus events dispatched as native events, so React's
// delegated handlers see them as a browser's.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { intentPath, LinkIntent, SMITHERS_UI_STYLE_ATTR } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "http://app.test";
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

/** Links inside a LinkIntent of `delayMs`, and the paths it reported. */
async function render(delayMs: number) {
  const intents: Array<string> = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <LinkIntent delayMs={delayMs} origin={ORIGIN} onIntent={(path) => intents.push(path)}>
        <a href={`${ORIGIN}/octocat/Spoon-Knife/blob/main/README.md?L=3`} data-testid="file">
          <span data-testid="name">README.md</span>
        </a>
        <a href={`${ORIGIN}/octocat/Spoon-Knife/tree/main/docs`} data-testid="folder">docs</a>
        <a href="https://github.com/octocat" data-testid="elsewhere">GitHub</a>
        <a href={`${ORIGIN}/raw`} target="_blank" data-testid="tab">Raw</a>
        <a href={`${ORIGIN}/download`} download="x" data-testid="download">Download</a>
        <p data-testid="text">Not a link</p>
      </LinkIntent>,
    ),
  );
  return intents;
}

const el = (id: string) => container!.querySelector(`[data-testid="${id}"]`)!;
const over = (target: Element) =>
  act(async () => void target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
const out = (target: Element, to: Element | null) =>
  act(async () => void target.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: to })));
/** Lets real time pass: the delay is the component's own. */
const pass = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe("LinkIntent", () => {
  test("a pointer resting on a link reports its path once, without its search", async () => {
    const intents = await render(20);
    await over(el("name"));
    expect(intents).toEqual([]);
    // Moving within the link restarts nothing.
    await out(el("name"), el("file"));
    await over(el("file"));
    await pass(60);
    expect(intents).toEqual(["/octocat/Spoon-Knife/blob/main/README.md"]);
  });

  test("a pointer that leaves before the delay reports nothing; the next link it rests on, its own", async () => {
    const intents = await render(30);
    await over(el("file"));
    await out(el("file"), el("text"));
    await pass(60);
    expect(intents).toEqual([]);
    await over(el("file"));
    await over(el("folder"));
    await pass(60);
    expect(intents).toEqual(["/octocat/Spoon-Knife/tree/main/docs"]);
  });

  test("focus reports a link as hover does, and blur cancels it", async () => {
    const intents = await render(20);
    await act(async () => void el("folder").dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await act(async () => void el("folder").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await pass(50);
    expect(intents).toEqual([]);
    await act(async () => void el("folder").dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await pass(50);
    expect(intents).toEqual(["/octocat/Spoon-Knife/tree/main/docs"]);
  });

  test("another origin, a new tab, a download or no link reports nothing, and takes no box", async () => {
    const intents = await render(10);
    for (const id of ["elsewhere", "tab", "download", "text"]) await over(el(id));
    await pass(40);
    expect(intents).toEqual([]);
    expect(container!.querySelector('[data-slot="link-intent"]')!.className).toBe("sui-link-intent");
  });

  test("intentPath reads only same-origin anchors that open here", () => {
    const a = document.createElement("a");
    a.href = `${ORIGIN}/x/y?L=1#top`;
    expect(intentPath(a, ORIGIN)).toBe("/x/y");
    expect(intentPath(a, "http://other.test")).toBeUndefined();
    a.target = "_self";
    expect(intentPath(a, ORIGIN)).toBe("/x/y");
    expect(intentPath(null, ORIGIN)).toBeUndefined();
    expect(intentPath(document.createElement("span"), ORIGIN)).toBeUndefined();
  });
});

test.each(["http://[", "https://[", "http://[::1"])("malformed link %s has no intent", async (href) => {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", href);
  expect(intentPath(anchor, ORIGIN)).toBeUndefined();
  const intents: string[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <LinkIntent delayMs={0} origin={ORIGIN} onIntent={(path) => intents.push(path)}>
      <a href={href}><span>Invalid</span></a>
    </LinkIntent>,
  ));
  const label = container.querySelector("span")!;
  await over(label);
  await act(async () => label.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  await pass(10);
  expect(intents).toEqual([]);
});
