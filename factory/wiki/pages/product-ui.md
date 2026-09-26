# Embedded UI and recursive inspection

The app keeps work inside the chat: `src/mainview/` holds the chat, embedded surfaces, Flow registry, controller and store. The embedded run card is the reference example of these rules.

## Embedded, never a takeover

`RunTraceBody` is the body of the existing embedded run card. The card stays embedded until the human explicitly maximizes it; both presentations retain the composer and the same card identity.

## One flow, three doors

The run-trace commands (`runs.trace.view`, `runs.trace.live`, `runs.trace.filter`, `runs.trace.select`) are application flows available through button, slash and agent doors. Missing inputs use the existing schema-derived form. Each transition records the invoking actor. No command in this group requests fullscreen or changes execution.

## State belongs in collections

The card's `selection`, `cursorSeq`, `liveTail`, `filter` and `events` fields are the persisted authority in TanStack DB. `TurnNarrative` is a transient projection and `spanPath` derives ancestry; neither adds a table or storage service.

## Background work

Worker toasts appear after 300 ms and stay running through launch and execution; the embedded run card retains the output. Toasts offer only the controls their host and current state support, such as open, stop, steer, approval, resume, retry or reconnect.

## Inspect real execution structure

The default Turns view shows one line per recorded turn, led by a bounded excerpt of the model's recorded prose and falling back to call names for code-only or truncated responses. These excerpts are the model's words, not verified explanations, and the projection makes no extra model request.

Selecting a turn opens its recursive call tree and recorded detail in the same card. Selection pins a journal sequence so every part of the view folds only that prefix; Latest removes the selection and returns to the live turn view. Realm variable snapshots are not in the journal events, attached child runs have no navigable child execution ID, and same-name concurrent call settlements are matched FIFO.
