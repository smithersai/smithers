# Flows reference

> Create, edit, and run personal flows in smithers.sh, or author file flows for the CLI and SDK.

Every action in Smithers runs as a typed, durable **flow**. On `smithers.sh`, Members and above manage personal flows at [Flows](https://smithers.sh/app/flows). Locally, the CLI and SDK load committed file flows from `.smithers/flows/<name>/flow.ts`.

```text
WEB APP: PERSONAL FLOWS (/app/flows)
  1. Draft (/flow.new name ...) -> 2. Check & Save (new revision) -> 3. Run (/flow.run name) -> Isolated browser realm
     (Runs stay pinned to the revision active when they started; flows needing a machine show Needs a sandbox.)

CLI & SDK: FILE FLOWS + PROTECTED SYSTEM FLOWS
  - .smithers/flows/<name>/flow.ts  (loaded by smthrs CLI and @smthrs/flow; invoke at a ref via /repo.run)
  - System flows are protected actions; personal revisions never replace them.
```

_Personal flow lifecycle in smithers.sh (/app/flows, /flow.new, /flow.run) alongside CLI/SDK file flows and protected system flows_

## Create a personal flow

Open [Flows](https://smithers.sh/app/flows), choose **New flow**, enter a name and what the flow should do, and submit. In Chat, `/flow.new greet Return a greeting` opens the exact same draft (see [Chat commands](https://smithers.sh/docs/commands/) for all `/` commands).

| Draft stage | What happens |
| --- | --- |
| **Questions & code** | Smithers drafts the code and asks any clarifying questions. |
| **Checks** | Validation checks run automatically on the draft. |
| **Ready to save** | **Save** activates once checks pass, creating a saved revision. |
| **Failed** | Shows the failure cause and offers **Draft again**. |

## Edit, inspect, and delete

On [Flows](https://smithers.sh/app/flows):

- **Edit:** starts a new draft from the saved flow's latest source; describe your change, check the diff and checks, then **Save**.
- **Code:** opens the saved source for direct editing; saving appends a new revision.
- **Delete:** removes a saved flow or an unfinished draft.

## Run a personal flow

Choose **Run** on [Flows](https://smithers.sh/app/flows), or invoke `/flow.run greet` in Chat. Pass optional input after the name: `/flow.run greet Hello`.

- **Pinned revision:** a run executes the saved revision selected at launch; later edits create newer revisions without mutating active runs.
- **Execution realm:** personal code runs inside the browser's isolated realm. A flow that requires a remote machine shows **Needs a sandbox** and cannot run in the browser realm yet.
- **Observability:** open the run page to inspect progress, outputs, or failure diagnostics.

## SDK file flows

System flows are protected actions; personal revisions do not replace them.

For the CLI and SDK, commit a file flow at `.smithers/flows/<name>/flow.ts` whose default export is a tagged `Flow.make` from `@smthrs/flow`:

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("greet", {
  description: "Return a greeting",
  capabilities: [],
  effects: [],
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  body: Node.capture({}, ({ name }) => Node.succeed(`Hello, ${name}`))
})
```

The app's Flows page manages personal flows; repository file-flow overrides and activation controls are not available there. To run a committed repository flow at a branch's head from Chat, use `/repo.run`.

## Related pages

- Why flows plan first and cache steps by content: [How durable flows work](https://smithers.sh/docs/durable-flows/).
- Every chat `/` command and minimum role: [Chat commands](https://smithers.sh/docs/commands/).
- Package contracts and CLI verbs: [flow API](/docs/reference/api/flow/) and [CLI reference](/docs/reference/cli/).
