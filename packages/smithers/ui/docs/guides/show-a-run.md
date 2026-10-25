---
title: "Show a run"
description: "Compose a run's page from RunHeader, SpanTree, SpanDetail, RunWaterfall and RunJournal, list runs with RunList and open one in place with RunDetails, show a value with JsonValue, and draft a flow with FlowDraftView."
---

A run page shows what a flow did, step by step. The host reads the run from its
engine, redacts every value and clips it, then hands these components plain
data. They render values as text and keep no data of their own.

```tsx
import { Button, RunHeader, RunJournal, RunWaterfall, SpanDetail, SpanTree, Tabs, TabsContent, TabsList, TabsTrigger } from "@smthrs/ui"

<RunHeader
  title={run.flow}
  state={run.state}
  cancelRequested={run.cancelRequested}
  startedAtMs={run.startedAtMs}
  finishedAtMs={run.finishedAtMs}
  now={now}
  host="This device"
  actions={<Button onClick={stop}>Stop</Button>}
/>
<Tabs defaultValue="steps">
  <TabsList>
    <TabsTrigger value="steps">Steps</TabsTrigger>
    <TabsTrigger value="timeline">Timeline</TabsTrigger>
    <TabsTrigger value="journal">Journal</TabsTrigger>
  </TabsList>
  <TabsContent value="steps">
    <SpanTree steps={steps} selected={selected} onSelect={select} now={now} />
    <SpanDetail label={step.label} state={step.state} attempts={attempts} input={input} output={output} now={now} />
  </TabsContent>
  <TabsContent value="timeline">
    <RunWaterfall steps={steps} now={now} selected={selected} onSelect={select} />
  </TabsContent>
  <TabsContent value="journal">
    <RunJournal events={events} originMs={run.startedAtMs} hasMore={hasMore} onMore={readMore} />
  </TabsContent>
</Tabs>
```

## Pass values the host already redacted

Every value is a `JsonValueData`: `text`, the value's `bytes` before any clip,
and whether the host `clipped` it. Redact and clip on the host's read, before
the value reaches the page. `JsonValue` pretty-prints whole JSON and shows a
clipped value exactly as cut, with a `Clipped` marker:

```tsx
<JsonValue label="Output" value={{ text: '{"length":5}', bytes: 12, clipped: false }} defaultOpen />
```

## Words, not states

A run's state reads as one word from a closed list: `runWord("running")` is
`Working`, and `Stopping` once a stop is requested, until the engine settles
the run `Stopped`. Pass `word` to `RunHeader` or `RunStatusPill` for a state
the engine doesn't name, such as `On another device`. The header's status sits
in a polite live region, so a screen reader hears each change.

## Time comes from the host

Every component takes `now` instead of reading the clock, so the host ticks
once for the page and a test pins it. An open step's duration and its bar run
to `now`.

## Keyboard

`SpanTree` is a listbox: one row takes Tab, the arrow keys, Home and End move,
and Enter or Space selects. `RunWaterfall` with `onSelect` makes each bar a
button. `JsonValue` and the drafted files are `<details>` disclosures.

## Draft a flow

`FlowDraftView` is the card a flow is written in. Before the first round it is
a form (`Name`, `What it should do`, `Draft`); after, it shows the round's
status, its questions with the default each assumed, the drafted files and the
static checks. The app keeps the person's unsent answers and passes them as
`answers`; `Answer` sends `answersToSend(questions, answers)` and is on while
that has something to send: a changed answer, or a blocking question's value
as its field shows it, so a person can accept its default. `Draft again`,
`Try`, `Save`, `Propose` and `Delete` show only with their handlers.

```tsx
<FlowDraftView
  where="Mine"
  name={draft.name}
  request={draft.request}
  status={draft.status}
  round={draft.round}
  questions={draft.questions}
  answers={answers}
  files={draft.files}
  checks={draft.checks}
  onAnswerChange={setAnswer}
  onAnswer={sendAnswers}
  onSave={save}
  saveDisabled={draft.checks.some((check) => !check.ok)}
/>
```

## Related

- [API reference](../api.md#runs-and-flows): the props and helpers.
- [Render a run status](./render-run-status.md): `StatusPill` and the shared
  status tones.

## List runs like a CI system

`RunList` lists runs as a table. Give each row a `trigger`, `branch` and `actor`
and the table shows those columns; `where` tags a row's flow, such as `Cloud`
when a list mixes hosts. A row with `toggleHref` gets a toggle that links there,
so the host keeps which run is open in its address, and `expanded` with
`renderDetails` shows that run's details under it. `RunDetails` draws them: the
run and the runs it started as jobs, each step a native disclosure that opens
to its log lines, a failed step open with its error code.

```tsx
<RunList
  runs={rows}
  now={Date.now()}
  renderLink={(href, children) => <Link to={href}>{children}</Link>}
  renderDetails={() => <RunDetails jobs={jobs} now={Date.now()} renderLogs={(_, step) => <pre>{lines(step)}</pre>} />}
/>
```
