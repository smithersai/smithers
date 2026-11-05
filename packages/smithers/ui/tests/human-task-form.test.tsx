/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Action, DurableDeferred, Flow, HumanTask, Interpreter } from "@smthrs/flow";
import { FlowEngine } from "@smthrs/engine";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { FlowFormView } from "../src/flow-form-view";
import { ApprovalCard } from "../src/approvals/ApprovalCard";
import { draftFrom, flag, formFieldsFor, humanTaskForm, partialPayload, publicFormPayload, text, type HumanTaskWait, type HumanTaskAnswer } from "../src/flow-form";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove(); root = undefined; container = undefined;
});
async function render(element: ReactElement) {
  if (!container) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(element));
}
async function type(name: string, value: string) {
  const element = container!.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  await act(async () => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function submit() { await act(async () => container!.querySelector("form")!.requestSubmit()); }
const question = (request: HumanTask.Request = { kind: "ask" }, token = "wait-one"): HumanTaskWait => ({
  token, request, state: "requested", revision: 0, canAnswer: true,
  validate: value => HumanTask.validate(value, request)
});
const view = (wait: HumanTaskWait, answers: HumanTaskAnswer[]) =>
  <FlowFormView title="Choose" wait={wait} onAnswer={answer => answers.push(answer)} />;

test("submits the exact wait token once, pending a durable receipt", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question(), answers));
  await type("answer", "Ship");
  await act(async () => { container!.querySelector("form")!.requestSubmit(); container!.querySelector("form")!.requestSubmit(); });
  expect(answers).toEqual([{ token: "wait-one", value: "Ship" }]);
  expect(container!.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  expect(container!.querySelector("[data-state]")!.getAttribute("data-state")).toBe("submitting");
});

test("select and confirm preserve string and boolean choices including empty strings", async () => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question({ kind: "select", options: ["", "false", "ship"] });
  await render(view(wait, answers));
  const select = container!.querySelector<HTMLSelectElement>("select")!;
  expect(select.options).toHaveLength(4);
  await type("answer", select.options[1]!.value);
  await submit();
  expect(answers).toEqual([{ token: "wait-one", value: "" }]);
  await render(view(question({ kind: "confirm" }, "wait-two"), answers));
  const choices = container!.querySelector<HTMLSelectElement>("select")!;
  await type("answer", choices.options[2]!.value);
  await submit();
  expect(answers[1]).toEqual({ token: "wait-two", value: false });
});

test("a new wait identity resets drafts without a parent remount", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question(), answers)); await type("answer", "old draft");
  await render(view(question({ kind: "ask" }, "wait-two"), answers));
  expect(container!.querySelector<HTMLInputElement>("input")!.value).toBe("");
  await type("answer", "new draft"); await submit();
  expect(answers).toEqual([{ token: "wait-two", value: "new draft" }]);
});

test("JSON object forms submit nested values and typed enum choices", async () => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question({ kind: "json", schema: {
    type: "object", properties: { count: { enum: [1, "1"] }, evidence: { type: "array", items: { type: "string" } }, note: { type: "object" } },
    required: ["count", "evidence", "note"]
  } });
  await render(view(wait, answers));
  const choices = container!.querySelector<HTMLSelectElement>("select")!;
  expect([...choices.options].map(option => option.textContent)).toEqual(["", "1", '"1"']);
  await type("count", choices.options[2]!.value);
  await type("evidence", '["receipt one", "receipt two"]'); await type("note", '{"ok":true}'); await submit();
  expect(answers).toEqual([{ token: "wait-one", value: { count: "1", evidence: ["receipt one", "receipt two"], note: { ok: true } } }]);
});

test("the shared HumanTask validator rejects invalid JSON before dispatch", async () => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question({ kind: "json", schema: { type: "integer" } });
  await render(view(wait, answers)); await type("answer", "1.5"); await submit();
  expect(answers).toEqual([]); expect(container!.querySelector("[role=alert]")).not.toBeNull();
  await type("answer", "2"); await submit(); expect(answers).toEqual([{ token: "wait-one", value: 2 }]);
});

