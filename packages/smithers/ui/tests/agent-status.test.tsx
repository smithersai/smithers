/** @jsxImportSource react */
// The agent-status pieces under happy-dom: real createRoot + act.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AGENT_STATES,
  AGENT_STATUS_GLYPHS,
  AGENT_STATUS_WORDS,
  AgentStatusPill,
  agentStatusTitle,
  answerText,
  isAgentState,
  NeedsYouCard,
  Toast,
  ToastStack,
  smithersUiCss,
} from "../src";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

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
  if (root === undefined) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const mounted = root;
  await act(async () => mounted.render(element));
}

const $ = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const $$ = (selector: string) => [...container!.querySelectorAll<HTMLElement>(selector)];
const click = (element: HTMLElement | null) => act(async () => element!.click());
const byText = (text: string) => $$("button").find((button) => button.textContent === text) ?? null;

describe("the agent's states", () => {
  test("five states, most urgent first, each with one word and one glyph", () => {
    expect(AGENT_STATES).toEqual(["needs_you", "failed", "working", "waiting", "done"]);
    expect(AGENT_STATUS_WORDS).toEqual({
      working: "Working",
      waiting: "Waiting",
      needs_you: "Needs you",
      failed: "Failed",
      done: "Done",
    });
    expect(new Set(Object.values(AGENT_STATUS_GLYPHS)).size).toBe(5);
    expect(Object.isFrozen(AGENT_STATUS_WORDS) && Object.isFrozen(AGENT_STATUS_GLYPHS)).toBe(true);
  });

  test("isAgentState accepts exactly the five", () => {
    for (const state of AGENT_STATES) expect(isAgentState(state)).toBe(true);
    for (const value of ["needs-you", "live", "", "constructor", 1, null, undefined]) {
      expect(isAgentState(value)).toBe(false);
    }
  });

  test("the tab title counts the runs that need the person, and never prefixes twice", () => {
    expect(agentStatusTitle("Smithers", 0)).toBe("Smithers");
    expect(agentStatusTitle("Smithers", 1)).toBe("(1) Smithers");
    expect(agentStatusTitle("(1) Smithers", 3)).toBe("(3) Smithers");
    expect(agentStatusTitle("(12) Smithers", 0)).toBe("Smithers");
    expect(agentStatusTitle("Smithers", 2.7)).toBe("(2) Smithers");
    expect(agentStatusTitle("Smithers", -1)).toBe("Smithers");
  });

  test("an answer reads as its words, Approved or Denied", () => {
    expect(answerText("docs-v2")).toBe("docs-v2");
    expect(answerText(true)).toBe("Approved");
    expect(answerText(false)).toBe("Denied");
  });
});

