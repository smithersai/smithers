/** @jsxImportSource react */
// TodoDraftCard under happy-dom: real createRoot + act, native events, so default-prevented flags are the browser's.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR, TodoDraftCard, type TodoDraftCardProps } from "../src/index";
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

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => root!.render(element));
}

async function key(el: Element, init: KeyboardEventInit): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  return followed;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

async function submit(el: HTMLFormElement): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  return followed;
}

async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const form = () => container!.querySelector<HTMLFormElement>("form[data-slot=todo-draft-card]")!;
const titleField = () => form().querySelector<HTMLInputElement>("input")!;
const promptField = () => form().querySelector<HTMLTextAreaElement>("textarea")!;
const commitButton = () => form().querySelector<HTMLButtonElement>("button[type=submit]")!;
const discardButton = () =>
  [...form().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Discard")!;
const labelFor = (field: HTMLElement) => form().querySelector(`label[for="${field.id}"]`)!.textContent;

/** Callbacks a test can count; every prop defaults to a filled, committable draft. */
function props(overrides: Partial<TodoDraftCardProps> = {}, calls: Array<string> = []): TodoDraftCardProps {
  return {
    title: "Retry webhook delivery",
    prompt: "Retry failed deliveries three times.",
    onTitleChange: (title) => calls.push(`title:${title}`),
    onPromptChange: (prompt) => calls.push(`prompt:${prompt}`),
    onCommit: () => calls.push("commit"),
    onDiscard: () => calls.push("discard"),
    ...overrides,
  };
}

describe("TodoDraftCard: layout", () => {
  test("a form named TODO draft with Draft, Only you and the repo in its header", async () => {
    await render(<TodoDraftCard {...props({ repo: "octocat/hello" })} id="draft" className="extra" />);
    expect(form().getAttribute("aria-label")).toBe("TODO draft");
    expect([form().id, form().className]).toEqual(["draft", "sui-todo-draft extra"]);
    const header = form().querySelector("header")!;
    expect(header.querySelector(".sui-todo-draft-name")!.textContent).toBe("Draft");
    const badge = header.querySelector<HTMLElement>("[data-slot=badge]")!;
    expect(badge.textContent).toBe("Only you");
    expect(badge.className).toContain("sui-badge-muted");
    expect(header.querySelector(".sui-todo-draft-repo")!.textContent).toBe("octocat/hello");
    await rerender(<TodoDraftCard {...props()} />);
    expect(form().querySelector(".sui-todo-draft-repo")).toBeNull();
  });

  test("source shows where the draft came from, such as its issue, as a chip after Only you; empty shows none", async () => {
    await render(<TodoDraftCard {...props({ source: "#12" })} />);
    const chips = [...form().querySelectorAll<HTMLElement>("header [data-slot=badge]")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Only you", "#12"]);
    expect(chips[1]!.className).toContain("sui-todo-draft-source");
    await rerender(<TodoDraftCard {...props({ source: "" })} />);
    expect(form().querySelector(".sui-todo-draft-source")).toBeNull();
  });

  test("labels the Title input and the Prompt textarea, with the title capped at 120 characters by default", async () => {
    await render(<TodoDraftCard {...props()} />);
    expect([labelFor(titleField()), labelFor(promptField())]).toEqual(["Title", "Prompt"]);
    expect([titleField().value, promptField().value]).toEqual(["Retry webhook delivery", "Retry failed deliveries three times."]);
    expect(titleField().maxLength).toBe(120);
    await rerender(<TodoDraftCard {...props({ maxTitleLength: 60 })} />);
    expect(titleField().maxLength).toBe(60);
  });

  test("Commit is a primary submit button and Discard a ghost button that never submits", async () => {
    await render(<TodoDraftCard {...props()} />);
    expect([commitButton().textContent, commitButton().className]).toEqual(["Commit", expect.stringContaining("sui-button-default")]);
    expect([discardButton().type, discardButton().className]).toEqual(["button", expect.stringContaining("sui-button-ghost")]);
  });

  test("acceptance criteria show read-only, in order; absent or empty shows none", async () => {
    await render(<TodoDraftCard {...props({ acceptance: ["Retries three times", "Logs each attempt"] })} />);
    const list = form().querySelector<HTMLUListElement>(".sui-todo-acceptance ul")!;
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Retries three times", "Logs each attempt"]);
    expect(form().querySelector(".sui-todo-acceptance")!.querySelectorAll("input, textarea, button, [contenteditable]")).toHaveLength(0);
    await rerender(<TodoDraftCard {...props({ acceptance: [] })} />);
    expect(form().querySelector(".sui-todo-acceptance")).toBeNull();
  });

  test("refused shows a destructive alert chip; absent or empty shows none", async () => {
    await render(<TodoDraftCard {...props({ refused: "Stack full" })} />);
    const chip = form().querySelector<HTMLElement>("[role=alert]")!;
    expect(chip.textContent).toBe("Stack full");
    expect(chip.className).toContain("sui-badge-destructive");
    await rerender(<TodoDraftCard {...props({ refused: "" })} />);
    expect(form().querySelector("[role=alert]")).toBeNull();
    await rerender(<TodoDraftCard {...props()} />);
    expect(form().querySelector("[role=alert]")).toBeNull();
  });
});

describe("TodoDraftCard: controlled fields", () => {
  test("typing reports each change and the fields show only what the host passes", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({ title: "", prompt: "" }, calls)} />);
    await type(titleField(), "Fix");
    await type(promptField(), "Fix it");
    expect(calls).toEqual(["title:Fix", "prompt:Fix it"]);
    // The host didn't apply the change, so the fields stay empty: no text lives in the component.
    expect([titleField().value, promptField().value]).toEqual(["", ""]);
  });

  test("a host that applies each change sees the typed text", async () => {
    const committed: Array<[string, string]> = [];
    function Host() {
      const [title, setTitle] = useState("");
      const [prompt, setPrompt] = useState("");
      return (
        <TodoDraftCard
          title={title}
          prompt={prompt}
          onTitleChange={setTitle}
          onPromptChange={setPrompt}
          onCommit={() => committed.push([title, prompt])}
          onDiscard={() => {}}
        />
      );
    }
    await render(<Host />);
    expect(commitButton().disabled).toBe(true);
    await type(titleField(), "Fix the README");
    await type(promptField(), "Correct the typo.");
    expect(commitButton().disabled).toBe(false);
    await click(commitButton());
    expect(committed).toEqual([["Fix the README", "Correct the typo."]]);
  });
});

