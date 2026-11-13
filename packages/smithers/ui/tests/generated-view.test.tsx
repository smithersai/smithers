/** @jsxImportSource react */
// GeneratedView under happy-dom: real createRoot + act. happy-dom delivers no
// window message's source or ports, so the frame's side of the handshake is
// played here: a MessageEvent from the iframe's contentWindow, and a spy on
// that window's postMessage to take the transferred port.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bridge, type Interactions, ViewCsp } from "@smthrs/views";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GeneratedView, type GeneratedViewInteraction, type GeneratedViewProps } from "../src/generated-view";
import { frameRuntime } from "../src/generated-view/runtime.generated";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

// happy-dom's IntersectionObserver never reports, so each test starts without
// one and the frame mounts at once; the visibility test installs its own.
let intersectionObserver: unknown;
beforeEach(() => {
  intersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = intersectionObserver;
});

const declared: Interactions.Declared = { cell: { kind: "state" }, ask: { kind: "message", label: "Play" } };

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

interface Rendered {
  readonly interactions: Array<GeneratedViewInteraction>;
  readonly refusals: Array<Bridge.Refusal>;
  readonly rerender: (props: Partial<GeneratedViewProps>) => Promise<void>;
}

async function render(props: Partial<GeneratedViewProps> = {}): Promise<Rendered> {
  const interactions: Array<GeneratedViewInteraction> = [];
  const refusals: Array<Bridge.Refusal> = [];
  const element = (overrides: Partial<GeneratedViewProps>): ReactElement => (
    <GeneratedView
      html="<p>hi</p>"
      interactions={declared}
      title="Board"
      theme="light"
      onInteraction={(interaction) => interactions.push(interaction)}
      onRefused={(reason) => refusals.push(reason)}
      {...props}
      {...overrides}
    />
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element({})));
  return {
    interactions,
    refusals,
    rerender: async (overrides) => {
      await act(async () => mounted.render(element(overrides)));
    },
  };
}

const iframe = () => container!.querySelector("iframe")!;
const nonceOf = (srcdoc: string) => new RegExp(`${ViewCsp.nonceAttribute}="([^"]+)"`).exec(srcdoc)![1]!;

/** Plays the frame's `ui/initialize` and returns the port the page transferred, with what arrives on it. */
async function handshake(options: { readonly nonce?: string; readonly source?: unknown } = {}) {
  const frameWindow = iframe().contentWindow!;
  const posted: Array<{ message: any; transfer: Array<MessagePort> }> = [];
  frameWindow.postMessage = (message: unknown, originOrOptions?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
    const transferred = typeof originOrOptions === "object" ? originOrOptions.transfer : transfer;
    const ports = (transferred ?? []).filter((item): item is MessagePort => "postMessage" in item);
    posted.push({ message, transfer: ports });
  };
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { jsonrpc: "2.0", id: "f", method: "ui/initialize", params: { nonce: options.nonce ?? nonceOf(iframe().srcdoc) } },
        source: (options.source ?? frameWindow) as never,
      }),
    );
  });
  const port = posted[0]?.transfer[0];
  const received: Array<any> = [];
  if (port !== undefined) port.onmessage = (event) => received.push(event.data);
  return { posted, port, received };
}

const send = async (port: MessagePort, message: unknown) => {
  await act(async () => {
    port.postMessage(message);
    await tick();
  });
};

const interaction = (params: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "smithers/interaction", params });

describe("GeneratedView frames the view", () => {
  test("in a scripts-only sandbox whose policy pins the runtime and nothing else", async () => {
    await render();
    const frame = iframe();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Board");
    expect(frame.hasAttribute("allow")).toBe(false);
    const srcdoc = frame.srcdoc;
    expect(srcdoc).toBe(
      ViewCsp.frameDocument({
        runtime: frameRuntime,
        nonce: nonceOf(srcdoc),
        theme: "light",
        styles: /<style>([\s\S]*)<\/style>/.exec(srcdoc)![1]!,
      }),
    );
    expect(srcdoc).toContain(ViewCsp.hash(frameRuntime));
    expect(nonceOf(srcdoc)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(srcdoc).not.toContain("<p>hi</p>");
    expect(container!.querySelector("[data-slot=generated-view]")!.getAttribute("data-size")).toBe("inline");
  });

  test("with the runtime and styles it is given", async () => {
    await render({ runtime: "/* runtime */", styles: ".x{}" });
    expect(iframe().srcdoc).toContain("<style>.x{}</style></head><body><script>/* runtime */</script>");
  });

  test("inline at its reported height between 80 and 480 pixels, full at its container's", async () => {
    await render();
    const wrapper = container!.querySelector<HTMLElement>("[data-slot=generated-view]")!;
    expect(wrapper.style.height).toBe("80px");
    const { port } = await handshake();
    await send(port!, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 250.5 } });
    expect(wrapper.style.height).toBe("251px");
    expect(iframe().style.height).toBe("251px");
    await send(port!, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9000 } });
    expect(wrapper.style.height).toBe("480px");
    await root!.unmount();
    root = undefined;
    await render({ size: "full" });
    expect(container!.querySelector<HTMLElement>("[data-slot=generated-view]")!.style.height).toBe("");
    expect(iframe().style.height).toBe("");
  });
});

