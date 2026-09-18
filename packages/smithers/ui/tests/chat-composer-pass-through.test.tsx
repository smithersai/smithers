/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/chat/ChatComposer";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

/*
 * Send and Stop are rendered by this component, so a host that must name the
 * act behind them — apps/app stamps `data-flow` on every affordance — has no
 * element of its own to put the attribute on. `submitProps` and `stopProps`
 * are that seam, and they are typed `ComponentProps<"button"> &
 * DataAttributes` (the FileTree `nodeProps` convention): an object holding
 * only `data-*` keys has nothing in common with React's button props, so
 * without the intersection TypeScript's weak-type check rejects exactly the
 * object a binding passes. The alternative a host falls back to is a ref
 * callback reaching into this component's rendered DOM.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

const send = () => container!.querySelector<HTMLButtonElement>("button[type=submit]")!;
const stop = () => container!.querySelector<HTMLButtonElement>(".sui-chat-composer-stop")!;
const input = () => container!.querySelector<HTMLTextAreaElement>("textarea")!;

describe("ChatComposer pass-through attributes", () => {
  test("submitProps and textareaProps carry the host's data attributes onto the rendered elements", async () => {
    await render(
      <ChatComposer
        value="ship it"
        onValueChange={() => {}}
        onSubmit={() => {}}
        submitProps={{ "data-flow": "chat.send", "data-testid": "composer-send" }}
        textareaProps={{ "data-testid": "composer-input" }}
      />,
    );
    expect(send().dataset.flow).toBe("chat.send");
    expect(send().dataset.testid).toBe("composer-send");
    expect(input().dataset.testid).toBe("composer-input");
    // The component keeps its own structure: the host added attributes, it did not replace the button.
    expect(send().type).toBe("submit");
    expect(send().classList).toContain("sui-chat-composer-send");
  });

  test("stopProps reach the Stop button, which exists only while the turn is busy", async () => {
    const stops: string[] = [];
    await render(
      <ChatComposer
        value="ship it"
        onValueChange={() => {}}
        onSubmit={() => {}}
        onStop={() => stops.push("stop")}
        lifecycleStatus="streaming"
        stopProps={{ "data-flow": "chat.stop" }}
      />,
    );
    expect(stop().dataset.flow).toBe("chat.stop");
    await act(async () => { stop().click(); });
    expect(stops).toEqual(["stop"]);
  });

  test("a host attribute wins over the component's own of the same name", async () => {
    await render(
      <ChatComposer
        value=""
        onValueChange={() => {}}
        onSubmit={() => {}}
        submitProps={{ "aria-label": "Send the turn", className: "host-send" }}
      />,
    );
    expect(send().getAttribute("aria-label")).toBe("Send the turn");
    expect(send().classList).toContain("host-send");
  });
});
