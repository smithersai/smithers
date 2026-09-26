---
title: Run durable flows
description: Discover a repository flow, fill its inputs, and inspect its run.
order: 13
section: Automate
---

A file flow lives at `flows/<name>/flow.ts` and default-exports `Flow.make` from `@smthrs/flow`. The tag matches its directory. `/flows` lists discovered descriptions without importing modules.

## Run with arguments

```tui-script run-flow
Use "flows"
Type "/flows"
Press Enter
Wait for "echo"
Capture "Browse the repository's flows."
Press Escape
Type "/flow echo text=hello"
Press Enter
Wait for "echo · done"
Type "/smithers"
Press Enter
Capture "Inspect a real completed durable flow run."
```

`/flow echo text=hello` and `/flow echo {"text":"hello"}` supply the same payload. A run gets its own tab and uses the native control host's plan, approval, execution, and watch path. Requested is not running; completion comes from the watch receipt.

## Fill missing input

```tui-script flow-form
Use "flows"
Type "/flow echo"
Press Enter
Wait for "Text"
Capture "Missing required input opens a schema-driven form."
Type "hello from the form"
Press Enter
Wait for "echo · done"
Press Ctrl+]
Press Ctrl+]
Wait for "hello from the form"
Capture "Submit the payload and wait for the actual run result."
```

Forms open once the composer is empty and no approval is pending. **Tab/Down** move forward; **Shift+Tab/Up** move back; **Space** toggles a boolean; **Left/Right** choose an option; **Enter** runs. **Esc**, search, Summary, or tab navigation close the form and leave the run parked. Open its tab and press **a** to return.

**x** requests cancellation. **r** or `/retry id` resumes an interrupted run. A parked form does not block new sessions, forking, or undo. With `--approve ask`, consequential capabilities use the approval row's **y/n/a** controls. Each declared capability is reviewed before launch.

## Approve a flow

```tui-script flow-approval
Use "flow-approval"
Type "/flow consequential"
Press Enter
Wait for "y allow"
Capture "Review the flow's declared write permission before it runs."
Press y
Wait for "proc:spawn:consequential"
Wait 500 ms
Capture "Review the process permission."
Press y
Wait for "net:post:https://example.test"
Wait 500 ms
Capture "Review the network permission."
Press y
Wait for "consequential · done"
Press Ctrl+]
Press Ctrl+]
Wait for "Authorized"
Capture "Inspect the completed run after approval."
```

## Define an echo flow

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("echo", {
  description: "Echo a message.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { text: Schema.String },
  success: Schema.String,
  body: ({ text }) => Node.succeed(text)
})
```

The recorder executes this flow through the same native control plane, in a private fixture project. No model is needed for the echo result.

## Inspect runs and refresh definitions

`/smithers` shows discovered flows and runs, newest first. Runs are stored under the project's `.flows` directory, shared with `smthrs runs`. Chat can also see the newest 20 store runs it did not start, marked `by: "cli"`.

Listing refreshes within 300 ms of a `flows/` change. Execution imports modules when the host warms after first draw; restart after changing a `flow.ts`. Run one executor per project directory.

The coordinator can call `smithers.flows`, `smithers.run`, and `smithers.inspect` for model-invocable flows. `smithers.run` returns a requested receipt immediately. A Markdown flow is a [custom agent](./agents.md); choosing one inserts `/agent name`.