test.each(["answered", "rejected", "expired", "cancelled", "unavailable"] as const)("refresh preserves the durable %s state", async state => {
  const answers: HumanTaskAnswer[] = [];
  await render(view({ ...question(), state, value: "recorded" }, answers));
  expect(container!.querySelector("button")).toBeNull();
  expect(container!.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  await submit(); expect(answers).toEqual([]);
});

test("permission comes from the host and is required independently of rendering", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view({ ...question(), canAnswer: false }, answers));
  await submit(); expect(answers).toEqual([]);
  expect(container!.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  await render(<ApprovalCard title="Ship" state="requested" wait={{ token: "wait-one", revision: 0, canAnswer: false }} onAnswer={a => answers.push(a)} />);
  for (const button of container!.querySelectorAll<HTMLButtonElement>("button")) { expect(button.disabled).toBe(true); await act(async () => button.click()); }
  expect(answers).toEqual([]);
});

test("approval decisions carry their own wait identity and cannot double dispatch", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(<ApprovalCard title="Ship" state="requested" wait={{ token: "wait-one", revision: 0, canAnswer: true }} onAnswer={a => answers.push(a)} />);
  await act(async () => { container!.querySelector<HTMLButtonElement>("[data-decision=deny]")!.click(); container!.querySelector<HTMLButtonElement>("[data-decision=approve]")?.click(); });
  expect(answers).toEqual([{ token: "wait-one", value: false }]);
});


test("real engine: refresh, independent waits, rejected stale answers, and replay", async () => {
  const flow = Flow.make("ui/HumanTaskFormRegression", {
    payload: { name: Schema.String }, success: Schema.Json, error: HumanTask.HumanTaskFailed,
    body: ({ name }) => HumanTask.action.call({ name: "decision", kind: "confirm", prompt: name, maxAttempts: 2 })
  });
  const layer = Layer.mergeAll(HumanTask.layer, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)
  );
  const token = (executionId: string, attempt = 1) => DurableDeferred.tokenFromExecutionId(HumanTask.deferred("decision", attempt), { flow, executionId });
  const reaches = (id: string, tag: "Suspended" | "Complete") => Effect.gen(function*() {
    for (let turn = 0; turn < 200; turn++) {
      const result = yield* flow.poll(id);
      if (Option.isSome(result) && result.value._tag === tag) return result.value;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`run did not reach ${tag}`);
  });
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* flow.execute({ name: "A" }, { executionId: "form-a", discard: true });
    yield* flow.execute({ name: "B" }, { executionId: "form-b", discard: true });
    yield* reaches("form-a", "Suspended"); yield* reaches("form-b", "Suspended");
    // A semantically refused answer consumes only A's first attempt.
    yield* HumanTask.answer({ token: token("form-a"), value: "not a boolean" });
    // Re-execution replays the recorded refusal and parks on attempt two.
    yield* flow.resume("form-a"); yield* reaches("form-a", "Suspended");
    const answers: HumanTaskAnswer[] = [];
    yield* Effect.promise(() => render(view(question({ kind: "confirm" }, token("form-a")), answers)));
    yield* Effect.promise(async () => {
      const select = container!.querySelector<HTMLSelectElement>("select")!;
      await type("answer", select.options[1]!.value); await submit();
    });
    const stale = yield* Effect.exit(HumanTask.answer({ token: answers[0]!.token, value: answers[0]!.value as boolean }));
    expect(Exit.isFailure(stale)).toBe(true);
    expect(Exit.isFailure(stale) && Cause.squash(stale.cause)).toMatchObject({ code: "answer_not_open" });
    yield* Effect.promise(() => render(view({ ...question({ kind: "confirm" }, token("form-a")), state: "rejected", error: "Answer is stale" }, answers)));
    expect(container!.textContent).toContain("Answer is stale");
    expect(container!.querySelector("button")).toBeNull();
    // B's still-open token remains usable, despite A's rejected attempt.
    yield* Effect.promise(() => render(view(question({ kind: "confirm" }, token("form-b")), answers)));
    yield* Effect.promise(async () => { const select = container!.querySelector<HTMLSelectElement>("select")!; await type("answer", select.options[2]!.value); await submit(); });
    yield* HumanTask.answer({ token: answers[1]!.token, value: answers[1]!.value as boolean });
    const b = yield* reaches("form-b", "Complete");
    expect(b._tag === "Complete" && b.exit).toEqual(Exit.succeed(false));
    // The current A projection is a different wait and starts with a clean draft.
    yield* Effect.promise(() => render(view(question({ kind: "confirm" }, token("form-a", 2)), answers)));
    expect(container!.querySelector<HTMLSelectElement>("select")!.value).toBe("");
    yield* Effect.promise(async () => { const select = container!.querySelector<HTMLSelectElement>("select")!; await type("answer", select.options[1]!.value); await submit(); });
    yield* HumanTask.answer({ token: answers[2]!.token, value: answers[2]!.value as boolean });
    yield* reaches("form-a", "Complete");
    expect(yield* flow.execute({ name: "A" }, { executionId: "form-a" })).toBe(true);
    expect(yield* flow.execute({ name: "B" }, { executionId: "form-b" })).toBe(false);
    // A full view refresh reconstructs settlement from the host's stored result.
    yield* Effect.promise(async () => { await act(async () => root!.unmount()); root = createRoot(container!); });
    yield* Effect.promise(() => render(view({ ...question({ kind: "confirm" }, token("form-b")), state: "answered", value: false }, answers)));
    expect(container!.querySelector<HTMLSelectElement>("select")!.value).toBe("false");
    expect(container!.querySelector("button")).toBeNull();
    expect(answers).toHaveLength(3);
  })).pipe(Effect.provide(layer)));
});


