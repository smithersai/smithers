/** @jsxImportSource react */
// The flow-draft card under happy-dom: real createRoot + act.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  answersToSend,
  changedAnswers,
  type DraftQuestion,
  draftStatusLine,
  FlowDraftView,
  type FlowDraftViewProps,
  isAssumed,
  questionValue,
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
const button = (text: string) => $$("button").find((element) => element.textContent === text) as HTMLButtonElement | undefined;
const labelled = (text: string) => {
  const label = $$("label").find((element) => element.textContent === text);
  return label === undefined ? null : container!.querySelector<HTMLInputElement>(`#${CSS.escape(label.getAttribute("for")!)}`);
};
/** Types `value` into a controlled input, as a person does: React hears an input event. */
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const questions: ReadonlyArray<DraftQuestion> = [
  { id: "tag", text: "Which tag pattern?", assumed: "v*", blocking: false },
  { id: "draft", text: "Post as a draft release?", assumed: "no", blocking: false, answer: "yes" },
  { id: "repo", text: "Which repository?", assumed: "", blocking: true },
];

const base: FlowDraftViewProps = {
  where: "Mine",
  name: "release-notes",
  request: "Summarize merged PRs since the last tag",
  status: "drafting",
  round: 1,
  questions,
  answers: {},
  files: [{ path: "SKILL.md", text: "---\nname: release-notes\n---\nSummarize." }],
  checks: [
    { check: "parses", ok: true },
    { check: "name", ok: false, code: "taken" },
  ],
};

describe("the draft's vocabulary", () => {
  test("each status as one line; the round shows from the second on", () => {
    expect(draftStatusLine("drafting", 0)).toBe("◌ Drafting");
    expect(draftStatusLine("drafting", 1)).toBe("◌ Drafting · round 2");
    expect(draftStatusLine("needs_you", 3)).toBe("◆ Needs you");
    expect(draftStatusLine("ready", 0)).toBe("✓ Ready");
    expect(draftStatusLine("failed", 0)).toBe("✕ Failed");
    expect(draftStatusLine("saved", 0)).toBe("✓ Saved");
    expect(draftStatusLine("proposed", 0)).toBe("✓ Proposed");
  });

  test("a field shows the unsent answer, else the held answer, else the assumed default", () => {
    expect(questionValue(questions[0]!, {})).toBe("v*");
    expect(questionValue(questions[0]!, { tag: "release-*" })).toBe("release-*");
    expect(questionValue(questions[1]!, {})).toBe("yes");
    expect(isAssumed(questions[0]!, {})).toBe(true);
    expect(isAssumed(questions[0]!, { tag: "v*" })).toBe(false);
    expect(isAssumed(questions[1]!, {})).toBe(false);
  });

  test("only answers that change what the draft holds count", () => {
    expect(changedAnswers(questions, {})).toEqual([]);
    expect(changedAnswers(questions, { tag: "v*", draft: "yes" })).toEqual([]);
    expect(changedAnswers(questions, { tag: "release-*", draft: "no", repo: "maya/tinyhttp" })).toEqual([
      { id: "tag", value: "release-*" },
      { id: "draft", value: "no" },
      { id: "repo", value: "maya/tinyhttp" },
    ]);
  });
});

describe("what Answer sends", () => {
  const blocking: ReadonlyArray<DraftQuestion> = [
    { id: "mode", text: "Light or dark?", assumed: "dark", blocking: true },
    { id: "say", text: "Say it is done?", assumed: "yes", blocking: false },
    { id: "repo", text: "Which repository?", assumed: "", blocking: true },
    { id: "done", text: "Which branch?", assumed: "main", blocking: true, answer: "dev" },
  ];

  test("a blocking question nobody answered sends the value its field shows, its default until a person types", () => {
    expect(answersToSend(blocking, {})).toEqual([{ id: "mode", value: "dark" }]);
    expect(answersToSend(blocking, { mode: "light" })).toEqual([{ id: "mode", value: "light" }]);
  });

  test("an optional question sends only a changed answer, and an answered one only a new value", () => {
    expect(answersToSend(blocking, { say: "yes", done: "dev" })).toEqual([{ id: "mode", value: "dark" }]);
    expect(answersToSend(blocking, { say: "no", done: "main" })).toEqual([
      { id: "mode", value: "dark" },
      { id: "say", value: "no" },
      { id: "done", value: "main" },
    ]);
  });

  test("an empty field sends nothing, a blocking one included", () => {
    expect(answersToSend(blocking, { mode: "  " })).toEqual([]);
    expect(answersToSend(blocking, { repo: "maya/tinyhttp" })).toEqual([
      { id: "mode", value: "dark" },
      { id: "repo", value: "maya/tinyhttp" },
    ]);
    expect(answersToSend([], {})).toEqual([]);
  });
});

