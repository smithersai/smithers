/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer, type ChatComposerError } from "../src/chat/ChatComposer";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

/**
 * A failing `onSubmit` must reach the host as `submit-failed`, never as an
 * unhandled rejection or an exception escaping the form handler, and the
 * draft the host owns must stay in the textarea.
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

async function submitForm(): Promise<void> {
  const form = container!.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // Let a rejection settle and any unhandled-rejection hook fire.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

describe("ChatComposer submission failures", () => {
  test.each([
    ["rejected", (cause: Error) => () => Promise.reject(cause)],
    ["throwing", (cause: Error) => () => {
      throw cause;
    }],
  ] as const)("a %s onSubmit reports submit-failed once and keeps the draft", async (_name, makeHandler) => {
    const cause = new Error("offline-submit");
    const errors: ChatComposerError[] = [];
    const unhandled = await collectUnhandled(async () => {
      await render(
        <ChatComposer
          value="hello"
          onValueChange={() => undefined}
          onSubmit={makeHandler(cause)}
          onError={(error) => errors.push(error)}
        />,
      );
      await submitForm();
    });
    expect(errors).toEqual([{ code: "submit-failed", cause }]);
    expect(unhandled).toEqual([]);
    expect((container!.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
  });

  test("without onError the failure goes to globalThis.reportError", async () => {
    const cause = new Error("offline-submit");
    const reported: unknown[] = [];
    const original = globalThis.reportError;
    globalThis.reportError = (error: unknown) => reported.push(error);
    try {
      const unhandled = await collectUnhandled(async () => {
        await render(<ChatComposer value="hello" onValueChange={() => undefined} onSubmit={() => Promise.reject(cause)} />);
        await submitForm();
      });
      expect(reported).toEqual([cause]);
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.reportError = original;
    }
  });
});