test("transport failure reopens a wait only on the host receipt and preserves the draft", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question(), answers)); await type("answer", "keep this"); await submit();
  await render(view({ ...question(), state: "failed-submission", error: "Unavailable" }, answers));
  expect(container!.querySelector<HTMLInputElement>("input")!.value).toBe("keep this");
  expect(container!.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  await submit(); expect(answers).toEqual([{ token: "wait-one", value: "keep this" }, { token: "wait-one", value: "keep this" }]);
});

test("JSON syntax errors remain editable and unstructured JSON keeps its value type", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question({ kind: "json" }), answers));
  await type("answer", "{"); await submit();
  expect(container!.querySelector("[role=alert]")!.textContent).toBe("Answer is not valid JSON.");
  expect(answers).toEqual([]);
  await type("answer", "null"); await submit(); expect(answers[0]!.value).toBeNull();
});

test("no choices and missing wait identities fail closed", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question({ kind: "select", options: [] }), answers));
  expect(container!.querySelector("button")).toBeNull();
  await render(view(question({ kind: "ask" }, ""), answers));
  await submit(); expect(answers).toEqual([]);
});

test("approval retry, note reset on a new wait, and settlement use host state", async () => {
  const answers: Array<HumanTaskAnswer & { note?: string }> = [];
  const approval = (token: string, state: "requested" | "failed-submission" | "approved" = "requested") =>
    <ApprovalCard title="Ship" state={state} wait={{ token, revision: 0, canAnswer: true }} defaultNote="Review" onAnswer={answer => answers.push(answer)} />;
  await render(approval("first"));
  await act(async () => container!.querySelector<HTMLButtonElement>("[data-decision=approve]")!.click());
  expect(answers).toEqual([{ token: "first", value: true, note: "Review" }]);
  await render(approval("first", "failed-submission"));
  await act(async () => container!.querySelector<HTMLButtonElement>("[data-decision=deny]")!.click());
  expect(answers[1]).toEqual({ token: "first", value: false, note: "Review" });
  await render(approval("second"));
  expect(container!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Review");
  await render(approval("second", "approved"));
  expect(container!.textContent).toContain("Approved"); expect(container!.querySelector("button")).toBeNull();
});


test("refresh restores a typed choice even when its display text collides", async () => {
  const wait = question({ kind: "json", schema: { type: "object", properties: { count: { enum: [1, "1"] } } } });
  await render(view({ ...wait, state: "answered", value: { count: "1" } }, []));
  const select = container!.querySelector<HTMLSelectElement>("select")!;
  expect(select.selectedIndex).toBe(2); expect(select.disabled).toBe(true);
});

test.each([
  { type: "object", nullable: true, properties: { value: { type: "string" } } },
  { type: "object", properties: { value: { type: "null" } } },
  { type: "object", properties: { value: { enum: [null, "x"] } } },
  { type: "object", properties: { value: { type: "string", nullable: true } } },
  { type: "object", properties: { value: {} } },
])("JSON schemas needing a complete JSON control remain answerable", async schema => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question({ kind: "json", schema }), answers));
  const value = "nullable" in schema ? null : { value: null };
  await type("answer", JSON.stringify(value)); await submit();
  expect(answers).toEqual([{ token: "wait-one", value }]);
});