describe("TodoDraftCard: Commit", () => {
  test("Commit is enabled only with a trimmed title and prompt, a title that fits, and no commit on its way", async () => {
    await render(<TodoDraftCard {...props()} />);
    const cases: ReadonlyArray<[Partial<TodoDraftCardProps>, boolean]> = [
      [{}, true],
      [{ title: "" }, false],
      [{ title: "   " }, false],
      [{ prompt: "" }, false],
      [{ prompt: "\n\t " }, false],
      [{ title: "", prompt: "" }, false],
      [{ committing: true }, false],
      [{ committing: false }, true],
      [{ title: "x".repeat(120) }, true],
      [{ title: "x".repeat(121) }, false],
      [{ title: "x".repeat(10), maxTitleLength: 10 }, true],
      [{ title: "x".repeat(11), maxTitleLength: 10 }, false],
    ];
    for (const [overrides, enabled] of cases) {
      await rerender(<TodoDraftCard {...props(overrides)} />);
      expect({ overrides, enabled: !commitButton().disabled }).toEqual({ overrides, enabled });
    }
  });

  // A commit goes to the device's own outbox: no loading state, only Commit disabled until it is on its way.
  test("committing disables Commit, with no loading state", async () => {
    await render(<TodoDraftCard {...props({ committing: true })} />);
    expect([commitButton().disabled, commitButton().getAttribute("aria-busy")]).toEqual([true, null]);
  });

  test("the Commit button calls onCommit once", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({}, calls)} />);
    await click(commitButton());
    expect(calls).toEqual(["commit"]);
  });

  test("submitting the form always prevents the default and commits only while Commit is enabled", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({}, calls)} />);
    expect(await submit(form())).toBe(false);
    expect(calls).toEqual(["commit"]);
    for (const overrides of [{ title: " " }, { prompt: "" }, { committing: true }]) {
      await rerender(<TodoDraftCard {...props(overrides, calls)} />);
      expect(await submit(form())).toBe(false);
    }
    expect(calls).toEqual(["commit"]);
  });

  test("Enter in the title commits and prevents the default; while disabled it only prevents", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({}, calls)} />);
    expect(await key(titleField(), { key: "Enter" })).toBe(false);
    expect(calls).toEqual(["commit"]);
    await rerender(<TodoDraftCard {...props({ prompt: "" }, calls)} />);
    expect(await key(titleField(), { key: "Enter" })).toBe(false);
    expect(calls).toEqual(["commit"]);
    expect(await key(titleField(), { key: "Enter", isComposing: true })).toBe(true);
    expect(await key(titleField(), { key: "a" })).toBe(true);
    expect(calls).toEqual(["commit"]);
  });

  test("⌘Enter and Ctrl+Enter in the prompt commit; plain Enter is a new line", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({}, calls)} />);
    expect(await key(promptField(), { key: "Enter" })).toBe(true);
    expect(await key(promptField(), { key: "Enter", shiftKey: true })).toBe(true);
    expect(calls).toEqual([]);
    expect(await key(promptField(), { key: "Enter", metaKey: true })).toBe(false);
    expect(await key(promptField(), { key: "Enter", ctrlKey: true })).toBe(false);
    expect(calls).toEqual(["commit", "commit"]);
    await rerender(<TodoDraftCard {...props({ committing: true }, calls)} />);
    expect(await key(promptField(), { key: "Enter", metaKey: true })).toBe(false);
    expect(calls).toEqual(["commit", "commit"]);
  });

  test("Discard calls onDiscard once and doesn't commit, even while committing", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({}, calls)} />);
    await click(discardButton());
    expect(calls).toEqual(["discard"]);
    await rerender(<TodoDraftCard {...props({ committing: true }, calls)} />);
    expect(discardButton().disabled).toBe(false);
    await click(discardButton());
    expect(calls).toEqual(["discard", "discard"]);
  });

  test("every control is keyboard reachable in reading order", async () => {
    await render(<TodoDraftCard {...props()} />);
    const controls = [...form().querySelectorAll<HTMLElement>("input, textarea, button")];
    expect(controls).toEqual([titleField(), promptField(), commitButton(), discardButton()]);
    for (const control of controls) {
      control.focus();
      expect(document.activeElement).toBe(control);
    }
  });
});