describe("AgentStatusPill", () => {
  test("each state is a badge in its tone, with its glyph hidden from screen readers", async () => {
    const variants = {
      working: "sui-badge-default",
      waiting: "sui-badge-muted",
      needs_you: "sui-badge-warning",
      failed: "sui-badge-destructive",
      done: "sui-badge-success",
    } as const;
    for (const state of AGENT_STATES) {
      await render(<AgentStatusPill state={state} />);
      const pill = $("[data-slot=agent-status]")!;
      expect(pill.tagName).toBe("SPAN");
      expect(pill.dataset.state).toBe(state);
      expect(pill.className).toContain(variants[state]);
      expect(pill.textContent).toBe(`${AGENT_STATUS_GLYPHS[state]}${AGENT_STATUS_WORDS[state]}`);
      expect(pill.querySelector(".sui-agent-status-glyph")!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("a count shows above 1 only", async () => {
    await render(<AgentStatusPill state="needs_you" count={1} />);
    expect($(".sui-agent-status-count")).toBeNull();
    await render(<AgentStatusPill state="needs_you" count={2} />);
    expect($(".sui-agent-status-count")!.textContent).toBe("2");
  });

  test("with onClick it is a button with the given name", async () => {
    let pressed = 0;
    await render(<AgentStatusPill state="needs_you" label="Smithers needs you" onClick={() => pressed++} />);
    const button = $<HTMLButtonElement>("button[data-slot=agent-status]")!;
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Smithers needs you");
    expect(button.className).toContain("sui-badge-warning");
    await click(button);
    expect(pressed).toBe(1);
  });

  test("clickable pills forward host attributes, styles, refs and keyboard handlers", async () => {
    let focused = 0;
    let keyed = 0;
    let pressed = 0;
    let host: HTMLSpanElement | null = null;
    await render(
      <AgentStatusPill
        state="needs_you"
        onClick={() => pressed++}
        id="answer-status"
        title="Open pending answers"
        aria-describedby="answer-help"
        data-tracking="answer-status"
        tabIndex={-1}
        style={{ marginLeft: 7 }}
        ref={(element) => { host = element; }}
        onFocus={() => focused++}
        onKeyDown={() => keyed++}
      />,
    );
    const button = $<HTMLButtonElement>("button[data-slot=agent-status]")!;
    expect(button.id).toBe("answer-status");
    expect(button.title).toBe("Open pending answers");
    expect(button.getAttribute("aria-describedby")).toBe("answer-help");
    expect(button.dataset.tracking).toBe("answer-status");
    expect(button.tabIndex).toBe(-1);
    expect(button.style.marginLeft).toBe("7px");
    expect(host).toBe(button);
    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(focused).toBe(1);
    expect(keyed).toBe(1);
    await click(button);
    expect(pressed).toBe(1);
  });

  test("passes span props through when it is not a button", async () => {
    await render(<AgentStatusPill state="waiting" className="mine" title="queued behind an answer" />);
    const pill = $("[data-slot=agent-status]")!;
    expect(pill.className).toContain("mine");
    expect(pill.getAttribute("title")).toBe("queued behind an answer");
  });
});

describe("NeedsYouCard", () => {
  const noop = () => {};

  test("a question: the prompt names the group, options answer with one press, the field answers on submit", async () => {
    const answers: Array<string | boolean> = [];
    const drafts: Array<string> = [];
    const card = (value: string, sending = false) => (
      <NeedsYouCard
        kind="question"
        prompt="Which branch should I deploy?"
        options={["main", "docs-v2"]}
        value={value}
        sending={sending}
        onValueChange={(next) => drafts.push(next)}
        onAnswer={(answer) => answers.push(answer)}
      />
    );
    await render(card(""));
    const group = $("[role=group]")!;
    expect(group.dataset.state).toBe("open");
    expect(group.dataset.kind).toBe("question");
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe(
      "Which branch should I deploy?",
    );
    expect($("[data-slot=agent-status]")!.textContent).toContain("Needs you");
    // An empty draft can't be sent.
    expect(byText("Answer")!.hasAttribute("disabled")).toBe(true);
    await act(async () => $("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(answers).toEqual([]);

    await click(byText("docs-v2"));
    expect(answers).toEqual(["docs-v2"]);

    const field = $<HTMLInputElement>("input")!;
    expect(field.placeholder).toBe("Your answer");
    expect(field.getAttribute("aria-label")).toBe("Your answer");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "staging");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(drafts.at(-1)).toBe("staging");

    await render(card("  staging  "));
    expect(byText("Answer")!.hasAttribute("disabled")).toBe(false);
    await click(byText("Answer"));
    expect(answers).toEqual(["docs-v2", "staging"]);

    // While an answer is on its way, nothing answers again.
    await render(card("staging", true));
    for (const button of $$("button")) expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => $("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(answers).toEqual(["docs-v2", "staging"]);
  });

  test("a question without options shows only the field", async () => {
    await render(<NeedsYouCard kind="question" prompt="Name?" options={[]} value="" onValueChange={noop} onAnswer={noop} />);
    expect($$("button").map((button) => button.textContent)).toEqual(["Answer"]);
  });

  test("an approval answers true for Approve and false for Deny, with no field", async () => {
    const answers: Array<string | boolean> = [];
    await render(
      <NeedsYouCard
        kind="approval"
        prompt="Delete the stale preview?"
        value=""
        onValueChange={noop}
        onAnswer={(answer) => answers.push(answer)}
      />,
    );
    expect($("input")).toBeNull();
    await click(byText("Approve"));
    await click(byText("Deny"));
    expect(answers).toEqual([true, false]);
  });

  test("an answered card collapses to the answer", async () => {
    await render(<NeedsYouCard kind="question" prompt="Which?" value="" answered="docs-v2" onValueChange={noop} onAnswer={noop} />);
    const answered = $("[data-slot=needs-you]")!;
    expect(answered.dataset.state).toBe("answered");
    expect(answered.getAttribute("aria-label")).toBe("Answered");
    expect($(".sui-needs-you-answer")!.textContent).toBe("docs-v2");
    expect($("input")).toBeNull();
    await render(<NeedsYouCard kind="approval" prompt="Delete?" value="" answered={false} onValueChange={noop} onAnswer={noop} />);
    expect($(".sui-needs-you-answer")!.textContent).toBe("Denied");
  });

  test("each new focus request focuses the field, or Approve for an approval", async () => {
    await render(<NeedsYouCard kind="question" prompt="Which?" value="" onValueChange={noop} onAnswer={noop} />);
    expect(document.activeElement).not.toBe($("input"));
    await render(<NeedsYouCard kind="question" prompt="Which?" value="" focusRequest={1} onValueChange={noop} onAnswer={noop} />);
    expect(document.activeElement).toBe($("input"));
    ;($("input") as HTMLInputElement).blur();
    await render(<NeedsYouCard kind="question" prompt="Which?" value="" focusRequest={2} onValueChange={noop} onAnswer={noop} />);
    expect(document.activeElement).toBe($("input"));
    await render(<NeedsYouCard kind="approval" prompt="Delete?" value="" focusRequest={3} onValueChange={noop} onAnswer={noop} />);
    expect(document.activeElement).toBe(byText("Approve"));
  });
});

describe("ToastStack and Toast", () => {
  test("a toast shows the state's glyph and word, its detail, one action and Hide", async () => {
    const acted: Array<string> = [];
    await render(
      <ToastStack>
        <Toast
          tone="needs_you"
          detail="Which branch should I deploy?"
          action={{ label: "Answer", onAction: () => acted.push("answer") }}
          onHide={() => acted.push("hide")}
        />
      </ToastStack>,
    );
    const stack = $("[data-slot=toast-stack]")!;
    expect(stack.tagName).toBe("SECTION");
    expect(stack.dataset.placement).toBe("fixed");
    expect(stack.getAttribute("aria-label")).toBe("Notifications");
    expect(stack.getAttribute("aria-live")).toBe("polite");
    const toast = $("[data-slot=toast]")!;
    expect(toast.dataset.tone).toBe("needs_you");
    expect(toast.querySelector(".sui-toast-text")!.textContent).toBe("Needs you · Which branch should I deploy?");
    await click(byText("Answer"));
    await click($("button[aria-label=Hide]"));
    expect(acted).toEqual(["answer", "hide"]);
  });

  test("a toast without a detail or an action shows its word and Hide", async () => {
    await render(
      <ToastStack label="Smithers" placement="anchored">
        <Toast tone="failed" onHide={() => {}} />
      </ToastStack>,
    );
    expect($("[data-slot=toast-stack]")!.getAttribute("aria-label")).toBe("Smithers");
    expect($("[data-slot=toast-stack]")!.dataset.placement).toBe("anchored");
    expect($(".sui-toast-text")!.textContent).toBe("Failed");
    expect($$("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Hide"]);
  });

  test("either placement overlays the page: the stack never sits in the flow, and a toast arrives by opacity and transform", () => {
    // Fixed floats at the window's bottom-left.
    expect(smithersUiCss).toContain(".sui-toast-stack { position:fixed; z-index:40; left:16px; bottom:16px;");
    // Anchored hangs under its positioned parent (apps/mvp decision 0137): absolute, so it has no height in the flow,
    // at the parent's end edge, each toast at most 380px and never wider than the parent.
    expect(smithersUiCss).toContain(
      ".sui-toast-stack[data-placement='anchored'] { position:absolute; top:calc(100% + 6px); right:0; bottom:auto; left:0; width:auto; align-items:flex-end; }",
    );
    expect(smithersUiCss).toContain(".sui-toast-stack[data-placement='anchored'] > .sui-toast { width:min(380px, 100%); }");
    // There is no placement in the page's flow any more.
    expect(smithersUiCss).not.toContain(".sui-toast-stack[data-placement='inline']");
    expect(smithersUiCss).not.toContain("position:static; width:100%;");
    // The entrance animates opacity and transform only: nothing a toast does lays the page out again.
    expect(smithersUiCss).toContain(".sui-toast { animation:sui-toast-in .12s ease both; }");
    expect(smithersUiCss).toContain(
      "@keyframes sui-toast-in { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }",
    );
    const keyframes = smithersUiCss.match(/@keyframes sui-toast-in \{[^}]*\}[^}]*\}[^}]*\}/)![0];
    for (const property of ["height", "margin", "padding", "top", "max-height"]) expect(keyframes).not.toContain(property);
  });

  test("a delayed toast fades in after 300 ms; others show at once", async () => {
    await render(
      <ToastStack>
        <Toast tone="needs_you" delayed onHide={() => {}} />
        <Toast tone="working" onHide={() => {}} />
      </ToastStack>,
    );
    const [delayed, plain] = $$("[data-slot=toast]");
    expect(delayed!.hasAttribute("data-delayed")).toBe(true);
    expect(plain!.hasAttribute("data-delayed")).toBe(false);
    // The 300 ms is a hold, named in --motion-hold, so reduced motion keeps it (reducedMotionCss) and the toast
    // still never flashes.
    expect(smithersUiCss).toContain(".sui-toast[data-delayed] { --motion-hold:300ms; animation-delay:.3s; }");
  });

  test("an empty stack renders nothing", async () => {
    await render(<ToastStack>{[]}</ToastStack>);
    expect(container!.innerHTML).toBe("");
  });

  test("past max, +N shows the rest in place", async () => {
    const toasts = ["a", "b", "c", "d", "e"].map((id) => <Toast key={id} tone="needs_you" detail={id} onHide={() => {}} />);
    await render(<ToastStack>{toasts}</ToastStack>);
    expect($$("[data-slot=toast]")).toHaveLength(3);
    expect(byText("+2")).not.toBeNull();
    await click(byText("+2"));
    expect($$("[data-slot=toast]")).toHaveLength(5);
    expect(byText("+2")).toBeNull();
    await render(<ToastStack max={1}>{toasts.slice(0, 2)}</ToastStack>);
    expect($$("[data-slot=toast]")).toHaveLength(2);
  });
});

describe("agent-status sheet", () => {
  test("is composed into the shipped stylesheet, gold for needs you and ember for failed", () => {
    expect(smithersUiCss).toContain(".sui-needs-you {");
    expect(smithersUiCss).toContain(".sui-toast[data-tone='needs_you'] { border-left-color:var(--warning,");
    expect(smithersUiCss).toContain(".sui-toast[data-tone='failed'] { border-left-color:var(--danger,");
    // Working waits the loading delay before it shows, and never pulses.
    expect(smithersUiCss).toContain(
      ".sui-agent-status[data-state='working'] { --motion-hold:300ms; animation:sui-loading-appear .2s ease-out 300ms both; }",
    );
    expect(smithersUiCss).not.toContain("sui-agent-status-pulse");
  });
});