test("JSON raw settlement preserves the stored value and secret fields never enter answers", async () => {
  const answers: HumanTaskAnswer[] = [];
  await render(view({ ...question({ kind: "json" }), state: "answered", value: [1, false, null] }, answers));
  expect(container!.querySelector<HTMLInputElement>("input")!.value).toBe("[1,false,null]");
  const wait = question({ kind: "json", schema: { type: "object", properties: { secret: { type: "string", writeOnly: true } } } });
  await render(view({ ...wait, token: "secret-wait" }, answers)); await type("secret", "test-private-value"); await submit();
  expect(answers).toEqual([]); expect(container!.querySelector("[role=alert]")!.textContent).toBe("Use secret names to answer.");
});

// Exercise the unchanged shared conversion paths alongside the new typed choices.
// These assertions keep both forms' grammar and redaction contracts covered.
test("shared form grammar and redaction preserve existing boundary behavior", () => {
  expect(text({ count: 2 }, "count")).toBe("2"); expect(text({ count: " " }, "count")).toBeUndefined();
  expect(flag({ count: 2 }, "count")).toBe("--count 2"); expect(flag({}, "count")).toBeUndefined();
  const fields = formFieldsFor(Schema.Struct({ count: Schema.Number, note: Schema.String }));
  expect(partialPayload(fields, undefined, "3 words with spaces")).toEqual({ count: 3, note: "words with spaces" });
  expect(partialPayload(fields, undefined, "NaN blocked")).toEqual({});
  const numeric = formFieldsFor(Schema.Struct({ count: Schema.Union([Schema.Number, Schema.Literal("NaN")]) }));
  expect(numeric[0]!.kind).toBe("number");
  const secret = [{ name: "key", label: "Key", kind: "write-only" as const, required: false }];
  expect(publicFormPayload(secret, { data: { key: "private", name: "visible" } }, "data")).toEqual({ data: { name: "visible" } });
  expect(publicFormPayload(secret, { data: "unavailable" }, "data")).toEqual({ data: "unavailable" });
  expect(publicFormPayload(secret, null as unknown as Record<string, unknown>)).toEqual({});
  expect(draftFrom(formFieldsFor(Schema.Struct({ count: Schema.Literals([1, "1"]) })), { count: 1 }).count).toBe("__choice_0");
  expect(humanTaskForm(question({ kind: "json", schema: { type: "object", properties: { value: null } } })).schema).toHaveProperty("properties.answer");
});


test("each authoritative failure receipt permits one further answer, even with the same state", async () => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question();
  await render(view(wait, answers)); await type("answer", "Ship"); await submit();
  await render(view({ ...wait, state: "failed-submission", revision: 1 }, answers)); await submit();
  await render(view({ ...wait, state: "failed-submission", revision: 2 }, answers));
  expect(container!.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
  await submit(); expect(answers).toHaveLength(3);
  // An unrelated rerender with the same receipt cannot release the dispatch latch.
  await render(view({ ...wait, state: "failed-submission", revision: 2 }, answers));
  await submit(); expect(answers).toHaveLength(3);
});

