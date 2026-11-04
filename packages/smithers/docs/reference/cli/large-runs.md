# Large run diagnosis

`smthrs runs show <run>` reads history as a stream. Small histories retain their
existing diagnosis document. When the history exceeds 16 MiB, 50,000 events, or
the 1 MiB per-event projection budget, the command retains a bounded recent
window and reports `history` alongside the diagnosis. Counts in the diagnosis
are unavailable: large histories return a reduced diagnosis with the committed
status, the bounded failure cause when available, and `unavailable: true`.
Content-dependent statistics are not inferred from replacement values.

`history` records the original event and byte totals, evicted event counts and
bytes, the twenty largest payload fields, and the twenty largest truncated
fields with their original JSON byte sizes. `truncatedFieldsOmitted` counts
additional truncation receipts. A truncated value becomes `null` only in the
in-memory diagnosis projection; persisted data stays intact. The last recorded
error and state `currentNode` and `round` survive window eviction. A bounded
operational fold also preserves running actions after their scheduling events
are evicted. Lost or absent node evidence is reported as unavailable, never as
an execution id. Metadata paths are bounded at 2,048 bytes; oversized keys use
a bounded ancestor receipt with that ancestor's full size. Native execution
snapshots supply execution status and the authoritative current lineage round. Event round observations are scoped to that selected execution.
Structured errors retain bounded content or an explicit omission receipt naming
the actual cause or fault field.

Field paths are JSON pointers. Under `/events`, the number is the committed event
sequence, not an array index. A derived watch event appends `:<member>` (for
example `/events/123:1/payload/messageId`); the source event is member zero.
Read a field independently:

```sh
smthrs runs show <run> --field /events/123/payload/state/round
smthrs runs show <run> --field /events/123/payload/state/blob --offset 4096 --length 4096
```

A field read has a separate 1 MiB output bound. Oversized strings return a page
(default 4,096 characters) with `page.nextOffset` and `page.totalCharacters`.
Offsets count JavaScript string characters (UTF-16 code units). `--length` is
bounded at 65,536. Oversized objects return their size and `omitted: true`; use a
child pointer to narrow the read. A missing field fails explicitly. Storage
failures remain failures, even after reading some history.

The history collector measures JSON bytes without serializing the complete
history or an oversized payload. It logs numeric omission counts at debug level,
adds the `cli.run_history.read` span, and increments
`smithers.cli.run_history.truncated`; diagnostic logs contain no payloads.

`runs list`, `runs resume` and `runs cancel` do not collect history through the
16 MiB reader. Their ordinary lookup/control paths have no matching limit.
`runs logs`, `runs devtools`, `runs show --timing`, approval listing, and legacy
forensic readers still use strict bounded history collection and can refuse
oversized histories. The field reader is an alternative for event data; it does
not expose raw engine-state SQL columns. Library catalog entries used:
`@smthrs/control` for run observations, `@smthrs/canonical` for JSON string byte
accounting, and Effect streams and services for bounded consumption.

Large histories omit derived health and execution-activity projections, with
`healthUnavailable` and `activityUnavailable` receipts. Their current action
comes from the independent bounded operational fold. Native observation queries
project only lifecycle columns and JSON version/flow name in SQL, excluding
serialized payload and result state from returned rows. JSON byte accounting is
iterative, so nesting depth cannot exhaust the JavaScript call stack.

State node hints are ordered against scheduling and settlement facts. Later
native work invalidates stale hints; `lastRecordedNode` is historical evidence,
not an assertion that the node remains active. Field reads also enforce a depth
and formatted-response budget, reserving space for the CLI envelope. A compact
JSON value that would expand beyond the pretty-printed budget, including
terminal-safe JSON escaping, returns an
explicit `omitted` receipt with `reason: rendering-limit` instead.
For a string, use `--length` to read a bounded page.

Matching control-plane completion, failure and cancellation invalidate current
node evidence even without native terminal facts. Authoritative terminal run
status also wins over a stale history hint; `lastRecordedNode` remains available
for diagnosis and delayed events cannot resurrect a current action.

Projection gaps invalidate affected current actions. Rewinds conservatively
discard all current-action evidence and node hints because ancestry is not
retained; older epochs cannot restore them. Fresh scheduling
restores evidence. Epoch tracking retains at most 128 rewound executions;
exhaustion reports unavailable activity. Ordinary generation-zero executions do
not consume that budget.

A confirmed rewind or control resume starts a new lifecycle. Old terminal
evidence and current actions are cleared; fresh scheduling restores the current
action, while older native generations remain fenced out.

Human output removes terminal controls from the suggested field command;
structured output preserves its original value.