describe("FlowDraftView before its first round: the form", () => {
  test("invalid field hints are associated with their inputs and clear when removed", async () => {
    await render(<FlowDraftView {...base} status={null} name="Bug bash status" request="x" questions={[]} files={[]} checks={[]} nameHint="Use lowercase letters, numbers and hyphens" requestHint="4,096 characters max" onStart={() => undefined} />);
    const name = labelled("Name")!;
    const hint = container!.querySelector<HTMLElement>(`#${CSS.escape(name.getAttribute("aria-describedby")!)}`);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(hint?.textContent).toBe("Use lowercase letters, numbers and hyphens");
    const request = labelled("What it should do")!;
    const requestHint = container!.querySelector<HTMLElement>(`#${CSS.escape(request.getAttribute("aria-describedby")!)}`);
    expect(request.getAttribute("aria-invalid")).toBe("true");
    expect(requestHint?.textContent).toBe("4,096 characters max");

    await render(<FlowDraftView {...base} status={null} questions={[]} files={[]} checks={[]} onStart={() => undefined} />);
    expect(labelled("Name")!.hasAttribute("aria-invalid")).toBe(false);
    expect(labelled("Name")!.hasAttribute("aria-describedby")).toBe(false);
    expect(labelled("What it should do")!.hasAttribute("aria-invalid")).toBe(false);
    expect(labelled("What it should do")!.hasAttribute("aria-describedby")).toBe(false);
  });

  test("Where, Name and What as inputs, Draft off until there is a request, and no status", async () => {
    const names: Array<string> = [];
    const requests: Array<string> = [];
    let started = 0;
    const props: FlowDraftViewProps = {
      ...base,
      status: null,
      round: 0,
      name: "",
      request: "",
      questions: [],
      files: [],
      checks: [],
      onNameChange: (name) => names.push(name),
      onRequestChange: (request) => requests.push(request),
      onStart: () => started++,
    };
    await render(<FlowDraftView {...props} />);
    expect($("[data-slot='flow-draft-view']")!.dataset.status).toBe("new");
    expect($("[role='status']")!.textContent).toBe("");
    expect($(".sui-flow-draft-where")!.textContent).toBe("Mine");
    expect(button("Draft")!.disabled).toBe(true);
    await type(labelled("Name")!, "release-notes");
    await type(labelled("What it should do")! as unknown as HTMLTextAreaElement, "Summarize merged PRs");
    expect(names).toEqual(["release-notes"]);
    expect(requests).toEqual(["Summarize merged PRs"]);
    // A form submitted with no request starts nothing.
    await act(async () => container!.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(started).toBe(0);

    await render(<FlowDraftView {...props} request="Summarize merged PRs" />);
    expect(button("Draft")!.disabled).toBe(false);
    await act(async () => button("Draft")!.click());
    expect(started).toBe(1);
    for (const name of ["Answer", "Save", "Try", "Propose"]) expect(button(name)).toBeUndefined();
  });

  test("without onStart there is no Draft; typing without handlers does nothing", async () => {
    await render(<FlowDraftView {...base} status={null} questions={[]} />);
    expect(button("Draft")).toBeUndefined();
    await type(labelled("Name")!, "x");
    await type(labelled("What it should do")! as unknown as HTMLTextAreaElement, "y");
    expect(labelled("Name")!.value).toBe("release-notes");
  });
});

describe("FlowDraftView once drafting", () => {
  test("the status, the name and request as text, the questions, the files and the checks", async () => {
    await render(<FlowDraftView {...base} />);
    expect($("[role='status']")!.textContent).toBe("◌ Drafting · round 2");
    expect(labelled("Name")).toBeNull();
    expect($(".sui-flow-draft-name")!.textContent).toBe("release-notes");
    expect($(".sui-flow-draft-request")!.textContent).toBe("Summarize merged PRs since the last tag");
    expect(labelled("Which tag pattern?")!.value).toBe("v*");
    expect(labelled("Post as a draft release?")!.value).toBe("yes");
    const items = $$(".sui-flow-draft-question");
    expect(items[0]!.querySelector(".sui-flow-draft-tag")!.textContent).toBe("assumed");
    expect(items[1]!.querySelector(".sui-flow-draft-tag")).toBeNull();
    expect(items[2]!.dataset.blocking).toBe("true");
    expect(items[2]!.querySelector(".sui-flow-draft-tag")!.textContent).toBe("Needs you");
    const file = $<HTMLDetailsElement>(".sui-flow-draft-file")!;
    expect(file.open).toBe(false);
    expect(file.querySelector("summary")!.textContent).toBe("SKILL.md");
    expect(file.querySelector("pre")!.textContent).toBe("---\nname: release-notes\n---\nSummarize.");
    const checks = $$(".sui-flow-draft-check");
    expect(checks.map((check) => [check.dataset.ok, check.textContent])).toEqual([
      ["true", "✓ parses"],
      ["false", "✕ name · taken"],
    ]);
    expect($(".sui-flow-draft-failure")).toBeNull();
    // Without handlers, no buttons.
    for (const name of ["Draft", "Answer", "Save", "Try", "Propose"]) expect(button(name)).toBeUndefined();
  });

  test("answers are the app's: typing reports them, and Answer turns on once one changes what the draft holds", async () => {
    const changes: Array<[string, string]> = [];
    let answered = 0;
    const props: FlowDraftViewProps = {
      ...base,
      status: "ready",
      onAnswerChange: (id, value) => changes.push([id, value]),
      onAnswer: () => answered++,
    };
    await render(<FlowDraftView {...props} />);
    expect(button("Answer")!.disabled).toBe(true);
    await type(labelled("Which tag pattern?")!, "release-*");
    expect(changes).toEqual([["tag", "release-*"]]);

    await render(<FlowDraftView {...props} answers={{ tag: "release-*" }} />);
    expect(labelled("Which tag pattern?")!.value).toBe("release-*");
    expect($$(".sui-flow-draft-question")[0]!.querySelector(".sui-flow-draft-tag")).toBeNull();
    expect(button("Answer")!.disabled).toBe(false);
    await act(async () => button("Answer")!.click());
    expect(answered).toBe(1);
  });

  test("Needs you: Answer is on with the blocking question's default shown, so the person can accept it", async () => {
    let answered = 0;
    const props: FlowDraftViewProps = {
      ...base,
      status: "needs_you",
      questions: [{ id: "mode", text: "Light or dark?", assumed: "dark", blocking: true }],
      onAnswer: () => answered++,
    };
    await render(<FlowDraftView {...props} />);
    expect($("[role='status']")!.textContent).toBe("◆ Needs you");
    expect(labelled("Light or dark?")!.value).toBe("dark");
    expect(button("Answer")!.disabled).toBe(false);
    await act(async () => button("Answer")!.click());
    expect(answered).toBe(1);
    // Emptied, the field has nothing to send.
    await render(<FlowDraftView {...props} answers={{ mode: "" }} />);
    expect(button("Answer")!.disabled).toBe(true);
  });

  test("Draft again and Delete show with their handlers", async () => {
    const pressed: Array<string> = [];
    await render(<FlowDraftView {...base} status="failed" failure="Model busy" />);
    expect(button("Draft again")).toBeUndefined();
    expect(button("Delete")).toBeUndefined();
    await render(
      <FlowDraftView
        {...base}
        status="failed"
        failure="Model busy"
        onRetry={() => pressed.push("again")}
        onDelete={() => pressed.push("delete")}
      />,
    );
    await act(async () => button("Draft again")!.click());
    await act(async () => button("Delete")!.click());
    expect(pressed).toEqual(["again", "delete"]);
    expect($(".sui-flow-draft-failure")!.textContent).toBe("✕ Model busy");
  });

  test("Try, Save and Propose show with their handlers; Save can be held off", async () => {
    const pressed: Array<string> = [];
    const props: FlowDraftViewProps = {
      ...base,
      status: "ready",
      onTry: () => pressed.push("try"),
      onSave: () => pressed.push("save"),
      onPropose: () => pressed.push("propose"),
    };
    await render(<FlowDraftView {...props} saveDisabled />);
    expect(button("Save")!.disabled).toBe(true);
    await render(<FlowDraftView {...props} />);
    expect($("[role='status']")!.textContent).toBe("✓ Ready");
    await act(async () => button("Try")!.click());
    await act(async () => button("Save")!.click());
    await act(async () => button("Propose")!.click());
    expect(pressed).toEqual(["try", "save", "propose"]);
    expect(button("Answer")).toBeUndefined();
  });

  test("a failed draft says why; a draft with no questions has no Answer", async () => {
    await render(<FlowDraftView {...base} status="failed" questions={[]} checks={[]} failure="rate_limited" onAnswer={() => {}} />);
    expect($("[role='status']")!.textContent).toBe("✕ Failed");
    expect($(".sui-flow-draft-failure")!.textContent).toBe("✕ rate_limited");
    expect($(".sui-flow-draft-questions")).toBeNull();
    expect($(".sui-flow-draft-checks")).toBeNull();
    expect(button("Answer")).toBeUndefined();
  });

  test("renders a drafted file's markup as text", async () => {
    await render(<FlowDraftView {...base} files={[{ path: "SKILL.md", text: "<script>alert(1)</script>" }]} />);
    expect($("script")).toBeNull();
    expect($(".sui-flow-draft-file pre")!.textContent).toBe("<script>alert(1)</script>");
  });
});

test("the card's sheet is part of smithersUiCss", () => {
  expect(smithersUiCss).toContain(".sui-flow-draft-check[data-ok='false']");
});