test("each authoritative approval failure receipt permits one further decision", async () => {
  const answers: HumanTaskAnswer[] = [];
  const approval = (revision: number, state: "requested" | "failed-submission") =>
    <ApprovalCard title="Ship" state={state} wait={{ token: "wait-one", revision, canAnswer: true }} onAnswer={answer => answers.push(answer)} />;
  await render(approval(0, "requested"));
  await act(async () => container!.querySelector<HTMLButtonElement>("[data-decision=approve]")!.click());
  await render(approval(1, "failed-submission"));
  await act(async () => container!.querySelector<HTMLButtonElement>("[data-decision=approve]")!.click());
  await render(approval(2, "failed-submission"));
  expect(container!.querySelectorAll("button").length).toBe(2);
  await act(async () => container!.querySelector<HTMLButtonElement>("[data-decision=deny]")!.click());
  expect(answers).toEqual([{ token: "wait-one", value: true }, { token: "wait-one", value: true }, { token: "wait-one", value: false }]);
  await render(approval(2, "failed-submission"));
  expect(container!.querySelectorAll("button").length).toBe(0);
});

test.each(["", "   "])("ask preserves valid blank prose", async value => {
  const answers: HumanTaskAnswer[] = [];
  await render(view(question(), answers)); await type("answer", value); await submit();
  expect(answers).toEqual([{ token: "wait-one", value }]);
});

test("JSON required and explicitly cleared optional strings preserve blank values", async () => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question({ kind: "json", schema: { type: "object", properties: { note: { type: "string" }, extra: { type: "string" } }, required: ["note"] } });
  await render(view(wait, answers)); await type("extra", "remove this"); await type("extra", ""); await submit();
  expect(answers).toEqual([{ token: "wait-one", value: { note: "", extra: "" } }]);
});

test("supported object enums remain answerable through JSON", async () => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question({ kind: "json", schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], enum: [{ note: "x" }] } });
  await render(view(wait, answers));
  expect(container!.querySelectorAll("input").length).toBe(1);
  await type("answer", '{"note":"x"}'); await submit();
  expect(answers).toEqual([{ token: "wait-one", value: { note: "x" } }]);
});


test("simultaneous question forms keep drafts and pending state on their own wait", async () => {
  const answers: HumanTaskAnswer[] = [];
  const forms = (firstToken: string) => <>
    <FlowFormView title="A" wait={question({ kind: "ask" }, firstToken)} onAnswer={answer => answers.push(answer)} />
    <FlowFormView title="B" wait={question({ kind: "ask" }, "second")} onAnswer={answer => answers.push(answer)} />
  </>;
  await render(forms("first"));
  const inputA = container!.querySelector<HTMLInputElement>('form[aria-label="A"] input')!;
  const inputB = container!.querySelector<HTMLInputElement>('form[aria-label="B"] input')!;
  await act(async () => {
    for (const [input, value] of [[inputA, "draft A"], [inputB, "draft B"]] as const) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => container!.querySelector<HTMLFormElement>('form[aria-label="B"]')!.requestSubmit());
  expect(answers).toEqual([{ token: "second", value: "draft B" }]);
  expect(inputA.value).toBe("draft A"); expect(inputA.disabled).toBe(false);
  await render(forms("next-first"));
  expect(container!.querySelector<HTMLInputElement>('form[aria-label="A"] input')!.value).toBe("");
  expect(container!.querySelector<HTMLInputElement>('form[aria-label="B"] input')!.disabled).toBe(true);
  expect(container!.querySelector<HTMLInputElement>('form[aria-label="B"] input')!.value).toBe("draft B");
});


test.each([
  [{ type: "array", items: { type: "string" } }, '["receipt"]'],
  [{ type: "object" }, '{"receipt":true}'],
] as const)("cleared optional JSON structures are omitted", async (schema, initial) => {
  const answers: HumanTaskAnswer[] = [];
  const wait = question({ kind: "json", schema: { type: "object", properties: { extra: schema } } });
  await render(view(wait, answers)); await type("extra", initial); await type("extra", ""); await submit();
  expect(answers).toEqual([{ token: "wait-one", value: {} }]);
});
