---
title: "Render agent output"
description: "Turn an unknown provider payload into a rendered response with parseAgentOutput and AgentOutput, or assemble the tool-call and reasoning parts yourself, with bounded formatting for values you did not produce."
---

The `agentic` family renders what a model returned: the response text, the tool
calls it made, and the reasoning summary the provider disclosed. Everything is
props-driven, so it works over control-plane events, an SSE stream, or a stored
transcript without knowing which.

## The fast path

`parseAgentOutput` takes an unknown payload and answers with a model or `null`,
and `AgentOutput` renders that model:

```tsx
import { AgentOutput, parseAgentOutput } from "@smthrs/ui"

export function ResponseSurface({ payload }: { readonly payload: unknown }) {
  const model = parseAgentOutput(payload)
  return model === null ? null : <AgentOutput model={model} />
}
```

The parser walks the common provider shapes: an `output`, `result`, `data`,
`response`, or `message` spine, and reasoning parts with nested `summary`
arrays. Two things bound the walk, so a hostile or cyclic payload cannot unmount
your tree: both traversals cap at depth 16 and carry a `WeakSet`. Over-depth or
cyclic branches are discarded. The result is `null` when nothing readable
remains, or a partial model containing only recognized fields. Discarded raw
branches are not retained. `AgentOutput` renders the model's response, summary,
and tools; it has no automatic JSON fallback.

The model it produces is small and typed:

```ts
import type { AgentOutputModel } from "@smthrs/ui"

const model: AgentOutputModel = {
  response: "Renamed the module and updated its callers.",
  reasoningSummary: "Checked the import graph first.",
  toolCalls: [{ name: "edit_file", state: "output-available", durationMs: 120 }],
  streaming: false
}
```

`reasoningSummary` carries only text the provider explicitly disclosed as a
summary. The parser drops raw reasoning, thinking, and thought transcripts at
the root, in content parts, and in nested message or envelope records. It does
not descend through those records except to read explicitly labeled summaries
into `reasoningSummary`. Records with `type` or `kind` set to
`redacted_thinking`, or with defined
`signature`, `redactedData`, or `redacted_data` metadata are dropped entirely,
including their summaries.

## Render streaming markdown

`MessageResponse` renders assistant prose. Pass `streaming` while tokens are
still arriving so the surface shows its in-flight treatment:

```tsx
import { MessageResponse } from "@smthrs/ui"

<MessageResponse content={text} onLinkClick={(href) => open(href)} streaming />
```

It renders through the dependency-free `Markdown` primitive, which builds React
children and never touches `innerHTML`, so model output cannot inject markup.
Link hrefs are additionally scheme-filtered.

## Assemble a tool call

`ToolCall` is a compound family. `state` drives the header treatment, and
`toolCallStatus` maps the eight lifecycle states onto the shared status
vocabulary:

```tsx
import { ToolCall, ToolCallContent, ToolCallHeader, ToolCallInput, ToolCallOutput } from "@smthrs/ui"

<ToolCall durationMs={120} name="edit_file" state="output-available">
  <ToolCallHeader />
  <ToolCallContent>
    <ToolCallInput args={{ path: "src/index.ts" }} />
    <ToolCallOutput resultText="1 file changed" />
  </ToolCallContent>
</ToolCall>
```

The eight states are `input-streaming`, `input-available`,
`approval-requested`, `approval-responded`, `running`, `output-available`,
`output-error`, and `output-denied`. `TOOL_CALL_STATE_LABELS` is the label for
each.

While arguments are still streaming, pass the raw text with `partial` and the
component streams it verbatim rather than guessing at the missing half:

```tsx
<ToolCallInput argsText={partialJson} partial />
```

`formatPartialJson` is the helper behind that decision. It reports whether the
text it was given is complete. Complete JSON gets two-space indentation without
changing number tokens, string escapes, duplicate keys, or key order. Invalid
fragments and deeply nested values stay verbatim. This also applies to complete
tool input in approval cards and JSON text result parts:

```ts
import { formatPartialJson } from "@smthrs/ui"

const { complete, text } = formatPartialJson('{"path": "src/ind')
```

## Show a reasoning summary

`Reasoning` is a collapsible container, and `ReasoningSummary` is the
presentation of one provider-disclosed summary. Use the drop-in form for the
common case:

```tsx
import { Reasoning, ReasoningSummary } from "@smthrs/ui"

<Reasoning duration={4} streaming={false}>
  <ReasoningSummary text="Checked the import graph before renaming." />
</Reasoning>
```

Pass `composed` when you want the trigger and content parts, which the container
otherwise renders for you:

```tsx
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@smthrs/ui"

<Reasoning composed defaultOpen={false}>
  <ReasoningTrigger>Thinking</ReasoningTrigger>
  <ReasoningContent>{summary}</ReasoningContent>
</Reasoning>
```

`ReasoningTrigger` and `ReasoningContent` throw when rendered outside
`<Reasoning composed>`, so the mistake fails loudly rather than rendering an
inert disclosure.

The streaming state is announced through a visually hidden polite live region,
which is why the surface needs no motion to communicate progress.

## Format a value you did not produce

Use `formatJsonSafe` explicitly when the host wants a bounded JSON fallback.
Only pass payloads the host has already approved for display to this example:
the formatter bounds serialization but does not filter private reasoning. A
`null` parse result can mean private output was discarded.

```tsx
import { AgentOutput, formatJsonSafe, parseAgentOutput } from "@smthrs/ui"

export function ApprovedResponseSurface({
  displaySafePayload
}: { readonly displaySafePayload: unknown }) {
  const model = parseAgentOutput(displaySafePayload)
  return model === null
    ? <pre>{formatJsonSafe(displaySafePayload)}</pre>
    : <AgentOutput model={model} />
}
```

This fallback runs only for `null`. Partial models render their recognized
fields and do not render discarded branches as JSON.

It truncates at four bounds, each marked in the output rather than silently: 12
levels of depth, 200 entries per container, 8192 characters per string, and
65536 UTF-8 bytes overall. A value that cannot be serialized at all, a cycle
included, returns the literal `[unserializable]`, which is a formatter code and
never a host exception's message. The exact values are in
[Failure codes and limits](../reference/contracts.md).

## Related

- [Collect a prompt with attachments](./collect-a-prompt.md): the input half of
  a chat surface.
- [Render a run status](./render-run-status.md): the vocabulary
  `toolCallStatus` maps onto.
- [API reference](../api.md): every part of every family.