// Decision 0153: a TODO hangs under exactly one issue. A host that passes `issues` shows an Issue picker, and Commit
// waits until an issue is chosen.
describe("TodoDraftCard: the issue it hangs under", () => {
  const issueSelect = () => form().querySelector<HTMLSelectElement>("select")!;
  const issues = [{ number: 12, title: "Browser build fails" }, { number: 14, title: "Docs drift" }];

  test("a labelled Issue picker lists the issues; Commit is disabled until one is chosen, and choosing reports it", async () => {
    const calls: Array<string> = [];
    await render(<TodoDraftCard {...props({ issues, onIssueChange: (n) => calls.push(`issue:${n}`) }, calls)} />);
    expect(labelFor(issueSelect())).toBe("Issue");
    expect([...issueSelect().options].map((option) => [option.value, option.textContent]))
      .toEqual([["", "Choose an issue"], ["12", "#12 Browser build fails"], ["14", "#14 Docs drift"]]);
    expect(commitButton().disabled).toBe(true);
    expect(await submit(form())).toBe(false);
    expect(calls).toEqual([]);
    await act(async () => {
      issueSelect().value = "14";
      issueSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls).toEqual(["issue:14"]);
    await rerender(<TodoDraftCard {...props({ issues, issue: 14, onIssueChange: () => {} }, calls)} />);
    expect([issueSelect().value, commitButton().disabled]).toEqual(["14", false]);
  });

  test("an issue the list doesn't hold still shows as chosen; without `issues` there is no picker", async () => {
    await render(<TodoDraftCard {...props({ issues, issue: 99, onIssueChange: () => {} })} />);
    expect([issueSelect().value, issueSelect().selectedOptions[0]!.textContent]).toEqual(["99", "#99"]);
    await rerender(<TodoDraftCard {...props()} />);
    expect(form().querySelector("select")).toBeNull();
    expect(commitButton().disabled).toBe(false);
  });

  test("the picker sits between the title and the prompt in reading order", async () => {
    await render(<TodoDraftCard {...props({ issues, issue: 12, onIssueChange: () => {} })} />);
    const controls = [...form().querySelectorAll<HTMLElement>("input, select, textarea, button")];
    expect(controls).toEqual([titleField(), issueSelect(), promptField(), commitButton(), discardButton()]);
  });
});