describe("GeneratedView answers the frame", () => {
  test("once, with the view's HTML, theme and size, and a port", async () => {
    const view = await render({ theme: "dark", size: "inline" });
    const { posted, port } = await handshake();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toEqual({ jsonrpc: "2.0", id: "f", result: { html: "<p>hi</p>", theme: "dark", size: "inline" } });
    expect(typeof port!.postMessage).toBe("function");
    expect(view.refusals).toEqual([]);
  });

  test("ignores sibling handshakes while accepting each view's own", async () => {
    const refusals: Array<string> = [];
    await render();
    await act(async () => root!.render(<>{["one", "two"].map((title) => (
      <GeneratedView key={title} html="<p>view</p>" interactions={declared} title={title} theme="light"
        onInteraction={() => {}} onRefused={(reason) => refusals.push(reason)} />
    ))}</>));
    const posted: Array<unknown> = [];
    for (const frame of Array.from(container!.querySelectorAll("iframe"))) {
      frame.contentWindow!.postMessage = ((message: unknown) => posted.push(message)) as never;
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        data: { jsonrpc: "2.0", id: "f", method: "ui/initialize", params: { nonce: nonceOf(frame.srcdoc) } },
        source: frame.contentWindow as never,
      })));
    }
    expect(posted).toHaveLength(2);
    expect(refusals).toEqual([]);
  });

  test("never another window, another nonce, or a second request", async () => {
    const view = await render();
    expect((await handshake({ source: window })).posted).toEqual([]);
    expect((await handshake({ nonce: "x".repeat(32) })).posted).toEqual([]);
    expect((await handshake()).posted).toHaveLength(1);
    expect((await handshake()).posted).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { method: "something/else" }, source: window }));
      window.dispatchEvent(new MessageEvent("message", { data: "text", source: window }));
    });
    expect(view.refusals).toEqual(["wrong_source", "wrong_source", "wrong_source"]);
  });

  test("passes declared events on, and refuses undeclared, malformed, oversized and too frequent ones", async () => {
    let now = 1_000;
    const view = await render({ now: () => now });
    const { port } = await handshake();
    await send(port!, interaction({ event: "cell", arg: "4" }));
    await send(port!, interaction({ event: "ask", values: { url: "https://github.com/maya/tinyhttp" } }));
    await send(port!, interaction({ event: "move" }));
    await send(port!, { jsonrpc: "2.0", method: "smithers/interaction" });
    await send(port!, interaction({ event: "ask", values: { body: "x".repeat(Bridge.maxValuesBytes) } }));
    for (let at = 0; at < 8; at++) await send(port!, interaction({ event: "cell", arg: String(at) }));
    now += 1;
    await send(port!, interaction({ event: "cell", arg: "late" }));
    expect(view.interactions.slice(0, 2)).toEqual([
      { _tag: "State", event: { name: "cell", arg: "4" } },
      { _tag: "Message", event: { name: "ask" }, label: "Play", values: { url: "https://github.com/maya/tinyhttp" } },
    ]);
    expect(view.interactions).toHaveLength(10);
    expect(view.refusals).toEqual(["undeclared", "malformed", "too_large", "rate_limited"]);
  });

  test("works without an onRefused", async () => {
    await render({ onRefused: undefined });
    const { port } = await handshake({ nonce: "y".repeat(32) });
    expect(port).toBeUndefined();
    const connected = await handshake();
    await send(connected.port!, interaction({ event: "move" }));
  });

  test("sends only what changed in the HTML or theme, over the port", async () => {
    const view = await render();
    const { received } = await handshake();
    await view.rerender({ html: "<p>2</p>" });
    await view.rerender({ html: "<p>2</p>", theme: "dark" });
    await view.rerender({ html: "<p>2</p>", theme: "dark", title: "Renamed" });
    await act(tick);
    expect(received).toEqual([Bridge.hostContextChanged({ html: "<p>2</p>" }), Bridge.hostContextChanged({ theme: "dark" })]);
  });

  test("sends nothing before the frame has asked", async () => {
    const view = await render();
    await view.rerender({ html: "<p>early</p>" });
    const { posted } = await handshake();
    expect(posted[0]!.message.result.html).toBe("<p>early</p>");
  });

  test("closes the port when it unmounts", async () => {
    const view = await render();
    const { port } = await handshake();
    const sent: Array<unknown> = [];
    port!.onmessage = (event) => sent.push(event.data);
    await root!.unmount();
    root = undefined;
    await act(tick);
    expect(sent).toEqual([]);
    expect(view.interactions).toEqual([]);
  });
});

describe("GeneratedView mounts its frame only near the screen", () => {
  test("and drops it, with its port, once it leaves", async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; disconnected: boolean }> = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      readonly record: { callback: IntersectionObserverCallback; disconnected: boolean };
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, disconnected: false };
        observers.push(this.record);
      }
      observe() {}
      disconnect() {
        this.record.disconnected = true;
      }
    };
    const intersect = async (isIntersecting: boolean) => {
      await act(async () => observers.at(-1)!.callback([{ isIntersecting } as IntersectionObserverEntry], {} as never));
    };
    await render();
    expect(container!.querySelector("iframe")).toBeNull();
    await intersect(true);
    const first = iframe().srcdoc;
    expect(first).toContain("<script>");
    await intersect(false);
    expect(container!.querySelector("iframe")).toBeNull();
    await intersect(true);
    expect(nonceOf(iframe().srcdoc)).not.toBe(nonceOf(first));
    await root!.unmount();
    root = undefined;
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  });
});
