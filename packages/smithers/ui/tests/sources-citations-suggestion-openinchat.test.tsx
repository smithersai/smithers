/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import { OpenInChat, type OpenInChatSubject } from "../src/agentic/OpenInChat";
import { Suggestion, SuggestionGroup } from "../src/agentic/Suggestion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("Suggestion", () => {
  test("renders the suggestion text and fires onClick with it", async () => {
    const picked: string[] = [];
    await render(<Suggestion suggestion="Explain checkpointing" onClick={(s) => picked.push(s)} />);
    const button = container!.querySelector('[data-slot="suggestion"]') as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Explain checkpointing");
    await act(async () => button.click());
    expect(picked).toEqual(["Explain checkpointing"]);
  });

  test("children override the visible label while onClick still gets the suggestion", async () => {
    const picked: string[] = [];
    await render(
      <Suggestion suggestion="raw value" onClick={(s) => picked.push(s)}>
        Pretty label
      </Suggestion>,
    );
    const button = container!.querySelector('[data-slot="suggestion"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Pretty label");
    await act(async () => button.click());
    expect(picked).toEqual(["raw value"]);
  });
});

describe("SuggestionGroup", () => {
  test("is a labeled horizontal group, not a tablist", async () => {
    await render(
      <SuggestionGroup>
        <Suggestion suggestion="one" />
        <Suggestion suggestion="two" />
      </SuggestionGroup>,
    );
    const group = container!.querySelector('[data-slot="suggestion-group"]')!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Suggestions");
    expect(group.querySelectorAll('[data-slot="suggestion"]')).toHaveLength(2);
    expect(container!.querySelector('[role="tablist"]')).toBeNull();
  });

  test("renders under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(
      <SuggestionGroup>
        <Suggestion suggestion="dark" />
      </SuggestionGroup>,
    );
    expect(container!.querySelector('[data-slot="suggestion-group"]')).not.toBeNull();
  });
});

describe("OpenInChat", () => {
  test("fires onOpen with the exact subject descriptor", async () => {
    const opened: OpenInChatSubject[] = [];
    const subject: OpenInChatSubject = { kind: "diff", label: "working-copy change", ref: "abc123" };
    await render(<OpenInChat subject={subject} onOpen={(s) => opened.push(s)} />);
    const button = container!.querySelector('[data-slot="open-in-chat"]') as HTMLButtonElement;
    expect(button.textContent).toContain("Ask Smithers");
    expect(button.getAttribute("aria-label")).toBe("Ask Smithers: working-copy change");
    expect(button.getAttribute("data-kind")).toBe("diff");
    await act(async () => button.click());
    expect(opened).toEqual([subject]);
  });

  test("supports a custom label and every subject kind icon", async () => {
    const kinds = ["file", "diff", "issue", "test", "run", "log", "error", "artifact"] as const;
    await render(<OpenInChat subject={{ kind: "file", label: "file" }} onOpen={() => {}} label="Discuss" />);
    for (const kind of kinds) {
      await act(async () =>
        root!.render(<OpenInChat subject={{ kind, label: kind }} onOpen={() => {}} label="Discuss" />),
      );
      const button = container!.querySelector('[data-slot="open-in-chat"]') as HTMLButtonElement;
      expect(button.getAttribute("data-kind")).toBe(kind);
      expect(button.getAttribute("aria-label")).toBe(`Discuss: ${kind}`);
      expect(button.textContent).toContain("Discuss");
      expect(button.querySelector(".sui-open-in-chat-icon svg")).not.toBeNull();
    }
  });

  test("renders under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<OpenInChat subject={{ kind: "file", label: "Sources.tsx" }} onOpen={() => {}} />);
    expect(container!.querySelector('[data-slot="open-in-chat"]')).not.toBeNull();
  });
});
