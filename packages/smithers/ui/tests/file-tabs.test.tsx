/** @jsxImportSource react */
// FileTabs under happy-dom: real createRoot + act, as breadcrumbs.test.tsx does. Clicks and keys are dispatched as
// native events, so the modifier keys, the default-prevented flag and the focus are the browser's own.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createRef, Suspense, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type FileTab, type FileTabsFocusEvent, FileTabs, SMITHERS_UI_STYLE_ATTR } from "../src/index";
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

/** Clicks `el` like a browser, returning whether the default action still runs. */
async function click(el: Element, init: MouseEventInit = {}): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
  return followed;
}

/** Presses `key` on `el`, returning whether the default action still runs. */
async function press(el: Element, key: string): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  });
  return followed;
}

const tab = (path: string, active = false): FileTab => ({
  key: path,
  label: path.split("/").at(-1)!,
  title: path,
  href: `/maya/tinyhttp/blob/main/${path}`,
  active,
});

const TABS = [tab("README.md"), tab("src/router.ts", true), tab("src/app.ts")];

const tabs = () => [...container!.querySelectorAll<HTMLElement>("[role=tab]")];

describe("FileTabs", () => {
  test("a tablist of links, the active file selected and the only tab in the Tab order", async () => {
    await render(<FileTabs tabs={TABS} onOpen={() => {}} onClose={() => {}} />);
    const list = container!.querySelector("[role=tablist]")!;
    expect(list.getAttribute("aria-label")).toBe("Open files");
    expect(tabs().map((el) => [el.textContent, el.getAttribute("href"), el.getAttribute("title")])).toEqual([
      ["README.md", "/maya/tinyhttp/blob/main/README.md", "README.md"],
      ["router.ts", "/maya/tinyhttp/blob/main/src/router.ts", "src/router.ts"],
      ["app.ts", "/maya/tinyhttp/blob/main/src/app.ts", "src/app.ts"],
    ]);
    expect(tabs().map((el) => el.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs().map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
    expect([...container!.querySelectorAll("button")].map((el) => [el.getAttribute("aria-label"), el.tabIndex]))
      .toEqual([["Close README.md", -1], ["Close router.ts", -1], ["Close app.ts", -1]]);
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(".sui-file-tab");
  });

  test("without an active file the first tab is in the Tab order; with no files there is no strip", async () => {
    await render(<FileTabs tabs={[tab("a.ts"), tab("b.ts")]} onOpen={() => {}} onClose={() => {}} aria-label="Files" />);
    expect(container!.querySelector("[role=tablist]")!.getAttribute("aria-label")).toBe("Files");
    expect(tabs().map((el) => el.tabIndex)).toEqual([0, -1]);
    await act(async () => root!.render(<FileTabs tabs={[]} onOpen={() => {}} onClose={() => {}} />));
    expect(container!.innerHTML).toBe("");
  });

  test("a tab whose href could run script has no href, and a plain click still opens it in the app", async () => {
    const opened: string[] = [];
    await render(<FileTabs tabs={[{ ...tab("x.ts"), href: "java\tscript:alert(1)" }, tab("y.ts")]} onOpen={(t) => opened.push(t.key)} onClose={() => {}} />);
    expect(tabs().map((el) => el.getAttribute("href"))).toEqual([null, "/maya/tinyhttp/blob/main/y.ts"]);
    await act(async () => void tabs()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(opened).toEqual(["x.ts"]);
  });

  test("a plain click opens in the app; a modified or secondary click is the browser's; × closes", async () => {
    const seen: Array<string> = [];
    await render(
      <FileTabs tabs={TABS} onOpen={(t) => seen.push(`open ${t.key}`)} onClose={(t) => seen.push(`close ${t.key}`)} />,
    );
    expect(await click(tabs()[0]!)).toBe(false);
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(await click(tabs()[2]!, init)).toBe(true);
    }
    await click(container!.querySelectorAll("button")[2]!);
    expect(seen).toEqual(["open README.md", "close src/app.ts"]);
  });

  test("arrows, Home and End move focus round the strip; Space opens; other keys are the browser's", async () => {
    const seen: Array<string> = [];
    await render(<FileTabs tabs={TABS} onOpen={(t) => seen.push(t.key)} onClose={() => {}} />);
    const focused = () => document.activeElement?.textContent;
    tabs()[1]!.focus();
    expect(await press(tabs()[1]!, "ArrowRight")).toBe(false);
    expect(focused()).toBe("app.ts");
    await press(tabs()[2]!, "ArrowRight");
    expect(focused()).toBe("README.md");
    await press(tabs()[0]!, "ArrowLeft");
    expect(focused()).toBe("app.ts");
    await press(tabs()[2]!, "Home");
    expect(focused()).toBe("README.md");
    await press(tabs()[0]!, "End");
    expect(focused()).toBe("app.ts");
    expect(await press(tabs()[2]!, " ")).toBe(false);
    expect(await press(tabs()[2]!, "a")).toBe(true);
    expect(seen).toEqual(["src/app.ts"]);
  });

  test("Delete or Backspace closes the focused tab and focuses the one taking its place", async () => {
    const seen: Array<string> = [];
    await render(<FileTabs tabs={TABS} onOpen={() => {}} onClose={(t) => seen.push(t.key)} />);
    tabs()[1]!.focus();
    expect(await press(tabs()[1]!, "Delete")).toBe(false);
    expect(document.activeElement?.textContent).toBe("app.ts");
    tabs()[2]!.focus();
    await press(tabs()[2]!, "Backspace");
    expect(document.activeElement?.textContent).toBe("router.ts");
    expect(seen).toEqual(["src/router.ts", "src/app.ts"]);
  });
});


test("focus diagnostics report keyboard requests, consumption, removal and outside ownership without paths", async () => {
  const events: Array<FileTabsFocusEvent> = [];
  const record = (event: FileTabsFocusEvent) => { events.push(event); };
  const draw = (files: ReadonlyArray<FileTab>) => <FileTabs tabs={files} onOpen={() => {}} onClose={() => {}} onFocusLifecycle={record} />;
  await render(draw(TABS));
  tabs()[0]!.focus();
  await press(tabs()[0]!, "Delete");
  expect(events).toEqual([
    { phase: "requested", reason: "keyboard" },
    { phase: "consumed", reason: "keyboard" },
  ]);
  await act(async () => root!.render(draw([tab("only.ts")])));
  tabs()[0]!.focus();
  await press(tabs()[0]!, "Delete");
  expect(events.slice(-2)).toEqual([
    { phase: "requested", reason: "keyboard" },
    { phase: "dropped", reason: "disconnected" },
  ]);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  await act(async () => root!.unmount());
  root = undefined;
  outside.remove();
  expect(events.at(-1)).toEqual({ phase: "dropped", reason: "outside" });
});


test("Suspense reveal records restoration and preserves the caller's strip ref", async () => {
  const events: Array<FileTabsFocusEvent> = [];
  const ref = createRef<HTMLDivElement>();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  function Pending({ pause }: { pause: boolean }) { if (pause) throw wait; return null; }
  const draw = (pause: boolean) => <Suspense fallback={<p>Pending</p>}>
    <FileTabs ref={ref} tabs={TABS} onOpen={() => {}} onClose={() => {}} onFocusLifecycle={(event) => { events.push(event); }} />
    <Pending pause={pause} />
  </Suspense>;
  await render(draw(false));
  const link = tabs()[0]!;
  const strip = ref.current;
  expect(strip).toBe(container!.querySelector('[role=tablist]'));
  link.focus();
  await act(async () => root!.render(draw(false)));
  expect(events).toEqual([]);
  expect(ref.current).toBe(strip);
  expect(document.activeElement).toBe(link);
  await act(async () => root!.render(draw(true)));
  // happy-dom keeps focus on a hidden link; Chromium's actual blur on hide
  // is covered by apps/mvp/tests/FileTabs.browser.test.ts.
  link.blur();
  await act(async () => { release(); root!.render(draw(false)); });
  expect(ref.current).toBe(strip);
  expect(document.activeElement).toBe(link);
  expect(events.slice(-2)).toEqual([
    { phase: "requested", reason: "restored" },
    { phase: "consumed", reason: "restored" },
  ]);
});


test("caller callback ref changes preserve focus, cleanup and accurate diagnostics", async () => {
  const events: Array<FileTabsFocusEvent> = [];
  const cleanups: Array<string> = [];
  const draw = (name: string) => <FileTabs
    ref={() => () => { cleanups.push(name); }}
    tabs={TABS} onOpen={() => {}} onClose={() => {}}
    onFocusLifecycle={(event) => { events.push(event); }}
  />;
  await render(draw("first"));
  const link = tabs()[0]!;
  link.focus();
  await act(async () => root!.render(draw("second")));
  expect(document.activeElement).toBe(link);
  expect(events).toEqual([]);
  expect(cleanups).toEqual(["first"]);
  await act(async () => root!.unmount());
  root = undefined;
  expect(cleanups).toEqual(["first", "second"]);
  expect(events).toEqual([{ phase: "dropped", reason: "disconnected" }]);
});
