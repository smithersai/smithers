import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type FrameWindow, formValues, initializeId, nonceAttribute, startFrame } from "../src/generated-view/frame";

const nonce = "n".repeat(32);

/** A frame of its own: a fresh window whose parent is itself, as happy-dom makes one. */
const frame = (options: { readonly resize?: boolean } = {}) => {
  const window = new Window();
  const asked: Array<unknown> = [];
  window.document.documentElement.setAttribute(nonceAttribute, nonce);
  window.postMessage = ((message: unknown) => asked.push(message)) as typeof window.postMessage;
  if (options.resize === false) (window as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
  startFrame(window as unknown as FrameWindow);
  return { window, document: window.document, asked };
};

/** Answers the frame's `ui/initialize` with a port, and collects what the frame posts on it. */
const connect = async (opened: ReturnType<typeof frame>, result: Record<string, unknown> = { html: "", theme: "light", size: "inline" }) => {
  const channel = new MessageChannel();
  const received: Array<any> = [];
  channel.port2.onmessage = (event) => received.push(event.data);
  opened.window.dispatchEvent(
    new opened.window.MessageEvent("message", {
      data: { jsonrpc: "2.0", id: initializeId, result },
      source: opened.window as never,
      ports: [channel.port1 as never],
    }),
  );
  await tick();
  return { port: channel.port2, received };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A click as a person makes one: trusted. */
const click = (opened: ReturnType<typeof frame>, element: ReturnType<ReturnType<typeof frame>["document"]["createElement"]>) => {
  const event = new opened.window.MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  element.dispatchEvent(event as never);
  return event;
};

const interactions = (received: Array<any>) => received.filter((message) => message.method === "smithers/interaction").map((message) => message.params);

describe("the frame runtime", () => {
  test("asks its parent once, with the nonce it was written with", () => {
    const opened = frame();
    expect(opened.asked).toEqual([{ jsonrpc: "2.0", id: initializeId, method: "ui/initialize", params: { nonce } }]);
    expect(opened.document.body.innerHTML).toBe('<div data-smithers-view=""></div>');
  });

  test("shows the sanitized HTML and the theme it is answered with, and their changes", async () => {
    const opened = frame();
    const { port, received } = await connect(opened, { html: '<p onclick="x()">hi</p><script>x()</script>', theme: "dark", size: "inline" });
    const root = opened.document.querySelector("[data-smithers-view]")!;
    expect(root.innerHTML).toBe("<p>hi</p>");
    expect(opened.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(received).toEqual([{ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 0 } }]);
    port.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { html: "<b>2</b>" } });
    await tick();
    expect(root.innerHTML).toBe("<b>2</b>");
    expect(opened.document.documentElement.getAttribute("data-theme")).toBe("dark");
    port.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
    port.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "neon" } });
    port.postMessage({ jsonrpc: "2.0", method: "something/else", params: { html: "<i>no</i>" } });
    port.postMessage("not an object");
    port.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: "no" });
    await tick();
    expect(root.innerHTML).toBe("<b>2</b>");
    expect(opened.document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("takes only the parent's answer to its request, carrying one port, once", async () => {
    const opened = frame();
    const root = opened.document.querySelector("[data-smithers-view]")!;
    const send = (data: unknown, options: { readonly source?: unknown; readonly ports?: number } = {}) =>
      opened.window.dispatchEvent(
        new opened.window.MessageEvent("message", {
          data,
          source: (options.source ?? opened.window) as never,
          ports: Array.from({ length: options.ports ?? 1 }, () => new MessageChannel().port1) as never,
        }),
      );
    const answer = (html: string) => ({ jsonrpc: "2.0", id: initializeId, result: { html, theme: "light", size: "inline" } });
    send(answer("<p>stranger</p>"), { source: new Window() });
    send({ ...answer("<p>wrong id</p>"), id: 7 });
    send({ jsonrpc: "2.0", id: initializeId });
    send("text");
    send(answer("<p>no port</p>"), { ports: 0 });
    send(answer("<p>two ports</p>"), { ports: 2 });
    expect(root.innerHTML).toBe("");
    await connect(opened, { html: "<p>parent</p>", theme: "light", size: "inline" });
    send(answer("<p>again</p>"));
    expect(root.innerHTML).toBe("<p>parent</p>");
  });

  test("turns a real click on a data-event element into an interaction", async () => {
    const opened = frame();
    const { received } = await connect(opened, {
      html: '<div><button data-event="cell:4"><span>X</span></button><button data-event="again">Again</button><button aria-disabled="true" data-event="off">Off</button><p>plain</p></div>',
      theme: "light",
      size: "inline",
    });
    const [cell, again, off] = Array.from(opened.document.querySelectorAll("button"));
    const event = click(opened, cell!.querySelector("span")!);
    click(opened, again!);
    click(opened, off!);
    click(opened, opened.document.querySelector("p")!);
    again!.dispatchEvent(new opened.window.MouseEvent("click", { bubbles: true }) as never);
    await tick();
    expect(event.defaultPrevented).toBe(true);
    expect(interactions(received)).toEqual([{ event: "cell", arg: "4" }, { event: "again" }]);
  });

  test("ignores clicks outside the view and clicks on things that are not elements", async () => {
    const opened = frame();
    const { received } = await connect(opened);
    const outside = opened.document.createElement("button");
    outside.setAttribute("data-event", "outside");
    opened.document.body.appendChild(outside);
    click(opened, outside);
    const text = opened.document.createTextNode("t");
    opened.document.querySelector("[data-smithers-view]")!.appendChild(text);
    click(opened, text as never);
    await tick();
    expect(interactions(received)).toEqual([]);
  });

  test("sends a form's values with its own or its button's event, and on Enter in a field", async () => {
    const opened = frame();
    const { received } = await connect(opened, {
      html: '<form data-event="clone"><input name="url" value="https://github.com/maya/tinyhttp"><input type="checkbox" name="private" checked>' +
        '<textarea name="note">n</textarea><button type="submit">Clone</button><button data-event="cancel">Cancel</button></form>' +
        '<form><input name="q"><button type="submit">Nothing</button></form>',
      theme: "light",
      size: "inline",
    });
    const [clone, cancel, nothing] = Array.from(opened.document.querySelectorAll("button"));
    click(opened, clone!);
    click(opened, cancel!);
    click(opened, nothing!);
    const enter = (target: ReturnType<ReturnType<typeof frame>["document"]["createElement"]>, key = "Enter", trusted = true) => {
      const event = new opened.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      if (trusted) Object.defineProperty(event, "isTrusted", { value: true });
      target.dispatchEvent(event as never);
    };
    const [url, , q] = Array.from(opened.document.querySelectorAll("input"));
    enter(url!);
    enter(url!, "a");
    enter(url!, "Enter", false);
    enter(opened.document.querySelector("textarea")!);
    enter(q!);
    const stray = opened.document.createElement("form");
    stray.setAttribute("data-event", "stray");
    stray.appendChild(opened.document.createElement("input"));
    opened.document.body.appendChild(stray);
    enter(stray.querySelector("input")!);
    await tick();
    const values = { url: "https://github.com/maya/tinyhttp", private: true, note: "n" };
    expect(interactions(received)).toEqual([
      { event: "clone", values },
      { event: "cancel", values },
      { event: "clone", values },
    ]);
  });

  test("runs where the frame has no ResizeObserver", async () => {
    const opened = frame({ resize: false });
    const { received } = await connect(opened, { html: "<p>x</p>", theme: "light", size: "full" });
    expect(received).toHaveLength(1);
  });
});

