# Jev

The agent asks Jev, Smithers' judge, for decisions over a list: which issues are bugs, which messages need a reply, which label fits each change. Two client flows put it in the agent's hands, and each judgment is one durable model step through the server's metered endpoint, role `judge`, on the cheap `fast` tier at low reasoning effort. Decisions: [0003](../decisions/0003-flows-and-the-agent.md), [0011](../decisions/0011-the-agent-runs-in-the-browser.md), [0107](../decisions/0107-model-tiers.md).

## The flows

| Flow | Takes | Answers |
|---|---|---|
| `app/jev/classify` | `question`; 1 to 50 `items` of up to 2,000 characters; optionally 2 to 10 distinct `labels` | `{ verdicts }`, one per item in order: `yes`, `no`, a label, or `unsure` |
| `app/jev/evaluate` | one `text` of up to 16,000 characters; a rubric of 1 to 20 `criteria` | `{ verdicts }`, one per criterion in order: `yes`, `no` or `unsure` |

Questions, items, labels, text and criteria must contain a non-whitespace character; their content is preserved. The label `unsure` is reserved for uncertainty and is rejected at both the flow and judge action boundaries.

Each verdict is `{ verdict, confidence }`, with `confidence` from 0 to 1 as `Classifier.confidence` reads it. A yes or no stands at 0.8 (a probability of yes at or above 0.9, or at or below 0.1) and a label at 0.7, the floors the library's guide reads them at; below, the verdict is `unsure`. A judge that can't answer fails the flow with `JudgeFailed { code }`, the judge's code: `unreachable` (the endpoint refused or couldn't be reached, a signed-out person included), `refused` (rate limited or out of budget), `timeout`, `invalid_answer` (an answer the judge sent that doesn't read), `empty`, `invalid_question` or `unconfigured`. The agent's cell sees `JudgeFailed`.

Both are model-invocable and in the registry, so the agent's catalog has them ([flows](flows.md#the-agents-catalog)). Neither has a slash command: a person's run would have nowhere to show its verdicts, so a person asks Smithers.

**The agent picks Jev on its own.** A person never has to name it. `app/jev/classify`'s description, which the agent reads in its catalog, says when to use it: whenever the person asks to sort, group, label, triage, filter or pick from a list of two or more items, with every item in one call and the person's categories as `labels`, and never to decide over a list itself. "Sort these issue titles into bug, feature and question: …" runs `app/jev/classify` with the three labels (Will, 2026-10-20 19:52: "a test where we don't explicitly ask for jev but it uses jev"). The agent eval `jev-sort` holds it to that ([agent evals](agent-evals.md#cases)).

## Seeing that Smithers used Jev

An answer's debug info, an icon among its hover controls, opens the run that answered it ([chat](chat.md#message-controls)). Its flow view shows the answer's steps and the Jev step its call ran:

```
/app/runs/<answer id>          chat/LoadTurn ─▶ chat/Respond ─▶ chat/Settle
                               app/jev/classify/judge  ✓ Done      ◀ select: Output = { verdicts }, Open ─▶
/app/runs/<call's run id>      app/jev/classify   Input = { question, items, labels }   Result = { verdicts }
```

The step's output is its verdicts. An action step records no input, so the step's Open link leads to the call's own run, `app/jev/classify`, whose Input is what the agent asked and whose Result is what Jev answered ([runs](runs.md#the-run-page)).

## How a judgment runs

```
app/jev/classify { question, items, labels? }
  app/jev/classify/judge ─ Classifier.make: one question per item, keyed item1…itemN, in one request
     Evaluator.layerFromSeat({ modelId: "judge", model })                       (@smthrs/model)
       model = ModelStep.model({ name: "app/jev/classify/model", seat })        (@smthrs/agent)
         one sealed ModelStep ─ ModelProxy client ─▶ POST /api/model/judge ─▶ the role's model
```

- **State and questions.** The items go in the state under their ids, and each question reads `<id>: <question>`, because the judge answers from a question's instructions and the state. `app/jev/evaluate` puts the text in the state and asks `criterion<k>: Does the text meet this criterion? <criterion>`.
- **Durable.** `ModelStep.model` makes each call the judge makes one sealed step of the run, keyed by what the endpoint is sent, so a run resumed after a crash reads the judgment back instead of paying for it again. Its retries are `ModelStep`'s: transport faults inside the step, capacity refusals for up to two minutes.
- **The endpoint.** The `judge` role maps to the `fast` tier at `low` reasoning effort, a hint only a model that takes one receives (Will, 2026-10-25: "We use haiku or Luna low for Jev replacement if no Jev"; [tiers](model-endpoint.md#tiers)). A person's own `fast` model answers it with their key: by default Claude Haiku with an Anthropic key, else the OpenAI-compatible cheap model ([Your model](personal-model.md#tiers)). Otherwise, while hosted inference is on, the model an admin set with `admin/SetModel`, else the `fast` tier's `TIER_MODELS` record, else `CHAT_MODEL`, which holds the key, bounds the request and meters it against the day's budget ([model endpoint](model-endpoint.md)). `MODEL_ROLE_TIERS` can point it at another tier. The device never calls a provider.
- **Every closed answer is Jev.** The app's calls whose answer is a label, a yes or no, or a state the UI routes on already run through Jev: these two flows, the memory opening's judge and issue triage. A pull request's free-text review is the `review` role on the `hard` tier, not a judgment ([decision 0107](../decisions/0107-model-tiers.md#the-audit-every-model-call-the-app-makes)).

| File | What it holds |
|---|---|
| `src/features/jev/flows.ts` | The two declarations, their steps' declarations, the payloads, `Verdicts` and `JudgeFailed`; the tab loads it |
| `src/features/jev/steps.ts` | What the steps run: `JudgeSeat`, the `judge` role on the origin, and the judgment; only an engine's host imports it |
| `src/features/jev/metrics.ts` | Its counts, log line and span |
| `src/features/jev/contract.ts` | The limits, the floors, the verdict codes and the telemetry contract |
| `src/flows/registrations.ts` | `jev(origin)`: both flows over `JudgeSeat.layer(origin)`, registered with every client flow |

## Observability

| Record | Kind | Fields |
|---|---|---|
| `jev.judge` | log | `flow`, `items`, `outcome` (`judged` or the failure code; Warn when it failed), `yes`, `no`, `labeled`, `unsure`, `durationMs` |
| `jev.judge` | span | `smithers.jev.flow`, `smithers.jev.items`, `smithers.jev.outcome` |
| `smithers_jev_judgments` | counter | `flow`, `outcome` |
| `smithers_jev_verdicts` | counter | `flow`, `verdict` (`yes`, `no`, `label`, `unsure`) |

Counts and verdict codes only: no record carries an item, a question, a label, a text or a criterion, and a label is counted as `label`. The judge's model call is a `ModelStep` and a `model.proxy.serve` with role `judge`, like any other ([model endpoint](model-endpoint.md)).

## Tests

| Test | Proves |
|---|---|
| `src/features/jev/jev.test.ts` | Both flows on the Node host against ChatApi's real model endpoint on the compose Postgres, with a scripted model: one judge call per judgment through the `judge` role, a verdict per item in order with `unsure` below the floor, labels, a rubric, a settled judgment read back without a second call, `invalid_answer` and a signed-out `unreachable`, the payload's bounds, records without a sentinel item, question, label, text or criterion; and the agent's cell calling `app/jev/classify` as a journaled step and reading its verdicts |
| `src/features/jev/jev.test.ts` "the answer's debug info…" | The answer's debug info opens its own run; read as the run screen reads it, its flow view shows `chat/LoadTurn`, `chat/Respond`, `chat/Settle` and `app/jev/classify/judge`, done, with the verdicts as output and a link to the call's run, whose input is the agent's question and items |
| `e2e/jev.spec.ts` | A real browser asks Smithers to sort nine issue titles into bug, feature and question, never naming Jev. The agent calls `app/jev/classify` once on its own, the judgment goes through `/api/model/judge`, and the answer groups the titles. Browser-wide judge traffic may also include [opening memory](memory.md). Debug info, shown only on hover, opens the answer's run; in its flow view Down moves the highlight through the recorded steps to the Jev step and Enter inspects it; its output holds nine verdicts, and its Open link shows the call's input, every title and the labels. Video and GIF: `~/Desktop/smithers-mvp/videos/jev/jev.mp4`, `gifs/jev-jev.gif` |
| `evals/cases.ts` `jev-sort` | The real agent and model: the same nine titles go to `app/jev/classify` with labels naming bug, feature and question, and nothing else is called ([agent evals](agent-evals.md#cases)) |
| `packages/smithers/agent/test/ModelStep.test.ts` "serves a Model…", "fails a Model's stream…" | `ModelStep.model`: calls sealed and replayed on resume, a sealed refusal failing the stream, and its failures |

Run them with the compose Postgres up (`pnpm db:up`): `pnpm exec vitest run src/features/jev`, and `pnpm e2e e2e/jev.spec.ts` against `alchemy dev`.
