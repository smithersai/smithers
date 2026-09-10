/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../src/chat/ChatComposer";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

/**
 * The composer's keyboard contract, which had no coverage of its own: `submit`
 * and `onKeyDown` were reached only incidentally by rendering tests, so the
 * trim guard, the busy/disabled guards, the IME composition guard, and the
 * Escape-to-stop path were all unexercised. Every case here drives a real
 * KeyboardEvent through the real textarea rather than calling the handler.
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

function textarea(): HTMLTextAreaElement {
  return container!.querySelector("textarea")!;
}

type KeyOptions = { shiftKey?: boolean; isComposing?: boolean; };

async function press(key: string, options: KeyOptions = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (options.isComposing) {
    Object.defineProperty(event, "isComposing", { value: true });
  }
  await act(async () => {
    textarea().dispatchEvent(event);
  });
  return event;
}

describe("ChatComposer keyboard contract", () => {
  test("Enter submits the trimmed value", async () => {
    const submitted: string[] = [];
    await render(
      <ChatComposer value="  hello  " onValueChange={() => {}} onSubmit={(next) => submitted.push(next)} />,
    );
    await press("Enter");
    expect(submitted).toEqual(["hello"]);
  });

  test("Shift+Enter does not submit and leaves the default newline behavior alone", async () => {
    const submitted: string[] = [];
    await render(<ChatComposer value="hello" onValueChange={() => {}} onSubmit={(n) => submitted.push(n)} />);
    const event = await press("Enter", { shiftKey: true });
    expect(submitted).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test("Enter while an IME composition is open does not submit", async () => {
    const submitted: string[] = [];
    await render(<ChatComposer value="にほんご" onValueChange={() => {}} onSubmit={(n) => submitted.push(n)} />);
    await press("Enter", { isComposing: true });
    expect(submitted).toEqual([]);
  });

  test("a whitespace-only value never submits", async () => {
    const submitted: string[] = [];
    await render(<ChatComposer value="   " onValueChange={() => {}} onSubmit={(n) => submitted.push(n)} />);
    await press("Enter");
    expect(submitted).toEqual([]);
  });

  test("disabled blocks submission", async () => {
    const submitted: string[] = [];
    await render(<ChatComposer value="hello" disabled onValueChange={() => {}} onSubmit={(n) => submitted.push(n)} />);
    await act(async () => {
      textarea().form!.requestSubmit();
    });
    expect(submitted).toEqual([]);
  });

  test("a busy lifecycle blocks submission", async () => {
    const submitted: string[] = [];
    await render(
      <ChatComposer
        value="hello"
        lifecycleStatus="streaming"
        onValueChange={() => {}}
        onSubmit={(n) => submitted.push(n)}
      />,
    );
    await act(async () => {
      textarea().form!.requestSubmit();
    });
    expect(submitted).toEqual([]);
  });

  test("Escape stops an in-flight generation, and does nothing while ready", async () => {
    const stops: number[] = [];
    await render(
      <ChatComposer
        value="hello"
        lifecycleStatus="streaming"
        onStop={() => stops.push(1)}
        onValueChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    await press("Escape");
    expect(stops).toHaveLength(1);

    await act(async () =>
      root!.render(
        <ChatComposer
          value="hello"
          lifecycleStatus="ready"
          onStop={() => stops.push(1)}
          onValueChange={() => {}}
          onSubmit={() => {}}
        />,
      )
    );
    await press("Escape");
    expect(stops).toHaveLength(1);
  });

  test("a host textareaProps.onKeyDown that prevents the default suppresses the built-in handling", async () => {
    const submitted: string[] = [];
    const seen: string[] = [];
    await render(
      <ChatComposer
        value="hello"
        onValueChange={() => {}}
        onSubmit={(n) => submitted.push(n)}
        textareaProps={{
          onKeyDown: (event) => {
            seen.push(event.key);
            event.preventDefault();
          },
        }}
      />,
    );
    await press("Enter");
    expect(seen).toEqual(["Enter"]);
    expect(submitted).toEqual([]);
  });

  test("a host textareaProps.onKeyDown that does not prevent the default still submits", async () => {
    const submitted: string[] = [];
    const seen: string[] = [];
    await render(
      <ChatComposer
        value="hello"
        onValueChange={() => {}}
        onSubmit={(n) => submitted.push(n)}
        textareaProps={{ onKeyDown: (event) => seen.push(event.key) }}
      />,
    );
    await press("Enter");
    expect(seen).toEqual(["Enter"]);
    expect(submitted).toEqual(["hello"]);
  });
});