describe("formValues", () => {
  test("omits hidden controls, including hidden ancestors and CSS", () => {
    const window = new Window();
    window.document.body.innerHTML = `<form>
      <input name="visible" value="yes"><input type="hidden" name="secret" value="no">
      <div hidden><input name="ancestor" value="no"></div>
      <input name="display" style="display:none" value="no">
      <input name="visibility" style="visibility:hidden" value="no">
      <div style="opacity:0"><textarea name="opacity">no</textarea></div>
      </form>`;
    expect(formValues(window.document.querySelector("form") as never)).toEqual({ visible: "yes" });
  });

  test("reads named, enabled fields as booleans, numbers and strings", () => {
    const window = new Window();
    window.document.body.innerHTML =
      '<form><input name="text" value="a"><input type="number" name="n" value="3"><input type="number" name="empty" value="">' +
      '<input type="range" name="r" value="7"><input type="checkbox" name="c"><input type="radio" name="pick" value="a">' +
      '<input type="radio" name="pick" value="b" checked><select name="many" multiple><option value="x" selected>x</option>' +
      '<option value="y" selected>y</option><option value="z">z</option></select><select name="one"><option value="o">o</option></select>' +
      '<input name="off" value="d" disabled><input value="unnamed"><input type="submit" name="s" value="S">' +
      '<input type="button" name="b" value="B"><input type="reset" name="re"></form>';
    expect(formValues(window.document.querySelector("form") as never)).toEqual({
      text: "a",
      n: 3,
      empty: "",
      r: 7,
      c: false,
      pick: "b",
      many: "x,y",
      one: "o",
    });
  });
});
